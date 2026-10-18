import { describe, expect, test } from "bun:test";
import type { Judge, JudgmentRequest } from "@oh-my-pi/pi-ai";
import { type Candidate, recommend } from "../lib/recommend";

function fakeJudge(score: (instructions: string) => number, calls: JudgmentRequest[] = []): Judge {
	return {
		label: "fake",
		async judge(request) {
			calls.push(request);
			const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, { type: "noul", noul: score(q.instructions) }]));
			return { api: "fake", provider: "fake", model: "fake", answers, usage: {} } as never;
		},
	};
}

const tools = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ kind: "tool", name: `t${i}`, description: `tool ${i}` }));

describe("recommend", () => {
	test("drops candidates under the threshold and ranks the rest best first", async () => {
		const scores: Record<string, number> = { "`a`": 0.2, "`b`": 0.9, "`c`": 0.6 };
		const judge = fakeJudge(text => Object.entries(scores).find(([k]) => text.includes(k))?.[1] ?? 0);
		const candidates: Candidate[] = ["a", "b", "c"].map(name => ({ kind: "skill", name, description: "x" }));
		const picks = await recommend(judge, "task", candidates);
		expect(picks.map(p => [p.name, p.score])).toEqual([["b", 0.9], ["c", 0.6]]);
	});

	test("maps answers back to the right candidate across concurrent chunks and caps at limit", async () => {
		const calls: JudgmentRequest[] = [];
		const judge = fakeJudge(text => Number(/tool (\d+)/.exec(text)![1]) / 100, calls);
		const picks = await recommend(judge, "task", tools(95), { limit: 3 });
		expect(calls.length).toBe(3);
		expect(picks.map(p => p.name)).toEqual(["t94", "t93", "t92"]);
		expect(picks[0]!.score).toBeCloseTo(0.94);
	});
});
