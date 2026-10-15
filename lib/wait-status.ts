/**
 * One-line readout for the `wait` tool. Its model-visible result is a multi-section markdown
 * snapshot of background jobs; collapsed, the transcript only needs the counts and which jobs.
 * Expanded (Ctrl+O) still shows the full native card.
 */
import type { Theme } from "@oh-my-pi/pi-tui/theme";

type WaitJob = { id?: unknown; label?: unknown; status?: unknown };
type WaitResult = { content?: unknown; details?: unknown; isError?: boolean };

const NAMES_SHOWN = 2;
// Job statuses that mean the job has not settled; everything else counts under its own name.
const LIVE = new Set(["running", "pending", "queued"]);
const FAILED = new Set(["failed", "error", "aborted", "timed_out"]);

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n");
}

function jobsOf(details: unknown): WaitJob[] | undefined {
	if (!details || typeof details !== "object" || !("jobs" in details)) return undefined;
	const jobs = (details as { jobs: unknown }).jobs;
	return Array.isArray(jobs) ? (jobs as WaitJob[]) : undefined;
}

function nameOf(job: WaitJob): string | undefined {
	const name = typeof job.label === "string" && job.label ? job.label : typeof job.id === "string" ? job.id : undefined;
	return name || undefined;
}

/** Counts per bucket and the job names, from details.jobs, else from `## Heading (N)` sections in the text. */
function tally(result: WaitResult): { counts: Map<string, number>; names: string[] } | undefined {
	const jobs = jobsOf(result.details);
	if (jobs?.length) {
		const counts = new Map<string, number>();
		const names: string[] = [];
		for (const job of jobs) {
			const status = typeof job.status === "string" ? job.status : "unknown";
			const bucket = LIVE.has(status) ? "running" : FAILED.has(status) ? "failed" : status;
			counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
			const name = nameOf(job);
			if (name) names.push(name);
		}
		return { counts, names };
	}
	const counts = new Map<string, number>();
	const names: string[] = [];
	const text = textOf(result.content);
	for (const match of text.matchAll(/^## ([A-Za-z][A-Za-z ]*?) \((\d+)\)/gm)) {
		const bucket = match[1]!.toLowerCase().replace(/^still /, "");
		counts.set(bucket, (counts.get(bucket) ?? 0) + Number(match[2]));
	}
	for (const match of text.matchAll(/^### (\S+) \[/gm)) names.push(match[1]!);
	return counts.size ? { counts, names } : undefined;
}

/** A themed single line for a `wait` call, or undefined when the native card should draw it (expanded). */
export function waitStatusLine(result: WaitResult | undefined, options: { expanded: boolean; isPartial: boolean; intent?: string }, theme: Theme): string | undefined {
	const meta = (text: string) => theme.fg("dim", text);
	if (options.isPartial || !result) {
		return `${theme.fg("warning", "⏳ Waiting")}${options.intent ? meta(` · ${options.intent}`) : ""}`;
	}
	if (options.expanded) return undefined;
	const details = result.details as { __interrupted?: unknown } | undefined;
	if (details?.__interrupted) return `${theme.fg("warning", "⏭ Wait skipped")} ${meta("· a background completion arrived first")}`;
	const tallied = tally(result);
	if (!tallied) {
		return result.isError ? theme.fg("error", "✗ Wait failed") : `${theme.fg("success", "✓ Wait")} ${meta("· no job changes")}`;
	}
	const { counts, names } = tallied;
	const failed = counts.get("failed") ?? 0;
	const running = counts.get("running") ?? 0;
	const parts = [...counts].sort(([a], [b]) => (a === "failed" ? -1 : b === "failed" ? 1 : 0)).map(([bucket, n]) => `${n} ${bucket}`);
	const glyph = failed ? "✗" : running && counts.size === 1 ? "◐" : "✓";
	const color = failed ? "error" : running && counts.size === 1 ? "warning" : "success";
	const shown = names.slice(0, NAMES_SHOWN).join(", ");
	const more = names.length > NAMES_SHOWN ? ` +${names.length - NAMES_SHOWN}` : "";
	return `${theme.fg(color, `${glyph} Wait`)} ${meta(`· ${parts.join(", ")}`)}${shown ? ` ${theme.fg("text", shown)}${meta(more)}` : ""}`;
}
