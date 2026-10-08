import { describe, expect, test } from "bun:test";
import { type ExecFn, formatMonitorResult, type MonitorResult, MonitorRegistry, type MonitorSpec, spawnStream, type StreamFn } from "../lib/monitors";

const spec = (overrides: Partial<MonitorSpec> = {}): MonitorSpec => ({
	name: "ci",
	command: "check",
	cwd: "/tmp",
	mode: "poll",
	intervalSec: 30,
	timeoutMin: 10,
	...overrides,
});

/** Virtual clock: sleep advances time instantly, so loops run without real waiting. */
function harness(outputs: { code: number; stdout: string }[]) {
	let clock = 0;
	let calls = 0;
	const notified: { spec: MonitorSpec; result: MonitorResult }[] = [];
	const exec: ExecFn = async () => {
		const out = outputs[Math.min(calls, outputs.length - 1)];
		calls += 1;
		clock += 1000;
		return { ...out, stderr: "" };
	};
	const registry = new MonitorRegistry({
		exec,
		notify: (s, result) => notified.push({ spec: s, result }),
		emit: () => { },
		now: () => clock,
		sleep: async ms => { clock += ms; },
	});
	return { registry, notified, calls: () => calls };
}

describe("monitors", () => {
	test("poll mode reports once when the command first exits 0", async () => {
		const h = harness([{ code: 1, stdout: "pending" }, { code: 1, stdout: "pending" }, { code: 0, stdout: "passed" }]);
		const result = await h.registry.start(spec());
		expect(result).toMatchObject({ outcome: "satisfied", runs: 3, code: 0, output: "passed" });
		expect(h.notified).toHaveLength(1);
		expect(h.registry.list()).toHaveLength(0);
	});

	test("poll mode with `until` ignores exit codes and waits for the pattern", async () => {
		const h = harness([{ code: 0, stdout: "ci=PENDING" }, { code: 0, stdout: "ci=SUCCESS" }]);
		const result = await h.registry.start(spec({ until: "ci=(SUCCESS|FAILURE)" }));
		expect(result).toMatchObject({ outcome: "satisfied", runs: 2, output: "ci=SUCCESS" });
	});

	test("times out with the last output when the condition never holds", async () => {
		const h = harness([{ code: 1, stdout: "still pending" }]);
		const result = await h.registry.start(spec({ timeoutMin: 2, intervalSec: 30 }));
		expect(result?.outcome).toBe("timed-out");
		expect(result?.output).toBe("still pending");
		expect(h.calls()).toBeGreaterThan(1);
		expect(h.notified).toHaveLength(1);
	});

	test("exit mode reports the exit code after a single run, even on failure", async () => {
		const h = harness([{ code: 8, stdout: "checks failed" }]);
		const result = await h.registry.start(spec({ mode: "exit" }));
		expect(result).toMatchObject({ outcome: "exited", runs: 1, code: 8 });
		expect(formatMonitorResult(spec({ mode: "exit" }), result!)).toContain('Monitor "ci" command exited with code 8');
	});

	test("a cancelled or replaced monitor never reports", async () => {
		let release!: () => void;
		const notified: string[] = [];
		const registry = new MonitorRegistry({
			exec: (_c, _cwd, signal) => {
				const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
				release = () => resolve({ code: 0, stdout: "done", stderr: "" });
				signal.addEventListener("abort", () => reject(new Error("aborted")));
				return promise;
			},
			notify: s => notified.push(s.command),
			emit: () => { },
		});
		const first = registry.start(spec({ command: "old" }));
		const second = registry.start(spec({ command: "new" }));
		expect(await first).toBeUndefined();
		release();
		expect(await second).toMatchObject({ outcome: "satisfied" });
		expect(notified).toEqual(["new"]);

		const third = registry.start(spec({ name: "gone" }));
		expect(registry.cancel("gone")).toBe(true);
		expect(await third).toBeUndefined();
		expect(notified).toEqual(["new"]);
	});

	test("a command that cannot run reports an error instead of retrying", async () => {
		const registry = new MonitorRegistry({ exec: async () => { throw new Error("spawn bash ENOENT"); }, notify: () => { }, emit: () => { } });
		expect(await registry.start(spec())).toMatchObject({ outcome: "error", output: "spawn bash ENOENT" });
	});

	test("rejects an invalid regex at start", () => {
		const h = harness([{ code: 0, stdout: "" }]);
		expect(() => h.registry.start(spec({ until: "(" }))).toThrow();
	});

	describe("stream mode", () => {
		/** A scripted watcher: `feed` pushes stdout lines, `finish` exits. */
		function streamHarness(batchMs = 5) {
			const events: string[][] = [];
			const notified: MonitorResult[] = [];
			let onLine!: (line: string) => void;
			let finish!: (code: number) => void;
			const stream: StreamFn = (_c, _cwd, signal, cb) => {
				onLine = cb;
				const { promise, resolve } = Promise.withResolvers<{ code: number; stderr: string }>();
				finish = code => resolve({ code, stderr: "" });
				signal.addEventListener("abort", () => resolve({ code: 143, stderr: "" }));
				return promise;
			};
			const registry = new MonitorRegistry({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), stream, batchMs, notify: (_s, r) => notified.push(r), emit: (_s, lines) => events.push(lines) });
			return { registry, events, notified, feed: (line: string) => onLine(line), finish: (code: number) => finish(code) };
		}

		test("each burst of lines wakes the agent once, then the exit is reported", async () => {
			const h = streamHarness();
			const done = h.registry.start(spec({ mode: "stream" }));
			h.feed("Watching PR #1787");
			h.feed("");
			await Bun.sleep(20);
			h.feed("scanner: pass");
			h.feed("buildkite: pending");
			await Bun.sleep(20);
			expect(h.events).toEqual([["Watching PR #1787"], ["scanner: pass", "buildkite: pending"]]);
			expect(h.notified).toHaveLength(0);
			expect(h.registry.list()[0]).toMatchObject({ events: 2, last: "buildkite: pending" });
			h.feed("buildkite: pass");
			h.finish(0);
			expect(await done).toMatchObject({ outcome: "exited", code: 0, events: 3 });
			expect(h.events.at(-1)).toEqual(["buildkite: pass"]);
			expect(h.notified).toHaveLength(1);
		});

		test("timeout kills the watcher and reports timed-out", async () => {
			const h = streamHarness();
			const result = await h.registry.start(spec({ mode: "stream", timeoutMin: 0.0005 }));
			expect(result).toMatchObject({ outcome: "timed-out", code: undefined });
			expect(h.notified).toHaveLength(1);
		});

		test("a cancelled watcher emits nothing further and never reports", async () => {
			const h = streamHarness(50);
			const done = h.registry.start(spec({ mode: "stream" }));
			h.feed("queued before cancel");
			h.registry.cancel("ci");
			expect(await done).toBeUndefined();
			await Bun.sleep(60);
			expect(h.events).toEqual([]);
			expect(h.notified).toEqual([]);
		});

		test("spawnStream delivers lines live and kills the whole process group on abort", async () => {
			const lines: string[] = [];
			const controller = new AbortController();
			const done = spawnStream("echo first; sleep 30 | cat; echo never", "/tmp", controller.signal, line => lines.push(line));
			while (!lines.length) await Bun.sleep(10);
			expect(lines).toEqual(["first"]);
			const started = Date.now();
			controller.abort();
			await done;
			expect(Date.now() - started).toBeLessThan(2000);
			expect(lines).toEqual(["first"]);
		});
	});
});
