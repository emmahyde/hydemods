import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { encode as encodeToon } from "@toon-format/toon";
import { parse as parseYaml } from "yaml";

type TweakCategory = "Workflow" | "Interface" | "Quality of life";

type Tweak = {
	name: string;
	title: string;
	description: string;
	category: TweakCategory;
	enabled: boolean;
	render: () => string;
};

/**
 * Add future tweaks here. Each entry owns its label, grouping, state, and
 * display copy so the panel does not need to know about individual tweaks.
 */
const TWEAKS: Tweak[] = [
	{
		name: "integrated-tool-expansion",
		title: "Integrated tool expansion",
		description: "Shows prettified structured results in compact rows and expanded output.",
		category: "Interface",
		enabled: true,
		render: () => "JSON and YAML are syntax-colored; terminal hover is unavailable, so the global tools-expand key is used.",
	},
	{
		name: "tool-results-toon",
		title: "Map tool results to TOON",
		description: "Encodes structured JSON/YAML tool results as TOON before display.",
		category: "Interface",
		enabled: true,
		render: () => "Active: structured JSON/YAML results are encoded as TOON before display.",
	},
	{
		name: "session-identity",
		title: "Session identity & colors",
		description: "Assigns a persistent codename, sigil, and distinct ANSI color to each session.",
		category: "Interface",
		enabled: true,
		render: () => "Active: session displays a unique codename badge and accent color in the status bar.",
	},
	{
		name: "last-prompt-drawer",
		title: "Last prompt drawer",
		description: "Shows the start of your latest prompt on one line above the editor.",
		category: "Interface",
		enabled: true,
		render: () => "Active: latest prompt is truncated to the terminal width with an ellipsis.",
	},
	{
		name: "session-irc-monitor",
		title: "IRC comms & System Monitor",
		description: "Enables session communication and deterministic System monitors over the IRC bus.",
		category: "Workflow",
		enabled: true,
		render: () => "Active: Claude-style monitors execute background checks and message Main as System.",
	},
	{
		name: "heartbeat-command",
		title: "Autonomous /heartbeat exploration",
		description: "Enables /heartbeat to prompt self-directed exploration and goal-setting.",
		category: "Workflow",
		enabled: true,
		render: () => "Active: /heartbeat triggers a self-directed codebase exploration cycle.",
	},
	{
		name: "session-retro-command",
		title: "Interactive /retro summary",
		description: "Enables /retro to run a structured session retrospective.",
		category: "Workflow",
		enabled: true,
		render: () => "Active: /retro synthesizes session decisions, friction points, and learnings.",
	},
];

const CATEGORIES: readonly TweakCategory[] = ["Workflow", "Interface", "Quality of life"];

type ThemeLike = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

type ToolMessage = {
	customType: string;
	content: string | unknown[];
	details?: {
		toolName: string;
		result: unknown;
		isError?: boolean;
	};
};

type RendererOptions = {
	expanded?: boolean;
};

type StructuredFormat = "json" | "yaml" | "toon" | "ast-toon" | "code" | "text";

type StructuredText = {
	text: string;
	format: StructuredFormat;
	lang?: string;
};

const TOON_ENCODER: ((result: unknown) => string) | undefined = encodeToon;

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

const CODE_TYPES: Record<string, true> = {
	int: true, float: true, double: true, bool: true, string: true, char: true, byte: true,
	sbyte: true, short: true, ushort: true, uint: true, ulong: true, long: true, decimal: true,
	object: true, void: true, Vector2: true, Vector3: true, Vector4: true, Quaternion: true,
	Matrix4x4: true, Color: true, GameObject: true, Transform: true, MonoBehaviour: true,
	ScriptableObject: true, Mesh: true, Material: true, Texture: true, Action: true, Func: true,
	List: true, Dictionary: true, HashSet: true, Task: true, Promise: true, Array: true, Record: true,
};

