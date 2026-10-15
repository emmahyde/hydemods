/**
 * Compact body for the `task` tool card: one dense row per agent, a state digest on top.
 *
 * Collapsed view only. Expanded (Ctrl+O), review findings, nested task trees and anything the
 * card cannot summarise defer to OMP's own renderer (`taskCardBody` returns undefined).
 *
 *   ◐ 2 running  ✓ 3 done  ✗ 1 failed  ○ 4 queued · $0.42 · 4m12s
 *   ◐ Auth-Refactor  split the token refresh path            12 ⚙ · 34 req · $0.18
 *     └ edit "src/auth/refresh.ts"
 *   ✗ Docs-Pass  update the README tables                    3 ⚙ · $0.02
 *     └ aborted: context exhausted
 */
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

type Status = "pending" | "running" | "completed" | "failed" | "aborted";

/** The slice of OMP's `AgentProgress` the card reads. */
export interface ProgressRow {
	id: string;
	status: Status;
	description?: string;
	task: string;
	assignment?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string }>;
	toolCount: number;
	requests: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAtMs: number };
	retryFailure?: { attempt: number; errorMessage: string };
	extractedToolData?: Record<string, unknown[]>;
	inflightTaskDetails?: unknown;
}

/** The slice of OMP's `SingleResult` the card reads. */
export interface ResultRow {
	id: string;
	description?: string;
	task: string;
	assignment?: string;
	exitCode: number;
	aborted?: boolean;
	abortReason?: string;
	error?: string;
	requests: number;
	contextTokens?: number;
	contextWindow?: number;
	durationMs: number;
	usage?: { cost?: { total?: number } };
	extractedToolData?: Record<string, unknown[]>;
	retryFailure?: { attempt: number; errorMessage: string };
}

export interface TaskDetails {
	results?: ResultRow[];
	progress?: ProgressRow[];
	totalDurationMs?: number;
}

type Painter = Pick<Theme, "fg" | "bold">;

const STALL_TOOL_MS = 6 * 60_000; // first stage of stall-watch's tool escalation
const SLOW_TOOL_MS = 5_000;
const CONTEXT_SHOW = 0.5;
const CONTEXT_WARN = 0.8;
const COST_OUTLIER = 2; // x the median of the other agents
const COST_FLOOR = 0.1;
const MAX_ROWS = 8;
const MAX_QUEUED_ROWS = 2;

/** One normalised agent, whether live or settled. */
interface Row {
	id: string;
	state: "running" | "stalled" | "queued" | "done" | "failed";
	summary: string;
	toolCount: number;
	requests: number;
	ctxFrac?: number;
	cost: number;
	activity?: { text: string; color: ThemeColor };
	problem?: string;
	elapsedMs: number;
}

const GLYPH: Record<Row["state"], { glyph: string; color: ThemeColor }> = {
	running: { glyph: "◐", color: "accent" },
	done: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	stalled: { glyph: "⏸", color: "warning" },
	queued: { glyph: "○", color: "dim" },
};

/** Tool-kind colour for the activity line: reads and searches, writes, shell, everything else. */
function toolColor(tool: string): ThemeColor {
	if (/^(read|grep|find|glob|ast_grep|lsp|web_search|search)/.test(tool)) return "accent";
	if (/^(edit|write|ast_edit|notebook)/.test(tool)) return "warning";
	if (/^(bash|eval|task|debug)/.test(tool)) return "success";
	return "muted";
}

