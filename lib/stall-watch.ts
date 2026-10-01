import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type StallKind = "model" | "tool";
export type StallThresholds = { modelStallMinutes: number; toolStallMinutes: number };
export type StallAlert = {
	agentName: string;
	kind: StallKind;
	idleMinutes: number;
	model?: string;
	toolName?: string;
	startedAt: Date;
	message: string;
	key: string;
};

type Entry = Record<string, unknown>;
const MODEL_DEFAULT = 5;
const TOOL_DEFAULT = 20;

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
	const positive = (name: string, fallback: number) => {
		const value = Number(process.env[name]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};
	return { modelStallMinutes: positive("HYDEMODS_STALL_MODEL_MIN", MODEL_DEFAULT), toolStallMinutes: positive("HYDEMODS_STALL_TOOL_MIN", TOOL_DEFAULT) };
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
		kind = "model";
		model = entries.slice().reverse().map(modelOf).find(Boolean);
		const priorStart = entries.slice(0, -1).reverse().find(entry => (dataOf(entry).customType ?? entry.customType) === "tool_execution_start");
		toolName = priorStart ? (typeof dataOf(priorStart).toolName === "string" ? dataOf(priorStart).toolName : undefined) : undefined;
	} else return undefined;
	const idleMinutes = Math.max(0, (now.getTime() - startedAt.getTime()) / 60_000);
	const limit = kind === "model" ? thresholds.modelStallMinutes : thresholds.toolStallMinutes;
	if (idleMinutes <= limit) return undefined;
	const agentName = basename(path, ".jsonl");
	const rounded = Math.floor(idleMinutes);
	const since = startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	const detail = kind === "model" ? `waiting on model${model ? ` (${model})` : ""} since ${since}${toolName ? ` after ${toolName}` : ""}` : `waiting on tool ${toolName ?? "unknown"} for ${rounded}m`;
	const message = `${agentName} idle ${rounded}m — ${detail}. Hint: kill: write proc://${agentName}/kill`;
	return { agentName, kind, idleMinutes, model, toolName, startedAt, message, key: `${path}:${startedAt.toISOString()}:${kind}` };
}

/** Scans the parent transcript and its sibling subagent transcripts, suppressing repeated alerts per episode. */
export function detectStalls(sessionFile: string, now = new Date(), thresholds = thresholdsFromEnv(), alerted = new Set<string>()): StallAlert[] {
	const files = [sessionFile];
	try {
		const dir = sessionFile.slice(0, -".jsonl".length);
		for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) files.push(join(dir, name));
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
