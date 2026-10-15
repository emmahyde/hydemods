import { expect, test } from "bun:test";
import { testSummaryLine } from "../lib/test-summary";

const theme = { fg: (color: string, text: string) => `<${color}:${text}>` };
const plain = (line: string | undefined) => line?.replace(/<[a-z]+:|>/g, "").replace(/\x1b\[[0-9;]*m/g, "");

const BUN_OK = "bun test v1.3.14 (0d9b296a)\n\n 107 pass\n 0 fail\n 293 expect() calls\nRan 107 tests across 13 files. [341.00ms]\n";

test("a green bun run is one row with pass count, files and time", () => {
	const line = testSummaryLine(BUN_OK, theme);
	expect(plain(line)).toBe("✓ 107 pass · 0 fail · 293 expects · 13 files · 341.00ms");
	expect(line).toContain("\x1b[38;2;156;219;117m✓ 107 pass\x1b[39m");
});

test("a bun run with failures is left for the native card so the failures stay visible", () => {
	expect(testSummaryLine(BUN_OK.replace(" 0 fail", " 2 fail"), theme)).toBeUndefined();
});

test("cargo suites are summed, ignored tests are called out", () => {
	const out = "test result: ok. 1000 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 1.2s\n\ntest result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s\n";
	expect(plain(testSummaryLine(out, theme))).toBe("✓ 1010 passed · 0 failed · 2 ignored · 2 suites");
	expect(testSummaryLine(out.replace("0 failed; 2", "1 failed; 2"), theme)).toBeUndefined();
});

test("output that is not a test run is not summarised", () => {
	expect(testSummaryLine("hello\n107 pass maybe", theme)).toBeUndefined();
});
