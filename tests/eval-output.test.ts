import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { decodeEvalOutput } from "../lib/eval-output";
import { MAX_RENDER_BYTES, decodeNestedJson, formatJsonOutput, sanitizeTerminalText } from "../lib/tool-output";

function values(text: string): unknown[] {
	const records = decodeEvalOutput(text);
	expect(records.map(record => record.raw).join("")).toBe(text);
	return records.filter(record => Object.hasOwn(record, "value")).map(record => record.value);
}

test("reads inspect literals with quoted, identifier, and numeric keys and trailing commas", () => {
	const text = "{ name: 'sector', \"count\": 2, 'active': true, $value: null, _items: [false, -2.5e+3, { 0: 'zero', },], }";
	expect(values(text)).toEqual([{ name: "sector", count: 2, active: true, $value: null, _items: [false, -2500, { 0: "zero" }] }]);
	expect(values("[]\n{}\n[0,-0,1.25,1e-5,1E+3]")).toEqual([[], {}, [0, -0, 1.25, 1e-5, 1000]]);
});

test("splits consecutive line-start records and retains every prose and whitespace byte", () => {
	const text = "Starting result\r\n  { id: 1 }  \r\n\t[ { id: 2 }, { id: 3 } ]\n\nFinished.\nWall time: 0.25 seconds\nCommand exited with code 0";
	const records = decodeEvalOutput(text);
	expect(values(text)).toEqual([{ id: 1 }, [{ id: 2 }, { id: 3 }]]);
	expect(records[0]).toEqual({ raw: "Starting result\r\n" });
	expect(records.at(-1)?.raw).toContain("Finished.\nWall time: 0.25 seconds\nCommand exited with code 0");
});

test("read-tool markers remain raw without blocking a later command envelope", () => {
	const excerpt = "[lib/source.ts#ABCD]\n1:const data = {\n2:  nested: [1, 2],\n3:};\n\n[Showing lines 1-3 of 20. Use :4 to continue]\n";
	const envelope = { text: "query complete", details: { exitCode: 0, wallTimeMs: 25, requestId: "read-then-command" }, hasError: false };
	const input = excerpt + Bun.inspect(envelope, { colors: false, depth: 20 });
	expect(values(input)).toEqual([envelope]);
	expect(decodeEvalOutput(input)[0]).toEqual({ raw: excerpt });
	const formatted = formatJsonOutput(values(input)[0]);
	expect(formatted.format).toBe("command");
	for (const expected of ["query complete", "exit 0", "requestId", "read-then-command"]) expect(formatted.text).toContain(expected);
	for (const ambiguous of ["[unknown heading]", "[invalid, array]", "[Showing lines nope]", "[lib/source.ts#oops]"]) {
		const rejected = ambiguous + "\n" + Bun.inspect(envelope, { colors: false });
		expect(decodeEvalOutput(rejected)).toEqual([{ raw: rejected }]);
	}
});

test("does not extract inline braces, inline literals, or scalar console logs", () => {
	for (const text of ["log { id: 1 }", "prefix [1,2]", "{ id: 1 } trailing prose", "{ id: 1 } { id: 2 }", "true\nnull\n42\n'hello'", "display[1]: { id: 1 }"]) {
		expect(decodeEvalOutput(text)).toEqual([{ raw: text }]);
	}
});

test("reads escaped JS strings and string-only concatenation without evaluating expressions", () => {
	const text = String.raw`{ a: 'single\'quote', b: "double\"quote", slash: '\\', lines: 'one\n' + "two\r\t", hex: '\x1b\u263a\u{1F680}', controls: '\b\f\v\0', template: \`both ' and "\`, escaped: \`\${notInterpolation}\`, }`.replaceAll("\\`", "`");
	expect(values(text)).toEqual([{
		a: "single'quote", b: 'double"quote', slash: "\\", lines: "one\ntwo\r\t", hex: "\x1b☺🚀", controls: "\b\f\v\0", template: "both ' and \"", escaped: "${notInterpolation}",
	}]);
	expect(values("{ text: `line one\r\nline two` }")).toEqual([{ text: "line one\nline two" }]);
	expect(values("{ text: 'one\\\ntwo' }")).toEqual([{ text: "onetwo" }]);
});

test("reads actual Bun.inspect output and preserves nested escaped JSON and metadata", () => {
	const data = { rows: [{ name: 'both "double" and \'single\'', path: "C:\\tmp\\file", note: "line one\nline two" }], count: 1 };
	const envelope = { text: JSON.stringify(data, null, 2), details: { durationMs: 28.6, source: "tool.read", extra: { cached: false } }, label: "read result" };
	const text = Bun.inspect(envelope, { colors: false, depth: 20 });
	expect(values(text)).toEqual([envelope]);
	const decoded = decodeNestedJson(values(text)[0]) as Record<string, unknown>;
	expect(decoded.text).toEqual(data);
	expect(decoded.details).toEqual(envelope.details);
	const formatted = formatJsonOutput(decoded);
	expect(formatted.text).toContain("durationMs");
	expect(formatted.text).toContain("28.6");
	expect(formatted.text).toContain("cached");
	expect(formatted.text).toContain("read result");
});

