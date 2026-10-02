import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "@oh-my-pi/pi-coding-agent";
import { Box, Ellipsis, formatMetricRow, Markdown, type MetricSpec, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
// Only host-mapped specifiers share the running instance; a deeper pi-tui path would patch a private copy.
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { summarizeCode } from "@oh-my-pi/pi-natives";
import type { Usage } from "@oh-my-pi/pi-ai";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { theme as uiTheme } from "@oh-my-pi/pi-tui/theme";
import { fileHyperlink } from "@oh-my-pi/pi-tui/render";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import type { ToolRenderer } from "@oh-my-pi/pi-tui/tools";
import { readSourceFsPath, renderFallbackToolCard, splitPathAndSel } from "./lib/host-copies";
import { outlineSource, recoverOldText, renderEditOutline, renderOutline, renderRange, type Outline } from "./lib/code-outline";
import { referenceLocations } from "./lib/reference-output";
// Keep helper modules below lib/: configured extension roots scan direct .ts files.
import { setHostAutoTitle, shouldGenerateTitle } from "./lib/session-title";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { isSettingsInitialized, settings as hostSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgReadToolResultPreview } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cappedRenderPayload, collapseTextLines, decodeNestedJson, formatJsonOutput, formatFileExcerpt, isFileExcerpt, formatSearchOutput, formatCommandText, formatJsonWithFooter, markdownOutput, parseGrepOutput, parseYamlDocument, sanitizeTerminalText } from "./lib/tool-output";
import { underlineLabel, underlinePathTokens } from "./lib/path-styling";
import { booleanSetting, integerSetting, readSetting, settings, watchSetting } from "./lib/settings";
import { refreshMyPrs, withPrDrawer, withVaultDrawer, type EditorProvider } from "./lib/url-drawers";
import type { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { execFile } from "node:child_process";
import { detectStalls, defaultStallThresholds, type StallAlert } from "./lib/stall-watch";
import { formatMonitorResult, MonitorRegistry, type MonitorResult, type MonitorSpec } from "./lib/monitors";

type MonitorMessageDetails = { spec: MonitorSpec; result: MonitorResult };
const MONITOR_COLLAPSED_LINES = 8;
import { runawayEdit } from "./lib/runaway-edit";

type StallMessageDetails = Pick<StallAlert, "agentName" | "kind" | "idleMinutes" | "action" | "toolName" | "model">;
// Subagents never outlive the OMP process, so transcripts untouched since load are dead, not stalled.
const WATCH_STARTED_AT = Date.now();

type TweakCategory = "Interface";

type TweakDef = {
	name: string;
	title: string;
	description: string;
	category: TweakCategory;
	render: () => string;
};

type Tweak = TweakDef & { setting: Setting<boolean> };

/**
 * Add future tweaks here. Each entry owns its label, grouping, and display copy; its on/off state
 * is a persisted OMP setting, `hydemods.<camelName>`, created from the entry.
 */
const TWEAK_DEFS: TweakDef[] = [
	{
		name: "integrated-tool-expansion",
		title: "Integrated tool cards",
		description: "Draws structured tool results inside OMP's own tool card.",
		category: "Interface",
		render: () => "Ctrl+O expands, Cmd+Opt+O toggles hydemods rendering for the session. Collapsed height: /hydemods collapsed-lines N or +/- here.",
	},
	{
		name: "tool-results-toon",
		title: "TOON for the model",
		description: "Hands JSON and MCP tool results to the model as TOON, a compact table-like text form.",
		category: "Interface",
		render: () => "TOON (Token-Oriented Object Notation) writes uniform arrays as one header row plus one row per item, so the same data costs far fewer tokens than JSON. Unpacks native JSON, eval outputs, and MCP fenced ```json blocks automatically; you still see OMP's JSON tree.",
	},
	{
		name: "last-prompt-drawer",
		title: "Last prompt drawer",
		description: "Shows a truncated preview of your latest prompt above the editor.",
		category: "Interface",
		render: () => "Automatic; no controls. The preview truncates to the terminal width.",
	},
	{
		name: "latest-thought-panel",
		title: "Latest thought panel",
		description: "Keeps thinking out of the transcript and shows only the newest thought block above the editor.",
		category: "Interface",
		render: () => "Turns on OMP's Hide Thinking Blocks for the session (not saved) and tails the newest thought, last 8 lines, while it streams.",
	},
	{
		name: "session-title",
		title: "Session title",
		description: "Names the session once from the first prompt and locks it.",
		category: "Interface",
		render: () => "OMP's own auto-titling is disabled while this is on. /rename still overrides.",
	},
	{
		name: "vault-url-drawer",
		title: "vault:// completion drawer",
		description: "Typing vault:// opens a drawer of Obsidian vaults, then folders and notes, like agent://.",
		category: "Interface",
		render: () => "Tab into a vault or folder to keep drilling; picking a note inserts its URL. Vaults come from Obsidian's own registry.",
	},
	{
		name: "pr-url-drawer",
		title: "pr:// completion drawer",
		description: "Typing pr:// opens a drawer of your own open PRs with CI, unresolved-thread and merge-conflict status.",
		category: "Interface",
		render: () => "Needs an authenticated gh. HYDEMODS_PR_OWNERS=org1,org2 limits the list to those owners; HYDEMODS_PR_APPROVER=<regex> adds an approved column for a matching reviewer login.",
	},
	{
		name: "stalled-agent-alerts",
		title: "Stalled agent alerts",
		description: "Notifies when this session or a subagent has made no persisted progress for too long; escalates stuck subagent tool calls.",
		category: "Interface",
		render: () => {
			const { modelStallMinutes, toolStageMinutes } = defaultStallThresholds();
			return `Model: alert at ${modelStallMinutes}m. Subagent tool calls: check in at ${toolStageMinutes[0]}m, alert at ${toolStageMinutes.slice(1, -1).join("/") || "-"}m, abort at ${toolStageMinutes.at(-1)}m.`;
		},
	},
];

const TWEAKS: Tweak[] = TWEAK_DEFS.map(def => ({ ...def, setting: booleanSetting(def.name, def.title, def.description) }));

const isTweakEnabled = (name: string): boolean => {
	const tweak = TWEAKS.find(t => t.name === name);
	return tweak ? readSetting(tweak.setting) : false;
};

const CATEGORIES: readonly TweakCategory[] = ["Interface"];

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

type ToolMessage = {
	customType: string;
	content: string | unknown[];
	details?: {
		toolName: string;
		result: unknown;
		isError?: boolean;
		cwd?: string;
	};
};

type RendererOptions = {
	expanded?: boolean;
};

const DEFAULT_COLLAPSED_LINES = 5;
const collapsedLinesSetting = integerSetting(
	"collapsed-lines",
	"Collapsed tool card lines",
	"Lines shown in a collapsed tool card before the omission marker.",
	DEFAULT_COLLAPSED_LINES,
);

type ToolDisplayState = { collapsedLines: number; cardsOn: boolean };

type StructuredFormat = "json" | "yaml" | "toon" | "code" | "file" | "links" | "markdown" | "text" | "command" | "outline" | "edit-outline";

type StructuredText = {
	text: string;
	format: StructuredFormat;
	lang?: string;
	/** Filesystem path the first row names, for hyperlinking in tree layouts. */
	path?: string;
};

const CODE_KEYWORDS: Record<string, true> = {
	using: true, namespace: true, public: true, private: true, protected: true, internal: true,
	static: true, readonly: true, class: true, struct: true, interface: true, enum: true,
	void: true, return: true, new: true, if: true, else: true, switch: true, case: true,
	break: true, for: true, foreach: true, in: true, while: true, do: true, async: true,
	await: true, try: true, catch: true, finally: true, throw: true, typeof: true,
	override: true, virtual: true, abstract: true, sealed: true, get: true, set: true,
	var: true, is: true, as: true, null: true, true: true, false: true, this: true,
	base: true, import: true, export: true, from: true, const: true, let: true,
	function: true, def: true, elif: true, not: true, and: true, or: true, pass: true,
	yield: true, lambda: true,
};

// C#-style primitive aliases, the only lowercase types the highlighter must know: every
// capitalised type name (Unity's Vector3, .NET's List, TypeScript's Promise) already hits the
// generic capitalised-identifier rule in colorizeCodeLine.
const CODE_TYPES: Record<string, true> = {
	int: true, float: true, double: true, bool: true, string: true, char: true, byte: true,
	sbyte: true, short: true, ushort: true, uint: true, ulong: true, long: true, decimal: true,
	object: true,
};

function colorizeCodeLine(line: string, theme: ThemeLike): string {
	if (/^\s*(?:\/\/|#|--)/.test(line)) {
		return theme.fg("syntaxComment", line);
	}

	const tokenRegex = /("(?:\\.|[^"\\])*"|'[^'\\]*(?:\\.[^'\\]*)*'|\x60[^\x60\\]*(?:\\.[^\x60\\]*)*\x60|(?:\/\/|#|--).*$|\b\d+(?:\.\d+)?[fFmMdD]?\b|[a-zA-Z_][a-zA-Z0-9_]*|[+\-*\/%=<>!&|^~?:]+)/g;

	return line.replace(tokenRegex, (match) => {
		if (match.startsWith("//") || match.startsWith("#") || match.startsWith("--")) {
			return theme.fg("syntaxComment", match);
		}
		const c = match.charCodeAt(0);
		if (c === 34 || c === 39 || c === 96) {
			return theme.fg("syntaxString", match);
		}
		if (/^\d/.test(match)) {
			return theme.fg("syntaxNumber", match);
		}
		if (CODE_KEYWORDS[match]) {
			return theme.fg("syntaxKeyword", match);
		}
		if (CODE_TYPES[match] || /^[A-Z][a-zA-Z0-9_]+$/.test(match)) {
			return theme.fg("syntaxType", match);
		}
		if (/^[+\-*\/%=<>!&|^~?:]+$/.test(match)) {
			return theme.fg("syntaxOperator", match);
		}
		return match;
	});
}

function colorizeAstToonLine(line: string, theme: ThemeLike): string {
	const kvMatch = line.match(/^(\s*)(?:(-\s+))?([a-zA-Z0-9_]+(?:\[\d+\])?(?:\{[^}]+\})?):\s*(.*)$/);
	if (kvMatch) {
		const indent = kvMatch[1];
		const bullet = kvMatch[2] ? theme.fg("accent", "- ") : "";
		const key = kvMatch[3];
		const val = kvMatch[4];
		const coloredKey = theme.fg("syntaxKeyword", key);
		if (!val) return `${indent}${bullet}${coloredKey}:`;

		let coloredVal = val;
		if (val === "class" || val === "struct" || val === "interface" || val === "enum") {
			coloredVal = theme.fg("syntaxKeyword", val);
		} else if (/^[A-Z][a-zA-Z0-9_]+$/.test(val)) {
			coloredVal = theme.fg("syntaxType", val);
		} else {
			coloredVal = colorizeCodeLine(val, theme);
		}
		return `${indent}${bullet}${coloredKey}: ${coloredVal}`;
	}

	return colorizeCodeLine(line, theme);
}

