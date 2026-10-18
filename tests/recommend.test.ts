import { describe, expect, test } from "bun:test";
import type { Judge, JudgmentRequest } from "@oh-my-pi/pi-ai";
import { type Candidate, recommend, stripRecommendMarker, takeMarkedPrompts } from "../lib/recommend";

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

describe("stripRecommendMarker", () => {
	test("removes a standalone marker at the start, middle or end", () => {
		expect(stripRecommendMarker("/recommend-tools fix the CI hook")).toEqual({ text: "fix the CI hook", marked: true });
		expect(stripRecommendMarker("fix /recommend-tools the CI hook")).toEqual({ text: "fix the CI hook", marked: true });
		expect(stripRecommendMarker("fix the CI hook /recommend-tools")).toEqual({ text: "fix the CI hook", marked: true });
	});

	test("leaves the marker alone inside a path or a longer word", () => {
		for (const text of ["read docs/recommend-tools.md", "/recommend-toolsx now"]) expect(stripRecommendMarker(text)).toEqual({ text, marked: false });
	});

	test("keeps line breaks in a multi-line prompt", () => {
		expect(stripRecommendMarker("/recommend-tools\nstep one\nstep two")).toEqual({ text: "step one\nstep two", marked: true });
	});

	test("keeps indentation and aligned spacing in the rest of the prompt", () => {
		const code = "```py\ndef f():\n    if x:\n        return  1\n```";
		expect(stripRecommendMarker(`/recommend-tools fix this\n${code}`)).toEqual({ text: `fix this\n${code}`, marked: true });
		expect(stripRecommendMarker(`fix this\n${code}\n/recommend-tools`)).toEqual({ text: `fix this\n${code}`, marked: true });
	});

	test("a marker alone leaves an empty task", () => {
		expect(stripRecommendMarker("  /recommend-tools  ")).toEqual({ text: "", marked: true });
	});
});

describe("takeMarkedPrompts", () => {
	test("an unmarked prompt that only contains a marked one does not take it", () => {
		const pending = ["fix"];
		expect(takeMarkedPrompts(pending, "fix tests")).toEqual([]);
		expect(pending).toEqual(["fix"]);
		expect(takeMarkedPrompts(pending, "fix")).toEqual(["fix"]);
		expect(pending).toEqual([]);
	});

	test("a queued batch takes every marked message it holds and leaves none stale", () => {
		const pending = ["fix the hook", "add a test", "later prompt"];
		expect(takeMarkedPrompts(pending, "fix the hook\n\nunmarked note\n\nadd a test")).toEqual(["fix the hook", "add a test"]);
		expect(pending).toEqual(["later prompt"]);
	});

	test("equal marked prompts are taken once per message in the batch", () => {
		const pending = ["retry", "retry"];
		expect(takeMarkedPrompts(pending, "retry")).toEqual(["retry"]);
		expect(pending).toEqual(["retry"]);
		const both = ["retry", "retry"];
		expect(takeMarkedPrompts(both, "retry\n\nretry")).toEqual(["retry", "retry"]);
		expect(both).toEqual([]);
	});
});
