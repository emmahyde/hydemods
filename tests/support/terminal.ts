import { Terminal } from "@xterm/headless";

export interface TerminalOptions {
	command: string[];
	cwd?: string;
	/** Merged with process.env. Use an isolated OMP config directory for replay tests. */
	env?: Record<string, string | undefined>;
	cols?: number;
	rows?: number;
	/** Fail rather than silently return incomplete history when this capacity is reached. */
	scrollback?: number;
}

export interface OmpTerminalOptions extends Omit<TerminalOptions, "command"> {
	executable?: string;
	args?: string[];
}

export interface TerminalBufferSnapshot {
	/** Physical rows, with trailing spaces removed; wrapped rows remain separate. */
	scrollbackLines: string[];
	screenLines: string[];
	/** Complete physical buffer, including rows below a scrolled viewport. */
	allLines: string[];
	scrollback: string;
	screen: string;
	text: string;
	/** Parallel to allLines, for reconstructing logical wrapped lines if desired. */
	wrapped: boolean[];
	viewportY: number;
	baseY: number;
	cursor: { x: number; y: number };
}

export interface TerminalSnapshot extends TerminalBufferSnapshot {
	cols: number;
	rows: number;
	revision: number;
	buffer: "normal" | "alternate";
	/** Retains access to the primary buffer while an application uses the alternate screen. */
	normal: TerminalBufferSnapshot;
}

export interface TerminalWaitOptions {
	timeoutMs?: number;
	description?: string;
}

export interface TerminalPaintOptions extends TerminalWaitOptions {
	/** Require parsed output newer than this snapshot revision before considering quiet. */
	after?: number;
	quietMs?: number;
}

/**
 * Real PTY bytes interpreted by xterm.js, not OMP's onPaint or its render model.
 * Requires Bun with Bun.Terminal support and @xterm/headless.
 * startOmp only launches the executable: it never sends a prompt or calls a model.
 * Callers own fixtures/config isolation and must close in finally (or await using).
 */
export class TerminalSession implements AsyncDisposable {
	private readonly emulator: Terminal;
	private readonly pty: Bun.Terminal;
	private readonly child: Bun.Subprocess;
	private readonly listeners = new Set<() => void>();
	private readonly output: Uint8Array[] = [];
	private readonly scrollbackCapacity: number;
	private pendingWrites = 0;
	private parsedRevision = 0;
	private lastOutputAt = performance.now();
	private failure: Error | undefined;
	private closing: Promise<void> | undefined;
	private disposed = false;
	private processExited = false;
	private streamClosed = false;

	static start(options: TerminalOptions): TerminalSession {
		return new TerminalSession(options);
	}

	static startOmp(options: OmpTerminalOptions = {}): TerminalSession {
		const { executable = "omp", args = [], ...terminal } = options;
		return TerminalSession.start({ ...terminal, command: [executable, ...args] });
	}

