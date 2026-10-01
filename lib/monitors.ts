/**
 * Background monitors: an agent registers a shell check, goes idle, and is woken with a
 * message when the check is satisfied, fails permanently, or times out.
 *
 * Modes:
 * - "poll": re-run `command` every `intervalSec` until it is satisfied (exit 0, or `until`
 *   matches its output).
 * - "exit": run `command` once (e.g. `gh pr checks --watch`) and report when it exits.
 */

export type MonitorMode = "poll" | "exit";

export type MonitorSpec = {
 name: string;
 command: string;
 cwd: string;
 mode: MonitorMode;
 /** Regex over stdout+stderr; poll mode is satisfied when it matches. Default: exit code 0. */
 until?: string;
 intervalSec: number;
 timeoutMin: number;
};

export type MonitorOutcome = "satisfied" | "exited" | "timed-out" | "error";

export type MonitorResult = { outcome: MonitorOutcome; runs: number; elapsedSec: number; code?: number; output: string };

export type ExecFn = (command: string, cwd: string, signal: AbortSignal, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export type MonitorDeps = {
 exec: ExecFn;
 notify: (spec: MonitorSpec, result: MonitorResult) => void;
 now?: () => number;
 sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type Running = { spec: MonitorSpec; startedAt: number; runs: number; last?: string; controller: AbortController };

const OUTPUT_TAIL = 3000;

const defaultSleep = (ms: number, signal: AbortSignal) => {
 const { promise, resolve } = Promise.withResolvers<void>();
 const timer = setTimeout(resolve, ms);
 signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
 return promise;
};

export class MonitorRegistry {
 readonly #running = new Map<string, Running>();
 readonly #deps: Required<MonitorDeps>;

 constructor(deps: MonitorDeps) {
  this.#deps = { now: Date.now, sleep: defaultSleep, ...deps };
 }

 /** Starts a monitor; a running monitor with the same name is replaced. Resolves when it settles (for tests). */
 start(spec: MonitorSpec): Promise<MonitorResult | undefined> {
  if (spec.until !== undefined) new RegExp(spec.until); // fail fast on a bad regex
  this.cancel(spec.name);
  const run: Running = { spec, startedAt: this.#deps.now(), runs: 0, controller: new AbortController() };
  this.#running.set(spec.name, run);
  return this.#loop(run);
 }

 cancel(name: string): boolean {
  const run = this.#running.get(name);
  if (!run) return false;
  run.controller.abort();
  this.#running.delete(name);
  return true;
 }

 cancelAll(): void {
  for (const name of [...this.#running.keys()]) this.cancel(name);
 }

 list(): { name: string; mode: MonitorMode; command: string; runs: number; elapsedSec: number; last?: string }[] {
  return [...this.#running.values()].map(r => ({
   name: r.spec.name,
   mode: r.spec.mode,
   command: r.spec.command,
   runs: r.runs,
   elapsedSec: Math.round((this.#deps.now() - r.startedAt) / 1000),
   last: r.last,
  }));
 }

 async #loop(run: Running): Promise<MonitorResult | undefined> {
  const { spec, controller } = run;
  const { signal } = controller;
  const deadline = run.startedAt + spec.timeoutMin * 60_000;
  const pattern = spec.until === undefined ? undefined : new RegExp(spec.until, "m");
  const elapsedSec = () => Math.round((this.#deps.now() - run.startedAt) / 1000);
  let result: MonitorResult | undefined;
  while (!signal.aborted) {
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
   await this.#deps.sleep(Math.min(spec.intervalSec * 1000, Math.max(0, deadline - this.#deps.now())), signal);
  }
  // Only the live owner of the name reports; a cancelled or replaced monitor stays silent.
  if (!result || this.#running.get(spec.name) !== run) return undefined;
  this.#running.delete(spec.name);
  this.#deps.notify(spec, result);
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
