import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { orderedReplayMarkers, replayMarkers, sanitizedReplaySession } from "./fixtures/terminal-replay";
import { TerminalSession, type TerminalSnapshot } from "./support/terminal";

// Run explicitly with: bun test tests/terminal-replay.test.ts
// OMP_REPLAY_EXECUTABLE selects an installed binary; OMP_REPLAY_VERSION pins the
// expected runtime (default: the 18.16.0 release this regression targets).
// No positional prompt, --restore, or Enter on user text is ever sent. The only
// submitted input is an already-registered, local Hydemods settings command.
const executable = process.env.OMP_REPLAY_EXECUTABLE ?? "omp";
const expectedVersion = process.env.OMP_REPLAY_VERSION ?? "18.16.0";
const extension = resolve(import.meta.dir, "../index.ts");
const waitOptions = { timeoutMs: 30_000 };

function terminalHistory(snapshot: TerminalSnapshot): string {
	// An alternate screen has no scrollback of its own. Its visible rows and the
	// retained primary history are both consumer-visible terminal state.
	const rows = (snapshot.buffer === "normal" ? snapshot.text : `${snapshot.normal.text}\n${snapshot.text}`).split("\n");
	// Hydemods' thought panel repeats the most recent prompt above its header.
	return rows.filter((row, index) => !(row.trimStart().startsWith("❯ ") && rows[index + 1]?.trimStart().startsWith("✻ "))).join("\n");
}

function assertTranscript(snapshot: TerminalSnapshot, label: string): void {
	const history = terminalHistory(snapshot);
	let previous = -1;
	for (const marker of orderedReplayMarkers) {
		const position = history.indexOf(marker, previous + 1);
		expect(position, `${label}: missing or reordered ${marker}`).toBeGreaterThan(previous);
		const first = history.indexOf(marker), last = history.lastIndexOf(marker);
		expect(first, `${label}: duplicate ${marker}\nfirst: ${history.slice(first - 100, first + 120)}\nlast: ${history.slice(last - 100, last + 120)}`).toBe(last);
		previous = position;
	}
	// Resize may legitimately move a reply between viewport and scrollback.
	// Preservation is about the combined terminal history, not fixed screen rows.
	expect(snapshot.normal.scrollback, `${label}: oldest user reply retained`).toContain(replayMarkers.question);
}

async function settledReplay(terminal: TerminalSession, after?: number): Promise<TerminalSnapshot> {
	try {
		await terminal.waitFor(snapshot =>
			terminalHistory(snapshot).includes(replayMarkers.thirdReply) &&
			(after === undefined || snapshot.revision > after),
			{ ...waitOptions, description: "resumed Q3 parsed into terminal history" },
		);
		return await terminal.waitForPaint({ ...waitOptions, after, quietMs: 250, description: "resume/resize output parsed and quiet" });
	} catch (error) {
		const snapshot = terminal.snapshot();
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nParsed emulator state: ${JSON.stringify({
			buffer: snapshot.buffer, cols: snapshot.cols, rows: snapshot.rows,
			normalScrollbackRows: snapshot.normal.scrollbackLines.length,
			screen: snapshot.screen, normalScreen: snapshot.normal.screen,
			lastHistoryRows: terminalHistory(snapshot).split("\n").slice(-40),
		})}`, { cause: error });
	}
}

for (const mode of ["native", "hydemods"] as const) {
	test(`actual OMP resume preserves long prose and adjacent replies: ${mode}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "hydemods-terminal-replay-"));
		let terminal: TerminalSession | undefined;
		try {
			const cwd = join(root, "workspace");
			const agentDir = join(root, "agent");
			const home = join(root, "home");
			await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(home)]);
			const session = join(root, "synthetic.jsonl");
			await writeFile(session, sanitizedReplaySession(cwd));
			// Clear inherited secrets AND profile/config selectors, rather than only
			// guessing provider key names. Keep the executable search path, nothing
			// from the user's agent config, credentials, project, or session history.
			const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
			Object.assign(env, {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: root,
				LANG: "en_US.UTF-8",
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				XDG_CONFIG_HOME: join(home, ".config"),
				PI_CODING_AGENT_DIR: agentDir,
			});
			await writeFile(join(agentDir, "auth.json"), "{}\n");
			const versionProcess = Bun.spawn([executable, "--version"], { cwd, env, stdout: "pipe", stderr: "pipe" });
			const [version, versionError, versionExit] = await Promise.all([
				new Response(versionProcess.stdout).text(), new Response(versionProcess.stderr).text(), versionProcess.exited,
			]);
			expect(versionExit, versionError).toBe(0);
			expect(version.trim()).toBe(`omp/${expectedVersion}`);
			const args = [
				"--resume", session, "--session-dir", join(root, "sessions"),
				"--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-title",
				...(mode === "hydemods" ? ["-e", extension] : []),
			];
			terminal = TerminalSession.startOmp({ executable, args, cwd, env, cols: 100, rows: 32, scrollback: 50_000 });
			const initial = await settledReplay(terminal);
			assertTranscript(initial, `${mode} 100x32`);
			// Pressure comes from actual rendered session prose, never fabricated
			// terminal writes. Capacity is deliberately not exhausted: eviction at
			// a terminal's configured limit would be legitimate, not an OMP bug.
			expect(initial.normal.scrollbackLines.length).toBeGreaterThan(initial.rows * 8);
			expect(initial.screen).toContain(replayMarkers.answerEnd);
			expect(initial.screen, "initial Q2 visible").toContain(replayMarkers.secondReply);
			expect(initial.screen, "initial Q3 visible").toContain(replayMarkers.thirdReply);
			terminal.scrollLines(-8);
			const scrolled = terminal.snapshot();
			expect(scrolled.viewportY).toBeLessThan(scrolled.baseY);
			expect(scrolled.screen).toContain(replayMarkers.firstReply);
			for (const [cols, rows] of [[52, 20], [120, 36], [68, 24], [100, 32]]) {
				terminal.scrollLines(-8);
				expect(terminal.snapshot().viewportY).toBeLessThan(terminal.snapshot().baseY);
				const before = terminal.revision;
				terminal.resize(cols!, rows!);
				process.kill(terminal.pid, "SIGWINCH");
				const snapshot = await settledReplay(terminal, before);
				expect([snapshot.cols, snapshot.rows]).toEqual([cols, rows]);
				assertTranscript(snapshot, `${mode} ${cols}x${rows}`);
				// Deliberately no physical-row equality, fixed clipping column, or
				// scrollback row-count equality: normal terminal reflow changes those.
			}
			let pluginEvidence = "discovery disabled; empty isolated config/workspace; no -e";
			if (mode === "hydemods") {
				// Successful dispatch proves the extension actually loaded; an -e flag
				// alone cannot distinguish a working plugin from a load failure.
				terminal.write("/hydemods collapsed-lines\r");
				await terminal.waitFor(snapshot => snapshot.screen.includes("Collapsed line limit:"), {
					...waitOptions, description: "local Hydemods command registration evidence",
				});
				pluginEvidence = "registered /hydemods collapsed-lines returned Collapsed line limit:";
			}
			console.info(JSON.stringify({ replay: mode, runtime: version.trim(), pluginEvidence, dimensions: ["100x32", "52x20", "120x36", "68x24", "100x32"], initialScrollbackRows: initial.normal.scrollbackLines.length }));
		} finally {
			try { await terminal?.close(); }
			finally { await rm(root, { recursive: true, force: true }); }
		}
	}, 120_000);
}