/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/*                          Structured Results & Panels                       */
/* -------------------------------------------------------------------------- */

function prettifyYaml(value: string): string {
	const lines = value.trim().split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, ""));
	const contentLines = lines.filter((line) => line.trim().length > 0);
	if (contentLines.length === 0) return "";
	const minimumIndent = Math.min(
		...contentLines.map((line) => (line.match(/^[ \t]*/) ?? [""])[0].replace(/\t/g, "  ").length),
	);
	return lines.map((line) => line.slice(Math.min(minimumIndent, line.length))).join("\n");
}

function isLikelyCode(text: string): boolean {
	return /(?:;\s*$|[{}]|\b(?:using|namespace|class|interface|public|private|protected|import|export|function|const|let|var|def|fn|return)\b|\/\/|\/\*)/m.test(text);
}

interface ToolResultBlock {
	type?: string;
	text?: string;
}

interface ToolResultEnvelope {
	content?: ToolResultBlock[];
	details?: {
		jsonOutputs?: unknown[];
		data?: unknown;
		result?: unknown;
		[key: string]: unknown;
	};
}

function extractToolPayload(event: { toolName: string; result: unknown }): unknown {
	const result = event.result;
	if (!result || typeof result !== "object") return result;

	const envelope = result as ToolResultEnvelope;
	if (Array.isArray(envelope.content)) {
		const textParts = envelope.content
			.filter((c): c is ToolResultBlock & { text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
		const rawText = textParts.join("\n");

		if (event.toolName === "eval" && Array.isArray(envelope.details?.jsonOutputs)) {
			const jsonOutputs = envelope.details.jsonOutputs;
			if (jsonOutputs.length > 0) {
				if (jsonOutputs.length === 1) {
					const item = jsonOutputs[0];
					if (
						item &&
						typeof item === "object" &&
						"text" in item &&
						Object.keys(item).length === 1
					) {
						const textVal = (item as Record<string, unknown>).text;
						if (typeof textVal === "string" && textVal.includes("\n")) {
							return textVal;
						}
					}
					return item;
				}
				return jsonOutputs;
			}
		}

		const displayMatch = /^display\[\d+\]:\s*\n([\s\S]*)$/.exec(rawText.trim());
		if (displayMatch) {
			const body = displayMatch[1].trim();
			try {
				const parsed: unknown = JSON.parse(body);
				if (
					parsed &&
					typeof parsed === "object" &&
					"text" in parsed &&
					Object.keys(parsed).length === 1
				) {
					const textVal = (parsed as Record<string, unknown>).text;
					if (typeof textVal === "string" && textVal.includes("\n")) {
						return textVal;
					}
				}
				return parsed;
			} catch {
				return body;
			}
		}

		if (event.toolName === "grep") {
			const grepParsed = parseGrepOutput(rawText);
			if (grepParsed) return grepParsed;
		}

		const trimmedRaw = rawText.trim();
		if (trimmedRaw.startsWith("{") || trimmedRaw.startsWith("[")) {
			try {
				return JSON.parse(trimmedRaw);
			} catch {
				// Not JSON, fall through
			}
		}
		// MCP tools often serialize structuredContent as a markdown fenced ```json block.
		const fencedRaw = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmedRaw);
		if (fencedRaw && /^[\[{]/.test(fencedRaw[1].trim())) {
			try {
				return JSON.parse(fencedRaw[1].trim());
			} catch {
				// Not JSON, fall through
			}
		}

		if (rawText.length > 0) return rawText;
	}

	if (envelope.details && typeof envelope.details === "object") {
		if (envelope.details.data !== undefined) return envelope.details.data;
		if (envelope.details.result !== undefined) return envelope.details.result;
	}

	return result;
}

function structuredResult(result: unknown): StructuredText {
	const useToon = isTweakEnabled("tool-results-toon");
	// Tool output is untrusted: strip escape hatches before anything parses or measures it.
	const text = typeof result === "string" ? sanitizeTerminalText(result) : result;
	if (typeof text === "string") {
		const search = formatSearchOutput(text);
		if (search !== undefined) return { text: search, format: "text" };
	}
	if (typeof text === "string" && isFileExcerpt(text)) {
		return { text: formatFileExcerpt(text, useToon), format: "text" };
	}
	const target = decodeNestedJson(text);

	if (target !== null && typeof target === "object") {
		if (useToon) {
			try {
				return formatJsonOutput(target, useToon);
			} catch {
				// Fall through
			}
		}
		try {
			return { text: JSON.stringify(target, null, 2) ?? String(target), format: "json" };
		} catch {
			return { text: String(target), format: "text" };
		}
	}

	if (typeof text === "string") {
		if (useToon) {
			const timedJson = formatJsonWithFooter(text, useToon);
			if (timedJson) return timedJson;
		}
		const yaml = isLikelyCode(text) ? undefined : parseYamlDocument(text);
		if (yaml !== undefined) {
			if (useToon) {
				try {
					return formatJsonOutput(decodeNestedJson(yaml), useToon);
				} catch (error) {
					// Only a parse-level failure falls back to the YAML text; a formatter bug
					// must not pass for "not structured".
					if (!(error instanceof SyntaxError)) throw error;
				}
			}
			return { text: prettifyYaml(text), format: "yaml" };
		}

		// Output that reads as code keeps syntax colour but is never rewritten: real outlines
		// come from the tree-sitter read/edit cards, not from guessing at command output.
		if (isLikelyCode(text)) return { text, format: "code" };
	}

	return { text: typeof text === "string" ? text : String(text), format: "text" };
}

// Labels the TUI prints raw: a model-controlled tool intent and the session name both reach
// the widget and window title, so escapes must go and a runaway name must not fill the bar.
function sanitizeLabel(text: string, max = 120): string {
	const clean = sanitizeTerminalText(text);
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Joined text blocks of a tool result: the same view the native card and the model start from.
function toolResultText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block)) continue;
		if (typeof block.text === "string") texts.push(block.text);
	}
	return texts.length === 0 ? undefined : texts.join("\n");
}

