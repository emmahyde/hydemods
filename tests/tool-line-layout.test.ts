import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { formatToolLine } from "../lib/tool-line-layout";

const plain = (text: string) => text.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");

test("pads styled prefixes to nine cells and separates the title by two spaces", () => {
	const prefix = "\x1b[32m✔\x1b[0m READ";
	const row = formatToolLine(prefix, "Inspect settings", undefined, 60);
	expect(row).toBe(`${prefix}     Inspect settings`);
	expect(plain(row).indexOf("Inspect settings")).toBe(11);
	expect(row.endsWith(" ")).toBe(false);
	expect(formatToolLine("✔ PYTHON3", "Run script", undefined, 60)).toBe("✔ PYTHON3  Run script");
});

test("truncates long prefixes without shifting the title column", () => {
	const row = formatToolLine("✔ LONG_TOOL_NAME", "Inspect", undefined, 40);
	expect(plain(row)).toBe("✔ LONG_TO  Inspect");
	expect(plain(row).indexOf("Inspect")).toBe(11);
});

test("right aligns the subject instead of padding titles to a shared column", () => {
	const row = formatToolLine("✔ PYTHON3", "Run", "script.py", 40);
	expect(row).toBe(`✔ PYTHON3  Run${" ".repeat(17)}script.py`);
	expect(visibleWidth(row)).toBe(40);
});

test("truncates the title before reducing the subject", () => {
	const row = formatToolLine("✔ PYTHON3", "Inspect settings", "file.ts", 26);
	expect(plain(row)).toBe("✔ PYTHON3  Inspe…  file.ts");
	expect(visibleWidth(row)).toBe(26);
});

test("omits the title when only the prefix and full subject fit", () => {
	expect(formatToolLine("✔ PYTHON3", "Inspect settings", "file.ts", 18)).toBe("✔ PYTHON3  file.ts");
	expect(formatToolLine("✔ PYTHON3", "Inspect settings", "file.ts", 20)).toBe("✔ PYTHON3    file.ts");
});

test("truncates the subject only after the title has been removed", () => {
	const row = formatToolLine("✔ PYTHON3", "Inspect settings", "file.ts", 15);
	expect(plain(row)).toBe("✔ PYTHON3  fil…");
	expect(visibleWidth(row)).toBe(15);
});

test("preserves complete OSC hyperlinks while right aligning their visible text", () => {
	for (const end of ["\x07", "\x1b\\"]) {
		const open = `\x1b]8;;file:///tmp/file.ts${end}`;
		const close = `\x1b]8;;${end}`;
		const subject = `${open}file.ts${close}`;
		const row = formatToolLine("✔ READ", "Inspect", subject, 36);
		expect(row.endsWith(subject)).toBe(true);
		expect(plain(row)).toBe(`✔ READ     Inspect${" ".repeat(11)}file.ts`);
		expect(visibleWidth(row)).toBe(36);

		const narrow = formatToolLine("✔ READ", "Inspect", subject, 15);
		expect(narrow).toContain(open);
		expect(narrow).toContain(close);
		expect(plain(narrow)).toBe("✔ READ     fil…");
		expect(visibleWidth(narrow)).toBe(15);
	}
});

test("handles wide characters by display cells rather than string length", () => {
	const row = formatToolLine("✔ 読取", "調査中", "資料.ts", 24);
	expect(visibleWidth(row)).toBe(24);
	expect(visibleWidth(row.slice(0, row.indexOf("調")))).toBe(11);
	expect(row.endsWith("  資料.ts")).toBe(true);
});

test("narrow widths never overflow or leave trailing padding", () => {
	for (let width = 0; width <= 40; width++) {
		for (const subject of [undefined, "file.ts", "資料.ts"]) {
			const row = formatToolLine("\x1b[32m✔\x1b[0m PYTHON3", "Inspect settings", subject, width);
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(row.endsWith(" ")).toBe(false);
		}
	}
	expect(formatToolLine("✔ PYTHON3", "Inspect", "file.ts", 0)).toBe("");
	expect(formatToolLine("✔ PYTHON3", "Inspect", "file.ts", 9)).toBe("✔ PYTHON3");
	expect(formatToolLine("✔ PYTHON3", "Inspect", "file.ts", 11)).toBe("✔ PYTHON3");
	expect(formatToolLine("✔ PYTHON3", "Inspect", "file.ts", 12)).toBe("✔ PYTHON3  …");
	expect(formatToolLine("✔ PYTHON3", "Inspect", undefined, 12)).toBe("✔ PYTHON3  …");
});

test("absent subjects and empty titles do not add trailing spaces", () => {
	expect(formatToolLine("✔ READ", "Inspect", "", 40)).toBe("✔ READ     Inspect");
	expect(formatToolLine("✔ READ", "", undefined, 40)).toBe("✔ READ");
	expect(formatToolLine("✔ READ", "", "file.ts", 24)).toBe(`✔ READ${" ".repeat(11)}file.ts`);
});
