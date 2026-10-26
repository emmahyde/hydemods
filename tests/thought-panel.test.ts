import { afterEach, expect, test, vi } from "bun:test";
import { ThoughtSummary, thoughtPanelRows } from "../lib/thought-panel";

const plain = { header: (text: string) => text, line: (text: string) => text };
afterEach(() => vi.useRealTimers());

test("collapsed drawer reserves three content rows and shows the summary, not raw thinking", () => {
 for (const text of ["", "short", "raw thought\n".repeat(30)]) {
  const rows = thoughtPanelRows(text, false, 40, plain, false, "The decision is to preserve height.");
  expect(rows).toHaveLength(4);
  expect(rows.slice(1)).toEqual(["  The decision is to preserve height.", "", ""]);
 }
});

test("expansion reveals every original line and collapse restores the summary", () => {
 const raw = Array.from({ length: 30 }, (_, n) => `step ${n}`).join("\n");
 const expanded = thoughtPanelRows(raw, false, 40, plain, true, "Brief summary");
 expect(expanded.slice(1)).toEqual(raw.split("\n").map(line => `  ${line}`));
 expect(thoughtPanelRows(raw, false, 40, plain, false, "Brief summary").slice(1)).toEqual(["  Brief summary", "", ""]);
});

test("narrow panes keep summary and header inside the width budget", () => {
 const rows = thoughtPanelRows("raw", true, 12, plain, false, "A long summary that must wrap across many rows without growing the drawer");
 expect(rows).toHaveLength(4);
 expect(rows.every(row => Bun.stringWidth(row) <= 12)).toBe(true);
});

test("a previous session's delayed summary cannot replace the current thought", async () => {
 vi.useFakeTimers();
 const { promise, resolve: finish } = Promise.withResolvers<string>();
 const summary = new ThoughtSummary(async () => promise, () => {});
 summary.update("old thought");
 vi.advanceTimersByTime(800);
 summary.clear();
 finish("obsolete summary");
 await Promise.resolve();
 expect(summary.summary).toBe("");
 summary.clear();
});

test("streamed updates coalesce and refresh to the newest thought after an active request", async () => {
 vi.useFakeTimers();
 const first = Promise.withResolvers<string>();
 const snapshots: string[] = [];
 const summary = new ThoughtSummary(async (_system, prompt) => {
  snapshots.push(JSON.parse(prompt).thought);
  return snapshots.length === 1 ? first.promise : "The latest decision";
 }, () => {});
 summary.update("A");
 vi.advanceTimersByTime(800);
 summary.update("AB");
 summary.update("ABC");
 expect(snapshots).toEqual(["A"]);
 first.resolve("An earlier decision");
 for (let i = 0; i < 6; i++) await Promise.resolve();
 vi.advanceTimersByTime(800);
 for (let i = 0; i < 6; i++) await Promise.resolve();
 expect(snapshots).toEqual(["A", "ABC"]);
 expect(summary.summary).toBe("The latest decision");
 summary.clear();
});
