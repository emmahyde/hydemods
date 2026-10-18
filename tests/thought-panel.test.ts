import { expect, test } from "bun:test";
import { ThoughtPanelLines, thoughtPanelRows } from "../lib/thought-panel";

const plain = { header: (text: string) => text, line: (text: string) => text };
const rows = (text: string, stale = false, width = 40) => thoughtPanelRows(text, stale, width, plain);

test("the panel keeps one height for no thought, a short thought, and a long one", () => {
 const long = Array.from({ length: 30 }, (_, n) => `step ${n}`).join("\n");
 for (const text of ["", "one line", long]) expect(rows(text)).toHaveLength(ThoughtPanelLines + 1);
});

test("a long thought rolls: the window shows its last lines and counts the rest", () => {
 const long = Array.from({ length: 30 }, (_, n) => `step ${n}`).join("\n");
 const shown = rows(long);
 expect(shown[0]).toBe("✻ thinking · 22 earlier lines");
 expect(shown.at(-1)).toBe("  step 29");
 expect(shown[1]).toBe("  step 22");
});

test("a short thought sits at the top and blank rows fill the rest", () => {
 expect(rows("first\nsecond")).toEqual(["✻ thinking", "  first", "  second", ...Array(ThoughtPanelLines - 2).fill("")]);
});

test("the header says when the thought is from the last turn or missing", () => {
 expect(rows("old idea", true)[0]).toBe("✻ last thought");
 expect(rows("", true)[0]).toBe("✻ no thought yet");
});

test("wrapped lines count against the window, so a narrow pane keeps the same height", () => {
 const wide = "word ".repeat(60).trim();
 const shown = rows(wide, false, 20);
 expect(shown).toHaveLength(ThoughtPanelLines + 1);
 expect(shown[0]).toMatch(/earlier lines$/);
});