// Complete JSON tool output, including `display[N]:`-prefixed eval results, encoded as TOON for
// the model. Undefined when the text is not one JSON document or when TOON would not be a plain
// body (command results, artifact previews, excerpts), so those results reach the model verbatim.
function toonForModel(text: string): string | undefined {
	const trimmed = text.trim();
	let jsonText: string;
	const displayMatch = /^(?:display\[\d+\]:\s*)?([\[{][\s\S]*)$/.exec(trimmed);
	if (displayMatch) {
		jsonText = displayMatch[1];
	} else {
		// MCP tools often serialize structuredContent as a markdown fenced ```json block.
		const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
		if (fenced && /^[\[{]/.test(fenced[1].trim())) {
			jsonText = fenced[1].trim();
		} else {
			return undefined;
		}
	}
	const decoded = decodeNestedJson(jsonText);
	if (decoded === null || typeof decoded !== "object") return undefined;
	try {
		const output = formatJsonOutput(decoded);
		return output.format === "toon" ? output.text : undefined;
	} catch {
		return undefined;
	}
}

// True when OMP's own card already draws this result as a JSON tree: the tool (or the xd://
// device behind a write) has no bespoke renderer and the text is one JSON document.
function nativeRendersJsonTree(toolName: string, args: unknown, text: string | undefined): boolean {
	if (text === undefined) return false;
	const trimmed = text.trimEnd();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try { JSON.parse(trimmed); } catch { return false; }
	let rendererName = toolName;
	if (toolName === "write" && args && typeof args === "object" && "path" in args && typeof args.path === "string" && args.path.startsWith("xd://")) {
		rendererName = args.path.slice("xd://".length).split(/[/?#]/)[0] || toolName;
	}
	return !(rendererName in toolRenderers);
}

function colorizeOutlineLine(line: string, theme: ThemeLike): string {
	const header = /^(\S[^·]*?)( · .*)$/.exec(line);
	if (header) return `${theme.fg("accent", header[1])}${theme.fg("dim", header[2])}`;
	const fold = /^(\s*)(⋯\d+)$/.exec(line);
	if (fold) return `${fold[1]}${theme.fg("muted", fold[2])}`;
	const row = /^(\s*)(.*?)(  ⋯\d+)?$/.exec(line);
	if (row) return `${row[1]}${colorizeCodeLine(row[2], theme)}${row[3] ? theme.fg("muted", row[3]) : ""}`;
	return line;
}

const EDIT_MARKER_COLOR: Record<string, ThemeColor> = { "~": "warning", "+": "success", "−": "error", "→": "accent" };

function colorizeEditOutlineLine(line: string, theme: ThemeLike): string {
	const header = /^(\S[^·]*?)( · .*)$/.exec(line);
	if (header) return `${theme.fg("accent", header[1])}${theme.fg("dim", header[2])}`;
	const diagnosticsHeading = /^ ! (Diagnostics.*)$/.exec(line);
	if (diagnosticsHeading) return ` ${theme.fg("error", "!")} ${theme.fg("warning", diagnosticsHeading[1])}`;
	const diagnostic = /^(\s{5})([✖⚠ℹ·]) (.*)$/.exec(line);
	if (diagnostic) {
		const color: ThemeColor = diagnostic[2] === "✖" ? "error" : diagnostic[2] === "⚠" ? "warning" : "dim";
		return `${diagnostic[1]}${theme.fg(color, diagnostic[2])} ${theme.fg(color, diagnostic[3])}`;
	}
	const detail = /^(\s{3,})([+−→]) (.*)$/.exec(line);
	if (detail) return `${detail[1]}${theme.fg(EDIT_MARKER_COLOR[detail[2]], detail[2])} ${colorizeCodeLine(detail[3], theme)}`;
	const row = /^ ([~+− ]) (\s*)(.*?)(  \([+−][\d −+]*\))?$/.exec(line);
	if (row) {
		const marker = row[1] === " " ? " " : theme.fg(EDIT_MARKER_COLOR[row[1]], row[1]);
		const signature = row[1] === " " || row[3] === "(top level)" ? theme.fg("dim", row[3]) : colorizeCodeLine(row[3], theme);
		return ` ${marker} ${row[2]}${signature}${row[4] ? theme.fg(EDIT_MARKER_COLOR[row[1]], row[4]) : ""}`;
	}
	return line;
}

function colorizeStructuredLine(line: string, format: StructuredFormat, theme: ThemeLike): string {
	if (format === "links") return line;
	if (format === "outline") return colorizeOutlineLine(line, theme);
	if (format === "edit-outline") return colorizeEditOutlineLine(line, theme);
	if (format === "command") {
		if (/^\s*Result(?: \d+)?(?:;|$)/.test(line)) return theme.fg(/; failed(?:;|$)/.test(line) ? "error" : "accent", line);
		return line;
	}
	if (/^\s*(?:\[[^\]\r\n]+#[\da-f]+\]|#{1,6} .+#[\da-f]+|#{1,6} .+\/)\s*$/i.test(line)) return theme.fg("dim", line);
	if (/^\s*\[(?:Showing lines|truncated;|Source:)/.test(line) || /^\s*(?:…|\.\.\.)\s*$/.test(line)) return theme.fg("dim", line);
	if (format === "file") {
		return /^\s*[\w$]+(?:\[\d+\])?(?:\{[^}]+\})?:\s/.test(line)
			? colorizeAstToonLine(line, theme) : colorizeCodeLine(line, theme);
	}
	if (format === "toon") {
		return colorizeAstToonLine(line, theme);
	}
	if (format === "code") {
		return colorizeCodeLine(line, theme);
	}
	const token = /^(\s*)(.*)$/.exec(line);
	if (!token) return line;
	const [, indent, value] = token;
	const colored = value.replace(
		format === "yaml"
			? /^(\s*(?:-\s+)?)([^:#\n]+)(:)(.*)$/
			: /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g,
		(...matches: string[]) => {
			if (format === "yaml") {
				const [, prefix, key, colon, rest] = matches;
				return `${prefix}${theme.fg("accent", key.trim())}${colon}${rest}`;
			}
			const [, key, string, number, literal] = matches;
			if (key) return theme.fg("accent", key);
			if (string) return theme.fg("success", string);
			if (number) return theme.fg("warning", number);
			return theme.fg(literal === "null" ? "muted" : "syntaxKeyword", literal);
		},
	);
	return indent + colored;
}

// Tool-card styling. Truecolor lime label (#84cc16); the host card owns the background.
const TOOL_NAME_ANSI = "\x1b[1;38;2;132;204;22m";
const ANSI_RESET = "\x1b[0m";

// Pad one card line to the requested width without changing its background.
function padToolBlockLine(line: string, width: number): string {
	const visible = visibleWidth(line);
	return line + " ".repeat(Math.max(0, width - visible));
}

type ToolCardDetails = NonNullable<ToolMessage["details"]>;

// Which hydemods layout a result gets. "text" means hydemods has nothing structural to add.
function structureToolResult(details: ToolCardDetails | undefined): StructuredText {
	const result = details?.result;
	const references = referenceLocations(result);
	const markdownText = markdownOutput(result);
	const base = details?.cwd ?? process.cwd();
	const structured: StructuredText = references ? {
		text: references.locations.map(location => {
			const path = location.path.startsWith("~/") ? resolve(homedir(), location.path.slice(2)) : resolve(base, location.path);
			const label = `${location.path}:${location.line}:${location.column}`;
			// Link only a file the user can actually open: a path the model invented, or one
			// outside the workspace and home, must not become an OSC 8 link.
			const home = homedir();
			let linkable = !/[\x00-\x1f\x7f]/.test(path) && (path.startsWith(`${base}${sep}`) || path.startsWith(`${home}${sep}`));
			if (linkable) {
				try {
					linkable = statSync(path).isFile();
				} catch {
					linkable = false;
				}
			}
			return linkable ? fileHyperlink(path, underlineLabel(label), { line: location.line }) : underlineLabel(label);
		}).concat(references.incomplete ? ["…"] : []).join("\n"),
		format: "links",
	} : markdownText !== undefined ? { text: markdownText, format: "markdown" } : structuredResult(result);
	if (structured.format === "text" && markdownOutput(structured.text) !== undefined) structured.format = "markdown";
	if (structured.format !== "links" && structured.format !== "markdown" && structured.format !== "command" && isFileExcerpt(structured.text)) structured.format = "file";
	return structured;
}

function toolMessageRenderer(message: ToolMessage, options: RendererOptions, theme: Theme, display: ToolDisplayState, structured: StructuredText = structureToolResult(message.details)) {
	const details = message.details;
	const toolName = details?.toolName || "tool";
	const error = details?.isError;
	const pretty = structured.text.trim() || "(empty)";
	const rawLines = pretty
		.split(/\r?\n/)
		.map((line) => line.replace(/\t/g, "  ").trimEnd())
		.filter((line) => structured.format === "command" || line.length > 0);

	const prefixSymbol = error ? "✖" : "▶";
	const label = `${theme.fg(error ? "error" : "accent", prefixSymbol)} ${TOOL_NAME_ANSI}${toolName}${ANSI_RESET}`;
	const coloredPrefix = `${label} `;
	// Continuation lines hang under the first content column (visible width of "▶ name ").
	const hangingIndent = " ".repeat(`${prefixSymbol} ${toolName} `.length);

	const markdown = structured.format === "markdown"
		? new Markdown(pretty.replace(/^(\[[^\]\r\n]+#[\da-f]+\]|\[(?:Source:|Showing lines|truncated;)[^\r\n]*\])$/gim, line => theme.fg("dim", line)), 0, 0, getMarkdownTheme(), { color: text => theme.fg("text", text) })
		: undefined;
	// A failed result keeps the standard layout; the error colour is what says it failed.
	const contentLines = markdown ? [] : rawLines.map((line, index) => {
		const colored = error ? theme.fg("error", line) : colorizeStructuredLine(line, structured.format, theme);
		if ((structured.format === "file" && index === 0) || (structured.path && index === 0)) return underlineLabel(colored);
		return structured.format === "command" || structured.format === "text" ? underlinePathTokens(colored) : colored;
	});
	const heading = `${label} · expanded ${structured.lang || structured.format} output`;
	return {
		render(width: number): readonly string[] {
			const expanded = options.expanded === true;
			const renderedContent = markdown
				? markdown.render(Math.max(1, width - (expanded ? 2 : visibleWidth(coloredPrefix))))
				: contentLines;
			if (expanded) {
				return [heading, ...renderedContent.map(line => `  ${line}`)]
					.flatMap(line => wrapTextWithAnsi(line, width))
					.map(line => padToolBlockLine(line, width));
			}
			const limit = display.collapsedLines;
			// Collapsed edit cards are the declaration tree; the change lines wait for expansion.
			// Diagnostics sit below the tree and stay visible: the heading and the first few messages.
			const diagnosticsAt = structured.format === "edit-outline" ? rawLines.findIndex(line => /^ ! Diagnostics/.test(line)) : -1;
			const tree = diagnosticsAt >= 0 ? renderedContent.slice(0, diagnosticsAt) : renderedContent;
			let selected: string[] = [
				...(structured.format === "edit-outline"
					? tree.filter((_, index) => !/^\s{3,}[+−→] /.test(rawLines[index]))
					: tree),
			];
			if (selected.length > limit) {
				if (structured.format === "outline" || structured.format === "edit-outline") {
					// Outline rows are a list: the last row carries no summary, so count the rest.
					const shown = Math.max(1, limit - 1);
					selected = [...selected.slice(0, shown), theme.fg("muted", `… ${selected.length - shown} more`)];
				} else if (limit <= 1) {
					// One row is all the space there is, so the first content line carries the
					// omission mark itself instead of the card showing nothing but `…`.
					selected = [`${renderedContent[0]} ${theme.fg("muted", "…")}`];
				} else {
					const omission = theme.fg("muted", "…");
					selected = limit < 3
						? [...renderedContent.slice(0, limit - 1), theme.fg("muted", `… ${renderedContent.length - (limit - 1)} more`)]
						: [...renderedContent.slice(0, limit - 2), omission, renderedContent[renderedContent.length - 1]];
				}
			}
			if (diagnosticsAt >= 0) {
				const messages = renderedContent.slice(diagnosticsAt + 1);
				const kept = messages.slice(0, 3);
				selected = [...selected, renderedContent[diagnosticsAt], ...kept];
				if (messages.length > kept.length) selected.push(theme.fg("muted", `       … ${messages.length - kept.length} more`));
			}
			return selected.map((line, index) =>
				padToolBlockLine(truncateToWidth(`${index === 0 ? coloredPrefix : hangingIndent}${line}`, width), width));
		},
		invalidate() { markdown?.invalidate(); },
	};
}

// A context_notes write acknowledges with one line; the notebook itself is what the card
// should show. Reads already return the notebook as the result.
function notebookPayload(toolName: string, args: unknown, isError: boolean | undefined): string | undefined {
	if (isError || toolName !== "context_notes") return;
	const text = (args as { text?: unknown } | undefined)?.text;
	return typeof text === "string" && text.trim() ? text : undefined;
}

/* ------------------------- declaration outlines ------------------------- */

// Outlines are pure functions of file content; keep the latest few so repaints and history
// replays do not re-parse.
const OUTLINE_MEMO_LIMIT = 64;
const outlineMemo = new Map<string, Outline | undefined>();

function memoOutline(key: string, code: string, path: string | undefined): Outline | undefined {
	if (outlineMemo.has(key)) return outlineMemo.get(key);
	let outline: Outline | undefined;
	try {
		outline = outlineSource(code, { path }, summarizeCode);
	} catch {
		outline = undefined;
	}
	if (outlineMemo.size >= OUTLINE_MEMO_LIMIT) outlineMemo.delete(outlineMemo.keys().next().value!);
	outlineMemo.set(key, outline);
	return outline;
}

function displayPath(path: string): string {
	const cwd = process.cwd();
	if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

type ReadOutlineDetails = {
	kind?: string;
	resolvedPath?: string;
	displayTarget?: string;
	totalLines?: number;
	truncation?: { truncated?: boolean };
	displayContent?: { text: string; startLine?: number; lineNumbers?: Array<number | null> };
	meta?: { source?: { type?: string; value?: unknown } };
};

// Once a read has an outline it keeps it: the transcript repaints the same result object long
// after the file it came from has been edited again.
const readOutlineByResult = new WeakMap<object, StructuredText>();

// A file read as a declaration outline. Whole-file reads outline the returned text; ranges
// outline the file on disk, but only where the disk still holds the lines the read returned.
function readOutlineStructured(result: { content: unknown; details?: unknown }, args: unknown): StructuredText | undefined {
	const remembered = readOutlineByResult.get(result);
	if (remembered) return remembered;
	const structured = computeReadOutline(result, args);
	if (structured) readOutlineByResult.set(result, structured);
	return structured;
}

// A whole-file write shown as the declaration outline of what was written, plus diagnostics.
function writeOutlineStructured(result: { details?: unknown; isError?: boolean }, args: unknown): StructuredText | undefined {
	if (result.isError) return undefined;
	const { path, content } = (args ?? {}) as { path?: unknown; content?: unknown };
	if (typeof path !== "string" || typeof content !== "string" || !content.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
	const details = (result.details ?? {}) as { resolvedPath?: unknown; diagnostics?: EditOutlineDetails["diagnostics"] };
	const fsPath = typeof details.resolvedPath === "string" ? details.resolvedPath : resolve(path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
	const outline = memoOutline(`text:${fsPath}:${Bun.hash(content)}`, content, fsPath);
	if (!outline || outline.declarations.length === 0) {
		// Nothing to outline (scripts, data, prose): one summary row instead of the full content.
		const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
		const rows = [`${displayPath(fsPath)} · ${lines} line${lines === 1 ? "" : "s"} written`, ...diagnosticsRows(details.diagnostics, fsPath)];
		return { text: rows.join("\n"), format: "outline", path: fsPath };
	}
	const rows = [...renderOutline(outline, displayPath(fsPath)), ...diagnosticsRows(details.diagnostics, fsPath)];
	return { text: rows.join("\n"), format: "outline", lang: outline.language, path: fsPath };
}

function computeReadOutline(result: { content: unknown; details?: unknown }, args: unknown): StructuredText | undefined {
	const details = (result.details ?? undefined) as ReadOutlineDetails | undefined;
	const text = details?.displayContent?.text;
	if (typeof text !== "string" || !text.trim() || (details?.kind && details.kind !== "file")) return undefined;
	const rawPath = (args as { path?: unknown; file_path?: unknown } | undefined);
	const target = typeof rawPath?.path === "string" ? rawPath.path : typeof rawPath?.file_path === "string" ? rawPath.file_path : "";
	const split = splitPathAndSel(target);
	const source = readSourceFsPath(details as Parameters<typeof readSourceFsPath>[0]) ?? details?.resolvedPath ?? details?.displayTarget ?? split.path;
	if (!source || /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return undefined;
	const fsPath = source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : resolve(source);
	const label = displayPath(split.path.startsWith("~/") ? resolve(homedir(), split.path.slice(2)) : resolve(split.path));
	// A range ending on a blank line ends the text with "\n"; `lineNumbers` counts that row.
	const shown = text.split("\n");
	if (!details?.displayContent?.lineNumbers && shown[shown.length - 1] === "") shown.pop();
	const startLine = details?.displayContent?.startLine ?? 1;
	const whole = startLine === 1 && !details?.truncation?.truncated && (details?.totalLines === undefined || Math.abs(details.totalLines - shown.length) <= 1);
	if (whole) {
		const outline = memoOutline(`text:${fsPath}:${Bun.hash(text)}`, text, fsPath);
		if (!outline || outline.declarations.length === 0) return undefined;
		return { text: renderOutline(outline, label).join("\n"), format: "outline", lang: outline.language, path: fsPath };
	}
	let disk: string;
	let stamp: string;
	try {
		const stat = statSync(fsPath);
		stamp = `${stat.size}:${stat.mtimeMs}`;
		disk = readFileSync(fsPath, "utf8");
	} catch {
		return undefined;
	}
	const diskLines = disk.split(/\r?\n/);
	// OMP pads a range with context and elides the gap as a `…` row; `lineNumbers` maps each
	// shown row to its source line (null for the elision).
	const numbers = details?.displayContent?.lineNumbers ?? shown.map((_, index) => startLine + index);
	if (numbers.length !== shown.length) return undefined;
	const numbered = numbers.filter((line): line is number => line !== null);
	if (numbered.length === 0) return undefined;
	// The requested lines, not the padded ones: `:50-60`, `:50`, `:50+10`, or several joined by commas.
	const parts = (split.sel ?? "").split(",").map(part => /^(\d+)(?:-(\d+)|\+(\d+))?$/.exec(part.trim())).filter((part): part is RegExpExecArray => part !== null);
	const requestedStart = Math.max(parts.length ? Math.min(...parts.map(part => Number(part[1]))) : -Infinity, Math.min(...numbered));
	const requestedEnd = Math.min(parts.length
		? Math.max(...parts.map(part => part[2] ? Number(part[2]) : part[3] ? Number(part[1]) + Number(part[3]) - 1 : Number(part[1])))
		: Infinity, Math.max(...numbered));
	if (requestedStart > requestedEnd) return undefined;
	// Only the requested lines must still be on disk; the padding is context OMP added and an
	// edit right beside the range rewrites it without touching what was read.
	const requested = numbers.map((line, index) => line !== null && line >= requestedStart && line <= requestedEnd ? index : -1).filter(index => index >= 0);
	if (requested.length === 0) return undefined;
	// Each contiguous run of requested lines is located on its own: an edit between two ranges
	// of one read moves the later range without touching the earlier one.
	const segments: number[][] = [];
	for (const index of requested) {
		const current = segments[segments.length - 1];
		if (current && numbers[index] === numbers[current[current.length - 1]]! + 1) current.push(index);
		else segments.push([index]);
	}
	const locate = (segment: number[]): number | undefined => {
		const matchesAt = (offset: number) => segment.every(index => {
			const at = numbers[index]! + offset;
			return at >= 1 && at <= diskLines.length && diskLines[at - 1].trimEnd() === shown[index].trimEnd();
		});
		if (matchesAt(0)) return 0;
		const anchorIndex = segment.find(index => shown[index].trim().length > 0);
		if (anchorIndex === undefined) return undefined;
		const anchorLine = numbers[anchorIndex]!;
		const anchorText = shown[anchorIndex].trimEnd();
		for (let line = 1; line <= diskLines.length; line++) {
			if (diskLines[line - 1].trimEnd() === anchorText && matchesAt(line - anchorLine)) return line - anchorLine;
		}
		return undefined;
	};
	const offsets = segments.map(locate);
	if (offsets.some(offset => offset === undefined)) return undefined;
	const first = segments[0];
	const last = segments[segments.length - 1];
	const rangeStart = numbers[first[0]]! + offsets[0]!;
	const endLine = numbers[last[last.length - 1]]! + offsets[offsets.length - 1]!;
	const outline = memoOutline(`disk:${fsPath}:${stamp}`, disk, fsPath);
	if (!outline) return undefined;
	const rows = renderRange(outline, diskLines, rangeStart, endLine, label);
	return rows ? { text: rows.join("\n"), format: "outline", lang: outline.language, path: fsPath } : undefined;
}

type EditOutlineDetails = {
	diff?: string;
	path?: string;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
	/** Outline captured by hydemods when the edit finished, while the disk still matched the diff. */
	hydemodsOutline?: string;
	perFileResults?: Array<{ diagnostics?: DiagnosticsLike }>;
	diagnostics?: DiagnosticsLike;
};

type DiagnosticsLike = { summary?: string; messages?: string[]; errored?: boolean };

const DIAGNOSTIC_GLYPH: Record<string, string> = { error: "✖", warning: "⚠", information: "ℹ", info: "ℹ", hint: "·" };

// LSP diagnostics as rows under the outline: a `!` heading with the summary, then one row per
// message with a severity glyph. The file is dropped from messages about the edited file, since
// the card heading already names it.
function diagnosticsRows(diagnostics: DiagnosticsLike | undefined, path: string | undefined): string[] {
	const messages = diagnostics?.messages ?? [];
	if (messages.length === 0) return [];
	const rows = [` ! Diagnostics${diagnostics?.summary ? ` (${diagnostics.summary})` : ""}`];
	for (const message of messages) {
		const parsed = /^(.+?):(\d+):(\d+) \[(\w+)\] (.*)$/.exec(message);
		if (!parsed) {
			rows.push(`     · ${message}`);
			continue;
		}
		const [, file, line, column, severity, text] = parsed;
		const own = path !== undefined && (path.endsWith(file) || file.endsWith(path));
		rows.push(`     ${DIAGNOSTIC_GLYPH[severity.toLowerCase()] ?? "·"} ${own ? "" : `${file}:`}${line}:${column} ${text}`);
	}
	return rows;
}

const editOutlineMemo = new Map<string, StructuredText | undefined>();

// An edit as the declarations it touched. Multi-file batches keep the native card. When the
// engine pruned the snapshots (large files), the file on disk stands in for the new text and
// the old text is rebuilt from it and the diff, as long as the diff still fits the disk.
function editOutlineStructured(result: { content: unknown; details?: unknown }): StructuredText | undefined {
	const details = (result.details ?? undefined) as EditOutlineDetails | undefined;
	if (!details || typeof details.diff !== "string" || !details.diff.trim() || (details.perFileResults?.length ?? 0) > 1) return undefined;
	const path = typeof details.path === "string" ? details.path : undefined;
	if (typeof details.hydemodsOutline === "string") return { text: details.hydemodsOutline, format: "edit-outline", path };
	const diagnostics = details.diagnostics ?? details.perFileResults?.[0]?.diagnostics;
	// Diagnostics can be filled in after the edit settles, so they are part of the memo key.
	const diagnosticsKey = Bun.hash(JSON.stringify(diagnostics?.messages ?? [])).toString();
	let newText = details.newText;
	let oldText = details.oldText;
	let key: string;
	if (typeof newText === "string") {
		key = `${path ?? ""}:${Bun.hash(details.diff)}:${Bun.hash(newText)}:${diagnosticsKey}`;
	} else {
		if (!path) return undefined;
		try {
			const stat = statSync(path);
			key = `${path}:${Bun.hash(details.diff)}:disk:${stat.size}:${stat.mtimeMs}:${diagnosticsKey}`;
			if (editOutlineMemo.has(key)) return editOutlineMemo.get(key);
			newText = readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
		oldText = recoverOldText(newText, details.diff);
		if (oldText === undefined) return undefined;
	}
	if (editOutlineMemo.has(key)) return editOutlineMemo.get(key);
	let structured: StructuredText | undefined;
	try {
		const rows = renderEditOutline({ oldText: oldText ?? "", newText, diff: details.diff, path }, path ? displayPath(path) : "edit", summarizeCode);
		structured = rows ? { text: [...rows, ...diagnosticsRows(diagnostics, path)].join("\n"), format: "edit-outline", path } : undefined;
	} catch {
		structured = undefined;
	}
	if (editOutlineMemo.size >= OUTLINE_MEMO_LIMIT) editOutlineMemo.delete(editOutlineMemo.keys().next().value!);
	editOutlineMemo.set(key, structured);
	return structured;
}

/* --------------------------- grouped read cards --------------------------- */

type ReadResultLike = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };
type ReadGroupState = {
	entries: Map<string, { args: unknown; result?: ReadResultLike }>;
	usage: Map<string, { usage: Usage; durationMs?: number; ttftMs?: number; timestamp?: number; turnElapsedMs?: number }>;
	expanded: boolean;
	visible: boolean;
};

// OMP folds consecutive reads into ReadToolGroupComponent, which draws its own summary rows and
// never consults toolRenderers. Record what each group is told, and draw the group as OMP does
// (`Read path` or `Read (N)` plus a tree) with each read's declaration outline nested under its
// path. Reads without an outline keep a bare path row; the group draws itself while any read is
// still pending. The class must come from `@oh-my-pi/pi-tui`: only host-mapped specifiers share
// the running instance, and a deeper import would patch a private copy.
function installReadGroupTakeover(takeover: CardTakeover): void {
	const states = new WeakMap<ReadToolGroupComponent, ReadGroupState>();
	const stateOf = (group: ReadToolGroupComponent): ReadGroupState => {
		let state = states.get(group);
		if (!state) {
			state = { entries: new Map(), usage: new Map(), expanded: false, visible: true };
			states.set(group, state);
		}
		return state;
	};
	const proto = ReadToolGroupComponent.prototype;
	const original = {
		updateArgs: proto.updateArgs,
		updateResult: proto.updateResult,
		renameEntry: proto.renameEntry,
		removeEntry: proto.removeEntry,
		attachUsage: proto.attachUsage,
		setExpanded: proto.setExpanded,
		setToolActivityVisible: proto.setToolActivityVisible,
		render: proto.render,
	};
	proto.updateArgs = function(args, toolCallId) {
		if (toolCallId) {
			const state = stateOf(this);
			const entry = state.entries.get(toolCallId);
			if (entry) entry.args = args;
			else state.entries.set(toolCallId, { args });
		}
		return original.updateArgs.call(this, args, toolCallId);
	};
	proto.updateResult = function(result, isPartial, toolCallId) {
		if (toolCallId && !isPartial) {
			const entry = stateOf(this).entries.get(toolCallId);
			if (entry) entry.result = result;
		}
		return original.updateResult.call(this, result, isPartial, toolCallId);
	};
	proto.renameEntry = function(oldId, newId) {
		const state = stateOf(this);
		const entry = state.entries.get(oldId);
		if (entry && oldId !== newId && !state.entries.has(newId)) {
			const reordered = [...state.entries].map(([key, value]) => [key === oldId ? newId : key, value] as const);
			state.entries = new Map(reordered);
		}
		return original.renameEntry.call(this, oldId, newId);
	};
	proto.removeEntry = function(toolCallId) {
		stateOf(this).entries.delete(toolCallId);
		return original.removeEntry.call(this, toolCallId);
	};
	proto.attachUsage = function(toolCallIds, usage, durationMs, ttftMs, timestamp, turnElapsedMs) {
		const state = stateOf(this);
		let anchor: string | undefined;
		for (const id of toolCallIds) if (state.entries.has(id)) anchor = id;
		if (anchor) state.usage.set(anchor, { usage, durationMs, ttftMs, timestamp, turnElapsedMs });
		return original.attachUsage.call(this, toolCallIds, usage, durationMs, ttftMs, timestamp, turnElapsedMs);
	};
	proto.setExpanded = function(expanded) {
		stateOf(this).expanded = expanded;
		return original.setExpanded.call(this, expanded);
	};
	proto.setToolActivityVisible = function(visible) {
		stateOf(this).visible = visible;
		return original.setToolActivityVisible.call(this, visible);
	};
	proto.render = function(width) {
		const state = states.get(this);
		if (!state || !state.visible || !takeover.active() || state.entries.size === 0) return original.render.call(this, width);
		const rows: ReadTreeRow[] = [];
		for (const [id, entry] of state.entries) {
			if (!entry.result || entry.result.isError) return original.render.call(this, width);
			rows.push({ id, ...readTreeRow(entry.result, entry.args) });
		}
		if (!rows.some(row => row.outline || row.prose)) return original.render.call(this, width);
		return renderReadTree(rows, state, uiTheme, takeover.display, width);
	};
}

type ReadTreeRow = { id: string; header: string; outline?: string[]; prose?: string[] };

// One read as a tree row: the path line (hyperlinked when it names a file) and, when the read
// parses, its outline rows beneath.
function readTreeRow(result: ReadResultLike, args: unknown): Omit<ReadTreeRow, "id"> {
	const structured = readOutlineStructured(result, args);
	if (structured) {
		const [header, ...outline] = structured.text.split("\n");
		const colored = colorizeOutlineLine(header, uiTheme);
		return { header: structured.path ? fileHyperlink(structured.path, underlineLabel(colored)) : colored, outline };
	}
	const rawPath = args as { path?: unknown; file_path?: unknown } | undefined;
	const target = typeof rawPath?.path === "string" ? rawPath.path : typeof rawPath?.file_path === "string" ? rawPath.file_path : "";
	const split = splitPathAndSel(target);
	const shown = /^[a-z][a-z0-9+.-]*:\/\//i.test(split.path) ? target : `${displayPath(split.path.startsWith("~/") ? resolve(homedir(), split.path.slice(2)) : resolve(split.path))}${split.sel ? `:${split.sel}` : ""}`;
	const text = toolResultText(result.content)?.trim();
	return { header: /^[a-z][a-z0-9+.-]*:\/\//i.test(split.path) ? uiTheme.fg("accent", shown) : uiTheme.fg("accent", underlineLabel(shown)), prose: text ? text.split(/\r?\n/) : undefined };
}

// Collapsed outlines keep the first rows and count the rest; expanded shows every row.
function outlineRows(outline: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	const colored = outline.map(line => colorizeOutlineLine(line, theme));
	if (expanded || colored.length <= limit) return colored;
	const shown = Math.max(1, limit - 1);
	return [...colored.slice(0, shown), theme.fg("muted", `… ${colored.length - shown} more`)];
}

function proseRows(prose: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	return collapseTextLines(prose, limit, expanded).map(line => line.startsWith("… ") ? theme.fg("muted", line) : line);
}

// Mirrors pi-tui's usage row, but against the theme handed to the renderer. The
// `overlays/usage-row` subpath is not host-mapped, so its copy of the theme
// singleton is never initialised and reading `theme.icon` there throws.
function formatUsageRow(theme: Theme, usage: Usage, durationMs?: number, ttftMs?: number, timestamp?: number, turnElapsedMs?: number): string {
	const specs: MetricSpec[] = [];
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0) {
		const d = new Date(timestamp);
		const pad = (n: number): string => String(n).padStart(2, "0");
		specs.push({ value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` });
	}
	if (turnElapsedMs !== undefined && turnElapsedMs > 0) specs.push({ value: `Δ ${formatDuration(Math.round(turnElapsedMs))}` });
	specs.push({ leading: theme.icon.input, value: formatNumber(usage.input + usage.cacheWrite) });
	specs.push({ leading: theme.icon.output, value: formatNumber(usage.output) });
	if (usage.cacheRead > 0) specs.push({ leading: theme.icon.cache, value: formatNumber(usage.cacheRead) });
	if (ttftMs && ttftMs > 0) specs.push({ leading: theme.icon.time, value: `${(ttftMs / 1000).toFixed(1)}s` });
	if (durationMs && durationMs > 100 && usage.output > 0) {
		specs.push({ leading: theme.icon.throughput, value: `${((usage.output / durationMs) * 1000).toFixed(1)}/s` });
	}
	return formatMetricRow(specs, { separator: "  " });
}

function renderReadTree(rows: ReadTreeRow[], state: ReadGroupState, theme: Theme, display: ToolDisplayState, width: number): string[] {
	const title = theme.fg("toolTitle", theme.bold("Read"));
	const usageLines = (id: string, prefix: string): string[] => {
		const row = state.usage.get(id);
		return row ? [theme.fg("dim", `${prefix}${formatUsageRow(theme, row.usage, row.durationMs, row.ttftMs, row.timestamp, row.turnElapsedMs)}`)] : [];
	};
	const lines: string[] = [];
	if (rows.length === 1) {
		const [row] = rows;
		lines.push(` ${theme.format.bullet} ${title} ${row.header}`);
		const body = row.outline ? outlineRows(row.outline, state.expanded, display.collapsedLines, theme) : proseRows(row.prose ?? [], state.expanded, display.collapsedLines, theme);
		for (const line of body) lines.push(`   ${line}`);
		lines.push(...usageLines(row.id, "   "));
	} else {
		lines.push(` ${theme.format.bullet} ${title}${theme.fg("dim", ` (${rows.length})`)}`);
		rows.forEach((row, index) => {
			const last = index === rows.length - 1;
			const connector = last ? theme.tree.last : theme.tree.branch;
			const guide = last ? " ".repeat(visibleWidth(connector)) : `${theme.tree.vertical}${" ".repeat(Math.max(0, visibleWidth(connector) - visibleWidth(theme.tree.vertical)))}`;
			lines.push(`   ${theme.fg("dim", connector)} ${row.header}`);
			const body = row.outline ? outlineRows(row.outline, state.expanded, display.collapsedLines, theme) : proseRows(row.prose ?? [], state.expanded, display.collapsedLines, theme);
			for (const line of body) lines.push(`   ${theme.fg("dim", guide)} ${line}`);
			lines.push(...usageLines(row.id, `   ${guide} `));
		});
	}
	return lines.map(line => truncateToWidth(line, width));
}

type CardTakeover = { active: () => boolean; display: ToolDisplayState };

// LSP diagnostics ride along in edit/write details (top level, in `meta`, or per file). The
// edit outline draws its own; any other hydemods view would drop them, so those results keep
// the native card and its diagnostics tree.
function carriesDiagnostics(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const record = details as { diagnostics?: unknown; meta?: { diagnostics?: unknown }; perFileResults?: unknown[] };
	if (record.diagnostics || record.meta?.diagnostics) return true;
	return Array.isArray(record.perFileResults) && record.perFileResults.some(carriesDiagnostics);
}

// The hydemods view of one settled result, or undefined when the native renderer should draw it:
// takeover off, still streaming, plain text hydemods cannot improve, a JSON document OMP already
// shows as a tree, or a payload past the size cap. Failures get the same card in error colour
// rather than a different one.
function hydemodsResultComponent(toolName: string, result: { content: unknown; details?: unknown; isError?: boolean }, options: { expanded: boolean; isPartial: boolean }, theme: Theme, args: unknown, takeover: CardTakeover) {
	if (!takeover.active() || options.isPartial) return undefined;
	// A rejected edit is routine (stale anchor, retry follows): one line, full text on Ctrl+O.
	if (toolName === "edit" && result.isError && !options.expanded) {
		const message = toolResultText(result.content)?.trim() ?? "";
		const reason = message.split(/\n|(?<=\.)\s/)[0] ?? "edit rejected";
		return new Text(`${theme.fg("error", "✖ edit rejected:")} ${theme.fg("muted", reason)} ${theme.fg("dim", "(Ctrl+O)")}`, 0, 0);
	}
	const outline = toolName === "read" ? readOutlineStructured(result, args) : toolName === "edit" ? editOutlineStructured(result) : toolName === "write" ? writeOutlineStructured(result, args) : undefined;
	if (!outline && carriesDiagnostics(result.details)) return undefined;
	if (outline) {
		const details: ToolCardDetails = { toolName, result: outline.text, isError: false, cwd: process.cwd() };
		return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: options.expanded }, theme, takeover.display, outline);
	}
	// An edit that cannot be outlined is better shown as OMP's diff than as a file excerpt.
	if (toolName === "edit") return undefined;
	const resultText = toolResultText(result.content);
	// A shell command handed to the background: its eventual output arrives as its own message.
	if (toolName === "bash" && resultText && /^Backgrounded (early|as job)/.test(resultText)) {
		const job = /\bbg_\d+\b/.exec(resultText)?.[0];
		return new Text(theme.fg("muted", `↳ backgrounded${job ? ` as ${job}` : ""}; output follows when it finishes`), 0, 0);
	}
	if (!result.isError && nativeRendersJsonTree(toolName, args, resultText)) return undefined;
	// Huge results keep the native card: hydemods would re-parse, colour and Markdown-render
	// the whole payload on every repaint, and the native card already limits what it draws.
	if (resultText !== undefined && cappedRenderPayload(resultText) === undefined) return undefined;
	const payload = notebookPayload(toolName, args, result.isError) ?? extractToolPayload({ toolName, result });
	if (cappedRenderPayload(payload) === undefined) return undefined;
	const details: ToolCardDetails = { toolName, result: payload, isError: result.isError, cwd: process.cwd() };
	const structured = structureToolResult(details);
	// Plain shell text still carries a Wall-time footer worth lifting into a heading.
	if (structured.format === "text" && toolName === "bash") {
		const command = formatCommandText(structured.text);
		if (command) return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: options.expanded }, theme, takeover.display, command);
	}
	return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: options.expanded }, theme, takeover.display, structured);
}

// Draw hydemods results inside OMP's own tool card instead of beside it. Every bespoke
// renderer is wrapped so its result view defers to hydemods when hydemods applies; tools that
// fall to OMP's generic card keep it, except the ones listed in EXTRA_CARD_TOOLS. Because the
// native component owns the card, Ctrl+O expansion and hidden tool output apply unchanged.
const EXTRA_CARD_TOOLS = ["context_notes"];
// Tools whose native card is already the better view; hydemods never replaces these.
const NATIVE_CARD_TOOLS: Record<string, true> = { find: true };

function installNativeCardTakeover(takeover: CardTakeover): void {
	for (const [name, original] of Object.entries(toolRenderers)) {
		if (NATIVE_CARD_TOOLS[name]) continue;
		const wrapped: ToolRenderer = {
			...original,
			renderResult(result, options, theme, args) {
				const evalOptions = options as typeof options & {
					renderContext?: { previewLines?: number;[key: string]: unknown };
				};
				const fallbackOptions = name === "eval"
					? {
						...evalOptions,
						renderContext: {
							...evalOptions.renderContext,
							previewLines: takeover.display.collapsedLines,
						},
					}
					: options;
				return hydemodsResultComponent(name, result, options, theme, args, takeover)
					?? original.renderResult(result, fallbackOptions, theme, args);
			},
		};
		toolRenderers[name] = wrapped;
	}
	for (const name of EXTRA_CARD_TOOLS) {
		if (name in toolRenderers) continue;
		const fallback = (args: unknown, result: { content: unknown; isError?: boolean } | undefined, options: { expanded: boolean; isPartial: boolean }, theme: Theme) =>
			renderFallbackToolCard({
				label: name,
				args,
				result: result ? { output: toolResultText(result.content) ?? "", isError: result.isError } : undefined,
				options,
			}, theme);
		toolRenderers[name] = {
			mergeCallAndResult: true,
			renderCall: (args, options, theme) => fallback(args, undefined, options, theme),
			renderResult: (result, options, theme, args) =>
				hydemodsResultComponent(name, result, options, theme, args, takeover) ?? fallback(args, result, options, theme),
		};
	}
}

const COLLAPSED_LINE_PRESETS = [1, 3, 5, 10];

// The collapsed-lines control is a row in the panel's selection order (after the Interface
// tweaks); it is distinguished from tweaks by identity rather than by a tweak-shaped stub.
const COLLAPSED_LINES_ROW = Symbol("collapsed-lines");

function panelComponent(theme: ThemeLike, done: (result: undefined) => void, display: ToolDisplayState, onToggle?: () => void) {
	const groups: Record<TweakCategory, readonly Tweak[]> = {
		Interface: TWEAKS.filter((tweak) => tweak.category === "Interface"),
	};
	const selectable: Array<Tweak | typeof COLLAPSED_LINES_ROW> = [...groups.Interface, COLLAPSED_LINES_ROW];
	const body = new Box(2, 1);
	const content = new Text();
	let selectedIndex = 0;

	const collapsedLinesRow = (selected: boolean): string[] => {
		const marker = selected ? theme.fg("accent", "❯") : " ";
		const options = COLLAPSED_LINE_PRESETS.map(preset => preset === display.collapsedLines
			? theme.fg("accent", theme.bold(`[${preset}]`))
			: theme.fg("muted", ` ${preset} `));
		const custom = COLLAPSED_LINE_PRESETS.includes(display.collapsedLines) ? "" : theme.fg("accent", theme.bold(`[${display.collapsedLines}]`));
		const chooser = [...options, custom].filter(Boolean).join(theme.fg("muted", "·"));
		return [
			` ${marker} ${chooser}  ${theme.bold("Collapsed card lines")}`,
			theme.fg("muted", "           Lines a collapsed tool card shows before the omission marker."),
			"           ←/→ pick a preset; +/- step by one; also /hydemods collapsed-lines N.",
		];
	};

	const paint = () => {
		const lines: string[] = [
			theme.fg("accent", theme.bold("HYDEMODS")),
			theme.fg("muted", "Toggles persist globally in settings.yaml, not per session"),
			"",
		];

		for (const category of CATEGORIES) {
			const tweaks = groups[category];
			lines.push(theme.fg("accent", theme.bold(category)));
			for (const tweak of tweaks) {
				const selected = selectable[selectedIndex] === tweak;
				const marker = selected ? theme.fg("accent", "❯") : " ";
				const state = readSetting(tweak.setting) ? theme.fg("success", "● enabled") : theme.fg("muted", "○ disabled");
				lines.push(` ${marker} ${state}  ${theme.bold(tweak.title)}`);
				lines.push(theme.fg("muted", `           ${tweak.description}`));
				lines.push(`           ${tweak.render()}`);
			}
			lines.push(...collapsedLinesRow(selectable[selectedIndex] === COLLAPSED_LINES_ROW));
			lines.push("");
		}

		lines.push(theme.fg("border", "────────────────────────────────────────"));
		lines.push(theme.fg("muted", "↑/↓ or j/k select  ·  Space/Enter toggle or cycle  ·  ←/→ or +/- collapsed lines  ·  Esc/q close"));
		content.setText(lines.join("\n"));
		body.invalidate();
	};

	const moveSelection = (delta: number) => {
		if (selectable.length === 0) return;
		selectedIndex = (selectedIndex + delta + selectable.length) % selectable.length;
		paint();
	};

	const setCollapsedLines = (next: number) => {
		if (next < 1 || next === display.collapsedLines) return;
		display.collapsedLines = next;
		collapsedLinesSetting.set(settings, next);
		paint();
		onToggle?.();
	};

	// Presets in order; a custom value steps to the next preset above it (or wraps).
	const cyclePreset = (direction: 1 | -1) => {
		const current = COLLAPSED_LINE_PRESETS.indexOf(display.collapsedLines);
		if (current >= 0) {
			setCollapsedLines(COLLAPSED_LINE_PRESETS[(current + direction + COLLAPSED_LINE_PRESETS.length) % COLLAPSED_LINE_PRESETS.length]);
			return;
		}
		const above = COLLAPSED_LINE_PRESETS.find(preset => preset > display.collapsedLines);
		const below = [...COLLAPSED_LINE_PRESETS].reverse().find(preset => preset < display.collapsedLines);
		setCollapsedLines((direction === 1 ? above ?? COLLAPSED_LINE_PRESETS[0] : below ?? COLLAPSED_LINE_PRESETS[COLLAPSED_LINE_PRESETS.length - 1]));
	};

	const toggleSelected = () => {
		const row = selectable[selectedIndex];
		if (row === COLLAPSED_LINES_ROW) {
			cyclePreset(1);
			return;
		}
		if (!row) return;
		row.setting.set(settings, !readSetting(row.setting));
		paint();
		onToggle?.();
	};

	body.addChild(content);
	paint();

	return {
		render(width: number): readonly string[] {
			return body.render(width).map((line) => truncateToWidth(line, width));
		},
		invalidate() {
			body.invalidate();
		},
		handleInput(data: string) {
			if (data === "\u001b" || data === "q" || data === "Q") {
				done(undefined);
				return;
			}
			if (data === "\u001b[A" || data === "k" || data === "K") {
				moveSelection(-1);
				return;
			}
			if (data === "\u001b[B" || data === "j" || data === "J") {
				moveSelection(1);
				return;
			}
			if (data === "\u001b[C" || data === "l" || data === "L") {
				cyclePreset(1);
				return;
			}
			if (data === "\u001b[D" || data === "h" || data === "H") {
				cyclePreset(-1);
				return;
			}
			if (data === "+" || data === "=") {
				setCollapsedLines(display.collapsedLines + 1);
				return;
			}
			if (data === "-" || data === "_") {
				setCollapsedLines(display.collapsedLines - 1);
				return;
			}
			if (data === " " || data === "\r" || data === "\n") toggleSelected();
		},
	};
}

/* -------------------------------------------------------------------------- */
/*                               Extension Entry                              */
/* -------------------------------------------------------------------------- */

export default function hydemods(pi: ExtensionAPI): void {
	let stopStallWatch: (() => void) | undefined;
	const display: ToolDisplayState = { collapsedLines: readSetting(collapsedLinesSetting), cardsOn: true };
	const repaintToolCards = (ctx: ExtensionContext) => {
		// ExtensionUIContext exposes no repaint call, and no other extension-visible setter
		// invalidates drawn tool blocks; the interactive host's setToolsExpanded ends in
		// ui.requestRender(true), so re-setting the current value is the supported way to repaint
		// them. Needed when a toggle changes which renderer applies: with the takeover off,
		// hydemodsResultComponent falls back to the host renderer on the next paint.
		if (ctx.hasUI) ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
	};
	let lastCtx: ExtensionContext | undefined;
	const restoreToolDisplay = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		display.collapsedLines = readSetting(collapsedLinesSetting);
		repaintToolCards(ctx);
	};
	watchSetting(collapsedLinesSetting, value => {
		display.collapsedLines = value;
		if (lastCtx) repaintToolCards(lastCtx);
	});

	// hydemods draws inside OMP's tool card (never beside it). One native card per call; Ctrl+O
	// expansion and hidden tool output apply to it as usual. The hotkey below toggles whether
	// hydemods or the original renderer fills the result view for the session.
	const takeover: CardTakeover = { display, active: () => display.cardsOn && isTweakEnabled("integrated-tool-expansion") };
	installNativeCardTakeover(takeover);
	installReadGroupTakeover(takeover);
	// When hydemods tool cards are active, OMP's inline read previews are redundant and
	// clash with hydemods' read cards. Override it off while active; clear override when off.
	const syncReadPreviewMapping = () => {
		if (!isSettingsInitialized()) return;
		if (takeover.active()) {
			cfgReadToolResultPreview.override(hostSettings, false);
		} else {
			cfgReadToolResultPreview.clearOverride(hostSettings);
		}
	};
	syncReadPreviewMapping();
	const cardsTweak = TWEAKS.find((tweak) => tweak.name === "integrated-tool-expansion");
	if (cardsTweak) watchSetting(cardsTweak.setting, () => syncReadPreviewMapping());

	const toggleCards = (ctx: ExtensionContext) => {
		display.cardsOn = !display.cardsOn;
		syncReadPreviewMapping();
		repaintToolCards(ctx);
		if (ctx.hasUI) ctx.ui.notify(`hydemods cards ${display.cardsOn ? "on" : "off"}`, "info");
	};
	pi.registerShortcut("super+alt+o", { description: "Toggle hydemods tool cards", handler: toggleCards });
	pi.registerShortcut("ctrl+alt+o", { description: "Toggle hydemods tool cards (terminals without Cmd reporting)", handler: toggleCards });

	// Sessions saved before the takeover carry a hydemods card message per tool call; the native
	// card now shows that content, so those messages render as nothing.
	pi.registerMessageRenderer("integrated-tool-expansion", () => ({ render: () => [], invalidate() { } }));

	/* ------------------------- TOON for the model ------------------------- */

	// The model reads JSON tool results as TOON; the persisted result and every card keep the
	// original JSON. Encoded per call id and re-used until the result text changes (pruning).
	const toonByCallId = new Map<string, { source: string; toon: string | undefined }>();
	const TOON_CACHE_LIMIT = 2000;

	pi.on("context", (event) => {
		if (!isTweakEnabled("tool-results-toon")) return;
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "toolResult" || message.isError) return message;
			const source = toolResultText(message.content);
			if (source === undefined) return message;
			let cached = toonByCallId.get(message.toolCallId);
			if (!cached || cached.source !== source) {
				if (toonByCallId.size >= TOON_CACHE_LIMIT) toonByCallId.clear();
				cached = { source, toon: toonForModel(source) };
				toonByCallId.set(message.toolCallId, cached);
			}
			if (cached.toon === undefined) return message;
			changed = true;
			const images = message.content.filter((block) => block.type !== "text");
			return { ...message, content: [{ type: "text" as const, text: cached.toon }, ...images] };
		});
		return changed ? { messages } : undefined;
	});

	/* --------------------------- Session Identity --------------------------- */

	let lastPrompt = "";

	// One-line preview of the prompt: code fences, tags, and newlines collapsed.
	const flattenPrompt = (text: string): string =>
		text
			.replace(/```[\s\S]*?```/g, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();

	// Drawer above the editor: as much of the latest prompt as fits, then an ellipsis.
	const refreshLastPromptDrawer = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const preview = flattenPrompt(lastPrompt);
		if (!isTweakEnabled("last-prompt-drawer") || !preview) {
			ctx.ui.setWidget("hydemods:last-prompt", undefined);
			return;
		}
		ctx.ui.setWidget(
			"hydemods:last-prompt",
			(_tui, theme) => ({
				render(width: number): readonly string[] {
					const body = truncateToWidth(preview, Math.max(1, width - 2), Ellipsis.Unicode);
					return [`${theme.fg("muted", "❯ ")}${theme.fg("dim", body)}`];
				},
				invalidate() { },
			}),
			{ placement: "aboveEditor" },
		);
	};

	const latestUserPrompt = (ctx: ExtensionContext): string => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type !== "message") continue;
			const m = (e as { message?: { role?: string; content?: string | unknown[] } }).message;
			if (m?.role !== "user") continue;
			if (typeof m.content === "string") return m.content;
			if (Array.isArray(m.content)) {
				return m.content
					.filter((c: unknown): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
					.map((c) => c.text)
					.join(" ");
			}
		}
		return "";
	};


	/* ---------------------------- Latest thought ---------------------------- */

	// OMP's own thinking blocks stay hidden (hideThinkingBlock) while this is on; the panel shows only
	// the newest thought block, tailing it while it streams.
	const THOUGHT_PANEL_LINES = 8;
	let latestThought = "";
	let thoughtTui: { requestRender(): void } | undefined;

	type ThinkingBlock = { type: "thinking"; thinking: string };
	const isThinkingBlock = (block: unknown): block is ThinkingBlock =>
		typeof block === "object" && block !== null && "type" in block && block.type === "thinking" && "thinking" in block && typeof block.thinking === "string" && block.thinking.trim().length > 0;
	const lastThinkingText = (message: { role?: unknown; content?: unknown } | undefined): string | undefined => {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
		return message.content.findLast(isThinkingBlock)?.thinking.trim();
	};

	const latestSessionThought = (ctx: ExtensionContext): string => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			const text = entry.type === "message" && "message" in entry ? lastThinkingText(entry.message) : undefined;
			if (text) return text;
		}
		return "";
	};

	const syncHostThinkingVisibility = (enabled: boolean) => {
		if (!isSettingsInitialized()) return;
		// The host re-applies this to every assistant message on screen when it changes.
		if (enabled) cfgHideThinkingBlock.override(hostSettings, true);
		else cfgHideThinkingBlock.clearOverride(hostSettings);
	};

	const refreshThoughtPanel = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!isTweakEnabled("latest-thought-panel")) {
			ctx.ui.setWidget("hydemods:latest-thought", undefined);
			thoughtTui = undefined;
			return;
		}
		ctx.ui.setWidget(
			"hydemods:latest-thought",
			(tui, theme) => {
				thoughtTui = tui;
				let cache: { text: string; width: number; lines: string[] } | undefined;
				return {
					render(width: number): readonly string[] {
						if (!latestThought) return [];
						if (cache?.text !== latestThought || cache.width !== width) {
							const wrapped = latestThought.split("\n").filter((line) => line.trim()).flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 4)));
							const shown = wrapped.slice(-THOUGHT_PANEL_LINES);
							const earlier = wrapped.length - shown.length;
							const header = theme.fg("muted", `✻ thinking${earlier > 0 ? ` · ${earlier} earlier line${earlier === 1 ? "" : "s"}` : ""}`);
							cache = { text: latestThought, width, lines: [header, ...shown.map((line) => `  ${theme.italic(theme.fg("thinkingText", line))}`)] };
						}
						return cache.lines;
					},
					invalidate() {
						cache = undefined;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	};

	const noteThought = (message: { role?: unknown; content?: unknown }) => {
		if (!isTweakEnabled("latest-thought-panel")) return;
		const text = lastThinkingText(message);
		if (!text || text === latestThought) return;
		latestThought = text;
		thoughtTui?.requestRender();
	};
	pi.on("message_update", (event, ctx) => {
		noteThought(event.message);
		guardRunawayEdit(event.message, ctx);
	});

	// Large files come back with pruned snapshots, and the card is redrawn long after later
	// edits change the disk. Capture the outline now, while the disk still matches this diff.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit" || event.isError || !event.details || typeof event.details !== "object") return undefined;
		// EditToolDetails is the host's type; hydemods reads the subset it outlines from.
		const details: EditOutlineDetails = event.details;
		if (typeof details.newText === "string" || details.hydemodsOutline !== undefined) return undefined;
		const outline = editOutlineStructured({ content: event.content, details });
		return outline ? { details: { ...event.details, hydemodsOutline: outline.text } } : undefined;
	});

	// Runaway edit guard: a model stuck repeating apply_patch markers streams until the output
	// cap (~38 min). Abort the turn as soon as the pattern shows and tell the agent to retry small.
	let guardedTimestamp: number | undefined;
	const guardRunawayEdit = (message: MessageUpdateEvent["message"], ctx: ExtensionContext) => {
		if (message.role !== "assistant" || guardedTimestamp === message.timestamp) return;
		const runaway = runawayEdit(message.content);
		if (!runaway) return;
		guardedTimestamp = message.timestamp;
		ctx.abort();
		pi.sendMessage(
			{ customType: "hydemods-runaway-edit", display: true, content: `Aborted a runaway edit call (${runaway.markers} "*** End Patch" markers, ${runaway.kb} KB). The edit tool has no Begin/End Patch markers. Re-issue it as small hashline ops, one region per call, or use write with the whole file.` },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};
	pi.on("message_end", (event) => noteThought(event.message));

	const thoughtTweak = TWEAKS.find((tweak) => tweak.name === "latest-thought-panel");
	if (thoughtTweak) {
		syncHostThinkingVisibility(readSetting(thoughtTweak.setting));
		watchSetting(thoughtTweak.setting, (enabled) => {
			syncHostThinkingVisibility(enabled);
			if (lastCtx) refreshThoughtPanel(lastCtx);
		});
	}

	/* ----------------------------- Session title ---------------------------- */

	// `titleSource` is on the live SessionManager but outside the read-only pick the context
	// exposes; it is the only way to tell a host-chosen name from one the user typed.
	const titleSourceOf = (ctx: ExtensionContext): unknown => "titleSource" in ctx.sessionManager ? ctx.sessionManager.titleSource : undefined;

	// A host-chosen name is still the host's to replace. Saving it again through the extension
	// API records it as the user's, which the host's replan re-title refuses to overwrite.
	const pinHostTitle = async (ctx: ExtensionContext) => {
		if (!isTweakEnabled("session-title")) return;
		const name = pi.getSessionName();
		if (!name || titleSourceOf(ctx) !== "auto") return;
		await pi.setSessionName(name);
	};

	let titleInFlightFor: string | undefined;
	const nameSessionFromPrompt = async (prompt: string, ctx: ExtensionContext) => {
		if (!isTweakEnabled("session-title") || !isSettingsInitialized()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const decision = { prompt, sessionName: pi.getSessionName(), sessionId, inFlightFor: titleInFlightFor, isLocalCommand: prompt.startsWith("/") };
		if (!shouldGenerateTitle(decision)) return;
		titleInFlightFor = sessionId;
		try {
			const title = await generateSessionTitle(prompt, ctx.modelRegistry, hostSettings, sessionId, ctx.model);
			// The session may have been switched or named by hand while the model was thinking.
			if (!title || ctx.sessionManager.getSessionId() !== sessionId || pi.getSessionName()) return;
			await pi.setSessionName(title);
		} finally {
			if (titleInFlightFor === sessionId) titleInFlightFor = undefined;
		}
	};

	const sessionTitleTweak = TWEAKS.find((tweak) => tweak.name === "session-title");
	if (sessionTitleTweak) {
		setHostAutoTitle(!readSetting(sessionTitleTweak.setting));
		watchSetting(sessionTitleTweak.setting, (enabled) => { setHostAutoTitle(!enabled); });
	}

	// Provider factories persist on the UI and are re-applied on every refresh, so install once per UI.
	// Each drawer re-reads its setting per keystroke, so toggling needs no reinstall.
	const drawersInstalled = new WeakSet<object>();
	const installDrawers = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || drawersInstalled.has(ctx.ui)) return;
		drawersInstalled.add(ctx.ui);
		ctx.ui.addAutocompleteProvider((inner) => withVaultDrawer(inner as EditorProvider, () => isTweakEnabled("vault-url-drawer")) as typeof inner);
		ctx.ui.addAutocompleteProvider((inner) => withPrDrawer(inner as EditorProvider, () => isTweakEnabled("pr-url-drawer")) as typeof inner);
		if (isTweakEnabled("pr-url-drawer")) void refreshMyPrs(); // warm the cache so the first pr:// is instant
	};

	// Runs inside the stalled subagent's own extension instance, so steer/abort hit that agent.
	const actOnOwnToolStall = (stall: StallAlert, ctx: ExtensionContext) => {
		const tool = stall.toolName ?? "tool";
		if (stall.action === "check-in") {
			pi.sendMessage({ customType: "hydemods-stall", display: true, content: `Stall check-in: your ${tool} call has run ${Math.floor(stall.idleMinutes)} minutes. When it returns, report what it was doing and whether it is still making progress before continuing.` }, { deliverAs: "steer" });
		} else if (stall.action === "kill") {
			ctx.abort();
			pi.sendMessage({ customType: "hydemods-stall", display: true, content: `Your ${tool} call was aborted after ${Math.floor(stall.idleMinutes)} minutes without progress. Do not rerun it as-is: narrow it (smaller scope, a timeout, or async), then continue the task.` }, { deliverAs: "followUp", triggerTurn: true });
		}
	};
	pi.registerMessageRenderer<StallMessageDetails>("hydemods-stall", (message, _options, theme) => {
		const stall = message.details;
		if (!stall) return undefined;
		const what = stall.kind === "tool" ? `in ${stall.toolName ?? "a tool"}` : `waiting on ${stall.model ?? "the model"}`;
		const color = stall.action === "kill" ? "error" : "warning";
		const next = stall.action === "kill" ? "turn aborted" : stall.action === "check-in" ? "asked to check in" : `kill: proc://${stall.agentName}/kill`;
		return new Text(`${theme.fg(color, "⏸ Stalled")} ${theme.bold(stall.agentName)}  ${theme.fg("dim", `${Math.floor(stall.idleMinutes)}m ${what} · ${next}`)}`, 1, 0);
	});

	// Background monitors: wake this session when a watched shell check settles.
	const monitors = new MonitorRegistry({
		// Login zsh loads ~/.zprofile (PATH for gh, bun, mise) but not ~/.zshrc, keeping output free of interactive-setup noise.
		exec: (command, cwd, signal, timeoutMs) => pi.exec("zsh", ["-lc", command], { cwd, signal, timeout: timeoutMs }),
		notify: (spec, result) =>
			pi.sendMessage<MonitorMessageDetails>(
				{ customType: "hydemods-monitor", display: true, content: formatMonitorResult(spec, result), details: { spec, result } },
				{ deliverAs: "steer", triggerTurn: true },
			),
	});
	pi.registerMessageRenderer<MonitorMessageDetails>("hydemods-monitor", (message, { expanded }, theme) => {
		if (!message.details) return undefined;
		const { spec, result } = message.details;
		const ok = result.outcome === "satisfied" || (result.outcome === "exited" && result.code === 0);
		const label = {
			satisfied: "✓ condition met",
			exited: `${result.code === 0 ? "✓" : "✗"} exited ${result.code}`,
			"timed-out": `⏱ timed out after ${spec.timeoutMin}m`,
			error: "✗ failed to run",
		}[result.outcome];
		const status = theme.fg(ok ? "success" : result.outcome === "timed-out" ? "warning" : "error", label);
		const meta = theme.fg("dim", `${result.elapsedSec}s · ${result.runs} run${result.runs === 1 ? "" : "s"}`);
		const lines = result.output ? result.output.split("\n") : [];
		const shown = expanded ? lines : lines.slice(-MONITOR_COLLAPSED_LINES);
		const hidden = lines.length - shown.length;
		const rows = [
			`${theme.fg("accent", "Monitor")} ${theme.bold(spec.name)}  ${status}  ${meta}`,
			theme.fg("dim", `$ ${spec.command}`),
			...(hidden > 0 ? [theme.fg("muted", `… ${hidden} earlier line${hidden === 1 ? "" : "s"} (Ctrl+O)`)] : []),
			...shown.map(line => theme.fg("text", line)),
		];
		return new Text(rows.join("\n"), 1, 0);
	});
	let monitorSessionFile: string | undefined;
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		loadMode: "essential",
		description: [
			"Start, list, or cancel a background monitor: a shell check that runs without blocking you and wakes you with a message when it settles.",
			"Use instead of sleep/poll loops (CI, PR reviews, deploys, long jobs). After `start`, end your turn or do other work; do not wait or poll — the result arrives as a new message.",
			'mode "poll" (default) re-runs `command` every `intervalSec` until it exits 0, or until `until` (regex over stdout+stderr) matches. Make the command print the status you are waiting for.',
			'mode "exit" runs `command` once (e.g. `gh pr checks 123 --watch`) and reports when it exits, whatever the code.',
			"Every monitor reports once: condition met, exited, timed out (`timeoutMin`), or failed to run. Starting a monitor with an existing name replaces it. Monitors live in this session and stop on reload or session switch.",
		].join("\n"),
		parameters: Type.Object({
			op: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("cancel")]),
			name: Type.Optional(Type.String({ description: "Unique monitor name (required for start/cancel)." })),
			command: Type.Optional(Type.String({ description: "Shell command (bash -lc). Required for start." })),
			mode: Type.Optional(Type.Union([Type.Literal("poll"), Type.Literal("exit")])),
			until: Type.Optional(Type.String({ description: "Poll mode: regex over output that means done. Default: exit code 0." })),
			intervalSec: Type.Optional(Type.Number({ description: "Poll interval, default 30, min 5." })),
			timeoutMin: Type.Optional(Type.Number({ description: "Give up and report after this many minutes, default 60." })),
			cwd: Type.Optional(Type.String({ description: "Working directory, default the session cwd." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });
			if (params.op === "list") {
				const rows = monitors.list();
				return text(rows.length ? rows.map(r => `${r.name} [${r.mode}] ${r.runs} runs, ${r.elapsedSec}s: ${r.command}${r.last ? `\n  last: ${r.last.split("\n").at(-1)}` : ""}`).join("\n") : "No monitors running.");
			}
			if (!params.name) throw new Error("`name` is required.");
			if (params.op === "cancel") return text(monitors.cancel(params.name) ? `Cancelled monitor "${params.name}".` : `No monitor named "${params.name}".`);
			if (!params.command) throw new Error("`command` is required for start.");
			const spec: MonitorSpec = {
				name: params.name,
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
				mode: params.mode ?? "poll",
				until: params.until,
				intervalSec: Math.max(5, params.intervalSec ?? 30),
				timeoutMin: Math.max(0.1, params.timeoutMin ?? 60),
			};
			void monitors.start(spec);
			return text(`Monitor "${spec.name}" started (${spec.mode}, timeout ${spec.timeoutMin}m). You will get a message when it settles; end your turn or continue other work — do not poll.`);
		},
	});
	// One handler per session event, each running the per-feature session work in a fixed order.
	const onSession = (_event: unknown, ctx: ExtensionContext) => {
		stopStallWatch?.();
		stopStallWatch = undefined;
		const sessionFile = ctx.sessionManager.getSessionFile();
		// Monitors report into the session that started them; drop them when the session changes.
		if (sessionFile !== monitorSessionFile) monitors.cancelAll();
		monitorSessionFile = sessionFile;
		const alerted = new Set<string>();
		if (sessionFile) {
			const check = () => {
				if (!isTweakEnabled("stalled-agent-alerts")) return;
				for (const stall of detectStalls(sessionFile, new Date(), defaultStallThresholds(), alerted, WATCH_STARTED_AT)) {
					// Subagents (no UI) act on their own stalled tool call; the UI session only notifies.
					if (!ctx.hasUI && stall.path === sessionFile && stall.kind === "tool") actOnOwnToolStall(stall, ctx);
					if (!ctx.hasUI) continue;
					ctx.ui.notify(stall.message, "warning");
					execFile("osascript", ["-e", `display notification ${JSON.stringify(stall.message)} with title "OMP agent stalled"`], () => { });
					// This instance runs in the main session, so posting here reaches the main agent:
					// it steers a busy turn, or starts a turn when idle, so it can kill/respawn/nudge.
					if (stall.path !== sessionFile) {
						pi.sendMessage(
							{ customType: "hydemods-stall", display: true, content: `[hydemods stall-watch, automated] ${stall.message}`, details: { agentName: stall.agentName, kind: stall.kind, idleMinutes: stall.idleMinutes, action: stall.action, toolName: stall.toolName, model: stall.model } },
							{ deliverAs: "steer", triggerTurn: true },
						);
					}
				}
			};
			const timer = ctx.setInterval(check, 30_000);
			stopStallWatch = () => ctx.clearTimer(timer);
			check();
		}
		installDrawers(ctx);
		restoreToolDisplay(ctx);
		lastPrompt = latestUserPrompt(ctx);
		latestThought = latestSessionThought(ctx);
		refreshThoughtPanel(ctx);
		refreshLastPromptDrawer(ctx);
		void pinHostTitle(ctx);
	};
	pi.on("session_start", onSession);
	pi.on("session_switch", onSession);
	pi.on("session_branch", onSession);
	pi.on("session_tree", onSession);

	pi.on("before_agent_start", (event, ctx) => {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (prompt.trim().length > 0) {
			lastPrompt = prompt;
			refreshLastPromptDrawer(ctx);
			void nameSessionFromPrompt(prompt, ctx);
		}
	});

	/* ------------------------------ Commands -------------------------------- */

	pi.registerCommand("rename", {
		description: "Rename the current session",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /rename <title>", "warning");
				return;
			}
			await pi.setSessionName(name);
			ctx.ui.notify(`Session renamed to "${name}"`, "info");
		},
	});



	pi.registerCommand("hydemods", {
		description: "Open the tweak panel or set collapsed-lines N (default 5, saved to settings)",
		handler: async (args, ctx) => {
			const [command, value, ...extra] = args.trim().split(/\s+/);
			if (command) {
				if (command === "collapsed-lines" && value === undefined) {
					if (ctx.hasUI) ctx.ui.notify(`Collapsed line limit: ${display.collapsedLines}; default: ${DEFAULT_COLLAPSED_LINES}`, "info");
					return;
				}
				const next = Number(value);
				if (command !== "collapsed-lines" || !value || !/^\d+$/.test(value) || extra.length || !Number.isInteger(next) || next < 1) {
					if (ctx.hasUI) ctx.ui.notify("Use /hydemods collapsed-lines N, where N is a positive whole number.", "warning");
					return;
				}
				collapsedLinesSetting.set(settings, next);
				display.collapsedLines = next;
				repaintToolCards(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Collapsed line limit set to ${next}; saved to settings.`, "info");
				return;
			}
			// Setting collapsed-lines works headless; only opening the panel needs the UI.
			if (!ctx.hasUI) return;
			await ctx.ui.custom(
				(_tui, theme, keybindings, done) => {
					const component = panelComponent(
						theme,
						done,
						display,
						() => {
							syncReadPreviewMapping();
							refreshLastPromptDrawer(ctx);
						},
					);
					return {
						...component,
						handleInput(data: string) {
							if (keybindings.matches(data, "app.interrupt") || data === "q" || data === "Q") {
								done(undefined);
								return;
							}
							component.handleInput(data);
						},
					};
				},
				{ overlay: true },
			);
		},
	});
}
