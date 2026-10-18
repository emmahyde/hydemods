import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "@oh-my-pi/pi-coding-agent";
import { Box, Ellipsis, formatMetricRow, Markdown, type MetricSpec, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { code as codeNode } from "@oh-my-pi/pi-tui/native/describe";
// Only host-mapped specifiers share the running instance; a deeper pi-tui path would patch a private copy.
import { AssistantMessageComponent, ReadToolGroupComponent, ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components";
import { installToolRuns, type RunCard } from "./lib/tool-runs";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { summarizeCode } from "@oh-my-pi/pi-natives";
import { completeSimple, type Usage } from "@oh-my-pi/pi-ai";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { theme as uiTheme } from "@oh-my-pi/pi-tui/theme";
import { fileHyperlink, previewWindowRows } from "@oh-my-pi/pi-tui/render";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import type { ToolRenderer } from "@oh-my-pi/pi-tui/tools";
import { readSourceFsPath, renderFallbackToolCard, renderTaskToolCard, splitPathAndSel } from "./lib/host-copies";
import { green } from "./lib/colors";
import { cardGutter, hiddenSize, rowSuffix } from "./lib/card-gutter";
import { testSummaryLine } from "./lib/test-summary";
import { commandSourcePath, compactBlocks, groupGrepPrefixes, isBraceLanguage, joinLoneClosers, printsLineNumbers, extensionOf, scanComments, stripComments, stripLineNumbers } from "./lib/source-text";
import { presentReadExcerpt } from "./lib/read-display";
import { outlineMarkdown, outlineSource, recoverOldText, renderEditOutline, renderGrepOutline, renderMarkdownOutline, renderOutline, renderRange, type GrepFileMatches, type Outline } from "./lib/code-outline";
import { referenceLocations } from "./lib/reference-output";
// Keep helper modules below lib/: configured extension roots scan direct .ts files.
import { setHostAutoTitle, shouldGenerateTitle } from "./lib/session-title";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { isSettingsInitialized, settings as hostSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgReadToolResultPreview } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cappedRenderPayload, collapseTextLines, decodeNestedJson, formatJsonOutput, formatFileExcerpt, isFileExcerpt, formatSearchOutput, formatCommandText, formatJsonWithFooter, markdownOutput, parseGrepOutput, parseTabularData, parseYamlDocument, sanitizeTerminalText, separateGeneratedNoticeFooter, stripGeneratedNoticeFooter } from "./lib/tool-output";
import { splitArchiveOutput } from "./lib/archive-output";
import { decodeEvalOutput } from "./lib/eval-output";
import { EvalSummaryCache } from "./lib/eval-summary";
import { TOOL_ROWS_MODES, type Complete } from "./lib/tool-rows";
import { ToolRows } from "./lib/tool-rows-host";
import { compactEvalResult, fitCollapseLine } from "./lib/eval-collapse";
import { underlineLabel, underlinePathTokens } from "./lib/path-styling";
import { booleanSetting, enumSetting, hostOverrideSettings, integerSetting, readSetting, settings, stringSetting, watchSetting } from "./lib/settings";
import { stylePlainBlocks } from "./lib/plain-blocks";
import { backgroundAnsi } from "./lib/message-bg";
import { BG_PRESETS, SURFACES, SURFACE_LABELS, installMessageBackgrounds, isHexColor, resolveBackground, type Surface, type ThemeLookups } from "./lib/message-bg";
import { registerHelperDrawers } from "./lib/helper-drawers";
import { installInternalLinks, linkComponentRows, linkTarget, uninstallInternalLinks } from "./lib/internal-links";
import { linkHandlerInstalled, startLinkServer, type LinkServer } from "./lib/link-bridge";
import { drawerScheme } from "./lib/drawer-types";
import { randomUUID } from "node:crypto";
import { vaultDrawer } from "./lib/drawer-vault";
import { contentDrawer } from "./lib/drawer-content";
import { runtimeDrawer } from "./lib/drawer-runtime";
import { remoteDrawer } from "./lib/drawer-remote";
import { fetchMyPrs, refreshMyPrs, withPrDrawer, withVaultDrawer, type EditorProvider } from "./lib/url-drawers";
import { withXdDrawer, withProcDrawer } from "./lib/xd-proc-drawers";
import { xdSourcesFor, procSourcesFor, asyncJobsFor } from "./lib/host-runtime";
import { registerMarketplace } from "./lib/marketplace";
import { registerUrlPreviewLifecycle } from "./lib/url-previews";
import { applyClassifications, assignTier, formatRorMessage, groupByTier, loadRorConfig, prKey, readyPrs, resolvePrRefs, rorConfigPath, saveRorConfig, sendSelfDm } from "./lib/ror";
import { classifyPrs, loadGuidance, rorGuidancePath } from "./lib/ror-classify";
import type { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { execFile } from "node:child_process";
import { detectStalls, defaultStallThresholds, type StallAlert } from "./lib/stall-watch";
import { formatMonitorEvent, formatMonitorResult, MonitorRegistry, type MonitorJobsHost, type MonitorResult, type MonitorSpec } from "./lib/monitors";
import { waitStatusLine } from "./lib/wait-status";
import { agentModel, callModel, EFFORTS, type AgentModelParams, type CallModelParams } from "./lib/model-tools";
import { type Candidate, formatRecommendations, RECOMMEND_MARKER, recommend, stripRecommendMarker, takeMarkedPrompts } from "./lib/recommend";
import { journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { cfgDisabledExtensions, cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";

type MonitorMessageDetails = { spec: MonitorSpec; result: MonitorResult };
type MonitorEventDetails = { spec: MonitorSpec; lines: string[] };
const MONITOR_COLLAPSED_LINES = 8;
import { runawayEdit } from "./lib/runaway-edit";

type StallMessageDetails = Pick<StallAlert, "agentName" | "kind" | "idleMinutes" | "action" | "toolName" | "model">;
// Subagents never outlive the OMP process, so transcripts untouched since load are dead, not stalled.
const WATCH_STARTED_AT = Date.now();

type TweakCategory = "Interface" | "Colors" | "Tools" | "Safeguards";

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
		title: "TOON tool results",
		description: "Formats structured tool results as TOON in cards and model context.",
		category: "Interface",
		render: () => "Unpacks JSON, printed Eval tool envelopes, and MCP JSON blocks. Uniform arrays share one header. Read and grep results retain AST context.",
	},
	{
		name: "eval-command-summaries",
		title: "Eval command summaries",
		description: "Uses the tiny model to describe each Eval command without delaying execution.",
		category: "Interface",
		render: () => "Shows a short intent summary when ready. Uses @tiny or @smol, never the primary model; falls back to the original title on failure.",
	},
	{
		name: "ast-structuring",
		title: "AST structuring",
		description: "Shows file reads, writes, edits and source printed by bash as declaration outlines instead of raw text.",
		category: "Interface",
		render: () => "Declarations are parsed with tree-sitter; bodies fold to a line count. Comments and line-number gutters are always stripped from displayed source. Off shows the plain excerpt; the model sees the same output either way.",
	},
	{
		name: "plain-code-blocks",
		title: "Plain code blocks stand out",
		description: "Tints fenced blocks that have no language tag and hangs a green bar on their left.",
		category: "Interface",
		render: () => "The host leaves untagged fences unhighlighted, so mockups, logs and diagrams blend into prose. Tagged blocks (```ts) keep their syntax colors.",
	},
	{
		name: "tool-runs",
		title: "Collapse earlier tool calls",
		description: "Folds every card in an unbroken run of tool calls to its header row, keeping the newest full.",
		category: "Interface",
		render: () => "A run is tool calls with no user message and no assistant text between them. Failed and still-running cards stay full; Ctrl+O expands everything.",
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
		description: "Keeps thinking out of the transcript and shows only the newest thought block below the editor.",
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
		name: "internal-url-drawers",
		title: "Interactive URL drawers",
		description: "Browse and inspect all 19 internal URL schemes before inserting a reference.",
		category: "Interface",
		render: () => "Type a URL and Tab, /browse, or Ctrl+Shift+U. Remote content loads only with Ctrl+F.",
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
	{
		name: "monitor-tool",
		title: "monitor tool",
		description: "Gives the agent the monitor tool: background shell watchers that wake it on events instead of polling.",
		category: "Tools",
		render: () => "Off removes the tool from the active set; running monitors (including ror-watch) keep going.",
	},
	{
		name: "call-model-tool",
		title: "call_model tool",
		description: "Gives the agent call_model: a one-shot prompt to any configured model, returning its text.",
		category: "Tools",
		render: () => "Also used by /ror classification, which is not affected by this toggle.",
	},
	{
		name: "agent-model-tool",
		title: "agent_model tool",
		description: "Gives the agent agent_model: override which model a task subagent type runs on, for the session.",
		category: "Tools",
		render: () => "Overrides are session-only.",
	},
	{
		name: "recommend-tools",
		title: "recommend_tools tool",
		description: "Gives the agent recommend_tools: the judge model ranks available tools and skills for a task.",
		category: "Tools",
		render: () => "Each call costs one judge request per 40 candidates, billed to the session.",
	},
	{
		name: "ror",
		title: "ror tool and /ror command",
		description: "Ready-for-review digest of your open PRs to a Slack DM, with tiers, labels, and watch.",
		category: "Tools",
		render: () => "Off removes the ror tool and makes /ror a no-op. Config and tiers live in the ror.json file.",
	},
	{
		name: "runaway-edit-guard",
		title: "Runaway edit guard",
		description: "Aborts a streaming edit call stuck repeating apply_patch end markers and tells the agent to retry small.",
		category: "Safeguards",
		render: () => "Triggers on 3+ \"*** End Patch\" markers or an edit input over 96 KB.",
	},
];

const TWEAKS: Tweak[] = TWEAK_DEFS.map(def => ({ ...def, setting: booleanSetting(def.name, def.title, def.description) }));

const isTweakEnabled = (name: string): boolean => {
	const tweak = TWEAKS.find(t => t.name === name);
	return tweak ? readSetting(tweak.setting) : false;
};

const CATEGORIES: readonly TweakCategory[] = ["Interface", "Colors", "Tools", "Safeguards"];

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
	"Content rows shown in a collapsed tool card; an inline glyph marks the hidden rows.",
	DEFAULT_COLLAPSED_LINES,
);

const toolRowsSetting = enumSetting(
	"tool-rows",
	"Tool rows",
	"How tool calls draw. cards: OMP's tool cards. lines: one row per call, described by a local model, with no gaps. group: one row per burst of calls, summarized by a local model once the agent replies. Ctrl+O shows the cards.",
	TOOL_ROWS_MODES,
	"lines",
);
const toolRowsModelSetting = stringSetting(
	"tool-rows-model",
	"Tool rows model",
	"Local model (see `omp tiny-models`) that writes tool row lines. It runs on the Apple GPU when providers.tinyModelDevice is mlx.",
	"llama3.2:3b",
	value => {
		if (!value.trim()) throw new Error("hydemods.toolRowsModel must name a local model");
	},
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

		const displayMatch = /^display\[\d+\]:\s*\n([\s\S]*)$/.exec(stripGeneratedNoticeFooter(rawText).trim());
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

		const trimmedRaw = stripGeneratedNoticeFooter(rawText).trim();
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

		if (useToon) {
			const tabular = parseTabularData(text);
			if (tabular !== undefined && tabular.length > 0) {
				try {
					return formatJsonOutput(tabular, useToon);
				} catch {
					// Fall through
				}
			}
		}
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
	const { body, footer } = separateGeneratedNoticeFooter(text);
	const trimmed = body.trim();
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
		if (output.format !== "toon") return undefined;
		return footer ? `${output.text}\n${footer.trimStart()}` : output.text;
	} catch {
		return undefined;
	}
}

// True when OMP's own card already draws this result as a JSON tree: the tool (or the xd://
// device behind a write) has no bespoke renderer and the text is one JSON document.
function nativeRendersJsonTree(toolName: string, args: unknown, text: string | undefined): boolean {
	if (text === undefined) return false;
	const trimmed = stripGeneratedNoticeFooter(text).trimEnd();
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
	// Markdown heading row: indent, hashes, heading text, line number
	const mdRow = /^(\s*)(#{1,6})\s+(.*?)(  :\d+)?$/.exec(line);
	if (mdRow) {
		const indent = mdRow[1];
		const hashes = theme.fg("syntaxKeyword", mdRow[2]);
		const title = theme.fg("syntaxType", mdRow[3]);
		const lineTarget = mdRow[4] ? theme.fg("dim", mdRow[4]) : "";
		return `${indent}${hashes} ${title}${lineTarget}`;
	}
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
	// Already coloured by whatever printed it. Tokenising would wrap the digits inside `\x1b[38;2;…m`
	// and shred the escape itself, leaving bare `38;2;91;192;190m` fragments on screen.
	if (line.includes("\x1b[")) return line;
	if (format === "links") return line;
	if (format === "outline") return colorizeOutlineLine(line, theme);
	if (format === "edit-outline") return colorizeEditOutlineLine(line, theme);
	if (format === "command") {
		if (/^\s*Result(?: \d+)?(?:;|$)/.test(line)) return theme.fg(/; failed(?:;|$)/.test(line) ? "error" : "accent", line);
		return line;
	}
	if (/^\s*(?:\[[^\]\r\n]+#(?:[\da-f]+|:[^\]\r\n]*)?\]|#{1,6} .+#[\da-f]+|#{1,6} .+\/)\s*$/i.test(line)) return theme.fg("dim", line);
	if (/^\s*\[(?:Showing lines|truncated;|Source:)/.test(line) || /^\s*(?:…|\.\.\.)\s*$/.test(line)) return theme.fg("dim", line);
	if (format === "file") {
		if (/^\s*[\w$]+(?:\[\d+\])?(?:\{[^}]+\})?:\s/.test(line)) return colorizeAstToonLine(line, theme);
		// Check for line-numbered source code output: e.g. "4:describe(...)" or "   4│ const x = 1;"
		const lineNumbered = /^(\s*\*?\d+[:│])\s*(.*)$/.exec(line);
		if (lineNumbered) {
			const num = theme.fg("dim", lineNumbered[1]);
			const code = colorizeCodeLine(lineNumbered[2], theme);
			return `${num} ${code}`;
		}
		return colorizeCodeLine(line, theme);
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

// Tool-card styling: the host card owns the background.
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

// File excerpts show `[name#:range]` instead of the snapshot header; the code under it loses its
// line numbers and comments. The host's display text wins over the model-facing text.
function commentFreeText(structured: StructuredText, displayText?: string): string {
	if (structured.format !== "file" || !/^\[[^\]#\r\n]+#[\da-f]+\]\r?\n/i.test(structured.text)) {
		return stripGeneratedNoticeFooter(structured.text);
	}
	const shown = presentReadExcerpt({ text: structured.text, displayContent: displayText === undefined ? undefined : { text: displayText }, filenameShown: false });
	return shown.header ? `${shown.header}\n${shown.body}` : shown.body;
}

function toolMessageRenderer(message: ToolMessage, options: RendererOptions, theme: Theme, display: ToolDisplayState, structured: StructuredText = structureToolResult(message.details)) {
	const details = message.details;
	const toolName = details?.toolName || "tool";
	const error = details?.isError;
	const resultDetails = (details?.result as { details?: ReadOutlineDetails } | undefined)?.details;
	const pretty = commentFreeText(structured, resultDetails?.displayContent?.text).trim() || "(empty)";
	const rawLines = pretty
		.split(/\r?\n/)
		.map((line) => line.replace(/\t/g, "  ").trimEnd())
		.filter((line) => structured.format === "command" || line.length > 0);

	const label = theme.fg(error ? "error" : "success", toolName);
	// A quote-style rule between the tool name and its output; continuation rows carry it too.
	const rule = error ? theme.fg("error", "│") : green("│");
	const trailingRule = error ? theme.fg("error", "┆") : green("┆");
	const coloredPrefix = `${label} ${rule} `;
	// Continuation lines hang under the first content column (visible width of "name ").
	const indent = " ".repeat(`${toolName} `.length);
	const hangingIndent = `${indent}${rule} `;

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
			let hiddenLines = 0;
			let selected: string[] = [
				...(structured.format === "edit-outline"
					? tree.filter((_, index) => !/^\s{3,}[+−→] /.test(rawLines[index]))
					: tree),
			];
			if (selected.length > limit) {
				// Output reads in order: the first rows, with what follows reported by the size in the last gutter.
				hiddenLines = selected.length - Math.max(1, limit);
				selected = selected.slice(0, Math.max(1, limit));
			}
			if (diagnosticsAt >= 0) {
				const messages = renderedContent.slice(diagnosticsAt + 1);
				const kept = collapseTextLines(messages, 3, false, { marker: () => theme.fg("muted", "[...]") });
				selected = [...selected, renderedContent[diagnosticsAt], ...kept];
			}
			// Every card ends on a dashed rule; hidden rows are reported as an estimated size (Ctrl+O shows them).
			const hiddenText = hiddenLines > 0 && diagnosticsAt < 0 ? hiddenSize(pretty) : undefined;
			return selected.map((line, index) => {
				const isFirst = index === 0;
				const isLast = index === selected.length - 1;
				const gutter = cardGutter({ prefix: isFirst ? coloredPrefix : hangingIndent, rule, trailingRule, indentWidth: indent.length, isFirst, isLast, hiddenText });
				return padToolBlockLine(truncateToWidth(`${gutter}${line}${rowSuffix(isFirst, isLast, hiddenText)}`, width), width);
			});
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
		// Comments never appear on a card, so signatures are read from the comment-free text; lines stay put.
		outline = outlineSource(path ? scanComments(code, extensionOf(path)).lines.join("\n") : code, { path }, summarizeCode);
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
// A grep result enriched with AST declaration context for matching lines.
function grepOutlineStructured(result: { content: unknown; details?: unknown; isError?: boolean }): StructuredText | undefined {
	if (result.isError) return undefined;
	const details = (result.details ?? {}) as {
		displayContent?: string;
		cwd?: string;
		files?: string[];
		scopePath?: string;
		searchPath?: string;
	};

	const rawText = details.displayContent ?? toolResultText(result.content) ?? "";
	if (!rawText || rawText === "No matches found") return undefined;

	// Parse file blocks and line matches from grep displayContent or raw output.
	// OMP grep output uses either:
	// 1) Single-file format: [path/to/file#hash] or starting directly with matches when scopePath is given.
	// 2) Multi-file format: markdown headings:
	//    # /dir/path/
	//    ## sub/
	//    ### file.ts#C690
	// 3) Line rows:
	//    Context: `  12: text` or `  12│text`
	//    Matches: ` *13: text` or ` *13│text`
	//    Elisions: `    │...`
	const lines = rawText.split(/\r?\n/);
	const filesMap = new Map<string, Array<{ line: number; text: string; starred: boolean }>>();
	let currentFile: string | undefined;
	const dirStack: string[] = [];

	for (const line of lines) {
		const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
		if (headingMatch) {
			const level = headingMatch[1].length;
			let headingTarget = headingMatch[2].trim();
			// Strip trailing tag like #D5B3
			const hashIndex = headingTarget.indexOf("#");
			if (hashIndex > 0) headingTarget = headingTarget.slice(0, hashIndex).trim();

			if (headingTarget.endsWith("/")) {
				// Directory heading
				dirStack.length = Math.min(dirStack.length, level - 1);
				dirStack[level - 1] = headingTarget;
				currentFile = undefined;
			} else {
				// File heading
				dirStack.length = Math.min(dirStack.length, level - 1);
				const dirPrefix = dirStack.join("");
				const candidatePath = dirPrefix ? `${dirPrefix}${headingTarget}` : headingTarget;
				currentFile = candidatePath;
				if (!filesMap.has(currentFile)) filesMap.set(currentFile, []);
			}
			continue;
		}

		const bracketMatch = /^\[([^\]#\s]+)(?:#[a-f0-9]+)?\]$/i.exec(line);
		if (bracketMatch) {
			currentFile = bracketMatch[1];
			if (!filesMap.has(currentFile)) filesMap.set(currentFile, []);
			continue;
		}

		if (!currentFile && details.scopePath && (line.includes(":") || line.includes("│"))) {
			currentFile = details.scopePath;
			if (!filesMap.has(currentFile)) filesMap.set(currentFile, []);
		}

		if (currentFile) {
			const matchLine = /^\s*(\*)?\s*(\d+)[│:]\s?(.*)$/.exec(line);
			if (matchLine) {
				const starred = Boolean(matchLine[1]);
				const lineNum = Number(matchLine[2]);
				const matchText = matchLine[3];
				filesMap.get(currentFile)!.push({ line: lineNum, text: matchText, starred });
			}
		}
	}

	if (filesMap.size === 0) return undefined;

	const fileMatchesList: GrepFileMatches[] = [];
	for (const [filePath, rows] of filesMap.entries()) {
		// When any row in the file is explicitly starred (*), filter to only starred rows (actual matches, not context)
		const hasStarred = rows.some(r => r.starred);
		const filtered = hasStarred ? rows.filter(r => r.starred) : rows;
		if (filtered.length > 0) {
			fileMatchesList.push({
				path: filePath,
				matches: filtered.map(r => ({ line: r.line, text: r.text })),
			});
		}
	}
	if (fileMatchesList.length === 0) return undefined;

	const outlineForFile = (filePath: string) => {
		const baseDir = details.cwd ?? process.cwd();
		const resolved = resolve(baseDir, filePath.startsWith("~/") ? resolve(homedir(), filePath.slice(2)) : filePath);
		try {
			const stat = statSync(resolved);
			const code = readFileSync(resolved, "utf8");
			const stamp = `${stat.size}:${stat.mtimeMs}`;
			const outline = memoOutline(`disk:${resolved}:${stamp}`, code, resolved);
			return { outline, lines: code.split(/\r?\n/) };
		} catch {
			return undefined;
		}
	};

	const rendered = renderGrepOutline(fileMatchesList, outlineForFile);
	if (!rendered) return undefined;

	return { text: rendered.join("\n"), format: "outline" };
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
		const isMarkdown = /\.(?:md|markdown|mdx)$/i.test(fsPath);
		if (isMarkdown) {
			const mdOutline = outlineMarkdown(text);
			if (mdOutline && mdOutline.headings.length > 0) {
				return { text: renderMarkdownOutline(mdOutline, label).join("\n"), format: "outline", lang: "markdown", path: fsPath };
			}
		}
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
	const scan = scanComments(disk, extensionOf(fsPath));
	const rows = renderRange(outline, scan.lines, rangeStart, endLine, label, scan.dropped);
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
// What each grouped read block was told, recorded by the takeover below; tool rows read it too.
const readGroupStates = new WeakMap<ReadToolGroupComponent, ReadGroupState>();

function installReadGroupTakeover(takeover: CardTakeover): void {
	const states = readGroupStates;
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
	const details = result.details as ReadOutlineDetails | undefined;
	const modelText = toolResultText(result.content);
	const displayText = details?.displayContent?.text;
	const isExcerpt = displayText !== undefined || (modelText !== undefined && /^\[[^\]#\r\n]+#[\da-f]+\]\r?\n/i.test(modelText));
	const header = isExcerpt ? `[${shown}]` : shown;
	// The row above already names the file, so only the code body is shown.
	const text = isExcerpt
		? presentReadExcerpt({ text: modelText ?? "", displayContent: displayText === undefined ? undefined : { text: displayText }, path: split.path, selector: split.sel || undefined, filenameShown: true }).body.trim()
		: stripGeneratedNoticeFooter(modelText ?? "").trim();
	return { header: /^[a-z][a-z0-9+.-]*:\/\//i.test(split.path) ? uiTheme.fg("accent", header) : uiTheme.fg("accent", underlineLabel(header)), prose: text ? text.split(/\r?\n/) : undefined };
}

// A read drops blank rows, and a collapsed preview keeps the first rows and ends at a `… N more`
// row: keeping the last row would leave a lone `}` hanging below the count. Expanded shows all.
function collapseReadRows(kept: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	if (expanded || kept.length <= limit) return kept;
	const shown = Math.max(1, limit - 1);
	return [...kept.slice(0, shown), theme.fg("muted", `… ${kept.length - shown} more`)];
}

function outlineRows(outline: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	return collapseReadRows(outline.filter(line => line.trim() !== "").map(line => colorizeOutlineLine(line, theme)), expanded, limit, theme);
}

function proseRows(prose: string[], expanded: boolean, limit: number, theme: Theme): string[] {
	const colored = prose.filter(line => line.trim() !== "").map(line => {
		// Check for line-numbered source code output: e.g. "4:describe(...)" or "   4│ const x = 1;"
		const lineNumbered = /^(\s*\*?\d+[:│])\s*(.*)$/.exec(line);
		if (lineNumbered) return `${theme.fg("dim", lineNumbered[1])} ${colorizeCodeLine(lineNumbered[2], theme)}`;
		if (/^\[[^\]]+#[0-9a-fA-F]+\]$/.test(line)) return theme.fg("dim", line);
		return colorizeCodeLine(line, theme);
	});
	return collapseReadRows(colored, expanded, limit, theme);
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
	return lines.map(line => fitCollapseLine(line, width));
}

type CardTakeover = {
	active: () => boolean;
	display: ToolDisplayState;
	summary?: (language: string, code: string) => string | undefined;
	/** Click target for internal URLs in card rows, or undefined while links have nowhere to go. */
	linkTarget?: () => ((uri: string) => string) | undefined;
};

// LSP diagnostics ride along in edit/write details (top level, in `meta`, or per file). The
// edit outline draws its own; any other hydemods view would drop them, so those results keep
// the native card and its diagnostics tree.
function carriesDiagnostics(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const record = details as { diagnostics?: unknown; meta?: { diagnostics?: unknown }; perFileResults?: unknown[] };
	if (record.diagnostics || record.meta?.diagnostics) return true;
	return Array.isArray(record.perFileResults) && record.perFileResults.some(carriesDiagnostics);
}

// A todo update is one row: the task that just finished (green, checked), else the one just
// started, else the overall count. The native card's phase-by-phase listing waits for Ctrl+O.
function todoOneLine(details: unknown, theme: Theme): string | undefined {
	const todo = details as { phases?: { tasks: { content: string; status: string }[] }[]; completedTasks?: { content: string }[] } | undefined;
	if (!todo || !Array.isArray(todo.phases)) return undefined;
	const done = todo.completedTasks ?? [];
	if (done.length > 0) return `${green(`☑ ${done[0].content}`)}${done.length > 1 ? theme.fg("muted", ` +${done.length - 1}`) : ""}`;
	const tasks = todo.phases.flatMap(phase => phase.tasks);
	const active = tasks.find(task => task.status === "in_progress");
	if (active) return theme.fg("accent", `☐ ${active.content}`);
	const finished = tasks.filter(task => task.status === "completed").length;
	return theme.fg("muted", `${finished}/${tasks.length} done`);
}

// Source a shell command printed (`sed -n`, `cat`, `grep -n`) gets the treatment a read gets: the
// line-number gutter is dropped, comments go, and where the command names the file, the text
// folds into its declaration outline. Output that is not numbered and names no file stays plain.
function bashSourceStructured(args: unknown, text: string, ast: boolean): StructuredText | undefined {
	const command = (args as { command?: unknown } | undefined)?.command;
	const path = typeof command === "string" ? commandSourcePath(command) : undefined;
	const cleaned = stripGeneratedNoticeFooter(sanitizeTerminalText(text).replace(/\r\n/g, "\n")).replace(/\n+Wall time: [^\n]*\s*$/, "");
	const numbering = typeof command === "string" && printsLineNumbers(command);
	// Rows that all begin `path:line:` (grep -rn, or any tool printing that shape) group under one header per file.
	const grouped = groupGrepPrefixes(cleaned);
	if (grouped.grouped) return { text: grouped.text.replace(/^\n+|\s+$/g, ""), format: "code" };
	const stripped = stripLineNumbers(cleaned, numbering ? 1 : undefined);
	if (!path && !stripped.numbered) return undefined;
	const ext = path ? extensionOf(path) : undefined;
	const code = stripComments(stripped.text, ext).replace(/^\n+|\s+$/g, "");
	if (!code) return undefined;
	if (path && ast) {
		const outline = memoOutline(`bash:${path}:${Bun.hash(code)}`, code, path);
		if (outline && outline.declarations.length > 0) {
			return { text: renderOutline(outline, displayPath(path)).join("\n"), format: "outline", lang: outline.language, path };
		}
	}
	const compact = isBraceLanguage(ext) ? compactBlocks(code, { singleQuotes: ext !== "rs" && ext !== "go" }) : joinLoneClosers(code);
	return { text: compact.split("\n").filter(row => row.trim() !== "").join("\n"), format: "code", lang: ext };
}

// The hydemods view of one settled result, or undefined when the native renderer should draw it:
// takeover off, still streaming, plain text hydemods cannot improve, a JSON document OMP already
// shows as a tree, or a payload past the size cap. Failures get the same card in error colour
// rather than a different one.

// Eval envelopes are data, never executable source.
function evalStructuredValue(value: unknown): StructuredText {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const envelope = value as { text?: unknown; details?: ReadOutlineDetails; hasError?: boolean };
		if (typeof envelope.text === "string" && !envelope.hasError) {
			const source = envelope.details && readSourceFsPath(envelope.details as Parameters<typeof readSourceFsPath>[0]);
			const result = { content: [{ type: "text", text: envelope.text }], details: envelope.details };
			const outline = source && readOutlineStructured(result, { path: source });
			if (outline) return outline;
			if (Object.keys(value).every(key => key === "text")) return evalStructuredValue(envelope.text);
			if (envelope.details && typeof (envelope.details as { displayContent?: unknown }).displayContent === "string") {
				const grep = grepOutlineStructured(result);
				if (grep) return grep;
			}
		}
	}
	if (typeof value === "string") {
		const raw = sanitizeTerminalText(value);
		if (/^\s*\*\d+[:│]|^#{1,3} .+/m.test(raw)) {
			const grep = grepOutlineStructured({ content: [{ type: "text", text: raw }] });
			if (grep) return grep;
		}
		const blocks = raw.split(/(?=^\[[^\]\r\n]+#[\da-f]{4}\]\r?$)/im);
		let changed = false;
		const rendered = blocks.map(block => {
			const header = /^\[([^\]\r\n]+)#[\da-f]{4}\]\r?\n/i.exec(block);
			if (!header) return block;
			const lines = block.slice(header[0].length).split(/\r?\n/);
			const numbers: Array<number | null> = [];
			const sourceLines: string[] = [];
			let at = 0;
			for (; at < lines.length; at++) {
				const row = /^(\d+):(.*)$/.exec(lines[at]);
				if (row) { numbers.push(Number(row[1])); sourceLines.push(row[2]); }
				else if (/^\s*…\s*$/.test(lines[at])) { numbers.push(null); sourceLines.push("…"); }
				else break;
			}
			if (!numbers.some(n => n !== null)) return block;
			const outline = readOutlineStructured({
				content: [], details: {
					resolvedPath: header[1], truncation: { truncated: true },
					displayContent: { text: sourceLines.join("\n"), startLine: numbers.find(n => n !== null), lineNumbers: numbers },
				}
			}, { path: header[1] });
			if (!outline) return block;
			changed = true;
			return outline.text + "\n" + lines.slice(at).join("\n");
		});
		if (changed) return { text: rendered.join(""), format: "outline" };
	}
	return structuredResult(value);
}

function formatEvalText(value: unknown, theme: Theme): string {
	const structured = evalStructuredValue(value);
	return structured.text.split("\n").map(line => colorizeStructuredLine(line, structured.format, theme)).join("\n");
}

// Archive listings are rendered as data cards; the prose around them keeps its normal treatment.
function formatEvalArchiveText(raw: string, theme: Theme): string | undefined {
	const segments = splitArchiveOutput(sanitizeTerminalText(raw));
	if (!segments.some(segment => segment.kind === "archive")) return undefined;
	return segments.map(segment => {
		if (segment.kind === "prose") return segment.text ? formatEvalText(segment.text, theme) : "";
		const structured = formatJsonOutput(segment.value);
		const card = structured.text.split("\n").map(line => colorizeStructuredLine(line, structured.format, theme)).join("\n");
		return segment.text.endsWith("\n") ? card + "\n" : card;
	}).join("");
}

function formatEvalPrintedOutput(text: string, theme: Theme): string {
	const cleaned = stripGeneratedNoticeFooter(text);
	if (cappedRenderPayload(cleaned) === undefined) return cleaned;
	return decodeEvalOutput(cleaned).map(part => {
		try {
			if ("value" in part) return formatEvalText(part.value, theme);
			return formatEvalArchiveText(part.raw, theme) ?? formatEvalText(part.raw, theme);
		} catch {
			// Malformed tool metadata must not prevent the original output from being read.
			return sanitizeTerminalText(part.raw);
		}
	}).join("");
}

type EvalViewArgs = { code?: string; language?: string; title?: string; cells?: EvalViewArgs[] };
type EvalViewResult = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };

function evalViewArgs(args: unknown, takeover: CardTakeover, expanded = false): unknown {
	if (!args || typeof args !== "object") return args;
	const input = args as EvalViewArgs;
	const limit = Math.min(takeover.display.collapsedLines, previewWindowRows());
	const summarize = (cell: EvalViewArgs) => {
		const code = typeof cell.code === "string" && !expanded && cappedRenderPayload(cell.code) !== undefined
			? collapseTextLines(cell.code.split(/\r?\n/), limit, false, { marker: "[...]" }).join("\n")
			: cell.code;
		return {
			...cell,
			...(code !== undefined ? { code } : {}),
			title: typeof cell.code === "string" ? takeover.summary?.(cell.language ?? "python", cell.code) ?? cell.title : cell.title,
		};
	};
	return input.cells ? { ...input, cells: input.cells.map(summarize) } : summarize(input);
}

// Freeze settled outlines against their returned snapshot, not later disk contents.
const evalViewOutputs = new WeakMap<object, { cells?: string[]; output?: string; json?: string }>();
function evalViewResult(result: EvalViewResult, partial: boolean, theme: Theme, takeover: CardTakeover): EvalViewResult {
	const details = (result.details ?? {}) as { cells?: Array<EvalViewArgs & { output: string; textOutput?: string; hasMarkdown?: boolean; status?: string }>; jsonOutputs?: unknown[] };
	if (details.jsonOutputs?.some(value => cappedRenderPayload(value) === undefined)) return result;
	let formatted = partial ? undefined : evalViewOutputs.get(result);
	if (!partial && !formatted) {
		const json = details.jsonOutputs?.map(value => {
			try {
				const structured = evalStructuredValue(value);
				return structured.text.split("\n").map(line => colorizeStructuredLine(line, structured.format, theme)).join("\n");
			} catch {
				return sanitizeTerminalText(JSON.stringify(value, null, 2) ?? String(value));
			}
		}).join("\n\n");
		formatted = {
			cells: details.cells?.map(cell => {
				const sourceOutput = details.jsonOutputs?.length && cell.textOutput !== undefined ? cell.textOutput : cell.output;
				return cell.hasMarkdown ? sourceOutput : formatEvalPrintedOutput(sourceOutput, theme);
			}),
			output: details.cells?.length ? undefined : formatEvalPrintedOutput(toolResultText(result.content) ?? "", theme),
			json,
		};
		evalViewOutputs.set(result, formatted);
	}
	const cells = details.cells?.map((cell, index) => {
		const summary = takeover.summary?.(cell.language ?? "python", cell.code ?? "");
		const extra = index === details.cells!.length - 1 ? formatted?.json : undefined;
		const baseOutput = formatted?.cells?.[index] ?? (details.jsonOutputs?.length && cell.textOutput !== undefined ? cell.textOutput : cell.output);
		const combinedOutput = [baseOutput, extra].filter(Boolean).join("\n\n");
		return {
			...cell, title: summary ?? cell.title,
			output: combinedOutput,
			...(cell.textOutput !== undefined ? { textOutput: combinedOutput } : {}),
		};
	});
	const output = formatted && !cells?.length ? [formatted.output, formatted.json].filter(Boolean).join("\n\n") : undefined;
	return {
		...result,
		content: output === undefined ? result.content : [
			{ type: "text", text: output },
			...(Array.isArray(result.content) ? result.content.filter(item => item.type !== "text") : []),
		],
		details: { ...details, ...(cells ? { cells } : {}), ...(formatted ? { jsonOutputs: [] } : {}) },
	};
}

type EvalArchiveCell = EvalViewArgs & { output: string; textOutput?: string; hasMarkdown?: boolean; status?: string; exitCode?: number; durationMs?: number; statusEvents?: Array<Record<string, unknown>>; statusEventsElided?: number };

// A settled, successful Eval whose printed output holds archive listings becomes one hydemods card
// (code, archive data, prose, status, foot) in place of the native cell box. Failed, partial or
// oversized results return undefined and keep the native box, so errors stay as the host draws them.
function evalArchiveCard(result: EvalViewResult, partial: boolean, expanded: boolean, takeover: CardTakeover): string | undefined {
	if (partial || result.isError || !takeover.active()) return undefined;
	const details = (result.details ?? {}) as { cells?: EvalArchiveCell[]; jsonOutputs?: unknown[] };
	const cells = details.cells;
	if (!cells?.length || details.jsonOutputs?.some(value => cappedRenderPayload(value) === undefined)) return undefined;
	if (cells.some(cell => (cell.status !== undefined && cell.status !== "complete") || (cell.exitCode !== undefined && cell.exitCode !== 0) || cell.hasMarkdown)) return undefined;
	const outputs = cells.map(cell => cell.textOutput ?? cell.output);
	if (outputs.some(output => cappedRenderPayload(output) === undefined)) return undefined;
	const split = outputs.map(output => splitArchiveOutput(sanitizeTerminalText(output)));
	if (!split.some(segments => segments.some(segment => segment.kind === "archive"))) return undefined;
	const rows: string[] = [];
	cells.forEach((cell, index) => {
		const code = cell.code ?? "";
		rows.push(`eval: ${takeover.summary?.(cell.language ?? "python", code) ?? cell.title ?? code.split("\n")[0]}`);
		if (expanded && code) rows.push("code:", ...code.split("\n").map(line => `  ${sanitizeTerminalText(line)}`));
		for (const segment of split[index]) {
			const body = segment.kind === "archive" ? formatJsonOutput(segment.value).text : segment.text;
			rows.push(...body.replace(/\s+$/, "").split("\n").filter(line => line.trim() !== ""));
		}
		const hidden = cell.statusEventsElided ?? 0;
		if (hidden > 0) rows.push(`status: ${hidden} earlier`);
		for (const event of cell.statusEvents ?? []) {
			const fields = Object.entries(event).filter(([key, value]) => key !== "op" && key !== "resolvedThinkingLevel" && ["string", "number", "boolean"].includes(typeof value));
			rows.push(`status: ${sanitizeTerminalText(String(event.op ?? "event"))}${fields.map(([key, value]) => ` ${key}=${sanitizeTerminalText(String(value))}`).join("")}`);
		}
		rows.push(`foot: done${cell.exitCode === undefined ? "" : ` · exit ${cell.exitCode}`}${cell.durationMs === undefined ? "" : ` · ${cell.durationMs} ms`}`);
	});
	for (const value of details.jsonOutputs ?? []) rows.push(...formatJsonOutput(value).text.split("\n"));
	return rows.join("\n");
}
function hydemodsResultComponent(toolName: string, result: { content: unknown; details?: unknown; isError?: boolean }, options: { expanded: boolean; isPartial: boolean }, theme: Theme, args: unknown, takeover: CardTakeover) {
	if (!takeover.active()) return undefined;
	// Background-job wait: one status line collapsed; the full snapshot stays in the model result and on Ctrl+O.
	if (toolName === "wait") {
		const intent = typeof (args as { i?: unknown } | undefined)?.i === "string" ? (args as { i: string }).i : undefined;
		const line = waitStatusLine(result, { ...options, intent }, theme);
		return line === undefined ? undefined : new Text(line, 0, 0);
	}
	if (options.isPartial) return undefined;
	// A rejected edit is routine (stale anchor, retry follows): one line, full text on Ctrl+O.
	if (toolName === "edit" && result.isError && !options.expanded) {
		const message = toolResultText(result.content)?.trim() ?? "";
		const reason = message.split(/\n|(?<=\.)\s/)[0] ?? "edit rejected";
		return new Text(`${theme.fg("error", "edit rejected:")} ${theme.fg("muted", reason)} ${theme.fg("dim", "(Ctrl+O)")}`, 0, 0);
	}
	if (toolName === "todo" && !result.isError && !options.expanded) {
		const line = todoOneLine(result.details, theme);
		if (line) {
			const details: ToolCardDetails = { toolName, result: line, isError: false, cwd: process.cwd() };
			return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details }, { expanded: false }, theme, takeover.display, { text: line, format: "command" });
		}
	}
	const astOn = isTweakEnabled("ast-structuring");
	const outline = !astOn ? undefined : toolName === "read" ? readOutlineStructured(result, args) : toolName === "edit" ? editOutlineStructured(result) : toolName === "write" ? writeOutlineStructured(result, args) : toolName === "grep" ? grepOutlineStructured(result) : undefined;
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
	if (toolName === "bash" && !result.isError && resultText) {
		const summary = testSummaryLine(sanitizeTerminalText(resultText), theme);
		if (summary) return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details: { toolName, result: summary, isError: false, cwd: process.cwd() } }, { expanded: options.expanded }, theme, takeover.display, { text: summary, format: "command" });
		const source = bashSourceStructured(args, resultText, isTweakEnabled("ast-structuring"));
		if (source) return toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details: { toolName, result: source.text, isError: false, cwd: process.cwd() } }, { expanded: options.expanded }, theme, takeover.display, source);
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
const EXTRA_CARD_TOOLS = ["context_notes", "wait"];
// Tools whose native card is already the better view; hydemods never replaces these.
const NATIVE_CARD_TOOLS: Record<string, true> = { find: true };

function installNativeCardTakeover(takeover: CardTakeover): void {
	for (const [name, original] of Object.entries(toolRenderers)) {
		if (NATIVE_CARD_TOOLS[name]) continue;
		const wrapped: ToolRenderer = {
			...original,
			renderCall(args, options, theme) {
				const expanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
				return original.renderCall(name === "eval" && takeover.active() ? evalViewArgs(args, takeover, expanded) : args, options, theme);
			},
			renderResult(result, options, theme, args) {
				if (name === "eval") {
					const archiveExpanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
					const archiveCard = evalArchiveCard(result, options.isPartial, archiveExpanded, takeover);
					if (archiveCard !== undefined) {
						const card = toolMessageRenderer({ customType: "integrated-tool-expansion", content: "", details: { toolName: "eval", result: archiveCard, isError: false, cwd: process.cwd() } }, { expanded: archiveExpanded }, theme, takeover.display, { text: archiveCard, format: "toon" });
						return takeover.linkTarget ? linkComponentRows(card, takeover.linkTarget) : card;
					}
					const context = (options as { renderContext?: { expanded?: boolean; output?: string } }).renderContext;
					const nativeOptions = {
						...options, renderContext: {
							...(options as { renderContext?: object }).renderContext,
							previewLines: takeover.display.collapsedLines,
						}
					};
					const active = takeover.active();
					const formatted = active ? evalViewResult(result, options.isPartial, theme, takeover) : result;
					const expanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
					const callArgs = active ? evalViewArgs(args, takeover, expanded) : args;
					const base = original.renderResult(formatted, nativeOptions, theme, callArgs);
					if (!active || !base) return base;
					let cachedWidth = -1;
					let cachedLimit = -1;
					let component = base;
					return Object.assign(Object.create(base), {
						render(width: number): readonly string[] {
							const limit = Math.min(takeover.display.collapsedLines, previewWindowRows());
							if (width !== cachedWidth || limit !== cachedLimit) {
								cachedWidth = width;
								cachedLimit = limit;
								component = original.renderResult(compactEvalResult(formatted, { expanded, limit, width, theme, output: context?.output }), { ...nativeOptions, renderContext: { ...nativeOptions.renderContext, output: undefined } }, theme, callArgs) ?? base;
							}
							return component.render(width);
						},
						invalidate() { cachedWidth = -1; component.invalidate?.(); },
					});
				}
				if (name === "task") {
					const taskCard = renderTaskToolCard(result, options, theme);
					if (taskCard) return taskCard;
				}
				const card = hydemodsResultComponent(name, result, options, theme, args, takeover);
				return card && takeover.linkTarget ? linkComponentRows(card, takeover.linkTarget) : card ?? original.renderResult(result, options, theme, args);
			},
		};
		if (original.describeCall) wrapped.describeCall = (args, options) => {
			const expanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
			return original.describeCall!(name === "eval" && takeover.active() ? evalViewArgs(args, takeover, expanded) : args, options);
		};
		if (original.describeResult) {
			wrapped.describeResult = (result, options, args) => {
				if (name === "eval") {
					const archiveExpanded = (options as { renderContext?: { expanded?: boolean } }).renderContext?.expanded ?? options.expanded;
					const archiveCard = evalArchiveCard(result, options.isPartial, archiveExpanded, takeover);
					if (archiveCard !== undefined) return {
						...original.describeResult!(result, options, evalViewArgs(args, takeover)),
						body: [codeNode(archiveCard, { lang: "yaml" })],
						preview: { lines: takeover.display.collapsedLines },
					};
					const active = takeover.active();
					const context = (options as { renderContext?: { expanded?: boolean; output?: string } }).renderContext;
					const expanded = context?.expanded ?? options.expanded;
					const formatted = active ? evalViewResult(result, options.isPartial, uiTheme, takeover) : result;
					const limit = Math.min(takeover.display.collapsedLines, previewWindowRows());
					return original.describeResult!(
						active ? compactEvalResult(formatted, { expanded, limit, theme: uiTheme, output: context?.output }) : result,
						{ ...options, renderContext: { ...context, ...(active ? { output: undefined } : {}), previewLines: takeover.display.collapsedLines } },
						active ? evalViewArgs(args, takeover, expanded) : args,
					);
				}
				if (takeover.active() && !options.isPartial) {
					const resultText = toolResultText(result.content);
					if (resultText !== undefined && cappedRenderPayload(resultText) !== undefined) {
						const payload = notebookPayload(name, args, result.isError) ?? extractToolPayload({ toolName: name, result });
						if (cappedRenderPayload(payload) !== undefined) {
							const structured = structureToolResult({ toolName: name, result: payload, isError: result.isError, cwd: process.cwd() });
							if (structured.format === "toon") return {
								...original.describeResult!(result, options, args),
								body: [codeNode(structured.text, { lang: "yaml" })],
								preview: { lines: takeover.display.collapsedLines },
							};
						}
					}
				}
				return original.describeResult!(result, options, args);
			};
		}
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
			renderResult: (result, options, theme, args) => {
				const card = hydemodsResultComponent(name, result, options, theme, args, takeover);
				return card && takeover.linkTarget ? linkComponentRows(card, takeover.linkTarget) : card ?? fallback(args, result, options, theme);
			},
		};
	}
}

// Preset name plus an optional #rrggbb override per surface; the hex wins when set.
const BG_SETTINGS = Object.fromEntries(SURFACES.map((surface) => [surface, {
	preset: stringSetting(`${surface}-bg`, SURFACE_LABELS[surface], `Preset tint behind ${SURFACE_LABELS[surface].toLowerCase().replace(" background", "s")}. "off" keeps the theme color.`, "off", (name) => {
		if (!BG_PRESETS.some((preset) => preset.name === name)) throw new Error(`hydemods.${surface}Bg must be one of: ${BG_PRESETS.map((preset) => preset.name).join(", ")}`);
	}),
	hex: stringSetting(`${surface}-bg-hex`, `${SURFACE_LABELS[surface]} (hex)`, "A #rrggbb color that overrides the preset. Empty clears it.", "", (value) => {
		if (value !== "" && !isHexColor(value)) throw new Error(`hydemods.${surface}BgHex must be #rrggbb or empty`);
	}),
}])) as Record<Surface, { preset: Setting<string>; hex: Setting<string> }>;

const BG_ROWS: readonly { surface: Surface }[] = SURFACES.map((surface) => ({ surface }));

const COLLAPSED_LINE_PRESETS = [1, 3, 4, 5, 10];

// The collapsed-lines control is a row in the panel's selection order (after the Interface
// tweaks); it is distinguished from tweaks by identity rather than by a tweak-shaped stub.
const COLLAPSED_LINES_ROW = Symbol("collapsed-lines");

function panelComponent(theme: ThemeLike, done: (result: undefined) => void, display: ToolDisplayState, onToggle?: () => void) {
	const groups = Object.fromEntries(CATEGORIES.map((category) => [category, TWEAKS.filter((tweak) => tweak.category === category)])) as unknown as Record<TweakCategory, readonly Tweak[]>;
	type PanelRow = Tweak | typeof COLLAPSED_LINES_ROW | (typeof BG_ROWS)[number];
	const selectable = CATEGORIES.flatMap<PanelRow>((category) => category === "Interface" ? [...groups[category], COLLAPSED_LINES_ROW] : category === "Colors" ? [...BG_ROWS] : groups[category]);
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
			theme.fg("muted", "           Content rows per collapsed card; [...] marks truncation inline."),
			"           ←/→ pick a preset; +/- step by one; also /hydemods collapsed-lines N.",
		];
	};

	const bgRow = (row: (typeof BG_ROWS)[number], selected: boolean): string[] => {
		const marker = selected ? theme.fg("accent", "❯") : " ";
		const preset = readSetting(BG_SETTINGS[row.surface].preset);
		const hex = readSetting(BG_SETTINGS[row.surface].hex);
		const chooser = BG_PRESETS.map((candidate) => candidate.name === preset ? theme.fg("accent", theme.bold(`[${candidate.name}]`)) : theme.fg("muted", ` ${candidate.name} `)).join(theme.fg("muted", "·"));
		return [
			` ${marker} ${chooser}  ${theme.bold(SURFACE_LABELS[row.surface])}`,
			theme.fg("muted", isHexColor(hex) ? `           Hex ${hex} from settings.yaml wins over the preset.` : `           ←/→ or Space picks a preset; hydemods.${row.surface}BgHex in settings.yaml sets any #rrggbb.`),
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
			if (category === "Interface") lines.push(...collapsedLinesRow(selectable[selectedIndex] === COLLAPSED_LINES_ROW));
			if (category === "Colors") for (const row of BG_ROWS) lines.push(...bgRow(row, selectable[selectedIndex] === row));
			lines.push("");
		}

		lines.push(theme.fg("border", "────────────────────────────────────────"));
		lines.push(theme.fg("muted", "↑/↓ or j/k select  ·  Space/Enter toggle or cycle  ·  ←/→ cycle preset  ·  +/- collapsed lines  ·  Esc/q close"));
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

	const cycleBg = (surface: Surface, direction: 1 | -1) => {
		const names = BG_PRESETS.map((candidate) => candidate.name);
		const current = Math.max(0, names.indexOf(readSetting(BG_SETTINGS[surface].preset)));
		BG_SETTINGS[surface].preset.set(settings, names[(current + direction + names.length) % names.length]);
		paint();
		onToggle?.();
	};

	// Presets in order; a custom value steps to the next preset above it (or wraps).
	const cyclePreset = (direction: 1 | -1) => {
		const selectedRow = selectable[selectedIndex];
		if (typeof selectedRow === "object" && "surface" in selectedRow) {
			cycleBg(selectedRow.surface, direction);
			return;
		}
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
		if (typeof row === "object" && "surface" in row) {
			cycleBg(row.surface, 1);
			return;
		}
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
	registerMarketplace(pi);
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
	// Prompt, response, and tool call backgrounds. The Theme and assistant component are wrapped once
	// a session exists (the live theme is not initialized when the extension loads).
	let backgroundsInstalled = false;
	const ensureBackgrounds = () => {
		if (backgroundsInstalled) return;
		backgroundsInstalled = true;
		// The links wrapper sits on top of the backgrounds wrapper and saved it as its original. Peel it
		// off first, or reinstalling backgrounds leaves the previous generation's closure live.
		uninstallInternalLinks(AssistantMessageComponent.prototype);
		installMessageBackgrounds(Object.getPrototypeOf(uiTheme) as ThemeLookups, AssistantMessageComponent.prototype, {
			hexFor: (surface, light) => resolveBackground(readSetting(BG_SETTINGS[surface].preset), readSetting(BG_SETTINGS[surface].hex), light),
			liveTheme: () => uiTheme as unknown as ThemeLookups,
			transformRows: (rows, width, light, mode) => isTweakEnabled("plain-code-blocks")
				? stylePlainBlocks(rows, width, backgroundAnsi(light ? "#e8ecf1" : "#1f252d", mode), visibleWidth)
				: rows,
		});
		installInternalLinks(AssistantMessageComponent.prototype, () => linkTargetFor());
	};
	for (const surface of SURFACES) {
		for (const setting of [BG_SETTINGS[surface].preset, BG_SETTINGS[surface].hex]) {
			watchSetting(setting, () => {
				if (lastCtx) repaintToolCards(lastCtx);
			});
		}
	}
	const toolRuns = installToolRuns(ToolExecutionComponent.prototype as unknown as RunCard, {
		headRow: (rows, width) => truncateToWidth(rows.find(row => /\S/.test(row.replace(/\x1b\[[0-9;]*m/g, ""))) ?? "", width),
		requestRender: () => thoughtTui?.requestRender(),
	});
	const restoreToolDisplay = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		ensureBackgrounds();
		ensureLinkServer();
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
	const evalSummaries = new EvalSummaryCache();
	const takeover: CardTakeover = {
		display, active: () => display.cardsOn && isTweakEnabled("integrated-tool-expansion"),
		summary: (language, code) => {
			if (!lastCtx || !lastCtx.hasUI || !isTweakEnabled("eval-command-summaries")) return;
			evalSummaries.request(language, code, lastCtx, () => { if (lastCtx) repaintToolCards(lastCtx); });
			return evalSummaries.get(language, code);
		},
		linkTarget: () => linkTargetFor(),
	};
	installNativeCardTakeover(takeover);
	installReadGroupTakeover(takeover);

	// Tool rows: one line per call, or one per burst, written by a local model.
	const liveCalls = new Map<string, { name: string; args: unknown }>();
	let scannedEntries = -1;
	const lookupCall = (id: string) => {
		const known = liveCalls.get(id);
		if (known || !lastCtx) return known;
		const entries = lastCtx.sessionManager.getEntries();
		if (entries.length === scannedEntries) return undefined;
		scannedEntries = entries.length;
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") liveCalls.set(block.id, { name: block.name, args: block.arguments });
			}
		}
		return liveCalls.get(id);
	};
	const localLine: Complete = async (system, prompt, signal) => {
		const model = lastCtx?.modelRegistry.find("local", readSetting(toolRowsModelSetting).trim());
		if (!model) return undefined;
		const response = await completeSimple(model, { systemPrompt: [system], messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { signal, maxTokens: 40 });
		if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
		return response.content.map(block => (block.type === "text" ? block.text : "")).join("");
	};
	const toolRows = new ToolRows({
		mode: () => readSetting(toolRowsSetting),
		expanded: () => (lastCtx?.hasUI ? lastCtx.ui.getToolsExpanded() : false),
		theme: () => uiTheme,
		complete: localLine,
		repaint: () => { if (lastCtx) repaintToolCards(lastCtx); },
		readEntries: group => readGroupStates.get(group)?.entries,
		lookupCall,
	});
	toolRows.install();
	watchSetting(toolRowsSetting, () => toolRows.refresh());
	watchSetting(toolRowsModelSetting, () => toolRows.reset());
	pi.on("tool_execution_start", event => {
		liveCalls.set(event.toolCallId, { name: event.toolName, args: event.args });
		toolRows.noteCall(event.toolCallId);
	});
	pi.on("agent_start", () => toolRows.setIdle(false));
	pi.on("agent_end", () => toolRows.setIdle(true));
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
	const cycleToolRows = (ctx: ExtensionContext) => {
		if (!isSettingsInitialized()) return;
		const current = readSetting(toolRowsSetting);
		const next = TOOL_ROWS_MODES[(TOOL_ROWS_MODES.indexOf(current) + 1) % TOOL_ROWS_MODES.length];
		toolRowsSetting.set(settings, next);
		if (ctx.hasUI) ctx.ui.notify(`Tool rows: ${TOOL_ROWS_MODES.map((mode) => (mode === next ? `[${mode}]` : mode)).join(" · ")}`, "info");
	};
	pi.registerShortcut("alt+o", { description: "Cycle hydemods tool rows (cards → lines → group)", handler: cycleToolRows });

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
		let lastAssistantIndex = -1;
		let lastThinkingIndex = -1;
		let thoughtText = "";

		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && "message" in entry && (entry.message as { role?: string })?.role === "assistant") {
				if (lastAssistantIndex === -1) lastAssistantIndex = i;
				const text = lastThinkingText(entry.message);
				if (text && lastThinkingIndex === -1) {
					lastThinkingIndex = i;
					thoughtText = text;
				}
				if (lastAssistantIndex !== -1 && lastThinkingIndex !== -1) break;
			}
		}

		// Only show the thought if it belongs to the most recent assistant message.
		// If subsequent assistant turns had no thinking, don't show a stale past thought.
		if (lastThinkingIndex !== -1 && lastThinkingIndex === lastAssistantIndex) {
			return thoughtText;
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
		// Widgets stack in insertion order; re-adding the drawer keeps the thought panel on top.
		refreshLastPromptDrawer(ctx);
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
		const { role, content } = event.message as { role?: unknown; content?: unknown };
		if (role === "assistant" && Array.isArray(content) && content.some((b: { type?: string; text?: string }) => b.type === "text" && b.text?.trim())) toolRuns.close();
		guardRunawayEdit(event.message, ctx);
		if (event.message.role === "assistant") {
			for (const block of event.message.content) {
				if (block.type !== "toolCall") continue;
				liveCalls.set(block.id, { name: block.name, args: block.arguments });
				toolRows.noteCall(block.id);
			}
		}
	});
	pi.on("agent_start", () => {
		latestThought = "";
		thoughtTui?.requestRender();
		toolRuns.setActive(isTweakEnabled("tool-runs"));
	});
	pi.on("agent_end", (_event, ctx) => {
		toolRuns.setActive(false);
		if (!thoughtTui) repaintToolCards(ctx);
	});
	pi.on("message_start", (event) => {
		if ((event.message as { role?: unknown }).role === "user") toolRuns.close();
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
		if (!isTweakEnabled("runaway-edit-guard") || message.role !== "assistant" || guardedTimestamp === message.timestamp) return;
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

	const urlPreviews = registerUrlPreviewLifecycle(pi, [vaultDrawer, runtimeDrawer, contentDrawer, remoteDrawer]);
	const helperDrawers = registerHelperDrawers(
		pi,
		[vaultDrawer, runtimeDrawer, contentDrawer, remoteDrawer],
		() => isTweakEnabled("internal-url-drawers"),
		(ctx, uri, page) => { urlPreviews.showPreview(ctx, uri, page); },
	);
	// Terminal-native clicks: transcript rows link internal URLs to hydemods://open?s=<key>&u=<uri>;
	// the handler app (/browse install-handler) forwards a click to this process's socket.
	const linkKey = randomUUID().slice(0, 8);
	let linkServer: LinkServer | undefined;
	const linkTargetFor = (): ((uri: string) => string) | undefined =>
		linkServer && isTweakEnabled("internal-url-drawers") && linkHandlerInstalled() ? uri => linkTarget(linkKey, uri) : undefined;
	const ensureLinkServer = () => {
		if (linkServer) return;
		try {
			linkServer = startLinkServer(linkKey, uri => { if (drawerScheme(uri)) helperDrawers.openFromLink(uri); });
		} catch {
			// No socket, no links: rows stay plain and the browser is still reachable by keyboard.
		}
	};
	pi.on("session_shutdown", async () => { linkServer?.stop(); linkServer = undefined; });
	const installDrawers = (ctx: ExtensionContext) => {
		helperDrawers.install(ctx);
		if (ctx.hasUI) {
			const enabled = () => isTweakEnabled("internal-url-drawers");
			const onApplied = (item: { value: string }) => {
				urlPreviews.showPreview(ctx, item.value.trimEnd());
			};
			ctx.ui.addAutocompleteProvider(inner => {
				let p = withVaultDrawer(inner as unknown as EditorProvider, enabled, onApplied);
				p = withPrDrawer(p, enabled, onApplied);
				p = withXdDrawer(p, enabled, xdSourcesFor(ctx), onApplied);
				p = withProcDrawer(p, enabled, procSourcesFor(ctx), onApplied);
				return p as unknown as typeof inner;
			});
		}
		urlPreviews.install(ctx);
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
		emit: (spec, lines) =>
			pi.sendMessage<MonitorEventDetails>(
				{ customType: "hydemods-monitor-event", display: true, content: formatMonitorEvent(spec, lines), details: { spec, lines } },
				{ deliverAs: "steer", triggerTurn: true },
			),
	});
	pi.registerMessageRenderer<MonitorEventDetails>("hydemods-monitor-event", (message, { expanded }, theme) => {
		if (!message.details) return undefined;
		const { spec, lines } = message.details;
		const shown = expanded ? lines : lines.slice(0, MONITOR_COLLAPSED_LINES);
		const hidden = lines.length - shown.length;
		const rows = [
			`${theme.fg("accent", "Monitor event:")} ${theme.fg("text", shown[0] ?? "")} ${theme.fg("dim", `· ${spec.name}`)}`,
			...shown.slice(1).map(line => `  ${theme.fg("text", line)}`),
			...(hidden > 0 ? [theme.fg("muted", `  … ${hidden} more line${hidden === 1 ? "" : "s"} (Ctrl+O)`)] : []),
		];
		return new Text(rows.join("\n"), 1, 0);
	});
	// Best effort: when the session exposes its async job manager, the monitor's loop is also
	// registered as one native job, so proc:// lists it for its whole life and `proc://<id>/kill`
	// aborts the loop and the shell check it is running. The job's own completion delivery is
	// suppressed: the monitor's `notify` above is the single wake. Without a manager the monitor
	// runs exactly as before, host-less; proc:// visibility is an extra, never a precondition.
	const monitorJobHost = (ctx: ExtensionContext): MonitorJobsHost | undefined => {
		const live = asyncJobsFor(ctx);
		if (!live) return undefined;
		const { manager, ownerId } = live;
		return {
			register: (label, run) =>
				manager.register("bash", label, ({ signal, reportProgress }) => run(signal, (text, output) => { void reportProgress(text, { output }); }), { ownerId }),
			cancel: jobId => manager.cancel(jobId, { ownerId }),
			// `acknowledgeDeliveries` is the durable suppression: a host wait/unwatch can lift a
			// watch and replay the completion, but an acknowledged delivery is never re-queued.
			suppressDelivery: jobId => { manager.acknowledgeDeliveries([jobId]); },
			setLabel: (jobId, label) => { const job = manager.getJob(jobId); if (job) job.label = label; },
		};
	};
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
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		loadMode: "essential",
		description: [
			"Start, list, or cancel a background monitor: a shell command that runs without blocking you and wakes you with a message when something happens.",
			"Use instead of sleep/poll loops (CI, PR reviews, deploys, long jobs). After `start`, end your turn or do other work; do not wait or poll — events arrive as new messages.",
			'mode "stream" (default) runs `command` once as a watcher: EVERY stdout line is an event that wakes you (lines within ~300ms share one event), and a final message reports when it exits or times out. Write the command to print only meaningful state changes, deduped, e.g. `prev=; while true; do s=$(gh pr checks 1787 2>&1 | sort); [ "$s" != "$prev" ] && echo "$s"; prev=$s; sleep 60; done`. Use stderr or `>/dev/null` for noise; exit the loop when finished.',
			'mode "poll" re-runs `command` every `intervalSec` and reports once when it exits 0, or when `until` (regex over stdout+stderr) matches.',
			'mode "exit" runs `command` once (e.g. `gh pr checks 123 --watch`) and reports only when it exits, whatever the code.',
			"Every monitor reports once when it settles: condition met, exited, timed out (`timeoutMin`), or failed to run. Starting a monitor with an existing name replaces it. Monitors live in this session and stop on reload or session switch.",
			"Each monitor is one native background job: it is visible at `proc://` for its whole life, including the gaps between checks, and `proc://<id>/kill` cancels the loop and any check it is running.",
		].join("\n"),
		parameters: Type.Object({
			op: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("cancel")]),
			name: Type.Optional(Type.String({ description: "Unique monitor name (required for start/cancel); shown on every event." })),
			command: Type.Optional(Type.String({ description: "Shell command (zsh -lc). Required for start." })),
			mode: Type.Optional(Type.Union([Type.Literal("stream"), Type.Literal("poll"), Type.Literal("exit")], { description: 'Default "stream".' })),
			until: Type.Optional(Type.String({ description: "Poll mode: regex over output that means done. Default: exit code 0." })),
			intervalSec: Type.Optional(Type.Number({ description: "Poll mode interval, default 30, min 5." })),
			timeoutMin: Type.Optional(Type.Number({ description: "Kill the command and report after this many minutes, default 60." })),
			cwd: Type.Optional(Type.String({ description: "Working directory, default the session cwd." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });
			if (params.op === "list") {
				const rows = monitors.list();
				return text(rows.length ? rows.map(r => `${r.name} [${r.mode}] ${r.mode === "stream" ? `${r.events} events` : `${r.runs} runs`}, ${r.elapsedSec}s${r.nextInSec === undefined ? "" : `, next ${r.nextInSec}s`}${r.jobId ? ` (proc://${r.jobId})` : ""}: ${r.command}${r.last ? `\n  last: ${r.last.split("\n").at(-1)}` : ""}`).join("\n") : "No monitors running.");
			}
			if (!params.name) throw new Error("`name` is required.");
			if (params.op === "cancel") return text(monitors.cancel(params.name) ? `Cancelled monitor "${params.name}".` : `No monitor named "${params.name}".`);
			if (!params.command) throw new Error("`command` is required for start.");
			const spec: MonitorSpec = {
				name: params.name,
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
				mode: params.mode ?? "stream",
				until: params.until,
				intervalSec: Math.max(5, params.intervalSec ?? 30),
				timeoutMin: Math.max(0.1, params.timeoutMin ?? 60),
			};
			void monitors.start(spec, monitorJobHost(ctx));
			return text(
				spec.mode === "stream"
					? `Monitor "${spec.name}" started (stream, timeout ${spec.timeoutMin}m). Each output line arrives as a "Monitor event" message; end your turn or continue other work — do not poll.`
					: `Monitor "${spec.name}" started (${spec.mode}, timeout ${spec.timeoutMin}m). You will get a message when it settles; end your turn or continue other work — do not poll.`,
			);
		},
	});
	pi.registerTool({
		name: "call_model",
		label: "Call Model",
		description: "Call a configured model directly with a one-shot prompt and get its text back. `model` is provider/id, a bare id, or @role; an optional `:effort` suffix (minimal|low|medium|high|xhigh|max) sets thinking unless `thinking` is given.",
		parameters: Type.Object({
			model: Type.String({ description: "provider/id, bare id, or @role (e.g. @slow), optionally with :effort." }),
			prompt: Type.String({ description: "User prompt sent to the model." }),
			system: Type.Optional(Type.String({ description: "Optional system prompt." })),
			thinking: Type.Optional(Type.Union(EFFORTS.map(e => Type.Literal(e)), { description: "Reasoning effort; omit for the model default." })),
			maxTokens: Type.Optional(Type.Number({ description: "Maximum output tokens." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { text, details } = await callModel(ctx, params as CallModelParams, signal);
			return { content: [{ type: "text" as const, text }], details };
		},
	});
	const recommendFor = async (ctx: ExtensionContext, task: string, include: "all" | "tools" | "skills", limit: number, signal?: AbortSignal): Promise<string> => {
		const candidates: Candidate[] = [];
		if (include !== "skills") {
			const active = new Set(pi.getActiveTools());
			for (const tool of pi.getAllTools()) if (tool.name !== "recommend_tools") candidates.push({ kind: "tool", name: tool.name, description: tool.description, inactive: !active.has(tool.name) });
		}
		if (include !== "tools") {
			const { skills } = await loadSkills({ ...cfgSkills.get(hostSettings), cwd: ctx.cwd, disabledExtensions: cfgDisabledExtensions.get(hostSettings) });
			for (const skill of skills) candidates.push({ kind: "skill", name: skill.name, description: skill.description });
		}
		const judge = resolveJudge({ settings: hostSettings, registry: ctx.modelRegistry, sessionModel: ctx.model, purpose: "hydemods_recommend", onUsage: journalJudgmentUsage(ctx.sessionManager) });
		return formatRecommendations(await recommend(judge, task, candidates, { limit: Math.max(1, limit), signal }));
	};
	pi.registerTool({
		name: "recommend_tools",
		label: "Recommend Tools",
		approval: "read",
		description: "Ask the judge model which available tools and skills fit a task. Use when starting unfamiliar work or when unsure whether a specialized tool, MCP server, or skill exists for it. Returns the strongest matches, best first, with the judge's confidence.",
		parameters: Type.Object({
			task: Type.String({ description: "The task in a sentence or two: what you are about to do and on what." }),
			limit: Type.Optional(Type.Number({ description: "Maximum recommendations, default 5." })),
			include: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("tools"), Type.Literal("skills")], { description: 'Default "all".' })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const text = await recommendFor(ctx, params.task, params.include ?? "all", params.limit ?? 5, signal);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});
	pi.registerTool({
		name: "agent_model",
		label: "Agent Model",
		description: "Override which model a task subagent type runs on, for this session only. `list` shows overrides; `set` needs `agent` (e.g. reviewer, task, scout) and `model`; `clear` removes the session override for `agent`.",
		parameters: Type.Object({
			op: Type.Union([Type.Literal("list"), Type.Literal("set"), Type.Literal("clear")]),
			agent: Type.Optional(Type.String({ description: "Agent name; required for set/clear." })),
			model: Type.Optional(Type.String({ description: "Model selector (provider/id, bare id, @role, optional :effort); required for set." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = agentModel(ctx, hostOverrideSettings(), params as AgentModelParams);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});
	pi.registerTool({
		name: "ror",
		label: "Ready for Review",
		description: [
			"Ready-for-review digest of your open PRs, grouped by your stored review tiers and sent to you as a Slack DM.",
			"A PR is ready when it is not a draft, one of the configured approvers' latest review approves the head commit, no reviewer's latest review requests changes, CI passes, no review threads are unresolved, and it has no merge conflicts.",
			'op "send" (default) fetches fresh PR state and DMs the message to the Slack user the configured Slack MCP is signed in as; "preview" returns the same message without sending.',
			'PRs in no tier are classified by a model against a risk rubric plus the guidance file, stored in their tier, and reported with the model\'s reason; failures stay under "Not tiered yet". Pass classify=false to skip. To correct a tier, use op "label" with `tier` and `prs` (owner/repo#N, #N or N): it moves them to the end of that tier and marks them as your ground truth.',
			'op "watch" starts the "ror-watch" background monitor. It re-checks PRs every `intervalSec` (default 300) and wakes you only with changes. A changed PR gets a status line ("ROR", "closed or merged", or "not ROR: <blockers>") plus, when not ROR, one indented line per blocker with its link: failing and pending checks, each unresolved thread (path:line, author, comment snippet), change requests, and approver state. The first poll reports every PR. With `prs` it watches those and stops once all are ROR or closed. With `full: true` (no `prs`) it watches every open PR in the configured owners, including new ones, until `timeoutMin` (default 1440). A new watch replaces the running one. Cancel with monitor op "cancel", name "ror-watch".',
			`Config and tiers live in ${rorConfigPath()}; classifier calibration lives in ${rorGuidancePath()}.`,
		].join("\n"),
		parameters: Type.Object({
			op: Type.Optional(Type.Union([Type.Literal("send"), Type.Literal("preview"), Type.Literal("label"), Type.Literal("watch")], { description: 'Default "send".' })),
			tier: Type.Optional(Type.String({ description: "Tier key; required for label." })),
			prs: Type.Optional(Type.Array(Type.String(), { description: "label: PRs to move; watch: PRs to watch (omit with full). owner/repo#N, #N, or N when unambiguous." })),
			full: Type.Optional(Type.Boolean({ description: "watch: watch all your open PRs in the configured owners instead of `prs`." })),
			intervalSec: Type.Optional(Type.Number({ description: "watch: seconds between checks, minimum 30. Default 300." })),
			timeoutMin: Type.Optional(Type.Number({ description: "watch: stop after this many minutes. Default 1440." })),
			classify: Type.Optional(Type.Boolean({ description: "send/preview: classify ready PRs that are in no tier with the model. Default true." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return { content: [{ type: "text" as const, text: await runRor(params, ctx, signal) }], details: undefined };
		},
	});
	const RORWATCH_SCRIPT = fileURLToPath(new URL("./scripts/ror-watch.ts", import.meta.url));
	type RorParams = { op?: "send" | "preview" | "label" | "watch"; tier?: string; prs?: string[]; full?: boolean; classify?: boolean; intervalSec?: number; timeoutMin?: number };
	async function runRor(params: RorParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
		let config = await loadRorConfig();
		const open = await fetchMyPrs();
		if (params.op === "watch") {
			if (Boolean(params.full) === Boolean(params.prs?.length)) throw new Error("watch needs either `prs` or `full: true`, not both.");
			const keys = params.full ? [] : resolvePrRefs(params.prs!, open);
			const intervalSec = Math.max(30, params.intervalSec ?? 300);
			const timeoutMin = Math.max(1, params.timeoutMin ?? 1440);
			const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
			void monitors.start({
				name: "ror-watch",
				command: ["bun", RORWATCH_SCRIPT, "--interval", String(intervalSec), ...(params.full ? ["--full"] : keys)].map(quote).join(" "),
				cwd: ctx.cwd,
				mode: "stream",
				intervalSec,
				timeoutMin,
				// The first poll lists every PR with its blockers; the default 20-line event cap would cut it off.
				maxEventLines: 500,
			});
			const what = params.full ? `all open PRs in ${config.owners?.join(", ") ?? "every repo"}` : `${keys.length} PRs (${keys.join(", ")})`;
			return `Watching ${what} for ROR every ${intervalSec}s (monitor "ror-watch", timeout ${timeoutMin}m). Changes, with each blocker's link, arrive as "Monitor event" messages; do not poll.`;
		}
		if (params.op === "label") {
			if (!params.tier || !params.prs?.length) throw new Error("label needs `tier` and `prs`.");
			const keys = resolvePrRefs(params.prs, open);
			await saveRorConfig(assignTier(config, params.tier, keys));
			return `Moved ${keys.join(", ")} to the end of tier "${params.tier}" (now your ground truth).`;
		}
		const ready = readyPrs(open, config);
		const tiered = new Set(config.tiers.flatMap((t) => t.prs));
		const toClassify = ready.filter((pr) => !tiered.has(prKey(pr)));
		let classified = "";
		if (params.classify !== false && toClassify.length) {
			const model = config.classifierModel ?? "@default:medium";
			const examples = open.flatMap((pr) => {
				const tier = config.tiers.find((t) => t.prs.includes(prKey(pr)));
				return tier && !config.autoTiered?.[prKey(pr)] ? [{ key: prKey(pr), title: pr.title, tier: tier.key }] : [];
			});
			const results = await classifyPrs(toClassify, config, {
				complete: (system, prompt) => callModel(ctx, { model, system, prompt }, signal).then((r) => r.text),
				guidance: await loadGuidance(),
				examples,
			});
			config = applyClassifications(config, results);
			await saveRorConfig(config);
			const labelOf = (key: string) => config.tiers.find((t) => t.key === key)?.label ?? key;
			const lines = results.map((r) => ("error" in r ? `${r.key}: ${r.error}` : `${r.key} -> ${labelOf(r.tier)}: ${r.reason}`));
			const failed = results.filter((r) => "error" in r).length;
			classified = `\n\nClassified by ${model} (${results.length - failed} of ${results.length}; failures stay under "Not tiered yet"):\n${lines.join("\n")}\nTo correct a tier, use op "label" (it makes your choice ground truth).`;
		}
		const sections = groupByTier(ready, config.tiers);
		const message = formatRorMessage(sections, config);
		const untiered = sections.find((s) => s.tier === null)?.prs ?? [];
		const untieredNote = untiered.length
			? `\n\nNot tiered yet (agree a tier with the user, then op "label"):\n${untiered.map((pr) => `${prKey(pr)} ${pr.title} | +${pr.additions}/-${pr.deletions}, ${pr.changedFiles} files`).join("\n")}`
			: "";
		if (params.op === "preview") return message + classified + untieredNote;
		const links = await sendSelfDm(config.slackServer, message);
		return `Sent ${ready.length} ready PRs to your Slack DM: ${links.join(" ")}${classified}${untieredNote}`;
	}
	pi.registerCommand("ror", {
		description: "Send your [ROR] PRs to your Slack DM, tiering new ones. /ror preview, /ror raw (skip the model), /ror label <tier> <#N...>, /ror watch <#N...> | --full",
		handler: async (args, ctx) => {
			if (!isTweakEnabled("ror")) {
				if (ctx.hasUI) ctx.ui.notify("ror is turned off in the hydemods panel.", "warning");
				return;
			}
			const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const params: RorParams =
				first === "label"
					? { op: "label", tier: rest[0], prs: rest.slice(1) }
					: first === "watch"
						? rest.includes("--full")
							? { op: "watch", full: true }
							: { op: "watch", prs: rest }
						: { op: first === "preview" ? "preview" : "send", classify: !rest.includes("raw") && first !== "raw" };
			if (ctx.hasUI) ctx.ui.notify(params.op === "label" ? "Updating tiers…" : params.op === "watch" ? "Starting ROR watch…" : "Fetching [ROR] PRs…", "info");
			try {
				const result = await runRor(params, ctx);
				pi.sendMessage({ customType: "hydemods-ror", display: true, content: result, details: undefined });
			} catch (err) {
				if (ctx.hasUI) ctx.ui.notify(`ror failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
	// Settings-gated tools: off removes them from the active set; on restores only what this sync removed,
	// so tools the user deactivated by other means stay off.
	const GATED_TOOLS: Record<string, string> = { "monitor-tool": "monitor", "call-model-tool": "call_model", "agent-model-tool": "agent_model", "recommend-tools": "recommend_tools", ror: "ror" };
	const removedByUs = new Set<string>();
	const syncGatedTools = () => {
		const active = pi.getActiveTools();
		const next = [...active];
		for (const [tweak, tool] of Object.entries(GATED_TOOLS)) {
			if (isTweakEnabled(tweak)) {
				if (removedByUs.delete(tool) && !next.includes(tool)) next.push(tool);
			} else if (next.includes(tool)) {
				next.splice(next.indexOf(tool), 1);
				removedByUs.add(tool);
			}
		}
		if (next.length !== active.length || next.some((tool, i) => tool !== active[i])) void pi.setActiveTools(next);
	};
	for (const tweak of TWEAKS) if (tweak.name in GATED_TOOLS) watchSetting(tweak.setting, syncGatedTools);
	// One handler per session event, each running the per-feature session work in a fixed order.
	const onSession = (_event: unknown, ctx: ExtensionContext) => {
		evalSummaries.clear();
		liveCalls.clear();
		scannedEntries = -1;
		toolRows.reset();
		toolRows.setIdle(true);
		stopStallWatch?.();
		stopStallWatch = undefined;
		const sessionFile = ctx.sessionManager.getSessionFile();
		// Monitors report into the session that started them. Every session event here (start,
		// switch, branch, tree) is a fresh session context, so drop them unconditionally: comparing
		// session files misses sessions that have no file (`-p`, SDK, embedded).
		monitors.cancelAll();
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
		syncGatedTools();
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
	// Emitted when the session is disposed (exit, Ctrl+C/D, signals), which also cancels its async
	// jobs; cancelling here aborts the loop and its shell check before the manager drains.
	pi.on("session_shutdown", () => { monitors.cancelAll(); evalSummaries.clear(); lastCtx = undefined; });

	// `/recommend-tools` anywhere in a prompt: strip it on submit (input handlers run before slash
	// commands dispatch), then attach the judge's picks for that prompt before its turn. Marked
	// prompts are remembered by text, so a queued unmarked prompt never takes another's picks.
	const recommendPending: string[] = [];
	pi.on("input", (event, ctx) => {
		if (!isTweakEnabled("recommend-tools")) return;
		const { text, marked } = stripRecommendMarker(event.text);
		if (!marked) return;
		if (!text) {
			ctx.ui.notify(`Add a task after ${RECOMMEND_MARKER}`, "warning");
			return { handled: true };
		}
		recommendPending.push(text);
		return { text };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (prompt.trim().length > 0) {
			lastPrompt = prompt;
			refreshLastPromptDrawer(ctx);
			void nameSessionFromPrompt(prompt, ctx);
		}
		const marked = takeMarkedPrompts(recommendPending, prompt);
		if (marked.length === 0) return;
		try {
			const picks = await recommendFor(ctx, marked.join("\n\n"), "all", 5);
			return { message: { customType: "hydemods-recommend-tools", display: true, content: `Tools and skills the judge recommends for this prompt (requested with ${RECOMMEND_MARKER}):\n\n${picks}` } };
		} catch (error) {
			ctx.ui.notify(`${RECOMMEND_MARKER} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
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
