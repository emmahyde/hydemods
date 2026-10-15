import { MAX_RENDER_BYTES } from "./tool-output";

const MAX_DEPTH = 64;
const MAX_WORK = MAX_RENDER_BYTES * 8;
const INVALID_LITERAL = Symbol("invalid inspected literal");
const KEYWORD_VALUES = [["true", true], ["false", false], ["null", null]] as const;
const STRING_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };

type EvalOutput = { raw: string; value?: unknown };

/** A literal reader, not a JavaScript interpreter. Every cursor advance spends work. */
class InspectReader {
	position: number;
	private work = MAX_WORK;

	constructor(private readonly text: string, start: number) {
		this.position = start;
	}

	private advance(): string {
		if (--this.work < 0 || this.position >= this.text.length) throw INVALID_LITERAL;
		return this.text[this.position++];
	}

	space(): void {
		while (/\s/.test(this.text[this.position] ?? "") && this.position < this.text.length) this.advance();
	}

	value(depth = 0): unknown {
		if (--this.work < 0 || depth > MAX_DEPTH) throw INVALID_LITERAL;
		this.space();
		const character = this.text[this.position];
		if (character === "{") return this.object(depth + 1);
		if (character === "[") return this.array(depth + 1);
		if (character === '"' || character === "'" || character === "`") {
			const parts = [this.string()];
			this.space();
			while (this.text[this.position] === "+") {
				this.advance();
				this.space();
				parts.push(this.string());
				this.space();
			}
			return parts.length === 1 ? parts[0] : parts.join("");
		}
		for (const [literal, value] of KEYWORD_VALUES) {
			if (this.text.startsWith(literal, this.position)) {
				for (let index = 0; index < literal.length; index++) this.advance();
				return value;
			}
		}
		if (character === "-" || (character >= "0" && character <= "9")) return this.number();
		throw INVALID_LITERAL;
	}

	private number(): number {
		const start = this.position;
		while (/[0-9eE+.\-]/.test(this.text[this.position] ?? "")) this.advance();
		const literal = this.text.slice(start, this.position);
		if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(literal)) throw INVALID_LITERAL;
		const number = Number(literal);
		if (!Number.isFinite(number)) throw INVALID_LITERAL;
		return number;
	}

	private object(depth: number): Record<string, unknown> {
		this.advance();
		const result: Record<string, unknown> = {};
		this.space();
		while (this.text[this.position] !== "}") {
			const character = this.text[this.position];
			let key: string;
			if (character === '"' || character === "'" || character === "`") key = this.string();
			else {
				const start = this.position;
				while (/[$\w]/.test(this.text[this.position] ?? "")) this.advance();
				key = this.text.slice(start, this.position);
				if (!/^(?:[$A-Za-z_][$\w]*|0|[1-9]\d*)$/.test(key)) throw INVALID_LITERAL;
			}
			this.space();
			if (this.advance() !== ":" || Object.hasOwn(result, key)) throw INVALID_LITERAL;
			const value = this.value(depth);
			// Assignment to __proto__ must create data, never change the prototype.
			Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
			this.space();
			if (this.text[this.position] === "}") break;
			if (this.advance() !== ",") throw INVALID_LITERAL;
			this.space();
		}
		this.advance();
		return result;
	}

	private array(depth: number): unknown[] {
		this.advance();
		const result: unknown[] = [];
		this.space();
		while (this.text[this.position] !== "]") {
			result.push(this.value(depth));
			this.space();
			if (this.text[this.position] === "]") break;
			if (this.advance() !== ",") throw INVALID_LITERAL;
			this.space();
		}
		this.advance();
		return result;
	}

	private hex(length: number): number {
		const start = this.position;
		for (let index = 0; index < length; index++) {
			if (!/[\da-fA-F]/.test(this.advance())) throw INVALID_LITERAL;
		}
		return Number.parseInt(this.text.slice(start, this.position), 16);
	}

	private string(): string {
		const quote = this.advance();
		if (quote !== '"' && quote !== "'" && quote !== "`") throw INVALID_LITERAL;
		const parts: string[] = [];
		let start = this.position;
		while (this.position < this.text.length) {
			const character = this.advance();
			if (character === quote) {
				parts.push(this.text.slice(start, this.position - 1));
				return parts.join("");
			}
			if (quote === "`" && character === "$" && this.text[this.position] === "{") throw INVALID_LITERAL;
			if (character !== "\\") {
				if (character.charCodeAt(0) < 32 && !(quote === "`" && /[\n\r\t]/.test(character))) throw INVALID_LITERAL;
				if (quote === "`" && character === "\r") {
					parts.push(this.text.slice(start, this.position - 1), "\n");
					if (this.text[this.position] === "\n") this.advance();
					start = this.position;
				}
				continue;
			}
			parts.push(this.text.slice(start, this.position - 1));
			const escape = this.advance();
			if (Object.hasOwn(STRING_ESCAPES, escape)) {
				if (escape === "0" && /\d/.test(this.text[this.position] ?? "")) throw INVALID_LITERAL;
				parts.push(STRING_ESCAPES[escape]);
			} else if (escape === "\\" || escape === '"' || escape === "'" || escape === "`" || escape === "/" || (escape === "$" && quote === "`")) parts.push(escape);
			else if (escape === "x") parts.push(String.fromCharCode(this.hex(2)));
			else if (escape === "u") {
				if (this.text[this.position] !== "{") parts.push(String.fromCharCode(this.hex(4)));
				else {
					this.advance();
					const hexStart = this.position;
					while (/[\da-fA-F]/.test(this.text[this.position] ?? "")) this.advance();
					const digits = this.position - hexStart;
					const codePoint = Number.parseInt(this.text.slice(hexStart, this.position), 16);
					if (digits < 1 || digits > 6 || codePoint > 0x10ffff || this.advance() !== "}") throw INVALID_LITERAL;
					parts.push(String.fromCodePoint(codePoint));
				}
			} else if (escape === "\r" || escape === "\n") {
				if (escape === "\r" && this.text[this.position] === "\n") this.advance();
			} else throw INVALID_LITERAL;
			start = this.position;
		}
		throw INVALID_LITERAL;
	}
}