test("reads Node inspect string concatenation and keeps command timing, exit, and extra details", () => {
	const envelope = {
		text: JSON.stringify({ files: ["a.ts", "b.ts"], count: 2 }, null, 2) + "\nWall time: 0.4 seconds\nCommand exited with code 7",
		details: { exitCode: 7, wallTimeMs: 400, timeoutSeconds: 30, stderr: "failed query", requestId: "abc" },
		hasError: true,
		operation: "query",
	};
	for (const text of [Bun.inspect(envelope, { colors: false, depth: 20 }), inspect(envelope, { colors: false, depth: 20, breakLength: 20, compact: false })]) {
		expect(values(text)).toEqual([envelope]);
		const formatted = formatJsonOutput(decodeNestedJson(values(text)[0]));
		expect(formatted.format).toBe("command");
		for (const expected of ["failed", "exit 7", "0.4 s", "timeout 30 s", "files", "a.ts", "failed query", "requestId", "abc", "operation", "query"]) expect(formatted.text).toContain(expected);
	}
});

test("unsupported and truncated inspect output stays raw, with no nested salvage", () => {
	const rejected = [
		"{ missing: undefined,\n nested: { valid: true }\n}",
		"{\n rows: [\n { safe: true }\n",
		"{ text: 'unterminated\n { safe: true }",
		"[ { good: true }, ... 5 more items ]",
		"{ data: [Object], more: [Array] }",
		"{ circular: [Circular *1] }",
		"{ key: true, key: false }",
		"{ trueish: trueValue }",
		"{ scalar: nullified }",
		"{ array: [,1] }",
		"{ number: 01 }", "{ number: +1 }", "{ number: .5 }", "{ number: 1. }", "{ number: 0xff }", "{ number: 1e309 }",
		"{ string: '\\u00xx' }", "{ string: '\\x0z' }", "{ string: '\\u{110000}' }", "{ string: '\\01' }", "{ string: '\\q' }",
		"{ string: 'a' + 1 }", "{ string: 'a' + unknown }",
		"Error: read failed\n    at run (source.ts:1:1)",
	];
	for (const text of rejected) expect(decodeEvalOutput(text)).toEqual([{ raw: text }]);
	const prefix = "{ good: true }\n";
	const tail = "{ missing: undefined,\n { nested: true }\n}\n{ later: true }";
	expect(values(prefix + tail)).toEqual([{ good: true }]);
	expect(decodeEvalOutput(prefix + tail).at(-1)?.raw).toBe("\n" + tail);
});

test("rejects executable syntax and template interpolation without side effects", () => {
	const sentinel = "__hydemodsEvalOutputExecuted";
	const globals = globalThis as unknown as Record<string, unknown>;
	delete globals[sentinel];
	const malicious = [
		`{ value: (globalThis.${sentinel} = true) }`,
		`{ value: (() => { globalThis.${sentinel} = true; return 1 })() }`,
		`{ value: \`\${globalThis.${sentinel} = true}\` }`,
		"{ value: `literal ${name}` }", "{ value: NaN }", "{ value: Infinity }", "{ value: undefined }", "{ value: 1n }",
		"{ value: function() {} }", "{ get value() { return 1; } }", "{ value: new Date() }", "{ ...other }", "{ [key]: 1 }", "{ value: /x/ }", "{ value: /* comment */ 1 }",
		`{ safe: true }; globalThis.${sentinel} = true`,
	];
	for (const text of malicious) expect(decodeEvalOutput(text)).toEqual([{ raw: text }]);
	expect(globals[sentinel]).toBeUndefined();
});

test("prototype-looking keys remain own data properties", () => {
	const value = values('{ __proto__: { polluted: true }, constructor: { prototype: { injected: true } }, toString: "data" }')[0] as Record<string, unknown>;
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	expect(Object.hasOwn(value, "__proto__")).toBe(true);
	expect(value.__proto__).toEqual({ polluted: true });
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	expect(Object.getOwnPropertyDescriptor(value, "toString")?.value).toBe("data");
});

test("enforces byte, depth, and bounded-work limits without losing the raw input", () => {
	const atCap = `{"text":"${"x".repeat(MAX_RENDER_BYTES - 11)}"}`;
	expect(Buffer.byteLength(atCap)).toBe(MAX_RENDER_BYTES);
	expect(values(atCap)).toHaveLength(1);
	for (const text of [atCap + " ", `{"text":"${"é".repeat(MAX_RENDER_BYTES / 2)}"}`, "[".repeat(10000) + "0" + "]".repeat(10000)]) {
		expect(decodeEvalOutput(text)).toEqual([{ raw: text }]);
	}
	const wide = "[" + "0,".repeat(40000) + "]";
	expect((values(wide)[0] as unknown[]).length).toBe(40000);
	const many = "{}\n".repeat(10000);
	expect(values(many)).toHaveLength(10000);
});

test("leaves raw control bytes lossless and sanitizes decoded escapes at the renderer boundary", () => {
	const raw = "Error: \x1b]52;c;ZXZpbA==\x07 failed";
	expect(decodeEvalOutput(raw)).toEqual([{ raw }]);
	const value = values(String.raw`{ text: '\x1b]52;c;ZXZpbA==\x07safe' }`)[0];
	expect(sanitizeTerminalText(formatJsonOutput(value).text)).not.toContain("\x1b]52");
});
