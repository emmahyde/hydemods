import { describe, expect, test } from "bun:test";
import { type ExecFn, formatMonitorResult, type MonitorJobsHost, type MonitorResult, MonitorRegistry, type MonitorSpec, spawnStream, type StreamFn } from "../lib/monitors";

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

/* ------------------------------ native job host ------------------------------ */

type FakeJob = {
	id: string;
	label: string;
	status: "running" | "completed" | "cancelled" | "failed";
	/** True once the monitor suppressed the host's own completion delivery. */
	suppressed: boolean;
	controller: AbortController;
	/** One entry per progress report: the job label and the detail block. */
	labels: string[];
	details: string[];
};

/** In-memory stand-in for the host's `AsyncJobManager`, narrowed to the monitor contract. */
function nativeHarness() {
	const jobs = new Map<string, FakeJob>();
	let nextId = 1;
	const host: MonitorJobsHost = {
		register(label, run) {
			const id = `bg_${nextId}`;
			nextId += 1;
			const controller = new AbortController();
			const job: FakeJob = { id, label, status: "running", suppressed: false, controller, labels: [], details: [] };
			jobs.set(id, job);
			void run(controller.signal, (text, output) => {
				job.labels.push(text);
				job.details.push(output);
			}).then(
				() => { if (job.status === "running") job.status = "completed"; },
				() => { if (job.status === "running") job.status = "failed"; },
			);
			return id;
		},
		cancel(id) {
			const job = jobs.get(id);
			if (!job || job.status !== "running") return false;
			job.status = "cancelled";
			job.controller.abort();
			return true;
		},
		suppressDelivery(id) {
			const job = jobs.get(id);
			if (job) job.suppressed = true;
		},
		setLabel(id, label) {
			const job = jobs.get(id);
			if (job) job.label = label;
		},
	};
	return { host, jobs, only: () => [...jobs.values()][0] };
}

/** A clock that advances on every exec and sleep, so poll loops settle without real waiting. */
function virtualClock() {
	let clock = 0;
	const now = () => clock;
	const advance = (ms: number) => { clock += ms; };
	return { now, advance };
}

