import { expect, test } from "bun:test";
import { presentReadExcerpt } from "../lib/read-display";

test("uppercase snapshot and numbered Rust inner doc comments are dropped", () => {
	const shown = presentReadExcerpt({ text: "[src/lib.rs#A1B2]\n1://! Rendering\n2:pub fn a() {}", filenameShown: false, selector: "1-2" });
	expect(shown).toEqual({ header: "[src/lib.rs:1-2]", body: "pub fn a() {}" });
});

test("numbered TypeScript comments go before the gutter is judged, even for one line", () => {
	expect(presentReadExcerpt({ text: "[a.ts#ab12]\n5:// note", filenameShown: false }).body).toBe("");
	expect(presentReadExcerpt({ text: "[a.ts#ab12]\n5:const x = 1; // why", filenameShown: false }).body).toBe("const x = 1;");
});

test("no filename header when the surrounding row already shows it", () => {
	const shown = presentReadExcerpt({ text: "7:const x = 1;", path: "a.ts", selector: "7", filenameShown: true });
	expect(shown).toEqual({ body: "const x = 1;" });
});

test("header carries the requested selector only, never a snapshot hash", () => {
	expect(presentReadExcerpt({ text: "[a.ts#DEADBEEF]\nx", filenameShown: false }).header).toBe("[a.ts]");
	expect(presentReadExcerpt({ text: "[a.ts#DEADBEEF]\nx", path: "~/a.ts", selector: "664-687", filenameShown: false }).header).toBe("[~/a.ts:664-687]");
});

test("host display content wins over model text and the input is untouched", () => {
	const input = { text: "[a.ts#ab12]\n1:old", displayContent: { text: "1:const shown = 1;\n2:// c" }, filenameShown: false };
	const copy = structuredClone(input);
	expect(presentReadExcerpt(input)).toEqual({ header: "[a.ts]", body: "const shown = 1;" });
	expect(input).toEqual(copy);
});