	private constructor(options: TerminalOptions) {
		if (typeof Bun.Terminal !== "function") {
			throw new Error("TerminalSession requires a Bun release with Bun.Terminal support.");
		}
		const cols = options.cols ?? 100;
		const rows = options.rows ?? 30;
		this.validateSize(cols, rows);
		this.scrollbackCapacity = options.scrollback ?? 100_000;
		if (!Number.isInteger(this.scrollbackCapacity) || this.scrollbackCapacity < 1) {
			throw new Error("scrollback must be a positive integer");
		}
		this.emulator = new Terminal({
			cols, rows, scrollback: this.scrollbackCapacity,
			allowProposedApi: true, logLevel: "off",
		});
		try {
			this.pty = new Bun.Terminal({
				cols, rows, name: "xterm-256color",
				data: (_terminal, bytes) => this.receive(bytes),
				exit: (_terminal, status) => {
					this.streamClosed = true;
					if (status !== 0 && !this.closing) this.failure = new Error("PTY stream failed");
					this.notify();
				},
			});
		} catch (error) {
			this.emulator.dispose();
			throw error;
		}
		// Answer terminal queries (cursor position/device attributes) using the
		// independent emulator's responses, just as a real terminal would.
		this.emulator.onData((data) => { if (!this.pty.closed) this.pty.write(data); });
		this.emulator.onBinary((data) => {
			if (!this.pty.closed) this.pty.write(Buffer.from(data, "binary"));
		});
		try {
			this.child = Bun.spawn(options.command, {
				cwd: options.cwd,
				env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...options.env },
				terminal: this.pty,
			});
		} catch (error) {
			this.pty.close();
			this.emulator.dispose();
			throw error;
		}
		void this.child.exited.then(() => {
			this.processExited = true;
			this.notify();
		});
	}

	get pid(): number { return this.child.pid; }
	get exited(): Promise<number> { return this.child.exited; }
	get revision(): number { return this.parsedRevision; }
	/** Exact PTY transcript, including control sequences; not a substitute for snapshot(). */
	get rawOutput(): string { return Buffer.concat(this.output).toString("utf8"); }

	write(input: string | Uint8Array<ArrayBuffer>): void {
		this.assertUsable();
		if (this.processExited || this.pty.closed) throw new Error("Cannot write to an exited terminal process");
		this.pty.write(input);
	}
	scrollLines(amount: number): void {
		this.assertUsable();
		this.emulator.scrollLines(amount);
		this.notify();
	}


	/** Resize both the emulator and the kernel PTY (which sends SIGWINCH). */
	resize(cols: number, rows: number): void {
		this.assertUsable();
		this.validateSize(cols, rows);
		// Reflow the old screen before the child can emit its resize redraw.
		this.emulator.resize(cols, rows);
		this.pty.resize(cols, rows);
		this.checkCapacity();
		this.notify();
	}

	/** Synchronous view of parsed bytes; await waitForPaint() to include queued writes. */
	snapshot(): TerminalSnapshot {
		this.assertUsable();
		const active = this.emulator.buffer.active;
		const normal = this.readBuffer(this.emulator.buffer.normal);
		return {
			...(active.type === "normal" ? normal : this.readBuffer(active)),
			cols: this.emulator.cols, rows: this.emulator.rows,
			revision: this.parsedRevision, buffer: active.type, normal,
		};
	}

	/** Resolve on parsed terminal state, never an application's paint notification. */
	waitFor(predicate: (snapshot: TerminalSnapshot) => boolean, options: TerminalWaitOptions = {}): Promise<TerminalSnapshot> {
		return this.awaitCondition(predicate, options);
	}

	/**
	 * Wait for the xterm parser queue to drain and PTY output to become quiet.
	 * Quiet is not proof that an application has finished: use waitFor for a
	 * semantic marker, then waitForPaint when taking a stable capture.
	 */
	waitForPaint(options: TerminalPaintOptions = {}): Promise<TerminalSnapshot> {
		const quietMs = options.quietMs ?? 100;
		if (!Number.isFinite(quietMs) || quietMs < 0) throw new Error("quietMs must be nonnegative");
		return this.awaitCondition(
			(snapshot) => this.pendingWrites === 0
				&& (options.after === undefined || snapshot.revision > options.after)
				&& performance.now() - this.lastOutputAt >= quietMs,
			{ ...options, description: options.description ?? "terminal output to settle" },
			quietMs,
		);
	}

	/** Idempotent, bounded TERM/KILL teardown; also supported by `await using`. */
	close(): Promise<void> {
		return this.closing ??= this.cleanup();
	}

	async [Symbol.asyncDispose](): Promise<void> { await this.close(); }

	private receive(bytes: Uint8Array): void {
		if (this.disposed) return;
		// Bun may reuse the callback's storage after return.
		const copy = Uint8Array.from(bytes);
		this.output.push(copy);
		this.pendingWrites++;
		this.lastOutputAt = performance.now();
		this.emulator.write(copy, () => {
			this.pendingWrites--;
			this.parsedRevision++;
			this.lastOutputAt = performance.now();
			this.checkCapacity();
			this.notify();
		});
		this.notify();
	}

	private readBuffer(buffer: Terminal["buffer"]["active"]): TerminalBufferSnapshot {
		const allLines: string[] = [];
		const wrapped: boolean[] = [];
		for (let row = 0; row < buffer.baseY + this.emulator.rows; row++) {
			const line = buffer.getLine(row);
			allLines.push(line?.translateToString(true) ?? "");
			wrapped.push(line?.isWrapped ?? false);
		}
		const scrollbackLines = allLines.slice(0, buffer.baseY);
		const screenLines = allLines.slice(buffer.viewportY, buffer.viewportY + this.emulator.rows);
		return {
			scrollbackLines, screenLines, allLines, wrapped,
			scrollback: scrollbackLines.join("\n"), screen: screenLines.join("\n"),
			text: allLines.join("\n"), cursor: { x: buffer.cursorX, y: buffer.cursorY }, viewportY: buffer.viewportY, baseY: buffer.baseY,
		};
	}

	private checkCapacity(): void {
		if (this.emulator.buffer.normal.length >= this.scrollbackCapacity + this.emulator.rows) {
			this.failure ??= new Error(`Terminal scrollback capacity reached (${this.scrollbackCapacity}); increase scrollback to preserve full history`);
		}
	}

	private awaitCondition(
		predicate: (snapshot: TerminalSnapshot) => boolean,
		options: TerminalWaitOptions,
		quietMs?: number,
	): Promise<TerminalSnapshot> {
		const timeoutMs = options.timeoutMs ?? 10_000;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");
		return new Promise((resolve, reject) => {
			let quietTimer: ReturnType<typeof setTimeout> | undefined;
			const timeout = setTimeout(() => finish(new Error(
				`Timed out waiting for ${options.description ?? "terminal condition"} (${timeoutMs}ms)\n${this.rawOutput.slice(-4000)}`,
			)), timeoutMs);
			const finish = (error?: unknown, snapshot?: TerminalSnapshot) => {
				clearTimeout(timeout);
				clearTimeout(quietTimer);
				this.listeners.delete(check);
				if (error) reject(error);
				else resolve(snapshot!);
			};
			const check = () => {
				clearTimeout(quietTimer);
				try {
					const snapshot = this.snapshot();
					if (predicate(snapshot)) { finish(undefined, snapshot); return; }
					if (this.processExited && this.streamClosed && this.pendingWrites === 0 && quietMs === undefined) {
						throw new Error(`Process exited (${this.child.exitCode}) before ${options.description ?? "terminal condition"}\n${snapshot.text}`);
					}
					if (quietMs !== undefined && performance.now() - this.lastOutputAt < quietMs) {
						quietTimer = setTimeout(check, Math.max(1, quietMs - (performance.now() - this.lastOutputAt)));
					}
				} catch (error) { finish(error); }
			};
			this.listeners.add(check);
			check();
		});
	}

	private assertUsable(): void {
		if (this.disposed || this.closing) throw new Error("Terminal session is closed");
		if (this.failure) throw this.failure;
	}

	private validateSize(cols: number, rows: number): void {
		if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 1) {
			throw new Error("Terminal size requires integer cols >= 2 and rows >= 1");
		}
	}

	private notify(): void { for (const listener of this.listeners) listener(); }

	private async cleanup(): Promise<void> {
		try {
			if (!this.processExited) {
				this.child.kill("SIGTERM");
				if (!await this.waitForExit(1000)) {
					this.child.kill("SIGKILL");
					if (!await this.waitForExit(2000)) throw new Error(`PTY process ${this.pid} did not exit after SIGKILL`);
				}
			}
		} finally {
			this.disposed = true;
			this.notify();
			try { this.pty.close(); } finally { this.emulator.dispose(); }
		}
	}

	private async waitForExit(timeoutMs: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.child.exited.then(() => true),
				new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
			]);
		} finally { clearTimeout(timer); }
	}
}
