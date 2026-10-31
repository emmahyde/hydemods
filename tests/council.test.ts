import { describe, expect, test } from "bun:test";
import { DEFAULT_ANALYST, DEFAULT_LEAD, runCouncil } from "../lib/council";

describe("runCouncil", () => {
	test("alternates members, shows each later turn the question and prior turns, and returns the synthesis", async () => {
		const calls: { system: string; prompt: string }[] = [];
		const { answer, turns } = await runCouncil("Why did X happen?", async (system, prompt) => {
			calls.push({ system, prompt });
			return `reply ${calls.length}`;
		});
		expect(turns.map(t => `${t.member}:${t.step}`)).toEqual([
			`${DEFAULT_LEAD.name}:context`,
			`${DEFAULT_ANALYST.name}:data needs`,
			`${DEFAULT_LEAD.name}:data`,
			`${DEFAULT_ANALYST.name}:analysis`,
			`${DEFAULT_LEAD.name}:synthesis`,
		]);
		expect(answer).toBe("reply 5");
		expect(calls[0].prompt).not.toContain("Question:");
		expect(calls[0].prompt).toContain("Why did X happen?");
		expect(calls[1].system).toContain(DEFAULT_ANALYST.role);
		expect(calls[1].prompt).toContain("Question: Why did X happen?");
		expect(calls[4].prompt).toContain("reply 1");
		expect(calls[4].prompt).toContain("reply 4");
		expect(calls[4].prompt).not.toContain("reply 5");
	});

	test("stops before the next turn once the deadline has passed", async () => {
		let clock = 0;
		const complete = async () => {
			clock += 100;
			return "ok";
		};
		await expect(runCouncil("q", complete, { timeoutMs: 250, now: () => clock })).rejects.toThrow("Council timed out after 3 of 5 turns (last: data)");
	});
});