describe("monitors with a native job host", () => {
	test("one native job covers the whole loop and reports checks, next check, and the outcome", async () => {
		const h = nativeHarness();
		const clock = virtualClock();
		const outputs = [
			{ code: 1, stdout: "still pending" },
			{ code: 1, stdout: "still pending" },
			{ code: 0, stdout: "passed" },
		];
		let calls = 0;
		const notified: MonitorResult[] = [];
		const registry = new MonitorRegistry({
			exec: async () => {
				const out = outputs[Math.min(calls, outputs.length - 1)];
				calls += 1;
				clock.advance(1000);
				return { ...out, stderr: "" };
			},
			notify: (_spec, result) => notified.push(result),
			now: clock.now,
			sleep: async ms => { clock.advance(ms); },
		});

		const result = await registry.start(spec({ intervalSec: 30 }), h.host);
		expect(result).toMatchObject({ outcome: "satisfied", runs: 3 });
		expect(h.jobs.size).toBe(1);
		const job = h.only();
		// The host's own delivery is suppressed: the monitor's notify is the single wake.
		expect(job.suppressed).toBe(true);
		expect(notified).toHaveLength(1);
		// The fake marks the row complete after the monitor's body settles, one microtask later.
		await Promise.resolve();
		expect(job.status).toBe("completed");
		// Between checks the label carries the check count and the absolute next-check time.
		expect(job.labels.some(label => label.includes("1 check") && /\bnext \d{2}:\d{2}:\d{2}\b/.test(label))).toBe(true);
		expect(job.details.some(detail => detail.includes("Checks: 1") && detail.includes("still pending") && detail.includes("next check at"))).toBe(true);
		// The settled row is self-describing for proc listings and drawers.
		expect(job.label).toContain("satisfied");
	});

	test("native cancellation during a command stops the check and emits no notification", async () => {
		const h = nativeHarness();
		const notified: string[] = [];
		let started = 0;
		const registry = new MonitorRegistry({
			exec: (_command, _cwd, signal) => {
				started += 1;
				const { promise, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				return promise;
			},
			notify: s => notified.push(s.name),
		});

		const settled = registry.start(spec(), h.host);
		const job = h.only();
		expect(job.status).toBe("running");
		expect(started).toBe(1);
		// Same call the host's `proc://<id>/kill` makes.
		expect(h.host.cancel(job.id)).toBe(true);
		expect(await settled).toBeUndefined();
		expect(job.status).toBe("cancelled");
		expect(notified).toEqual([]);
		expect(registry.list()).toHaveLength(0);
	});

	test("native cancellation during the poll sleep stops the loop before the next check", async () => {
		const h = nativeHarness();
		const notified: string[] = [];
		let calls = 0;
		const registry = new MonitorRegistry({
			exec: async () => { calls += 1; return { code: 1, stdout: "pending", stderr: "" }; },
			notify: s => notified.push(s.name),
			sleep: (_ms, signal) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => resolve(), { once: true });
				return promise;
			},
		});

		const settled = registry.start(spec({ intervalSec: 30 }), h.host);
		const job = h.only();
		await Promise.resolve();
		expect(calls).toBe(1);
		expect(job.label).toMatch(/\bnext \d{2}:\d{2}:\d{2}\b/);
		expect(h.host.cancel(job.id)).toBe(true);
		expect(await settled).toBeUndefined();
		expect(calls).toBe(1);
		expect(notified).toEqual([]);
	});

	test("entering a check clears the next-check time until the following check is scheduled", async () => {
		const h = nativeHarness();
		const clock = virtualClock();
		const releases: Array<() => void> = [];
		const registry = new MonitorRegistry({
			exec: (_command, _cwd, signal) => {
				const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
				signal.addEventListener("abort", () => resolve({ code: 1, stdout: "aborted", stderr: "" }), { once: true });
				releases.push(() => resolve({ code: 1, stdout: "pending", stderr: "" }));
				return promise;
			},
			notify: () => { },
			now: clock.now,
			sleep: async ms => { clock.advance(ms); },
		});

		const settled = registry.start(spec({ intervalSec: 30 }), h.host);
		const job = h.only();
		// A check is in flight: the row must not advertise a next-check time while it runs.
		expect(job.labels.at(-1)).not.toContain("next");
		releases.shift()!();
		for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
		// The completed check scheduled the next one, then the next check started and cleared it again.
		expect(job.labels.some(label => /\bnext \d{2}:\d{2}:\d{2}\b/.test(label))).toBe(true);
		expect(job.labels.at(-1)).not.toContain("next");
		expect(job.details.at(-1)).not.toContain("next check at");
		registry.cancelAll();
		expect(await settled).toBeUndefined();
	});

	test("replacing a monitor cancels the old job and the new one owns the name", async () => {
		const h = nativeHarness();
		const notified: string[] = [];
		const registry = new MonitorRegistry({
			exec: (command, _cwd, signal) => {
				if (command === "new") return Promise.resolve({ code: 0, stdout: "done", stderr: "" });
				const { promise, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				return promise;
			},
			notify: s => notified.push(s.command),
		});

		const first = registry.start(spec({ name: "ci", command: "old" }), h.host);
		const oldId = h.only().id;
		const second = registry.start(spec({ name: "ci", command: "new" }), h.host);
		const newId = [...h.jobs.keys()].find(id => id !== oldId)!;
		expect(newId).not.toBe(oldId);
		expect(h.jobs.get(oldId)!.status).toBe("cancelled");
		expect(await first).toBeUndefined();
		expect(await second).toMatchObject({ outcome: "satisfied" });
		expect(notified).toEqual(["new"]);
		// The replaced run must not have cleared or overwritten the new owner's progress.
		expect(h.jobs.get(newId)!.label).toContain("satisfied");
		expect(registry.list()).toHaveLength(0);
	});

	test("cancelAll cancels every native job (session cleanup)", async () => {
		const h = nativeHarness();
		const notified: string[] = [];
		const registry = new MonitorRegistry({
			exec: (_command, _cwd, signal) => {
				const { promise, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				return promise;
			},
			notify: s => notified.push(s.name),
		});

		const first = registry.start(spec({ name: "a" }), h.host);
		const second = registry.start(spec({ name: "b" }), h.host);
		registry.cancelAll();
		expect(await first).toBeUndefined();
		expect(await second).toBeUndefined();
		expect(notified).toEqual([]);
		expect([...h.jobs.values()].every(job => job.status === "cancelled")).toBe(true);
		expect(registry.list()).toHaveLength(0);
	});

	test("a refused registration falls back to a host-less run that still settles and notifies", async () => {
		const host: MonitorJobsHost = {
			register() { throw new Error("Background job limit reached (15)."); },
			cancel: () => false,
			suppressDelivery: () => { },
			setLabel: () => { },
		};
		const notified: MonitorResult[] = [];
		const registry = new MonitorRegistry({ exec: async () => ({ code: 0, stdout: "done", stderr: "" }), notify: (_s, r) => { notified.push(r); } });
		const result = await registry.start(spec(), host);
		expect(result?.outcome).toBe("satisfied");
		expect(notified).toHaveLength(1);
		expect(registry.list()).toHaveLength(0);
	});
});
