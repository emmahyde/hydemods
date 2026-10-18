import { expect, test } from "bun:test";
import { cardGutter, rowSuffix } from "../lib/card-gutter";

const base = { rule: "│", trailingRule: "┆", indentWidth: 5, isFirst: false, isLast: true };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("rows before the last keep their prefix", () => {
	expect(cardGutter({ ...base, prefix: "     │ ", isLast: false, hiddenText: "1.2k" })).toBe("     │ ");
});

test("the last row of a multi-row card trails off", () => {
	expect(cardGutter({ ...base, prefix: "     │ " })).toBe("     ┆ ");
});

test("a single-row card also ends on the dashed rule and keeps its name", () => {
	expect(cardGutter({ ...base, prefix: "read │ ", isFirst: true })).toBe("read ┆ ");
});

test("hidden rows put the grey size in the last row's name column", () => {
	const gutter = cardGutter({ ...base, prefix: "     │ ", hiddenText: "1.2k" });
	expect(plain(gutter)).toBe("1.2k ┆ ");
	expect(gutter).toContain("\x1b[38;2;138;140;146m");
	expect(gutter).not.toContain("\x1b[3m");
});

test("a one-row card with hidden output appends the size instead of dropping its name", () => {
	const gutter = cardGutter({ ...base, prefix: "read │ ", isFirst: true, hiddenText: "842" });
	expect(gutter).toBe("read ┆ ");
	expect(plain(rowSuffix(true, true, "842"))).toBe(" 842");
	expect(rowSuffix(true, false, "842")).toBe("");
	expect(rowSuffix(true, true, undefined)).toBe("");
});
