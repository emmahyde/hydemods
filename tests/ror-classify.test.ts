import { expect, test } from "bun:test";
import { join } from "node:path";
import { classifyPrs, loadGuidance, parseClassification, type PrEvidence } from "../lib/ror-classify";
import { applyClassifications, assignTier, type RorConfig } from "../lib/ror";
import type { MyPr } from "../lib/url-drawers";

const pr = (number: number): MyPr => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/acme/app/pull/${number}`,
	repo: "acme/app",
	isDraft: false,
	ci: "pass",
	unresolvedThreads: 0,
	mergeable: "clean",
	approved: null,
	reviews: [{ login: "review-bot", state: "APPROVED", onHead: true }],
	additions: 0,
	deletions: 0,
	changedFiles: 0,
});

const config = (over: Partial<RorConfig> = {}): RorConfig => ({
	approvers: ["review-bot"],
	slackServer: "slack",
	tiers: [
		{ key: "small", label: "Small", prs: ["acme/app#1"] },
		{ key: "human", label: "Human", prs: ["acme/app#2", "acme/app#3"] },
	],
	...over,
});

const evidence = (p: MyPr): Promise<PrEvidence> => Promise.resolve({ key: `${p.repo}#${p.number}`, title: p.title, body: "", files: [], diff: "" });

test("parseClassification accepts fenced JSON with prose around it", () => {
	const text = 'Sure:\n```json\n{"tier": "human", "reason": " Touches the shared formatter. "}\n```\nDone.';
	expect(parseClassification(text, ["small", "human"])).toEqual({ tier: "human", reason: "Touches the shared formatter." });
});

test("parseClassification rejects an unknown tier and a missing reason", () => {
	expect(() => parseClassification('{"tier": "huge", "reason": "x"}', ["small"])).toThrow(/Unknown tier/);
	expect(() => parseClassification('{"tier": "small"}', ["small"])).toThrow(/reason/);
	expect(() => parseClassification('{"tier": "small", "reason": "  "}', ["small"])).toThrow(/reason/);
	expect(() => parseClassification("no json here", ["small"])).toThrow();
});

test("classifyPrs keeps input order and isolates one PR's failure", async () => {
	const prs = [pr(10), pr(11), pr(12), pr(13)];
	const results = await classifyPrs(prs, config(), {
		guidance: "",
		examples: [],
		fetchEvidence: (p) => (p.number === 11 ? Promise.reject(new Error("diff unavailable")) : evidence(p)),
		complete: async (_system, prompt) => {
			if (prompt.includes("PR 12")) return "not json";
			return '{"tier": "small", "reason": "narrow"}';
		},
	});
	expect(results).toEqual([
		{ key: "acme/app#10", tier: "small", reason: "narrow" },
		{ key: "acme/app#11", error: "diff unavailable" },
		{ key: "acme/app#12", error: expect.any(String) },
		{ key: "acme/app#13", tier: "small", reason: "narrow" },
	]);
});

test("classifyPrs never runs more than `concurrency` PRs at once", async () => {
	let active = 0;
	let peak = 0;
	const results = await classifyPrs([1, 2, 3, 4, 5, 6, 7].map(pr), config(), {
		guidance: "",
		examples: [],
		concurrency: 2,
		fetchEvidence: evidence,
		complete: async () => {
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active--;
			return '{"tier": "small", "reason": "r"}';
		},
	});
	expect(results).toHaveLength(7);
	expect(peak).toBe(2);
});

test("applyClassifications appends to the end of the tier, moves out of other tiers, records the reason and skips errors", () => {
	const start = config({ autoTiered: { "acme/app#2": "old reason" } });
	const next = applyClassifications(start, [
		{ key: "acme/app#1", tier: "human", reason: "wide" },
		{ key: "acme/app#9", tier: "small", reason: "narrow" },
		{ key: "acme/app#8", error: "boom" },
	]);
	expect(next.tiers.map((t) => t.prs)).toEqual([["acme/app#9"], ["acme/app#2", "acme/app#3", "acme/app#1"]]);
	expect(next.autoTiered).toEqual({ "acme/app#2": "old reason", "acme/app#1": "wide", "acme/app#9": "narrow" });
	expect(start.tiers[0].prs).toEqual(["acme/app#1"]);
});

test("a manual label clears the auto-tiered mark of the moved keys only", () => {
	const start = config({ autoTiered: { "acme/app#2": "a", "acme/app#3": "b" } });
	expect(assignTier(start, "small", ["acme/app#2"]).autoTiered).toEqual({ "acme/app#3": "b" });
});

test("loadGuidance returns an empty string for a missing file", async () => {
	expect(await loadGuidance(join(import.meta.dir, "does-not-exist-guidance.md"))).toBe("");
});