function detectCodeLanguage(text: string): string {
	if (/(?:using\s+System|namespace\s+[A-Za-z0-9_.]+|public\s+(?:class|struct|enum|interface|void)|\[SerializeField\])/.test(text)) {
		return "csharp";
	}
	if (/^(?:import\s+.*from|export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type)|const\s+[a-zA-Z0-9_]+\s*=|function\s+[a-zA-Z0-9_]+\()/m.test(text)) {
		return "typescript";
	}
	if (/^(?:def\s+[a-zA-Z0-9_]+\(|class\s+[A-Za-z0-9_]+(?:\(.*\))?:|import\s+[a-zA-Z0-9_]+|from\s+[a-zA-Z0-9_]+\s+import)/m.test(text)) {
		return "python";
	}
	if (/^(?:#!\/bin\/(?:ba)?sh|export\s+[A-Za-z0-9_]+=|npm\s+|bun\s+|git\s+|cd\s+)/m.test(text)) {
		return "bash";
	}
	return "code";
}

function colorizeToken(theme: ThemeLike, color: string, fallback: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return theme.fg(fallback, text);
	}
}

function colorizeCodeLine(line: string, theme: ThemeLike): string {
	if (/^\s*(?:\/\/|#|--)/.test(line)) {
		return colorizeToken(theme, "syntaxComment", "muted", line);
	}

	const tokenRegex = /("(?:\\.|[^"\\])*"|'[^'\\]*(?:\\.[^'\\]*)*'|\x60[^\x60\\]*(?:\\.[^\x60\\]*)*\x60|(?:\/\/|#|--).*$|\b\d+(?:\.\d+)?[fFmMdD]?\b|[a-zA-Z_][a-zA-Z0-9_]*|[+\-*\/%=<>!&|^~?:]+)/g;

	return line.replace(tokenRegex, (match) => {
		if (match.startsWith("//") || match.startsWith("#") || match.startsWith("--")) {
			return colorizeToken(theme, "syntaxComment", "muted", match);
		}
		const c = match.charCodeAt(0);
		if (c === 34 || c === 39 || c === 96) {
			return colorizeToken(theme, "syntaxString", "success", match);
		}
		if (/^\d/.test(match)) {
			return colorizeToken(theme, "syntaxNumber", "warning", match);
		}
		if (CODE_KEYWORDS[match]) {
			return colorizeToken(theme, "syntaxKeyword", "accent", match);
		}
		if (CODE_TYPES[match] || /^[A-Z][a-zA-Z0-9_]+$/.test(match)) {
			return colorizeToken(theme, "syntaxType", "info", match);
		}
		if (/^[+\-*\/%=<>!&|^~?:]+$/.test(match)) {
			return colorizeToken(theme, "syntaxOperator", "error", match);
		}
		return match;
	});
}

interface AstMethod {
	sig: string;
}

interface AstType {
	kind: string;
	name: string;
	inherits?: string;
	methods?: AstMethod[];
}

interface CodeAst {
	namespace?: string;
	types: AstType[];
}

function extractCodeAst(code: string, lang: string): CodeAst | null {
	const lines = code.split(/\r?\n/);
	const types: AstType[] = [];
	let currentNamespace = "";
	let currentType: AstType | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.startsWith("#")) continue;

		const nsMatch = line.match(/^namespace\s+([A-Za-z0-9_.]+)/);
		if (nsMatch) {
			currentNamespace = nsMatch[1];
			continue;
		}

		let typeMatch = line.match(/\b(class|struct|interface|enum)\s+([A-Za-z0-9_]+)(?:\s*(?:extends|implements|:)\s*([A-Za-z0-9_,\s<>]+))?/);
		if (!typeMatch && lang === "python") {
			const pyMatch = line.match(/^class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?:/);
			if (pyMatch) {
				typeMatch = [pyMatch[0], "class", pyMatch[1], pyMatch[2]];
			}
		}

		if (typeMatch) {
			const kind = typeMatch[1];
			const name = typeMatch[2];
			const inherits = typeMatch[3]?.trim();
			currentType = {
				kind,
				name,
				...(inherits ? { inherits } : {}),
				methods: [],
			};
			types.push(currentType);
			continue;
		}

		let methodMatch: RegExpMatchArray | null = null;
		if (lang === "csharp") {
			methodMatch = line.match(/(?:(?:public|private|protected|internal|static|virtual|override|async)\s+)*([A-Za-z0-9_<>\[\]]+)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
		} else if (lang === "typescript" || lang === "javascript") {
			methodMatch = line.match(/(?:(?:public|private|protected|static|async|export)\s+)*(?:function\s+)?([A-Za-z0-9_]+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([A-Za-z0-9_<>\[\]|&\s]+))?/);
		} else if (lang === "python") {
			methodMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([A-Za-z0-9_\[\], ]+))?:/);
		}

		if (methodMatch) {
			let sig = "";
			if (lang === "csharp") {
				const ret = methodMatch[1];
				const name = methodMatch[2];
				const params = methodMatch[3].trim();
				if (!["if", "while", "for", "foreach", "switch", "catch"].includes(name)) {
					sig = `${name}(${params}) -> ${ret}`;
				}
			} else if (lang === "typescript" || lang === "javascript") {
				const name = methodMatch[1];
				const params = methodMatch[2].trim();
				const ret = methodMatch[3]?.trim() || "void";
				if (!["if", "while", "for", "switch", "catch"].includes(name)) {
					sig = `${name}(${params})${ret ? ` -> ${ret}` : ""}`;
				}
			} else if (lang === "python") {
				const name = methodMatch[2];
				const params = methodMatch[3].trim();
				const ret = methodMatch[4]?.trim() || "None";
				sig = `${name}(${params}) -> ${ret}`;
			}

			if (sig) {
				if (currentType) {
					currentType.methods?.push({ sig });
				} else {
					let topLevel = types.find((t) => t.name === (currentNamespace || "TopLevel"));
					if (!topLevel) {
						topLevel = { kind: "module", name: currentNamespace || "TopLevel", methods: [] };
						types.push(topLevel);
					}
					topLevel.methods?.push({ sig });
				}
			}
		}
	}

	for (const t of types) {
		if (t.methods && t.methods.length === 0) delete t.methods;
	}

	if (types.length === 0) return null;

	return {
		...(currentNamespace ? { namespace: currentNamespace } : {}),
		types,
	};
}

