import { describe, expect, test } from "bun:test";
import { type ExecFn, formatMonitorResult, type MonitorResult, MonitorRegistry, type MonitorSpec } from "../lib/monitors";

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
		const registry = new MonitorRegistry({ exec: async () => { throw new Error("spawn bash ENOENT"); }, notify: () => { } });
		expect(await registry.start(spec())).toMatchObject({ outcome: "error", output: "spawn bash ENOENT" });
	});

	test("rejects an invalid regex at start", () => {
		const h = harness([{ code: 0, stdout: "" }]);
		expect(() => h.registry.start(spec({ until: "(" }))).toThrow();
	});
});