function oneLine(text: string | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

function firstLine(text: string | undefined): string {
	return oneLine((text ?? "").split("\n").find(line => line.trim()) ?? "");
}

function summary(row: { description?: string; assignment?: string; task: string }): string {
	return oneLine(row.description) || firstLine(row.assignment) || firstLine(row.task);
}

function ctxFrac(row: { contextTokens?: number; contextWindow?: number }): number | undefined {
	return row.contextTokens && row.contextWindow && row.contextWindow > 0 ? row.contextTokens / row.contextWindow : undefined;
}

function liveRow(p: ProgressRow, nowMs: number): Row {
	const base = {
		id: p.id,
		summary: summary(p),
		toolCount: p.toolCount,
		requests: p.requests,
		ctxFrac: ctxFrac(p),
		cost: p.cost,
		elapsedMs: p.durationMs,
	};
	if (p.status === "pending") return { ...base, state: "queued" };
	if (p.status === "failed" || p.status === "aborted") {
		const reason = p.retryFailure ? `rate-limited after ${p.retryFailure.attempt} tries: ${oneLine(p.retryFailure.errorMessage)}` : p.status;
		return { ...base, state: "failed", problem: reason };
	}
	if (p.status === "completed") return { ...base, state: "done" };
	const toolMs = p.currentToolStartMs ? nowMs - p.currentToolStartMs : 0;
	const tool = p.currentTool ?? p.recentTools[0]?.tool;
	const arg = oneLine(p.currentTool ? (p.lastIntent ?? p.currentToolArgs) : (p.lastIntent ?? p.recentTools[0]?.args));
	let activity: Row["activity"];
	if (p.retryState) {
		const waitMs = Math.max(0, p.retryState.startedAtMs + p.retryState.delayMs - nowMs);
		activity = {
			text: `retrying ${p.retryState.attempt}/${p.retryState.maxAttempts} in ${formatDuration(waitMs)}: ${oneLine(p.retryState.errorMessage)}`,
			color: "warning",
		};
	} else if (tool) {
		const slow = toolMs > SLOW_TOOL_MS ? ` ${formatDuration(toolMs)}` : "";
		activity = { text: `${tool}${arg ? ` "${arg}"` : ""}${slow}`, color: toolMs > SLOW_TOOL_MS ? "warning" : toolColor(tool) };
	}
	return { ...base, state: toolMs > STALL_TOOL_MS ? "stalled" : "running", activity };
}

function settledRow(r: ResultRow): Row {
	const failed = Boolean(r.aborted) || r.exitCode !== 0 || Boolean(r.error);
	const reason = r.aborted
		? `aborted${r.abortReason ? `: ${firstLine(r.abortReason)}` : ""}`
		: r.retryFailure
			? `rate-limited after ${r.retryFailure.attempt} tries`
			: r.error
				? firstLine(r.error)
				: `exit ${r.exitCode}`;
	return {
		id: r.id,
		state: failed ? "failed" : "done",
		summary: summary(r),
		toolCount: 0,
		requests: r.requests,
		ctxFrac: ctxFrac(r),
		cost: r.usage?.cost?.total ?? 0,
		problem: failed ? reason : undefined,
		elapsedMs: r.durationMs,
	};
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function money(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

/** Task ids look like `0-AuthRefactor`; show the name without the dispatch index. */
function displayId(id: string): string {
	return id.replace(/^\d+-/, "");
}

/** A stat the row can show, in left-to-right display order; lower `drop` goes first when width runs out. */
interface Stat {
	text: string;
	color: ThemeColor;
	drop: number;
}

function stats(row: Row, outlier: boolean): Stat[] {
	const out: Stat[] = [];
	if (row.toolCount > 0) out.push({ text: `${formatNumber(row.toolCount)} ⚙`, color: "dim", drop: 2 });
	if (row.requests > 0) out.push({ text: `${formatNumber(row.requests)} req`, color: "dim", drop: 1 });
	if (row.ctxFrac !== undefined && row.ctxFrac >= CONTEXT_SHOW) {
		out.push({ text: `ctx ${Math.round(row.ctxFrac * 100)}%`, color: row.ctxFrac >= CONTEXT_WARN ? "warning" : "muted", drop: 0 });
	}
	if (row.cost > 0) out.push({ text: money(row.cost), color: outlier ? "warning" : "statusLineCost", drop: 3 });
	return out;
}

function renderStats(items: Stat[], theme: Painter): string {
	return items.map(s => theme.fg(s.color, s.text)).join(theme.fg("dim", " · "));
}

function renderRow(row: Row, outlier: boolean, width: number, theme: Painter): string[] {
	const g = GLYPH[row.state];
	const nameColor: ThemeColor = row.state === "queued" ? "dim" : row.state === "done" ? "text" : row.state === "failed" ? "error" : "accent";
	const head = `${theme.fg(g.color, g.glyph)} ${theme.fg(nameColor, theme.bold(displayId(row.id)))}`;
	let shown = stats(row, outlier);
	const gap = 2;
	const headWidth = visibleWidth(head);
	// Drop the least important stat first until the summary has room to breathe.
	while (shown.length > 0 && headWidth + 2 + 12 + gap + visibleWidth(renderStats(shown, theme)) > width) {
		const least = shown.reduce((a, b) => (b.drop < a.drop ? b : a));
		shown = shown.filter(s => s !== least);
	}
	const right = renderStats(shown, theme);
	const rightWidth = visibleWidth(right);
	const room = Math.max(0, width - headWidth - 2 - (rightWidth ? rightWidth + gap : 0));
	const text = truncateToWidth(row.summary, room);
	const pad = Math.max(gap, width - headWidth - 2 - visibleWidth(text) - rightWidth);
	const lines = [`${head}  ${theme.fg(row.state === "queued" ? "dim" : "muted", text)}${rightWidth ? " ".repeat(pad) + right : ""}`];
	if (row.problem) lines.push(`  ${theme.fg("dim", "└")} ${theme.fg("error", truncateToWidth(row.problem, Math.max(10, width - 4)))}`);
	else if (row.activity) lines.push(`  ${theme.fg("dim", "└")} ${theme.fg(row.activity.color, truncateToWidth(row.activity.text, Math.max(10, width - 4)))}`);
	return lines;
}

function digest(rows: Row[], totalCost: number, wallMs: number | undefined, theme: Painter): string {
	const count = (state: Row["state"]) => rows.filter(r => r.state === state).length;
	const parts: string[] = [];
	const add = (state: Row["state"], label: string, color: ThemeColor = GLYPH[state].color) => {
		const n = count(state);
		if (n > 0) parts.push(theme.fg(color, `${GLYPH[state].glyph} ${n} ${label}`));
	};
	add("running", "running");
	add("stalled", "stalled");
	add("done", "done");
	add("failed", "failed");
	add("queued", "queued");
	const tail = [totalCost > 0 ? theme.fg("statusLineCost", money(totalCost)) : "", wallMs ? theme.fg("dim", formatDuration(wallMs)) : ""].filter(Boolean);
	return [parts.join("  "), ...tail].join(theme.fg("dim", " · "));
}

/** Fold-away order: problems first, then live edge, then queued; finished rows go last and collapse. */
const ORDER: Record<Row["state"], number> = { failed: 0, stalled: 1, running: 2, queued: 3, done: 4 };

export interface TaskCardBody {
	lines: string[];
	/** Any agent failed or aborted: the card is in its error state. */
	failed: boolean;
}

/**
 * Compact collapsed-card body, or undefined when OMP's native renderer should draw the card.
 * `nowMs` drives elapsed-tool and retry-countdown text; pass the host's frozen clock when given.
 */
export function taskCardBody(details: TaskDetails | undefined, opts: { expanded: boolean; width: number; nowMs: number }, theme: Painter): TaskCardBody | undefined {
	if (!details || opts.expanded) return undefined;
	const results = details.results ?? [];
	const progress = (details.progress ?? []).filter(p => !results.some(r => r.id === p.id));
	if (results.length + progress.length === 0) return undefined;
	// Review verdicts, yielded data and nested task trees need the native renderer.
	const heavy = (x: { extractedToolData?: Record<string, unknown[]> }) => Boolean(x.extractedToolData && Object.keys(x.extractedToolData).length > 0);
	if (results.some(heavy) || progress.some(p => heavy(p) || p.inflightTaskDetails)) return undefined;

	const rows = [...results.map(settledRow), ...progress.map(p => liveRow(p, opts.nowMs))];
	const costs = rows.map(r => r.cost);
	const outlierOf = (row: Row) => {
		const others = costs.filter((_, i) => rows[i] !== row);
		return rows.length >= 3 && row.cost >= COST_FLOOR && row.cost > COST_OUTLIER * median(others);
	};
	const ordered = [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.elapsedMs - a.elapsedMs);

	const lines = [digest(rows, costs.reduce((a, b) => a + b, 0), details.totalDurationMs || undefined, theme)];
	const done = ordered.filter(r => r.state === "done");
	const queued = ordered.filter(r => r.state === "queued");
	const active = ordered.filter(r => r.state !== "done" && r.state !== "queued");
	// A small batch keeps every row; a large one folds finished and queued agents into summary lines.
	const foldDone = rows.length > 4 && done.length > 0;
	const shownQueued = rows.length > 4 ? queued.slice(0, MAX_QUEUED_ROWS) : queued;
	const visible = [...active.slice(0, MAX_ROWS), ...shownQueued, ...(foldDone ? [] : done)];
	for (const row of visible) lines.push(...renderRow(row, outlierOf(row), opts.width, theme));
	const hiddenActive = active.length - Math.min(active.length, MAX_ROWS);
	if (hiddenActive > 0) lines.push(theme.fg("dim", `… ${hiddenActive} more active agent${hiddenActive === 1 ? "" : "s"} (Ctrl+O)`));
	if (queued.length > shownQueued.length && rows.length > 4) lines.push(theme.fg("dim", `○ ${queued.length - shownQueued.length} more queued`));
	if (foldDone) lines.push(theme.fg("dim", truncateToWidth(`✓ ${done.length} done: ${done.map(r => displayId(r.id)).join(", ")} (Ctrl+O)`, opts.width)));
	return { lines, failed: rows.some(r => r.state === "failed") };
}