function parseGrepOutput(rawText: string): unknown {
	const lines = rawText.split(/\r?\n/);
	const matches: Array<{ line: number; match: string }> = [];
	const starMatches: Array<{ line: number; match: string }> = [];

	for (const line of lines) {
		const m = line.match(/^\s*(\*)?\s*(\d+)\|\s*(.*)$/);
		if (m) {
			const isStar = Boolean(m[1]);
			const lineNum = parseInt(m[2], 10);
			const matchText = m[3].trim();
			const item = { line: lineNum, match: matchText };
			if (isStar) starMatches.push(item);
			matches.push(item);
		}
	}

	const items = starMatches.length > 0 ? starMatches : matches;
	if (items.length > 0) {
		return {
			matches: items.slice(0, 16),
		};
	}
	return null;
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
/*                               Session Identity                             */
/* -------------------------------------------------------------------------- */

interface SessionColor {
	name: string;
	ansi: string;
	hex: string;
	themeColor: "accent" | "success" | "warning" | "error" | "info" | "muted";
}

const SESSION_PALETTE: readonly SessionColor[] = [
	{ name: "Cyan", ansi: "\x1b[96m", hex: "#06b6d4", themeColor: "accent" },
	{ name: "Emerald", ansi: "\x1b[92m", hex: "#10b981", themeColor: "success" },
	{ name: "Amber", ansi: "\x1b[93m", hex: "#f59e0b", themeColor: "warning" },
	{ name: "Violet", ansi: "\x1b[95m", hex: "#8b5cf6", themeColor: "accent" },
	{ name: "Coral", ansi: "\x1b[91m", hex: "#f43f5e", themeColor: "error" },
	{ name: "Azure", ansi: "\x1b[36m", hex: "#38bdf8", themeColor: "info" },
	{ name: "Indigo", ansi: "\x1b[34m", hex: "#6366f1", themeColor: "accent" },
	{ name: "Mint", ansi: "\x1b[32m", hex: "#14b8a6", themeColor: "success" },
	{ name: "Rose", ansi: "\x1b[35m", hex: "#ec4899", themeColor: "accent" },
	{ name: "Orange", ansi: "\x1b[33m", hex: "#f97316", themeColor: "warning" },
	{ name: "Lime", ansi: "\x1b[92m", hex: "#84cc16", themeColor: "success" },
	{ name: "Sky", ansi: "\x1b[94m", hex: "#0ea5e9", themeColor: "info" },
];

const CODENAMES = [
	"Vigil", "Beacon", "Chronos", "Horizon", "Pioneer", "Zephyr",
	"Aegis", "Solstice", "Polaris", "Kepler", "Nexus", "Prometheus",
	"Orion", "Helios", "Astral", "Vanguard", "Eclipse", "Cygnus",
	"Mirage", "Zenith", "Specter", "Nova", "Titan", "Aurora"
] as const;

const SIGILS = ["◆", "▲", "●", "◈", "✦", "⬡", "★", "⬢"] as const;

function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return Math.abs(hash);
}

function getSessionIdentity(sessionId: string) {
	const hash = hashString(sessionId || "default-session");
	const color = SESSION_PALETTE[hash % SESSION_PALETTE.length];
	const codename = CODENAMES[(hash >> 3) % CODENAMES.length];
	const sigil = SIGILS[(hash >> 6) % SIGILS.length];
	return { color, codename, sigil, id: sessionId };
}

/* -------------------------------------------------------------------------- */
/*                              System Monitors                               */
/* -------------------------------------------------------------------------- */

type MonitorWhen = "output" | "changed" | "match" | "exit_zero" | "exit_nonzero" | "always";
const MONITOR_WHEN: readonly MonitorWhen[] = ["output", "changed", "match", "exit_zero", "exit_nonzero", "always"];

interface MonitorSpec {
	name: string;
	to: string;
	from: string;
	/** Fixed poll interval. Omit for adaptive: 5s, doubling while quiet, capped at 120s, reset on activity. */
	intervalSec?: number;
	command?: string;
	message?: string;
	when: MonitorWhen;
	pattern?: string;
	once: boolean;
	urgent: boolean;
}

const MONITOR_BASE_SEC = 5;
const MONITOR_MAX_SEC = 120;

interface ActiveMonitor extends MonitorSpec {
	timer: NodeJS.Timeout | number;
	currentSec: number;
	runCount: number;
	reportCount: number;
	lastRun?: number;
	lastOutput?: string;
}

interface MonitorRun {
	stdout: string;
	stderr: string;
	output: string;
	code: number;
	match: RegExpMatchArray | null;
}

const activeMonitors = new Map<string, ActiveMonitor>();

// Decides whether one tick earns a report. `changed` compares against the last tick's
// output, so the first tick reports only when there is output to compare later.
function monitorShouldReport(mon: ActiveMonitor, run: MonitorRun): boolean {
	switch (mon.when) {
		case "always": return true;
		case "output": return run.output.length > 0;
		case "changed": return mon.lastOutput !== undefined && run.output !== mon.lastOutput;
		case "match": return run.match !== null;
		case "exit_zero": return run.code === 0;
		case "exit_nonzero": return run.code !== 0;
	}
}

// Fills `{var}` slots in the message template from the tick's context.
// Unknown slots are left as written so a typo is visible in the delivered message.
function renderMonitorMessage(mon: ActiveMonitor, run: MonitorRun): string {
	const template = mon.message || (mon.command ? "{output}" : "Monitor {name} heartbeat.");
	const vars: Record<string, string> = {
		name: mon.name,
		command: mon.command ?? "",
		stdout: run.stdout,
		stderr: run.stderr,
		output: run.output,
		code: String(run.code),
		run: String(mon.runCount),
		time: new Date().toLocaleTimeString(),
		match: run.match?.[0] ?? "",
		prev: mon.lastOutput ?? "",
	};
	run.match?.forEach((group, index) => { vars[String(index)] = group ?? ""; });
	if (run.match?.groups) { Object.assign(vars, run.match.groups); }
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (slot, key: string) => (key in vars ? vars[key] : slot));
}

function stopMonitor(name: string): boolean {
	const existing = activeMonitors.get(name);
	if (!existing) return false;
	clearTimeout(existing.timer);
	activeMonitors.delete(name);
	return true;
}

function listMonitors() {
	return Array.from(activeMonitors.values()).map((m) => ({
		name: m.name,
		to: m.to,
		from: m.from,
		cadence: m.intervalSec === undefined ? `adaptive (now ${m.currentSec}s)` : `${m.intervalSec}s`,
		when: m.when,
		pattern: m.pattern,
		once: m.once,
		command: m.command,
		message: m.message,
		runs: m.runCount,
		reports: m.reportCount,
		lastRun: m.lastRun ? new Date(m.lastRun).toLocaleTimeString() : "none",
	}));
}

