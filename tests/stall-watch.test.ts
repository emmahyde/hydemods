import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStall, detectStalls } from "../lib/stall-watch";

const now = new Date("2026-10-01T16:00:00.000Z");
const old = "2026-10-01T15:54:00.000Z";
const thresholds = { modelStallMinutes: 5, toolStallMinutes: 20 };

function fixture(lines: unknown[]): string {
	const root = mkdtempSync(join(tmpdir(), "hydemods-stall-"));
	const session = join(root, "parent.jsonl");
	writeFileSync(session, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
	return session;
}

describe("stall watch", () => {
	test("classifies an old tool result as model stall", () => {
		const path = fixture([
			{ timestamp: old, type: "message", message: { role: "assistant", model: "gpt-5.6-luna", content: [] } },
			{ timestamp: old, type: "message", message: { role: "toolResult", toolCallId: "call-1" } },
		]);
		const stall = classifyStall(path, now, thresholds);
		expect(stall?.kind).toBe("model");
		expect(stall?.message).toContain("parent idle 6m");
		expect(stall?.message).toContain("waiting on model (gpt-5.6-luna)");
	});

	test("classifies an open tool execution with its tool name", () => {
		const path = fixture([{ timestamp: "2026-10-01T15:30:00.000Z", type: "custom", customType: "tool_execution_start", data: { toolName: "bash", startedAt: "2026-10-01T15:30:00.000Z" } }]);
		const stall = classifyStall(path, now, thresholds);
		expect(stall?.kind).toBe("tool");
		expect(stall?.message).toContain("waiting on tool bash for 30m");
	});

	test("deduplicates an episode and rearms after a new entry", () => {
		const path = fixture([{ timestamp: old, type: "message", message: { role: "user", content: "go" } }]);
		const dir = path.slice(0, -".jsonl".length);
		const alerted = new Set<string>();
		expect(detectStalls(path, now, thresholds, alerted)).toHaveLength(1);
		expect(detectStalls(path, now, thresholds, alerted)).toHaveLength(0);
		writeFileSync(path, JSON.stringify({ timestamp: "2026-10-01T15:53:00.000Z", type: "message", message: { role: "user", content: "again" } }) + "\n");
		expect(detectStalls(path, now, thresholds, alerted)).toHaveLength(1);
		void dir;
	});
});
