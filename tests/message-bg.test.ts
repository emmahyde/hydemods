import { describe, expect, test } from "bun:test";
import { installMessageBackgrounds, paintRows, resolveBackground, type ThemeLookups } from "../lib/message-bg";

const RESET = "\x1b[49m";

describe("resolveBackground", () => {
	test("hex override wins over preset and is lowercased", () => {
		expect(resolveBackground("blue", "#ABCDEF", false)).toBe("#abcdef");
	});
	test("preset picks the tint matching theme lightness; off and unknown keep the theme color", () => {
		expect(resolveBackground("slate", "", false)).toBe("#1f252d");
		expect(resolveBackground("slate", "", true)).toBe("#e8ecf1");
		expect(resolveBackground("off", "", false)).toBeUndefined();
		expect(resolveBackground("nope", "not-a-hex", false)).toBeUndefined();
	});
});

describe("paintRows", () => {
	const ansi = "\x1b[48;2;1;2;3m";
	test("fills interior rows to width and leaves leading and trailing blanks alone", () => {
		const rows = paintRows(["", "ab", "", "cd", ""], 4, ansi);
		expect(rows[0]).toBe("");
		expect(rows[4]).toBe("");
		expect(rows[1]).toBe(`${ansi}ab  ${RESET}`);
		expect(rows[2]).toBe(`${ansi}    ${RESET}`);
	});
	test("resumes the background after nested resets", () => {
		const [row] = paintRows(["a\x1b[0mb"], 2, ansi);
		expect(row).toBe(`${ansi}a\x1b[0m${ansi}b${RESET}`);
	});
	test("all-blank input is returned unchanged", () => {
		const rows = ["", "  "];
		expect(paintRows(rows, 5, ansi)).toBe(rows);
	});
});

function fakes() {
	const theme: ThemeLookups = {
		getBgHex: () => "#101010",
		getBgAnsi: (color) => `orig:${color}`,
		getColorMode: () => "truecolor",
		bg: (color, text) => `[${color}]${text}`,
		bgFill: (color, text) => `[fill ${color}]${text}`,
	};
	const assistant = { render: (_width: number) => ["hi"], renderTranscriptStableRows: (_count: number, _width: number) => ["hi"] };
	return { theme, assistant };
}

describe("installMessageBackgrounds", () => {
	test("overrides user and tool backgrounds, spares error and unrelated keys, and paints the response", () => {
		const { theme, assistant } = fakes();
		installMessageBackgrounds(theme, assistant, {
			hexFor: (surface) => (surface === "assistant" ? "#000010" : surface === "user" ? "#000001" : undefined),
			liveTheme: () => theme,
		});
		expect(theme.bg("userMessageBg", "x")).toBe("\x1b[48;2;0;0;1mx\x1b[49m");
		expect(theme.getBgHex("userMessageBg")).toBe("#000001");
		expect(theme.bg("toolSuccessBg", "x")).toBe("[toolSuccessBg]x");
		expect(theme.bg("toolErrorBg", "x")).toBe("[toolErrorBg]x");
		expect(assistant.render(4)[0]).toBe("\x1b[48;2;0;0;16mhi  \x1b[49m");
		expect(assistant.renderTranscriptStableRows(1, 4)[0]).toBe("\x1b[48;2;0;0;16mhi  \x1b[49m");
	});

	test("tool tint covers pending and success and passes the light-theme flag", () => {
		const { theme, assistant } = fakes();
		const seen: boolean[] = [];
		installMessageBackgrounds(theme, assistant, {
			hexFor: (surface, light) => {
				seen.push(light);
				return surface === "tool" ? "#000002" : undefined;
			},
			liveTheme: () => theme,
		});
		expect(theme.bg("toolPendingBg", "x")).toBe("\x1b[48;2;0;0;2mx\x1b[49m");
		expect(theme.getBgAnsi("toolSuccessBg")).toBe("\x1b[48;2;0;0;2m");
		expect(seen.every((light) => light === false)).toBe(true);
	});

	test("reinstall does not stack wrappers and uninstall restores the originals", () => {
		const { theme, assistant } = fakes();
		const originalBg = theme.bg;
		const options = { hexFor: () => "#000003", liveTheme: () => theme };
		installMessageBackgrounds(theme, assistant, options);
		const uninstall = installMessageBackgrounds(theme, assistant, options);
		expect(assistant.render(2)[0]).toBe("\x1b[48;2;0;0;3mhi\x1b[49m");
		uninstall();
		expect(theme.bg).toBe(originalBg);
		expect(assistant.render(2)).toEqual(["hi"]);
	});
});
