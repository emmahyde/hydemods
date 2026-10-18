import { expect, test } from "bun:test";
import { plainBlockRows, stylePlainBlocks } from "../lib/plain-blocks";

const fence = (text: string) => `\x1b[38;2;119;125;136m${text}\x1b[39m`;
const width = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "").length;
const TINT = "\x1b[48;2;31;37;45m";

test("only the body of an untagged fence is picked out; tagged blocks and prose are not", () => {
	const rows = ["prose", fence("```"), "  $> bash │ a", "  more", fence("```"), "between", fence("```ts"), "  const a = 1;", fence("```"), "after"];
	expect(plainBlockRows(rows)).toEqual([false, false, true, true, false, false, false, false, false, false]);
});

test("a fence inside a tagged block's text does not open a plain block", () => {
	const rows = [fence("```text"), "  ```", "  inner", fence("```"), "tail"];
	expect(plainBlockRows(rows)).toEqual([false, false, false, false, false]);
});

test("a block still streaming (no closing fence yet) is styled to the end", () => {
	expect(plainBlockRows([fence("```"), "  a", "  b"])).toEqual([false, true, true]);
});

test("body rows get a bar, the tint to full width and the tint after inner resets", () => {
	const rows = [fence("```"), "  \x1b[31mred\x1b[39m text \x1b[0mend", fence("```")];
	const styled = stylePlainBlocks(rows, 30, TINT, width);
	expect(styled[0]).toBe(rows[0]);
	expect(styled[2]).toBe(rows[2]);
	expect(styled[1]).toStartWith(`${TINT}\x1b[38;2;156;219;117m▎`);
	expect(styled[1]).toContain(`\x1b[0m${TINT}end`);
	expect(width(styled[1]!)).toBe(30);
	expect(styled[1]!.endsWith("\x1b[49m")).toBe(true);
});

test("rows without untagged blocks come back untouched", () => {
	const rows = ["a", fence("```ts"), "  x", fence("```")];
	expect(stylePlainBlocks(rows, 20, TINT, width)).toBe(rows);
});

test("an unindented body row gets the bar in front instead of losing text", () => {
	const styled = stylePlainBlocks([fence("```"), "First", fence("```")], 20, TINT, width);
	expect(styled[1]).toBe(`${TINT}\x1b[38;2;156;219;117m▎\x1b[39m First${" ".repeat(13)}\x1b[49m`);
});
