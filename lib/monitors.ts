/**
 * Background monitors: an agent registers a shell command, goes idle, and is woken with a
 * message when something happens.
 *
 * Modes:
 * - "stream": run `command` once as a long-lived watcher; every stdout line is an event that
 *   wakes the agent (lines arriving within `batchMs` share one event). A final message reports
 *   the exit code when the command ends, or a timeout.
 * - "poll": re-run `command` every `intervalSec` until it is satisfied (exit 0, or `until`
 *   matches its output).
 * - "exit": run `command` once (e.g. `gh pr checks --watch`) and report when it exits.
 *
 * Each monitor is registered with the host as ONE native async job whose run body owns the whole
 * loop, including the sleeps between checks. That makes every monitor visible to the host's own
 * `proc://` handler (list, read, `proc://<id>/kill`) for its entire life, and native cancellation
 * aborts the job's `AbortSignal`, which this loop bridges into the running shell check and its
 * sleep. The host's completion delivery is suppressed ({@link MonitorJobsHost.suppressDelivery})
 * because the monitor owns its own notification: exactly one wake per settled monitor, never both.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type MonitorMode = "stream" | "poll" | "exit";

export type MonitorSpec = {
	name: string;
	command: string;
	cwd: string;
	mode: MonitorMode;
	/** Regex over stdout+stderr; poll mode is satisfied when it matches. Default: exit code 0. */
	until?: string;
	intervalSec: number;
	timeoutMin: number;
	/** Stream mode: lines per event before the rest collapse to "… N more lines". Default 20. */
	maxEventLines?: number;
};

export type MonitorOutcome = "satisfied" | "exited" | "timed-out" | "error";

export type MonitorResult = { outcome: MonitorOutcome; runs: number; elapsedSec: number; code?: number; output: string; events?: number };

export type ExecFn = (command: string, cwd: string, signal: AbortSignal, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs `command` until it exits or `signal` aborts, calling `onLine` for each stdout line as it arrives. */
export type StreamFn = (command: string, cwd: string, signal: AbortSignal, onLine: (line: string) => void) => Promise<{ code: number; stderr: string }>;

/** Reports live progress into a native job row: a one-line label plus a detail block. */
export type MonitorProgressReporter = (text: string, output: string) => void | Promise<void>;

/**
 * The slice of the host's `AsyncJobManager` (owned by the calling agent's session) that a monitor
 * needs. Supplied by the caller so this module stays host-free and testable; see `lib/host-runtime.ts`
 * for the live wiring.
 *
 * The native job is a mirror, never the engine: the registry's own loop drives the command and the
 * wake whether or not the host ever runs the job body. The body only waits for the monitor to settle
 * (so proc:// shows it alive), and its abort signal is the proc://<id>/kill bridge into the loop.
 */
export type MonitorJobsHost = {
	/** Register a native background job that mirrors the monitor; returns the native job id. */
	register(label: string, run: (signal: AbortSignal, report: MonitorProgressReporter) => Promise<string>): string;
	/** Cancel a running native job this session owns; false when it already settled. */
	cancel(jobId: string): boolean;
	/**
	 * Durable suppression of the host's own completion delivery: the monitor owns its single wake.
	 * The host must not use a reversible "watch" (a wait/unwatch can lift it and replay the result);
	 * the acknowledgement is permanent for the job's retained lifetime.
	 */
	suppressDelivery(jobId: string): void;
	/** Rewrite the native job's label so proc listings and drawers show live progress. */
	setLabel(jobId: string, label: string): void;
};

export type MonitorDeps = {
	exec: ExecFn;
	notify: (spec: MonitorSpec, result: MonitorResult) => void;
	/** Stream mode: a batch of new stdout lines. Omitted: stream events are dropped, the settle still reports. */
	emit?: (spec: MonitorSpec, lines: string[]) => void;
	stream?: StreamFn;
	/** Stream mode: lines arriving within this window are delivered as one event. */
	batchMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type Running = {
	spec: MonitorSpec;
	startedAt: number;
	runs: number;
	/** Stream mode: batches of lines delivered so far. */
	events: number;
	last?: string;
	/** When the current poll sleep ends; undefined while a check is executing. */
	nextCheckAt?: number;
	/** Bridges cancellation for the host-less path; the native path aborts through the job signal. */
	controller: AbortController;
	host?: MonitorJobsHost;
	jobId?: string;
	settled: Promise<MonitorResult | undefined>;
};

export type MonitorListRow = {
	name: string;
	mode: MonitorMode;
	command: string;
	runs: number;
	events: number;
	elapsedSec: number;
	last?: string;
	/** Native `proc://` id, when the monitor was registered with the host. */
	jobId?: string;
	/** Seconds until the next poll check; absent while a check runs or for "exit" and "stream" modes. */
	nextInSec?: number;
};

const OUTPUT_TAIL = 3000;
const MAX_EVENT_LINES = 20;
const MAX_LINE_CHARS = 500;

const tail = (text: string) => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text);

const OUTCOME_LABEL: Record<MonitorOutcome, string> = {
	satisfied: "satisfied",
	exited: "exited",
	"timed-out": "timed out",
	error: "failed",
};

const defaultSleep = (ms: number, signal: AbortSignal) => {
	// An already-aborted signal must not strand the loop waiting on a timer that no later abort clears.
	if (signal.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const onAbort = () => { clearTimeout(timer); resolve(); };
	const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
};

/**
 * Login zsh (loads ~/.zprofile for PATH, not ~/.zshrc) in its own process group, so aborting
 * kills the whole pipeline (`while …; sleep`, `gh … | grep`) rather than orphaning children.
 */
export const spawnStream: StreamFn = (command, cwd, signal, onLine) => {
	const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stderr: string }>();
	const child = spawn("zsh", ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const kill = () => {
		try {
			if (child.pid) process.kill(-child.pid, "SIGTERM");
		} catch {
			// already gone
		}
	};
	if (signal.aborted) kill();
	signal.addEventListener("abort", kill, { once: true });
	let stderr = "";
	createInterface({ input: child.stdout }).on("line", onLine);
	child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-OUTPUT_TAIL); });
	child.on("error", error => { signal.removeEventListener("abort", kill); reject(error); });
	child.on("close", code => { signal.removeEventListener("abort", kill); resolve({ code: code ?? 1, stderr }); });
	return promise;
};

