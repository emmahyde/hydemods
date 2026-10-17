import { expect, test } from "bun:test";
import { summarizeCode } from "@oh-my-pi/pi-natives";
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

const rowsOf = (code: string, lang: string) =>
	flattenDeclarations(outlineSource(code, { lang }, summarizeCode)!.declarations).map(d => `${"  ".repeat(d.depth)}${d.signature}`);

test("nested Ruby modules that only wrap a class collapse into one qualified row, freeing depth for its methods", () => {
	const code = ["module Shop", "  module Billing", "    class Invoice < Base", "      def total(lines)", "        lines.sum", "        0", "      end", "", "      def due", "        @due", "      end", "    end", "  end", "end"].join("\n");
	expect(rowsOf(code, "ruby")).toEqual(["class Shop::Billing::Invoice < Base", "  def total(lines)", "  def due"]);
});

test("a Ruby module holding anything beside its one class keeps its own row", () => {
	const code = ["module Shop", "  TIMEOUT = 5", "", "  class Invoice < Base", "    def total(lines)", "      lines.sum", "      0", "    end", "", "    def due", "      @due", "    end", "  end", "end"].join("\n");
	expect(rowsOf(code, "ruby")).toEqual(["module Shop", "  class Invoice < Base", "    def total(lines)", "    def due"]);
});

test("a TypeScript namespace wrapping one class joins its name with a dot", () => {
	const code = ["export namespace Outer {", "  export class Inner {", "    run(): void {", "      a();", "      b();", "    }", "  }", "}"].join("\n");
	expect(rowsOf(code, "typescript")[0]).toBe("export class Outer.Inner");
});
