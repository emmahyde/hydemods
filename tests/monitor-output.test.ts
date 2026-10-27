import { expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { formatMonitorOutput } from "../lib/monitors";
import { monitorOutputComponent } from "../lib/monitor-output";

test("monitor JSONL keeps nested metadata, quoted strings and interleaved timestamps", () => {
	const event = { timestamp: "2026-10-25T16:31:12.208Z", message: 'credentials, "refreshed"', dd: { env: "production" }, owner_id: "9223372036854775807" };
	const lines = ["2026-10-25T16:31:12.209202406Z", JSON.stringify(event), "not json {", JSON.stringify({ ...event, message: "boot.sandbox_files_written" })];
	expect(decode(formatMonitorOutput(lines.join("\n")))).toEqual({ output: [lines[0], event, lines[2], { ...event, message: "boot.sandbox_files_written" }] });
	expect(decode(formatMonitorOutput(JSON.stringify([event])))).toEqual({ output: [event] });
});

test("long records stay within the preview row and width bounds; expansion retains the last value", () => {
	const output = formatMonitorOutput(Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, message: "credentials.refreshed ".repeat(20), end: `record-${i}` })).join("\n"));
	for (const width of [30, 80, 120]) {
		const rows = monitorOutputComponent("Monitor event: minion-2200-debug", output, false).render(width);
		expect(rows.length).toBeLessThanOrEqual(8);
		expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
		expect(rows.at(-1)).toContain("Ctrl+O");
	}
	const expanded = monitorOutputComponent("Monitor event", output, true).render(80).join("\n");
	expect(expanded).toContain("record-19");
	expect(expanded).not.toContain("Ctrl+O");
});