function startMonitor(pi: ExtensionAPI, spec: MonitorSpec): ActiveMonitor {
	stopMonitor(spec.name);
	const regex = spec.pattern ? new RegExp(spec.pattern) : null;

	const tick = async () => {
		const mon = activeMonitors.get(spec.name);
		if (!mon) return;
		mon.runCount++;
		mon.lastRun = Date.now();

		let run: MonitorRun = { stdout: "", stderr: "", output: "", code: 0, match: null };
		if (mon.command) {
			try {
				const result = await pi.exec("sh", ["-c", mon.command], { timeout: 15_000 });
				const stdout = (result.stdout || "").trim();
				const stderr = (result.stderr || "").trim();
				run = { stdout, stderr, output: stdout || stderr, code: result.code ?? 0, match: null };
			} catch (err) {
				const stderr = err instanceof Error ? err.message : String(err);
				run = { stdout: "", stderr, output: stderr, code: -1, match: null };
			}
		}
		if (regex) { run.match = run.output.match(regex); }

		const report = monitorShouldReport(mon, run);
		const body = report ? renderMonitorMessage(mon, run) : "";
		const changed = mon.lastOutput !== undefined && run.output !== mon.lastOutput;
		mon.lastOutput = run.output;
		// Adaptive cadence: anything interesting snaps back to the base; silence backs off fast.
		if (mon.intervalSec === undefined) {
			mon.currentSec = report || changed ? MONITOR_BASE_SEC : Math.min(MONITOR_MAX_SEC, mon.currentSec * 2);
		}
		if (activeMonitors.get(mon.name) === mon) { mon.timer = setTimeout(tick, mon.currentSec * 1000); }
		if (!report) return;

		mon.reportCount++;
		if (mon.once) { stopMonitor(mon.name); }

		pi.sendMessage(
			{
				customType: "irc:incoming",
				content: `[Monitor:${mon.name} (${mon.from})] ${body}`,
				details: {
					id: `mon_${mon.name}_${Date.now()}`,
					from: mon.from,
					to: mon.to,
					message: body,
					monitor: mon.name,
					code: run.code,
					stopped: mon.once,
				},
				display: true,
			},
			{
				deliverAs: mon.urgent ? "steer" : "aside",
				triggerTurn: true,
			},
		);
	};

	const currentSec = spec.intervalSec ?? MONITOR_BASE_SEC;
	const mon: ActiveMonitor = { ...spec, timer: 0, currentSec, runCount: 0, reportCount: 0 };
	mon.timer = setTimeout(tick, currentSec * 1000);
	activeMonitors.set(spec.name, mon);
	return mon;
}

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

function hasMultilineStrings(obj: unknown): boolean {
	if (!obj || typeof obj !== "object") return false;
	for (const val of Object.values(obj as Record<string, unknown>)) {
		if (typeof val === "string" && val.includes("\n")) return true;
		if (typeof val === "object" && val !== null && hasMultilineStrings(val)) return true;
	}
	return false;
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

		if (rawText.length > 0) return rawText;
	}

	if (envelope.details && typeof envelope.details === "object") {
		if (envelope.details.data !== undefined) return envelope.details.data;
		if (envelope.details.result !== undefined) return envelope.details.result;
	}

	return result;
}

