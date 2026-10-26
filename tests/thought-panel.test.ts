import { expect, test } from "bun:test";
import { thoughtPanelRows } from "../lib/thought-panel";

const plain = { header: (text: string) => text, line: (text: string) => text };

test("collapsed thinking shows its first and last sentences, omitting the middle", () => {
 const rows = thoughtPanelRows("Inspect the input. Discard this middle detail. Keep the result.", false, 80, plain);
 expect(rows.slice(1)).toEqual(["  Inspect the input. ... Keep the result.", "", ""]);
});

test("a single sentence is not duplicated and an unfinished streaming tail is kept", () => {
 expect(thoughtPanelRows("One sentence.", false, 80, plain).slice(1)).toEqual(["  One sentence.", "", ""]);
 expect(thoughtPanelRows("First sentence. Middle sentence. Still deciding", false, 80, plain).slice(1)).toEqual(["  First sentence. ... Still deciding", "", ""]);
});

test("overflow ends with three dots and stays within three content lines", () => {
 const rows = thoughtPanelRows("First sentence. Middle. " + "Long final sentence ".repeat(30), false, 30, plain);
 expect(rows).toHaveLength(4);
 expect(rows[3]!.endsWith("...")).toBe(true);
 expect(rows.every(row => Bun.stringWidth(row) <= 30)).toBe(true);
});

test("expansion preserves original thinking and collapse restores the excerpt", () => {
 const raw = "First sentence.\nHidden middle sentence.\nLast sentence.";
 expect(thoughtPanelRows(raw, false, 80, plain, true).slice(1)).toEqual(raw.split("\n").map(line => `  ${line}`));
 expect(thoughtPanelRows(raw, false, 80, plain).slice(1)).toEqual(["  First sentence. ... Last sentence.", "", ""]);
});

test("empty thoughts preserve the fixed height and narrow panes do not overflow", () => {
 expect(thoughtPanelRows("", false, 40, plain)).toEqual(["✻ no thought yet", "", "", ""]);
 for (const width of [1, 2, 3, 4, 8]) {
  expect(thoughtPanelRows("First sentence. More detail. Last sentence.", true, width, plain).every(row => Bun.stringWidth(row) <= width)).toBe(true);
 }
});
