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
 * - "exit": run `command` once (e.g. `gh pr checks --watch`) and report only when it exits.
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

export type MonitorDeps = {
 exec: ExecFn;
 notify: (spec: MonitorSpec, result: MonitorResult) => void;
 /** Stream mode: a batch of new stdout lines. */
 emit: (spec: MonitorSpec, lines: string[]) => void;
 stream?: StreamFn;
 /** Stream mode: lines arriving within this window are delivered as one event. */
 batchMs?: number;
 now?: () => number;
 sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type Running = { spec: MonitorSpec; startedAt: number; runs: number; events: number; last?: string; controller: AbortController };

const OUTPUT_TAIL = 3000;
const MAX_EVENT_LINES = 20;
const MAX_LINE_CHARS = 500;

const tail = (text: string) => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text);

const defaultSleep = (ms: number, signal: AbortSignal) => {
 const { promise, resolve } = Promise.withResolvers<void>();
 const timer = setTimeout(resolve, ms);
 signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
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

export class MonitorRegistry {
 readonly #running = new Map<string, Running>();
 readonly #deps: Required<MonitorDeps>;

 constructor(deps: MonitorDeps) {
  this.#deps = { now: Date.now, sleep: defaultSleep, stream: spawnStream, batchMs: 300, ...deps };
 }

 /** Starts a monitor; a running monitor with the same name is replaced. Resolves when it settles (for tests). */
 start(spec: MonitorSpec): Promise<MonitorResult | undefined> {
  if (spec.until !== undefined) new RegExp(spec.until); // fail fast on a bad regex
  this.cancel(spec.name);
  const run: Running = { spec, startedAt: this.#deps.now(), runs: 0, events: 0, controller: new AbortController() };
  this.#running.set(spec.name, run);
  return spec.mode === "stream" ? this.#stream(run) : this.#loop(run);
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

 list(): { name: string; mode: MonitorMode; command: string; runs: number; events: number; elapsedSec: number; last?: string }[] {
  return [...this.#running.values()].map(r => ({
   name: r.spec.name,
   mode: r.spec.mode,
   command: r.spec.command,
   runs: r.runs,
   events: r.events,
   elapsedSec: Math.round((this.#deps.now() - r.startedAt) / 1000),
   last: r.last,
  }));
 }

 async #stream(run: Running): Promise<MonitorResult | undefined> {
  const { spec, controller } = run;
  const elapsedSec = () => Math.round((this.#deps.now() - run.startedAt) / 1000);
  const owned = () => this.#running.get(spec.name) === run;
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
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, spec.timeoutMin * 60_000);
  let result: MonitorResult;
  try {
   const { code, stderr } = await this.#deps.stream(spec.command, spec.cwd, controller.signal, onLine);
   run.runs = 1;
   flush();
   const text = tail([output, stderr.trim()].filter(Boolean).join("\n"));
   result = { outcome: timedOut ? "timed-out" : "exited", runs: 1, elapsedSec: elapsedSec(), code: timedOut ? undefined : code, output: text, events: run.events };
  } catch (error) {
   flush();
   result = { outcome: "error", runs: 1, elapsedSec: elapsedSec(), output: error instanceof Error ? error.message : String(error), events: run.events };
  } finally {
   clearTimeout(deadline);
  }
  // A timeout aborts our own signal but keeps ownership; a cancel or replacement removes it.
  if (!owned()) return undefined;
  this.#running.delete(spec.name);
  this.#deps.notify(spec, result);
  return result;
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

export function formatMonitorEvent(spec: MonitorSpec, lines: string[]): string {
 return `Monitor event (${spec.name}): ${lines.join("\n")}\nThe monitor is still running; react if this matters, otherwise end your turn. Do not poll.`;
}