/** Local wall-clock `HH:MM:SS` for a next-check timestamp; a published label is read long after it is written. */
function formatClock(ms: number): string {
	const date = new Date(ms);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

/**
 * The native job label: name, mode, and the progress a `proc://` listing or drawer row shows.
 * The next check is an absolute clock time, not a countdown, because the label is written once
 * per transition and then read at arbitrary times by a proc listing or drawer.
 */
export function formatMonitorLabel(spec: MonitorSpec, state: { checks: number; nextAt?: number; settled?: MonitorOutcome }): string {
	const parts = [`monitor "${spec.name}" [${spec.mode}]`];
	if (state.settled !== undefined) parts.push(OUTCOME_LABEL[state.settled]);
	const unit = spec.mode === "stream" ? "event" : "check";
	parts.push(`${state.checks} ${unit}${state.checks === 1 ? "" : "s"}`);
	if (state.nextAt !== undefined) parts.push(`next ${formatClock(state.nextAt)}`);
	return parts.join(" · ");
}

export class MonitorRegistry {
	readonly #running = new Map<string, Running>();
	readonly #deps: Required<MonitorDeps>;

	constructor(deps: MonitorDeps) {
		this.#deps = { now: Date.now, sleep: defaultSleep, stream: spawnStream, batchMs: 300, emit: () => {}, ...deps };
	}

	/**
	 * Starts a monitor; a running monitor with the same name is replaced. Resolves when the monitor
	 * settles (or is cancelled/replaced). The loop always runs here, on the registry's own signal.
	 * With `host`, a native job mirrors it: label updates for proc:// listings, and the job's abort
	 * (proc://<id>/kill) cancels the monitor. A host that refuses or never runs the job changes nothing.
	 */
	start(spec: MonitorSpec, host?: MonitorJobsHost): Promise<MonitorResult | undefined> {
		if (spec.until !== undefined) new RegExp(spec.until); // fail fast on a bad regex
		this.cancel(spec.name);
		const run: Running = { spec, startedAt: this.#deps.now(), runs: 0, events: 0, controller: new AbortController(), settled: Promise.resolve(undefined) };
		// Register the map entry first so a replaced run's late settle never touches the new owner.
		this.#running.set(spec.name, run);
		let reporter: MonitorProgressReporter | undefined;
		const body = spec.mode === "stream" ? this.#stream(run, run.controller.signal, (t, o) => reporter?.(t, o)) : this.#loop(run, run.controller.signal, (t, o) => reporter?.(t, o));
		run.settled = body.then(result => this.#settle(run, result));
		if (host) {
			try {
				const jobId = host.register(formatMonitorLabel(spec, { checks: 0 }), async (signal, report) => {
					reporter = report;
					// The loop may already have published before the mirror attached; catch the row up.
					this.#publish(run, report);
					// proc://<id>/kill: only cancel while this run still owns its name; a replaced run's
					// late kill must not touch the new owner.
					signal.addEventListener("abort", () => { if (this.#running.get(spec.name) === run) this.cancel(spec.name); }, { once: true });
					const result = await run.settled;
					return result ? formatMonitorResult(spec, result) : `Monitor "${spec.name}" stopped.`;
				});
				run.host = host;
				run.jobId = jobId;
				host.suppressDelivery(jobId);
			} catch {
				// The native job layer is an extra; a host that refuses the registration must not stop the monitor.
			}
		}
		return run.settled;
	}

	cancel(name: string): boolean {
		const run = this.#running.get(name);
		if (!run) return false;
		this.#running.delete(name);
		run.controller.abort();
		if (run.jobId !== undefined) run.host?.cancel(run.jobId);
		return true;
	}

	cancelAll(): void {
		for (const name of [...this.#running.keys()]) this.cancel(name);
	}

	list(): MonitorListRow[] {
		const now = this.#deps.now();
		return [...this.#running.values()].map(r => ({
			name: r.spec.name,
			mode: r.spec.mode,
			command: r.spec.command,
			runs: r.runs,
			events: r.events,
			elapsedSec: Math.round((now - r.startedAt) / 1000),
			last: r.last,
			jobId: r.jobId,
			nextInSec: r.nextCheckAt === undefined ? undefined : Math.max(0, Math.round((r.nextCheckAt - now) / 1000)),
		}));
	}

	/** Publishes progress to the native job (label + render details). No-op without a native job. */
	#publish(run: Running, report?: MonitorProgressReporter): void {
		const checks = run.spec.mode === "stream" ? run.events : run.runs;
		const label = formatMonitorLabel(run.spec, { checks, nextAt: run.nextCheckAt });
		if (run.jobId !== undefined) run.host?.setLabel(run.jobId, label);
		void report?.(label, this.#progressText(run, run.nextCheckAt));
	}

	#progressText(run: Running, nextAt?: number): string {
		const { spec } = run;
		const cadence = spec.mode === "exit" ? "single run" : spec.mode === "stream" ? "long-lived watcher" : `every ${spec.intervalSec}s`;
		const progress = spec.mode === "stream" ? `Events: ${run.events}` : `Checks: ${run.runs}`;
		const lines = [
			`Monitor "${spec.name}" [${spec.mode}] — ${cadence}, timeout ${spec.timeoutMin}m`,
			`${progress} · elapsed ${Math.round((this.#deps.now() - run.startedAt) / 1000)}s${nextAt === undefined ? "" : ` · next check at ${formatClock(nextAt)}`}`,
			run.last ? `Last output:\n${run.last}` : "No output yet.",
		];
		return lines.join("\n");
	}

	/**
	 * The single settle point. Only the live owner of the name reports; a cancelled or replaced
	 * monitor stays silent (no false success, no duplicate wake).
	 */
	#settle(run: Running, result: MonitorResult | undefined): MonitorResult | undefined {
		if (this.#running.get(run.spec.name) !== run) return undefined;
		this.#running.delete(run.spec.name);
		if (!result) return undefined;
		const checks = run.spec.mode === "stream" ? run.events : run.runs;
		if (run.jobId !== undefined) run.host?.setLabel(run.jobId, formatMonitorLabel(run.spec, { checks, settled: result.outcome }));
		try {
			this.#deps.notify(run.spec, result);
		} catch {
			// A failed wake (e.g. a disposed session) must not turn a settled job into a failed one.
		}
		return result;
	}

	async #stream(run: Running, signal: AbortSignal, report?: MonitorProgressReporter): Promise<MonitorResult | undefined> {
		const { spec } = run;
		const elapsedSec = () => Math.round((this.#deps.now() - run.startedAt) / 1000);
		const owned = () => this.#running.get(spec.name) === run;
		// The watcher's own signal: the caller's abort (cancel, replace, native kill) and our deadline
		// both end it, but the deadline must not abort a native job signal we do not own.
		const local = new AbortController();
		const forward = () => local.abort();
		if (signal.aborted) forward();
		signal.addEventListener("abort", forward, { once: true });
		let output = "";
		let pending: string[] = [];
		let batch: Timer | undefined;
		const flush = () => {
			clearTimeout(batch);
			batch = undefined;
			const lines = pending;
			pending = [];
			if (!lines.length || !owned()) return;
			run.events += 1;
			const max = spec.maxEventLines ?? MAX_EVENT_LINES;
			const shown = lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`] : lines;
			this.#deps.emit(spec, shown);
			this.#publish(run, report);
		};
		const onLine = (raw: string) => {
			const line = raw.trimEnd();
			if (!line || !owned()) return;
			output = tail(output ? `${output}\n${line}` : line);
			run.last = line;
			pending.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
			batch ??= setTimeout(flush, this.#deps.batchMs);
		};
		let timedOut = false;
		const deadline = setTimeout(() => { timedOut = true; local.abort(); }, spec.timeoutMin * 60_000);
		this.#publish(run, report);
		let result: MonitorResult;
		try {
			const { code, stderr } = await this.#deps.stream(spec.command, spec.cwd, local.signal, onLine);
			run.runs = 1;
			flush();
			const text = tail([output, stderr.trim()].filter(Boolean).join("\n"));
			result = { outcome: timedOut ? "timed-out" : "exited", runs: 1, elapsedSec: elapsedSec(), code: timedOut ? undefined : code, output: text, events: run.events };
		} catch (error) {
			flush();
			result = { outcome: "error", runs: 1, elapsedSec: elapsedSec(), output: error instanceof Error ? error.message : String(error), events: run.events };
		} finally {
			clearTimeout(deadline);
			signal.removeEventListener("abort", forward);
		}
		// A timeout aborts our own signal but keeps ownership; a cancel or replacement removes it
		// (and #settle stays silent for a run that no longer owns its name).
		return result;
	}

	async #loop(run: Running, signal: AbortSignal, report?: MonitorProgressReporter): Promise<MonitorResult | undefined> {
		const { spec } = run;
		const deadline = run.startedAt + spec.timeoutMin * 60_000;
		const pattern = spec.until === undefined ? undefined : new RegExp(spec.until, "m");
		const elapsedSec = () => Math.round((this.#deps.now() - run.startedAt) / 1000);
		let result: MonitorResult | undefined;
		while (!signal.aborted) {
			run.nextCheckAt = undefined;
			// A check is starting: clear the scheduled next-check time in the proc row before the command
			// runs, so the row never advertises a check that has already begun.
			this.#publish(run, report);
			const remaining = deadline - this.#deps.now();
			if (remaining <= 0) {
				result = { outcome: "timed-out", runs: run.runs, elapsedSec: elapsedSec(), output: run.last ?? "" };
				break;
			}
			let code: number;
			let output: string;
			try {
				const res = await this.#deps.exec(spec.command, spec.cwd, signal, remaining);
				code = res.code;
				output = `${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`.trim();
			} catch (error) {
				if (signal.aborted) break;
				result = { outcome: "error", runs: run.runs + 1, elapsedSec: elapsedSec(), output: error instanceof Error ? error.message : String(error) };
				break;
			}
			if (signal.aborted) break;
			run.runs += 1;
			run.last = output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output;
			if (spec.mode === "exit") {
				result = { outcome: this.#deps.now() >= deadline ? "timed-out" : "exited", runs: run.runs, elapsedSec: elapsedSec(), code, output: run.last };
				break;
			}
			if (pattern ? pattern.test(output) : code === 0) {
				result = { outcome: "satisfied", runs: run.runs, elapsedSec: elapsedSec(), code, output: run.last };
				break;
			}
			const sleepMs = Math.min(spec.intervalSec * 1000, Math.max(0, deadline - this.#deps.now()));
			run.nextCheckAt = this.#deps.now() + sleepMs;
			this.#publish(run, report);
			await this.#deps.sleep(sleepMs, signal);
		}
		run.nextCheckAt = undefined;
		return result;
	}
}

export function formatMonitorResult(spec: MonitorSpec, result: MonitorResult): string {
	const head = {
		satisfied: `condition met`,
		exited: `command exited with code ${result.code}`,
		"timed-out": `timed out after ${spec.timeoutMin}m`,
		error: `failed to run`,
	}[result.outcome];
	return [
		`Monitor "${spec.name}" ${head} (${result.runs} run${result.runs === 1 ? "" : "s"}, ${result.elapsedSec}s).`,
		`Command: ${spec.command}`,
		result.output ? `Last output:\n${result.output}` : "No output.",
	].join("\n");
}

export function formatMonitorEvent(spec: MonitorSpec, lines: string[]): string {
	return `Monitor event (${spec.name}): ${lines.join("\n")}\nThe monitor is still running; react if this matters, otherwise end your turn. Do not poll.`;
}
