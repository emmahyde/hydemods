import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type StallKind = "model" | "tool";
export type StallThresholds = { modelStallMinutes: number; toolStageMinutes: number[] };
/** check-in: ask the stuck agent to report; alert: notify only; kill: abort the agent's current turn. */
export type StallAction = "check-in" | "alert" | "kill";
export type StallAlert = {
	agentName: string;
	kind: StallKind;
	idleMinutes: number;
	/** Index of the highest tool stage passed; always 0 for model stalls. */
	stage: number;
	action: StallAction;
	path: string;
	model?: string;
	toolName?: string;
	startedAt: Date;
	message: string;
	key: string;
};

type Entry = Record<string, unknown>;
const MODEL_DEFAULT = 5;
/** Tool-call escalation: first stage checks in, middle stages alert, the last kills. */
const TOOL_STAGES_DEFAULT = [6, 12, 20];

function asDate(value: unknown): Date | undefined {
	if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value);
	if (typeof value === "string") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date;
	}
	return undefined;
}

function timestamp(entry: Entry): Date | undefined {
	return asDate(entry.timestamp) ?? asDate((entry.data as Entry | undefined)?.startedAt) ?? asDate((entry.data as Entry | undefined)?.recordedAt);
}

function dataOf(entry: Entry): Entry {
	return (entry.data && typeof entry.data === "object" ? entry.data : entry) as Entry;
}

function roleOf(entry: Entry): string | undefined {
	const message = entry.message as Entry | undefined;
	return typeof message?.role === "string" ? message.role : typeof entry.role === "string" ? entry.role : undefined;
}

function toolResultId(entry: Entry): string | undefined {
	const message = entry.message as Entry | undefined;
	const source = message ?? entry;
	return typeof source.toolCallId === "string" ? source.toolCallId : typeof source.tool_call_id === "string" ? source.tool_call_id : undefined;
}

function modelOf(entry: Entry): string | undefined {
	const message = entry.message as Entry | undefined;
	const source = message ?? entry;
	if (typeof source.model === "string") return source.model;
	if (typeof entry.model === "string") return String(entry.model);
	return undefined;
}

function readEntries(path: string): Entry[] {
	try {
		return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
			try { return [JSON.parse(line) as Entry]; } catch { return []; }
		});
	} catch { return []; }
}

function thresholdsFromEnv(): StallThresholds {
	const model = Number(process.env.HYDEMODS_STALL_MODEL_MIN);
	const stages = (process.env.HYDEMODS_STALL_TOOL_STAGES ?? "").split(",").map(Number).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
	return {
		modelStallMinutes: Number.isFinite(model) && model > 0 ? model : MODEL_DEFAULT,
		toolStageMinutes: stages.length ? stages : TOOL_STAGES_DEFAULT,
	};
}

/** Picks the stage an idle tool call has reached, or undefined below the first threshold. */
export function toolStage(idleMinutes: number, stages: number[]): { stage: number; action: StallAction } | undefined {
	const stage = stages.filter(minutes => idleMinutes > minutes).length - 1;
	if (stage < 0) return undefined;
	const action: StallAction = stage === 0 ? "check-in" : stages.length > 1 && stage === stages.length - 1 ? "kill" : "alert";
	return { stage, action };
}

export function defaultStallThresholds(): StallThresholds { return thresholdsFromEnv(); }

/** Classifies one persisted JSONL transcript. Returns a stall only after its configured idle threshold. */
export function classifyStall(path: string, now = new Date(), thresholds = thresholdsFromEnv()): StallAlert | undefined {
	const entries = readEntries(path);
	if (!entries.length) return undefined;
	const last = entries[entries.length - 1];
	const lastData = dataOf(last);
	if ((lastData.customType ?? last.customType) === "session_exit") return undefined;
	const lastTimestamp = timestamp(last);
	if (!lastTimestamp) return undefined;
	let kind: StallKind | undefined;
	let toolName: string | undefined;
	let startedAt = lastTimestamp;
	let model: string | undefined;
	const role = roleOf(last);
	if ((lastData.customType ?? last.customType) === "tool_execution_start") {
		kind = "tool";
		toolName = typeof lastData.toolName === "string" ? lastData.toolName : undefined;
		startedAt = asDate(lastData.startedAt) ?? lastTimestamp;
	} else if (role === "toolResult" || role === "user") {
		// A yield result is a finished subagent sitting idle, not a stall.
		if (role === "toolResult" && (last.message as Entry | undefined)?.toolName === "yield") return undefined;
		kind = "model";
		model = entries.slice().reverse().map(modelOf).find(Boolean);
		const priorStart = entries.slice(0, -1).reverse().find(entry => (dataOf(entry).customType ?? entry.customType) === "tool_execution_start");
		const priorTool = priorStart ? dataOf(priorStart).toolName : undefined;
		toolName = typeof priorTool === "string" ? priorTool : undefined;
	} else return undefined;
	const idleMinutes = Math.max(0, (now.getTime() - startedAt.getTime()) / 60_000);
	let stage = 0;
	let action: StallAction = "alert";
	if (kind === "model") {
		if (idleMinutes <= thresholds.modelStallMinutes) return undefined;
	} else {
		const reached = toolStage(idleMinutes, thresholds.toolStageMinutes);
		if (!reached) return undefined;
		({ stage, action } = reached);
	}
	const agentName = basename(path, ".jsonl");
	const rounded = Math.floor(idleMinutes);
	const since = startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	const detail = kind === "model" ? `waiting on model${model ? ` (${model})` : ""} since ${since}${toolName ? ` after ${toolName}` : ""}` : `waiting on tool ${toolName ?? "unknown"} for ${rounded}m`;
	const next = action === "check-in" ? "Asked it to check in." : action === "kill" ? "Aborting its turn." : `Hint: kill: write proc://${agentName}/kill`;
	const message = `${agentName} idle ${rounded}m — ${detail}. ${next}`;
	return { agentName, kind, idleMinutes, stage, action, path, model, toolName, startedAt, message, key: `${path}:${startedAt.toISOString()}:${kind}:${stage}` };
}

/**
 * Scans the parent transcript and its sibling subagent transcripts, suppressing repeated alerts per episode.
 * Subagent transcripts last written before `liveSince` belong to a previous OMP process (subagents never
 * survive a restart), so they are skipped rather than reported as stalled forever.
 */
export function detectStalls(sessionFile: string, now = new Date(), thresholds = thresholdsFromEnv(), alerted = new Set<string>(), liveSince = 0): StallAlert[] {
	const files = [sessionFile];
	try {
		const dir = sessionFile.slice(0, -".jsonl".length);
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (name.endsWith(".jsonl") && statSync(path).mtimeMs >= liveSince) files.push(path);
		}
	} catch { /* session may not have a subagent directory yet */ }
	const alerts: StallAlert[] = [];
	for (const path of [...new Set(files)]) {
		const stall = classifyStall(path, now, thresholds);
		if (stall && !alerted.has(stall.key)) { alerted.add(stall.key); alerts.push(stall); }
		if (!stall) for (const key of [...alerted]) if (key.startsWith(`${path}:`)) alerted.delete(key);
	}
	return alerts;
}

export function sessionAgentDirectory(sessionFile: string): string { return dirname(sessionFile); }