function structuredResult(result: unknown): StructuredText {
	let target = result;

	if (typeof target === "string") {
		const trimmed = target.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				target = JSON.parse(trimmed);
			} catch {
				// Fall through
			}
		}
	}

	if (target !== null && typeof target === "object") {
		if (TOON_ENCODER) {
			try {
				return { text: TOON_ENCODER(target), format: "toon" };
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

	if (typeof result === "string") {
		if (!isLikelyCode(result) && (result.trim().startsWith("---") || /^(?:[a-zA-Z0-9_-]+:\s.*|[ \t]*-\s.*)$/m.test(result))) {
			try {
				const parsedYaml = parseYaml(result);
				if (parsedYaml !== null && typeof parsedYaml === "object") {
					if (TOON_ENCODER) {
						try {
							return { text: TOON_ENCODER(parsedYaml), format: "toon" };
						} catch {}
					}
					return { text: prettifyYaml(result), format: "yaml" };
				}
			} catch {
				// Preserve malformed or ambiguous text verbatim.
			}
		}

		if (isLikelyCode(result)) {
			const lang = detectCodeLanguage(result);
			const ast = extractCodeAst(result, lang);
			if (ast && TOON_ENCODER) {
				try {
					return { text: TOON_ENCODER(ast), format: "ast-toon", lang };
				} catch {}
			}
			return { text: result, format: "code", lang };
		}
	}

	return { text: String(result), format: "text" };
}

function colorizeStructuredLine(line: string, format: StructuredFormat, theme: ThemeLike): string {
	if (format === "ast-toon" || format === "toon") {
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
			return theme.fg(literal === "null" ? "muted" : "info", literal);
		},
	);
	return indent + colored;
}

function mapToolResultToToon(result: unknown): unknown {
	const enabled = TWEAKS.some((tweak) => tweak.name === "tool-results-toon" && tweak.enabled);
	if (!enabled || !TOON_ENCODER) return result;

	if (hasMultilineStrings(result)) return result;

	if (typeof result === "string") {
		try {
			const parsedJson = JSON.parse(result);
			if (parsedJson !== null && typeof parsedJson === "object") {
				if (hasMultilineStrings(parsedJson)) return result;
				return TOON_ENCODER(parsedJson);
			}
		} catch {
			if (!isLikelyCode(result) && (result.trim().startsWith("---") || /^(?:[a-zA-Z0-9_-]+:\s.*|[ \t]*-\s.*)$/m.test(result))) {
				try {
					const parsedYaml = parseYaml(result);
					if (parsedYaml !== null && typeof parsedYaml === "object") {
						if (hasMultilineStrings(parsedYaml)) return result;
						return TOON_ENCODER(parsedYaml);
					}
				} catch {
					// Preserve text
				}
			}
		}
		return result;
	}

	if (result !== null && typeof result === "object") {
		if ("content" in result && Array.isArray((result as ToolResultEnvelope).content)) return result;
		return TOON_ENCODER(result);
	}
	return result;
}

// Tool-card styling. Truecolor lime label (#84cc16) on a deep blue block (#0f1d3a);
// the theme palette has neither slot.
const TOOL_NAME_ANSI = "\x1b[1;38;2;132;204;22m";
const TOOL_BLOCK_BG = "\x1b[48;2;15;29;58m";
const ANSI_RESET = "\x1b[0m";

// Paints one card line edge to edge: pad to the full width, and re-arm the background
// after every full reset that inner theme colors emit.
function paintToolBlockLine(line: string, width: number): string {
	const visible = line.replace(/\x1b\[[0-9;]*m/g, "").length;
	const padded = line + " ".repeat(Math.max(0, width - visible));
	const rearmed = padded.replace(/\x1b\[(?:0|49)m/g, (m) => `${m}${TOOL_BLOCK_BG}`);
	return `${TOOL_BLOCK_BG}${rearmed}${ANSI_RESET}`;
}

function toolMessageRenderer(message: ToolMessage, options: RendererOptions, theme: ThemeLike) {
	const details = message.details;
	const toolName = details?.toolName || "tool";
	const result = details?.result;
	const error = details?.isError;
	const structured = structuredResult(result);
	const pretty = structured.text.trim() || "(empty)";
	const rawLines = pretty
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);

	const prefixSymbol = error ? "✖" : "▶";
	const label = `${theme.fg(error ? "error" : "accent", prefixSymbol)} ${TOOL_NAME_ANSI}${toolName}${ANSI_RESET}`;
	const coloredPrefix = `${label} `;
	// Continuation lines hang under the first content column (visible width of "▶ name ").
	const hangingIndent = " ".repeat(`${prefixSymbol} ${toolName} `.length);

	const firstContentLine = rawLines[0]
		? colorizeStructuredLine(rawLines[0], structured.format, theme)
		: "(empty)";
	const line1 = `${coloredPrefix}${firstContentLine}`;

	// Compact card: up to 5 rows. Long output shows the first 3 lines, a lone "…" row,
	// then the final line, so the reader sees how the output ended.
	const maxCompactLines = 5;
	const headCount = rawLines.length > maxCompactLines ? maxCompactLines - 2 : rawLines.length;
	const compactLines: string[] = [line1];
	for (let i = 1; i < headCount; i++) {
		compactLines.push(`${hangingIndent}${colorizeStructuredLine(rawLines[i], structured.format, theme)}`);
	}
	if (rawLines.length > maxCompactLines) {
		compactLines.push(`${hangingIndent}${theme.fg("muted", "…")}`);
		compactLines.push(`${hangingIndent}${colorizeStructuredLine(rawLines[rawLines.length - 1], structured.format, theme)}`);
	}

	const lines = options.expanded
		? [
			`${label} · expanded ${structured.format === "ast-toon" ? `${structured.lang || "code"} AST (TOON)` : (structured.lang || structured.format)} output`,
			...rawLines.map((line) => `  ${colorizeStructuredLine(line, structured.format, theme)}`),
		]
		: compactLines;

	return {
		render(width: number): readonly string[] {
			return lines.map((line) => paintToolBlockLine(truncateToWidth(line, width), width));
		},
		invalidate() { },
	};
}

function panelComponent(theme: ThemeLike, done: (result: undefined) => void, onToggle?: () => void) {
	const groups: Record<TweakCategory, readonly Tweak[]> = {
		Workflow: TWEAKS.filter((tweak) => tweak.category === "Workflow"),
		Interface: TWEAKS.filter((tweak) => tweak.category === "Interface"),
		"Quality of life": TWEAKS.filter((tweak) => tweak.category === "Quality of life"),
	};
	const selectable = CATEGORIES.flatMap((category) => [...groups[category]]);
	const body = new Box(2, 1);
	const content = new Text();
	let selectedIndex = 0;

	const paint = () => {
		const lines: string[] = [
			theme.fg("accent", theme.bold("HYDEMODS")),
			theme.fg("muted", "A visual home for small, composable session tweaks"),
			"",
		];

		for (const category of CATEGORIES) {
			const tweaks = groups[category];
			lines.push(theme.fg("accent", theme.bold(category)));
			if (tweaks.length === 0) {
				lines.push(theme.fg("muted", "  No tweaks yet"));
				lines.push("");
				continue;
			}
			for (const tweak of tweaks) {
				const selected = selectable[selectedIndex] === tweak;
				const marker = selected ? theme.fg("accent", "❯") : " ";
				const state = tweak.enabled ? theme.fg("success", "● enabled") : theme.fg("muted", "○ disabled");
				lines.push(` ${marker} ${state}  ${theme.bold(tweak.title)}`);
				lines.push(theme.fg("muted", `           ${tweak.description}`));
				lines.push(`           ${tweak.render()}`);
			}
			lines.push("");
		}

		lines.push(theme.fg("border", "────────────────────────────────────────"));
		lines.push(theme.fg("muted", "↑/↓ or j/k select  ·  Space/Enter toggle  ·  Esc/q close"));
		content.setText(lines.join("\n"));
		body.invalidate();
	};

	const moveSelection = (delta: number) => {
		if (selectable.length === 0) return;
		selectedIndex = (selectedIndex + delta + selectable.length) % selectable.length;
		paint();
	};

	const toggleSelected = () => {
		const tweak = selectable[selectedIndex];
		if (!tweak) return;
		tweak.enabled = !tweak.enabled;
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
			if (data === " " || data === "\r" || data === "\n") toggleSelected();
		},
	};
}

/* -------------------------------------------------------------------------- */
/*                               Extension Entry                              */
/* -------------------------------------------------------------------------- */

export default function hydemods(pi: ExtensionAPI): void {
	const z = pi.zod;

	// Integrated Tool Expansion Renderer
	pi.registerMessageRenderer("integrated-tool-expansion", (message, options, theme) =>
		toolMessageRenderer(
			message as ToolMessage,
			options as RendererOptions,
			{
				fg: (color, text) => theme.fg(color as Parameters<typeof theme.fg>[0], text),
				bold: (text) => theme.bold(text),
			},
		),
	);

	pi.on("tool_execution_end", (event) => {
		if (!TWEAKS.some((tweak) => tweak.name === "integrated-tool-expansion" && tweak.enabled)) return;
		const payload = extractToolPayload(event);
		const result = mapToolResultToToon(payload);
		pi.sendMessage({
			customType: "integrated-tool-expansion",
			content: `Tool ${event.toolName} completed.`,
			details: {
				toolName: event.toolName,
				result,
				isError: event.isError,
			},
			display: true,
		});
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
		const drawerTweak = TWEAKS.find((t) => t.name === "last-prompt-drawer");
		const preview = flattenPrompt(lastPrompt);
		if (!drawerTweak?.enabled || !preview) {
			ctx.ui.setWidget("hydemods:last-prompt", undefined);
			return;
		}
		ctx.ui.setWidget(
			"hydemods:last-prompt",
			(_tui, theme) => ({
				render(width: number): readonly string[] {
					const body = truncateToWidth(preview, Math.max(1, width - 2), "…");
					return [`${theme.fg("muted", "❯ ")}${theme.fg("dim", body)}`];
				},
				invalidate() {},
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

	// Session naming is owned by the harness title generator (tiny model, online
	// fallback). It only runs while the session is unnamed, so this extension
	// never sets a name itself.
	// Intent of the tool call in flight (the `i` argument); cleared when the turn ends.
	let currentIntent = "";

	const refreshSessionIdentity = async (ctx: ExtensionContext) => {
		const identityTweak = TWEAKS.find((t) => t.name === "session-identity");
		if (!identityTweak?.enabled) {
			if (ctx.hasUI) {
				ctx.ui.setStatus("hydemods:identity", undefined);
				ctx.ui.setWidget("hydemods:identity", undefined);
			}
			return;
		}

		const sessionId = ctx.sessionManager.getSessionId();
		const identity = getSessionIdentity(sessionId);

		const badge = `${identity.color.ansi}${identity.sigil} [${identity.codename}]\x1b[0m`;

		if (ctx.hasUI) {
			ctx.ui.setStatus("hydemods:identity", badge);
			const activity = currentIntent ? `\x1b[1m${currentIntent}\x1b[0m` : "\x1b[2midle\x1b[0m";
			ctx.ui.setWidget("hydemods:identity", [` ${badge} ${activity}`], { placement: "aboveEditor" });
			ctx.ui.setTitle(`${identity.sigil} [${identity.codename}] ${pi.getSessionName() || "Session"}`);
		}
	};

	pi.on("tool_execution_start", async (event, ctx) => {
		const args = event.args as { i?: unknown } | undefined;
		const intent = event.intent || (typeof args?.i === "string" ? args.i : "");
		currentIntent = intent.trim() || event.toolName;
		await refreshSessionIdentity(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		lastPrompt = latestUserPrompt(ctx);
		refreshLastPromptDrawer(ctx);
		await refreshSessionIdentity(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastPrompt = latestUserPrompt(ctx);
		refreshLastPromptDrawer(ctx);
		await refreshSessionIdentity(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (prompt.trim().length > 0) {
			lastPrompt = prompt;
			refreshLastPromptDrawer(ctx);
		}
		await refreshSessionIdentity(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		currentIntent = "";
		await refreshSessionIdentity(ctx);
	});

	/* ----------------------------- Monitor Tool ----------------------------- */

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: "Run a shell command on an interval and report back only when a condition holds. Same engine as the /monitor command. `when` gates the report; `message` is a template over {output} {stdout} {stderr} {code} {name} {command} {run} {time} {match} {1}..{n} {prev}. `once` stops the monitor after its first report. Also sends direct IRC messages with action 'send'.",
		parameters: z.object({
			action: z.enum(["start", "stop", "list", "send"]).describe("'start' a monitor, 'stop' one by name, 'list' active monitors, or 'send' a direct IRC message"),
			name: z.string().optional().describe("Monitor name (required for start/stop)"),
			command: z.string().optional().describe("Shell command run each interval via sh -c"),
			interval_sec: z.number().optional().describe("Fixed seconds between runs (minimum 2). Omit for adaptive: 5s, doubling while quiet up to 120s, reset on any change or report."),
			when: z.enum(MONITOR_WHEN as [MonitorWhen, ...MonitorWhen[]]).optional().describe("Report condition: output (stdout non-empty, default) | changed (output differs from last run) | match (pattern matches output) | exit_zero | exit_nonzero | always"),
			pattern: z.string().optional().describe("Regex tested against output; required for when=match; capture groups fill {1}..{n} and named groups"),
			message: z.string().optional().describe("Report template. Default '{output}'. For 'send', the message body."),
			once: z.boolean().optional().describe("Stop the monitor after its first report"),
			to: z.string().optional().describe("Recipient agent/session (default 'Main')"),
			from: z.string().optional().describe("Sender identity (default 'System')"),
			urgent: z.boolean().optional().describe("Deliver as an interrupting steer instead of an aside"),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const ircTweak = TWEAKS.find((t) => t.name === "session-irc-monitor");
			if (!ircTweak?.enabled) {
				return {
					content: [{ type: "text", text: "Error: 'session-irc-monitor' tweak is currently disabled in Hydemods." }],
					details: { error: "tweak_disabled" },
				};
			}

			const to = params.to || "Main";
			const from = params.from || "System";

			if (params.action === "send") {
				if (!params.message) {
					return { content: [{ type: "text", text: "Error: 'message' is required when action is 'send'." }] };
				}
				onUpdate?.({ content: [{ type: "text", text: `Sending IRC message from ${from} to ${to}...` }] });
				pi.sendMessage(
					{
						customType: "irc:incoming",
						content: `[IRC: ${from} → ${to}]\n${params.message}`,
						details: { id: `mon_${Date.now()}`, from, to, message: params.message },
						display: true,
					},
					{ deliverAs: params.urgent ? "steer" : "aside", triggerTurn: true },
				);
				ctx.ui.notify(`IRC message sent from ${from} to ${to}`, "info");
				return {
					content: [{ type: "text", text: `Delivered IRC message from "${from}" to "${to}".` }],
					details: { to, from, message: params.message },
				};
			}

			if (params.action === "list") {
				const list = listMonitors();
				return {
					content: [{ type: "text", text: list.length === 0 ? "No active monitors." : JSON.stringify(list, null, 2) }],
					details: { monitors: list },
				};
			}

			if (params.action === "stop") {
				if (!params.name) {
					return { content: [{ type: "text", text: "Error: 'name' is required to stop a monitor." }] };
				}
				if (!stopMonitor(params.name)) {
					return { content: [{ type: "text", text: `No active monitor named "${params.name}".` }] };
				}
				ctx.ui.notify(`Monitor "${params.name}" stopped.`, "info");
				return { content: [{ type: "text", text: `Monitor "${params.name}" stopped.` }], details: { stopped: params.name } };
			}

			if (params.action === "start") {
				if (!params.name) {
					return { content: [{ type: "text", text: "Error: 'name' is required to start a monitor." }] };
				}
				const when = params.when ?? (params.pattern ? "match" : "output");
				if (when === "match" && !params.pattern) {
					return { content: [{ type: "text", text: "Error: when=match requires 'pattern'." }] };
				}
				if (params.pattern) {
					try { new RegExp(params.pattern); } catch (err) {
						return { content: [{ type: "text", text: `Error: invalid pattern: ${err instanceof Error ? err.message : String(err)}` }] };
					}
				}
				const spec: MonitorSpec = {
					name: params.name,
					to,
					from,
					intervalSec: params.interval_sec === undefined ? undefined : Math.max(2, params.interval_sec),
					command: params.command,
					message: params.message,
					when,
					pattern: params.pattern,
					once: params.once ?? false,
					urgent: params.urgent ?? false,
				};
				startMonitor(pi, spec);
				const summary = `Monitor "${spec.name}" ${spec.intervalSec === undefined ? "adaptive cadence (5s, backing off)" : `every ${spec.intervalSec}s`}, reports when=${spec.when}${spec.pattern ? ` /${spec.pattern}/` : ""}${spec.once ? ", once" : ""}, to ${to}.`;
				ctx.ui.notify(summary, "info");
				return { content: [{ type: "text", text: summary }], details: { ...spec } };
			}

			return { content: [{ type: "text", text: `Unknown action "${params.action}".` }] };
		},
	});

	/* ------------------------------ Commands -------------------------------- */

	pi.registerCommand("irc", {
		description: "Send an IRC message to an agent/session (Usage: /irc <to> <message>)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /irc <to> <message>", "warning");
				return;
			}
			const to = parts[0];
			const message = parts.slice(1).join(" ");
			const identity = getSessionIdentity(ctx.sessionManager.getSessionId());

			pi.sendMessage(
				{
					customType: "irc:incoming",
					content: `[IRC: ${identity.codename} → ${to}]\n${message}`,
					details: {
						from: identity.codename,
						to,
						message,
					},
					display: true,
				},
				{ deliverAs: "aside", triggerTurn: true },
			);
			ctx.ui.notify(`Message sent to ${to}`, "info");
		},
	});

	// Splits `key=value key="quoted value" -- command` into options and the command tail.
	function parseMonitorArgs(input: string): { options: Record<string, string>; command?: string } {
		const split = input.indexOf(" -- ");
		const head = split === -1 ? input : input.slice(0, split);
		const command = split === -1 ? undefined : input.slice(split + 4).trim() || undefined;
		const options: Record<string, string> = {};
		const re = /(\w+)=(?:"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+))/g;
		for (const m of head.matchAll(re)) {
			options[m[1]] = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\\"/g, '"');
		}
		return { options, command };
	}

	pi.registerCommand("monitor", {
		description: 'Background monitors. Usage: /monitor [list] | stop <name> | start <name> [every=<sec>] [when=output|changed|match|exit_zero|exit_nonzero|always] [match=<regex>] [once] [urgent] [msg="template with {output} {code} {1}…"] -- <shell command>. Without every=, cadence is adaptive: 5s, backing off to 120s while quiet.',
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const sub = trimmed.split(/\s+/)[0] || "list";

			if (sub === "stop") {
				const target = trimmed.split(/\s+/)[1];
				if (!target) {
					ctx.ui.notify("Usage: /monitor stop <name>", "warning");
					return;
				}
				const stopped = stopMonitor(target);
				ctx.ui.notify(stopped ? `Monitor "${target}" stopped` : `No active monitor named "${target}"`, stopped ? "info" : "warning");
				return;
			}

			if (sub === "start") {
				const rest = trimmed.slice("start".length).trim();
				const name = rest.split(/\s+/)[0];
				if (!name || name.includes("=") || name === "--") {
					ctx.ui.notify("Usage: /monitor start <name> [every=<sec>] [when=…] [match=…] [once] [urgent] [msg=\"…\"] -- <command>", "warning");
					return;
				}
				const optionText = rest.slice(name.length);
				const { options, command } = parseMonitorArgs(optionText);
				const head = optionText.includes(" -- ") ? optionText.slice(0, optionText.indexOf(" -- ")) : optionText;
				const flags = new Set(head.split(/\s+/));
				const pattern = options.match;
				const whenRaw = options.when ?? (pattern ? "match" : "output");
				const when = MONITOR_WHEN.find((w) => w === whenRaw);
				if (!when) {
					ctx.ui.notify(`Unknown when=${whenRaw}. Use one of: ${MONITOR_WHEN.join(", ")}`, "warning");
					return;
				}
				if (when === "match" && !pattern) {
					ctx.ui.notify("when=match needs match=<regex>", "warning");
					return;
				}
				if (pattern) {
					try { new RegExp(pattern); } catch (err) {
						ctx.ui.notify(`Invalid match regex: ${err instanceof Error ? err.message : String(err)}`, "warning");
						return;
					}
				}
				const spec: MonitorSpec = {
					name,
					to: options.to || "Main",
					from: options.from || "System",
					intervalSec: options.every === undefined ? undefined : Math.max(2, Number(options.every) || MONITOR_BASE_SEC),
					command,
					message: options.msg ?? options.message,
					when,
					pattern,
					once: flags.has("once") || options.once === "true",
					urgent: flags.has("urgent") || options.urgent === "true",
				};
				startMonitor(pi, spec);
				ctx.ui.notify(`Monitor "${name}" ${spec.intervalSec === undefined ? "adaptive cadence" : `every ${spec.intervalSec}s`}, when=${when}${pattern ? ` /${pattern}/` : ""}${spec.once ? ", once" : ""}`, "info");
				return;
			}

			const list = listMonitors();
			if (list.length === 0) {
				ctx.ui.notify("No active monitors.", "info");
				return;
			}
			ctx.ui.notify(`Active monitors (${list.length}): ${list.map((m) => `${m.name} [${m.when}, ${m.cadence}, ${m.reports}/${m.runs} reported]`).join("; ")}`, "info");
		},
	});

	pi.registerCommand("rename", {
		description: "Rename the current session and refresh identity badge",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /rename <title>", "warning");
				return;
			}
			await pi.setSessionName(name);
			await refreshSessionIdentity(ctx);
			ctx.ui.notify(`Session renamed to "${name}"`, "info");
		},
	});

	pi.registerCommand("heartbeat", {
		description: "Prompt the agent to establish intrinsic goals and explore the codebase (Usage: /heartbeat [optional topic])",
		handler: async (args, ctx) => {
			const tweak = TWEAKS.find((t) => t.name === "heartbeat-command");
			if (!tweak?.enabled) {
				ctx.ui.notify("Error: 'heartbeat-command' is disabled in /hydemods.", "warning");
				return;
			}

			const focus = args.trim();
			const focusText = focus
				? `Focus your curiosity on this domain: "${focus}".`
				: "Survey recent commits, project structure, open notes, and code that catches your attention.";

			const prompt = [
				"💓 [Autonomous Heartbeat Cycle]",
				focusText,
				"",
				"Instructions:",
				"1. Review the current state of the workspace.",
				"2. Formulate 1 to 3 explicit intrinsic goals you want to explore.",
				"3. Perform a read-only investigation using discovery tools (read, grep, glob).",
				"4. Share your findings and observations concisely (following ASD-STE100 principles). If you discover actionable improvements, propose them before mutating files.",
			].join("\n");

			pi.sendUserMessage(prompt, { deliverAs: "steer" });
			ctx.ui.notify(focus ? `Heartbeat pulse: ${focus}` : "Autonomous heartbeat dispatched", "info");
		},
	});

	pi.registerCommand("retro", {
		description: "Trigger a structured session retrospective (Usage: /retro)",
		handler: async (_args, ctx) => {
			const tweak = TWEAKS.find((t) => t.name === "session-retro-command");
			if (!tweak?.enabled) {
				ctx.ui.notify("Error: 'session-retro-command' is disabled in /hydemods.", "warning");
				return;
			}

			const prompt = [
				"🧭 [Session Retrospective]",
				"Conduct a structured retrospective of the work completed in this session:",
				"1. What goals were established and what was achieved?",
				"2. What technical friction or unexpected obstacles occurred, and how were they resolved?",
				"3. What durable insights, conventions, or architectural decisions should be remembered?",
				"Format the response clearly with headers, bullet points, and ASD-STE100 principles.",
			].join("\n");

			pi.sendUserMessage(prompt, { deliverAs: "steer" });
			ctx.ui.notify("Retrospective cycle dispatched", "info");
		},
	});

	pi.on("session_shutdown", () => {
		for (const monitor of activeMonitors.values()) {
			clearInterval(monitor.timer);
		}
		activeMonitors.clear();
	});

	pi.registerCommand("hydemods", {
		description: "Open the Hydemods visual tweak panel",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom(
				(_tui, theme, keybindings, done) => {
					const component = panelComponent(
						{
							fg: (color, text) => {
								const themeColor = color as Parameters<typeof theme.fg>[0];
								return theme.fg(themeColor, text);
							},
							bold: (text) => theme.bold(text),
						},
						done,
						() => {
							refreshSessionIdentity(ctx);
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
