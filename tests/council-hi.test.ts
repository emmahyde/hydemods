import { describe, expect, test } from "bun:test";
import { loadPersonas, parseStance, routeSeats, runHiCouncil, tally, TRIADS } from "../lib/council-hi";

const personas = loadPersonas();

describe("persona council", () => {
	test("every triad names imported personas", () => {
		expect(personas.size).toBe(18);
		for (const [domain, ids] of Object.entries(TRIADS)) for (const id of ids) expect(personas.has(id), `${domain}: ${id}`).toBe(true);
	});

	test("polarity partners sit on different model slots while the panel spreads evenly", () => {
		const ids = ["socrates", "feynman", "kahneman", "watts", "ada", "rams"];
		const seats = routeSeats(ids.map(id => personas.get(id)!), 5);
		const slotOf = new Map(seats.map(s => [s.member.id, s.slot]));
		expect(slotOf.get("socrates")).not.toBe(slotOf.get("feynman"));
		expect(slotOf.get("kahneman")).not.toBe(slotOf.get("feynman"));
		expect(slotOf.get("socrates")).not.toBe(slotOf.get("watts"));
		expect(slotOf.get("rams")).not.toBe(slotOf.get("ada"));
		const loads = [0, 1, 2, 3, 4].map(i => seats.filter(s => s.slot === i).length);
		expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
	});

	test("an option carries only with two thirds of base weight; low confidence cannot shrink the bar", () => {
		const s = (option: string, confidence: "high" | "med" | "low") => ({ option, confidence, dealbreaker: false });
		const carried = tally([{ member: "ada", stance: s("monorepo", "high") }, { member: "feynman", stance: s("monorepo", "high") }, { member: "aristotle", stance: s("polyrepo", "high") }], "ada");
		expect(carried.total).toBe(3.5);
		expect(carried.winner).toBe("monorepo");
		const hesitant = tally([{ member: "ada", stance: s("monorepo", "low") }, { member: "feynman", stance: s("monorepo", "low") }, { member: "aristotle", stance: s("abstain", "high") }], "ada");
		expect(hesitant.winner).toBeUndefined();
	});

	test("the stance line is read from the last matching line, through markdown emphasis", () => {
		expect(parseStance("I hold firm.\n**STANCE: Ship Now | CONFIDENCE: Medium | DEALBREAKER: yes**")).toEqual({ option: "ship now", confidence: "med", dealbreaker: true });
		expect(parseStance("no stance here")).toBeUndefined();
	});

	test("cross-examination hides who wrote what, a failed model falls back within its slot, and the chairman sits outside the panel", async () => {
		const prompts: { model: string; prompt: string }[] = [];
		const result = await runHiCouncil(
			"Monorepo or polyrepo?",
			async (model, system, prompt) => {
				prompts.push({ model, prompt });
				if (model === "dead/model") throw new Error("401");
				const who = /You are (\w+)/.exec(system)?.[1] ?? "chair";
				return { model, text: `${who} argues as ${who}.\nSTANCE: monorepo | CONFIDENCE: high | DEALBREAKER: no` };
			},
			{ members: ["ada", "feynman", "aristotle"].map(id => personas.get(id)!), mode: "full", slots: [["dead/model", "alive/a"], ["alive/b"], ["alive/c"], ["chair/x"]] },
		);
		const crossExam = prompts.filter(p => p.model !== "dead/model" && p.prompt.includes("Identity is masked in this round"));
		expect(crossExam.length).toBe(3);
		for (const p of crossExam) for (const name of ["Ada", "Feynman", "Aristotle"]) expect(p.prompt).not.toContain(name);
		expect(result.fallbacks.length).toBeGreaterThan(0);
		expect(result.routing.map(r => r.model)).not.toContain("dead/model");
		expect(result.chairman).toBe("chair/x");
		expect(result.tally.winner).toBe("monorepo");
	});
});
