import { expect, test } from "bun:test";
import { flattenDeclarations, outlineSource, type Summarize } from "../lib/code-outline";

// A summarizer that elides line 2 of a three-line block, as the host does for a body.
const elideSecondLine: Summarize = ({ code }) => ({
	parsed: true,
	language: "typescript",
	totalLines: code.split("\n").length,
	segments: code.split("\n").length === 3
		? [{ kind: "kept", startLine: 1, endLine: 1 }, { kind: "elided", startLine: 2, endLine: 2 }, { kind: "kept", startLine: 3, endLine: 3 }]
		: [{ kind: "kept", startLine: 1, endLine: 5 }],
});

test("a test call outlines as its title alone", () => {
	const code = 'test("joins rows (tight), then folds", () => {\n\texpect(1).toBe(1);\n});';
	const outline = outlineSource(code, { lang: "typescript" }, elideSecondLine);
	expect(flattenDeclarations(outline!.declarations).map(d => d.signature)).toEqual(['test("joins rows (tight), then folds")']);
});

test("a multi-line test call keeps only the title", () => {
	const code = 'describe("group",\n  () => {\n  x();\n});';
	const summarize: Summarize = ({ code: c }) => ({
		parsed: true,
		language: "typescript",
		totalLines: c.split("\n").length,
		segments: [{ kind: "kept", startLine: 1, endLine: 2 }, { kind: "elided", startLine: 3, endLine: 3 }, { kind: "kept", startLine: 4, endLine: 4 }],
	});
	const outline = outlineSource(code, { lang: "typescript" }, summarize);
	expect(flattenDeclarations(outline!.declarations).map(d => d.signature)).toEqual(['describe("group")']);
});