/**
 * Decode complete line-start inspect records without executing code or unwrapping metadata.
 * Raw slices always reconstruct the input. A rejected record makes the remaining text
 * ambiguous: keep that tail intact instead of mistaking its nested values for new records.
 * Terminal sanitization belongs to the renderer, not this lossless decoder.
 */
export function decodeEvalOutput(text: string): EvalOutput[] {
	if (text.length > MAX_RENDER_BYTES || Buffer.byteLength(text, "utf8") > MAX_RENDER_BYTES) return [{ raw: text }];
	const output: EvalOutput[] = [];
	let rawStart = 0;
	let lineStart = 0;
	while (lineStart < text.length) {
		let start = lineStart;
		while (text[start] === " " || text[start] === "\t") start++;
		// These read-tool markers are prose, not rejected array literals.
		if (text[start] === "[") {
			const lineEnd = text.indexOf("\n", start);
			const line = text.slice(start, lineEnd < 0 ? text.length : lineEnd);
			if (/^\[[^\]\[\r\n"'`{},]+#[\da-f]+\][ \t]*\r?$/i.test(line) ||
				/^\[Showing lines \d+(?:-\d+)? of \d+[^\]\r\n]*\][ \t]*\r?$/.test(line)) {
				if (lineEnd < 0) break;
				lineStart = lineEnd + 1;
				continue;
			}
		}
		if (text[start] === "{" || text[start] === "[") {
			const reader = new InspectReader(text, start);
			let value: unknown;
			try {
				value = reader.value();
			} catch {
				break;
			}
			let end = reader.position;
			// A literal followed by code or inline prose is not a complete inspected record.
			while (text[end] === " " || text[end] === "\t") end++;
			if (end < text.length && text[end] !== "\n" && text[end] !== "\r") break;
			if (lineStart > rawStart) output.push({ raw: text.slice(rawStart, lineStart) });
			output.push({ raw: text.slice(lineStart, reader.position), value });
			rawStart = reader.position;
			lineStart = reader.position;
		}
		const nextLine = text.indexOf("\n", lineStart);
		if (nextLine < 0) break;
		lineStart = nextLine + 1;
	}
	if (rawStart < text.length || output.length === 0) output.push({ raw: text.slice(rawStart) });
	return output;
}
