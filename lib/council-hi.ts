/**
 * Council of High Intelligence on OMP models: persona members deliberate in rounds
 * (independent analysis, anonymized cross-examination, final stance), a weighted tally
 * decides consensus, and a chairman who did not deliberate writes the verdict.
 * Personas are imported verbatim from council-of-high-intelligence (MIT, see
 * council-personas/LICENSE). Its multi-provider routing is replaced by OMP model slots.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface Persona {
	/** Short id, e.g. "feynman". */
	id: string;
	figure: string;
	domain: string;
	polarity: string;
	polarityPairs: string[];
	triads: string[];
	reasoningMethod: string;
	/** The agent file body after the frontmatter: identity, method, output formats. */
	body: string;
}

const PERSONA_DIR = fileURLToPath(new URL("./council-personas/", import.meta.url));

export function loadPersonas(dir = PERSONA_DIR): Map<string, Persona> {
	const personas = new Map<string, Persona>();
	for (const file of readdirSync(dir).filter(f => f.startsWith("council-") && f.endsWith(".md")).sort()) {
		const text = readFileSync(dir + file, "utf8");
		const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
		if (!match) throw new Error(`Persona ${file} has no frontmatter.`);
		const front = parse(match[1]) as { council?: Record<string, unknown> };
		const c = front.council ?? {};
		const id = file.slice("council-".length, -".md".length);
		personas.set(id, {
			id,
			figure: String(c.figure ?? id),
			domain: String(c.domain ?? ""),
			polarity: String(c.polarity ?? ""),
			polarityPairs: (c.polarity_pairs as string[] | undefined) ?? [],
			triads: (c.triads as string[] | undefined) ?? [],
			reasoningMethod: String(c.reasoning_method ?? ""),
			body: match[2].trim(),
		});
	}
	return personas;
}

/** The skill's predefined triads, keyed by domain. */
export const TRIADS: Record<string, string[]> = {
	architecture: ["aristotle", "ada", "feynman"],
	strategy: ["sun-tzu", "machiavelli", "aurelius"],
	ethics: ["aurelius", "socrates", "lao-tzu"],
	debugging: ["feynman", "socrates", "ada"],
	innovation: ["ada", "lao-tzu", "aristotle"],
	conflict: ["socrates", "machiavelli", "aurelius"],
	complexity: ["lao-tzu", "aristotle", "ada"],
	risk: ["sun-tzu", "aurelius", "feynman"],
	shipping: ["torvalds", "musashi", "feynman"],
	product: ["torvalds", "machiavelli", "watts"],
	founder: ["musashi", "sun-tzu", "torvalds"],
	ai: ["karpathy", "sutskever", "ada"],
	"ai-product": ["karpathy", "torvalds", "machiavelli"],
	"ai-safety": ["sutskever", "aurelius", "socrates"],
	decision: ["kahneman", "munger", "aurelius"],
	systems: ["meadows", "lao-tzu", "aristotle"],
	uncertainty: ["taleb", "sun-tzu", "sutskever"],
	design: ["rams", "torvalds", "watts"],
	economics: ["munger", "machiavelli", "sun-tzu"],
	bias: ["kahneman", "socrates", "watts"],
};

/**
 * Model slots, one model family each. A slot lists alternatives in order: the first that
 * answers serves the seat, so a lapsed login falls back (Kimi Code to a Codex model).
 */
export const DEFAULT_SLOTS: string[][] = [
	["google-antigravity/gemini-4-argon"],
	["openai-codex/gpt-6-astra"],
	["kimi-code/k3", "openai-codex/gpt-6.1-sol"],
	["anthropic/claude-fable-5-1"],
	["anthropic/claude-opus-5-5"],
];
/** Chairman preference by slot index when a slot is free of panel seats: opus, fable, astra, argon, kimi. */
const CHAIR_ORDER = [4, 3, 1, 0, 2];

export interface Seat {
	member: Persona;
	slot: number;
}

/**
 * Spread members across slots: each takes the least-loaded slot that does not already hold
 * one of its polarity partners, earliest slot on ties. Partners share a slot only when no
 * other slot is free of them.
 */
export function routeSeats(members: Persona[], slotCount: number): Seat[] {
	const seats: Seat[] = [];
	const load = new Array<number>(slotCount).fill(0);
	for (const member of members) {
		const partnerSlots = new Set(seats.filter(s => member.polarityPairs.includes(s.member.id) || s.member.polarityPairs.includes(member.id)).map(s => s.slot));
		const order = [...load.keys()].sort((a, b) => load[a] - load[b] || a - b);
		const slot = order.find(i => !partnerSlots.has(i)) ?? order[0];
		load[slot]++;
		seats.push({ member, slot });
	}
	return seats;
}

export function chairSlot(seats: Seat[], slotCount: number): number {
	const used = new Set(seats.map(s => s.slot));
	return CHAIR_ORDER.filter(i => i < slotCount).find(i => !used.has(i)) ?? CHAIR_ORDER.find(i => i < slotCount) ?? 0;
}

export interface Stance {
	option: string;
	confidence: "high" | "med" | "low";
	dealbreaker: boolean;
}

const STANCE_LINE = /STANCE:\s*(.+?)\s*\|\s*CONFIDENCE:\s*(high|med|medium|low)\s*\|\s*DEALBREAKER:\s*(yes|no)/i;

export function parseStance(text: string): Stance | undefined {
	const lines = text.trim().split("\n").reverse();
	for (const line of lines) {
		const m = STANCE_LINE.exec(line.replace(/[*`_]/g, ""));
		if (!m) continue;
		const confidence = m[2].toLowerCase() === "medium" ? "med" : (m[2].toLowerCase() as Stance["confidence"]);
		return { option: normalizeOption(m[1]), confidence, dealbreaker: m[3].toLowerCase() === "yes" };
	}
	return undefined;
}

export function normalizeOption(label: string): string {
	return label.toLowerCase().replace(/["'.!]/g, "").replace(/\s+/g, " ").trim();
}

const CONFIDENCE_FACTOR = { high: 1, med: 0.75, low: 0.5 } as const;

export interface Tally {
	options: { option: string; weight: number; backers: string[] }[];
	total: number;
	threshold: number;
	winner?: string;
	dealbreakers: string[];
}

/** Confidence-weighted vote. Base weight 1, the domain seat 1.5; abstentions raise the bar but back nothing. */
export function tally(stances: { member: string; stance: Stance }[], domainSeat?: string): Tally {
	const byOption = new Map<string, { weight: number; backers: string[] }>();
	let total = 0;
	const dealbreakers: string[] = [];
	for (const { member, stance } of stances) {
		const base = member === domainSeat ? 1.5 : 1;
		total += base;
		if (stance.dealbreaker) dealbreakers.push(`${member}: ${stance.option}`);
		if (stance.option === "abstain") continue;
		const entry = byOption.get(stance.option) ?? { weight: 0, backers: [] };
		entry.weight += base * CONFIDENCE_FACTOR[stance.confidence];
		entry.backers.push(`${member}${member === domainSeat ? " [1.5× domain]" : ""} (${stance.confidence})`);
		byOption.set(stance.option, entry);
	}
	const options = [...byOption].map(([option, v]) => ({ option, ...v })).sort((a, b) => b.weight - a.weight || a.option.localeCompare(b.option));
	const threshold = (2 / 3) * total;
	const top = options[0];
	const winner = top && top.weight >= threshold - 1e-9 ? top.option : undefined;
	return { options, total, threshold, winner, dealbreakers };
}

export function formatTally(t: Tally): string {
	const lines = t.options.map(o => `- ${o.option} — ${o.weight.toFixed(2)} (${o.backers.join(", ")})`);
	lines.push(`- total weight ${t.total.toFixed(2)} · threshold ${t.threshold.toFixed(2)} · ${t.winner ? `**${t.winner}** carries` : "no option carries → the decision goes to the user"}`);
	return lines.join("\n");
}

export type Complete = (model: string, system: string, prompt: string) => Promise<{ text: string; model: string }>;

export interface HiCouncilOptions {
	members: Persona[];
	mode: "full" | "quick";
	/** Member id that carries 1.5× weight; fixed before any analysis. */
	domainSeat?: string;
	slots?: string[][];
	/** Overrides the chairman slot with an explicit model. */
	chairman?: string;
	timeoutMs?: number;
	now?: () => number;
	onProgress?: (line: string) => void;
}

export interface HiCouncilResult {
	verdict: string;
	routing: { member: string; model: string }[];
	chairman: string;
	rounds: { round: string; member: string; model: string; text: string }[];
	tally: Tally;
	fallbacks: string[];
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function system(p: Persona): string {
	return `You are operating as a council member in a structured deliberation.\n\n${p.body}`;
}

function stanceInstruction(): string {
	return [
		"Then, on the LAST line, emit your structured stance EXACTLY in this format:",
		"STANCE: <one short option label> | CONFIDENCE: high|med|low | DEALBREAKER: yes|no",
		"Use the SAME wording as peers where you agree. Write STANCE: abstain if you back no option.",
		"DEALBREAKER: yes means you consider the opposing option actively harmful, not merely sub-optimal.",
	].join("\n");
}

/** Replace each member's name and figure with its label so round 2 judges arguments, not authors. */
export function anonymize(text: string, members: Persona[], labels: Map<string, string>): string {
	let out = text;
	for (const m of members) {
		const label = `Member ${labels.get(m.id)}`;
		for (const name of [m.figure, m.id, ...m.figure.split(" ").filter(w => w.length > 3)]) {
			out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), label);
		}
	}
	return out;
}

export async function runHiCouncil(question: string, complete: Complete, options: HiCouncilOptions): Promise<HiCouncilResult> {
	const { members, mode } = options;
	if (members.length < 2) throw new Error("The council needs at least two members.");
	const slots = options.slots ?? DEFAULT_SLOTS;
	const now = options.now ?? Date.now;
	const deadline = options.timeoutMs === undefined ? Infinity : now() + options.timeoutMs;
	const seats = routeSeats(members, slots.length);
	const chairModels = options.chairman ? [options.chairman] : slots[chairSlot(seats, slots.length)];
	const fallbacks: string[] = [];
	const rounds: HiCouncilResult["rounds"] = [];
	const served = new Map<string, string>();
	/** Models that failed once are skipped for the rest of the session, so a lapsed login costs one call. */
	const dead = new Set<string>();

	const ask = async (models: string[], who: string, sys: string, prompt: string) => {
		let last: unknown;
		for (const model of models) {
			if (dead.has(model) && model !== models.at(-1)) continue;
			try {
				const reply = await complete(model, sys, prompt);
				if (model !== models[0] && !fallbacks.some(f => f.startsWith(`${who}: `))) fallbacks.push(`${who}: ${models[0]} → ${model} (${String(last instanceof Error ? last.message : last ?? "failed earlier").slice(0, 120)})`);
				return reply;
			} catch (error) {
				last = error;
				dead.add(model);
			}
		}
		throw new Error(`${who}: every model in its slot failed (${models.join(", ")}): ${last instanceof Error ? last.message : String(last)}`);
	};
	const checkTime = (next: string) => {
		if (now() > deadline) throw new Error(`Council timed out before ${next}.`);
	};
	const round = async (name: string, prompt: (seat: Seat) => string) => {
		checkTime(name);
		options.onProgress?.(`${name}: ${seats.length} members`);
		const replies = await Promise.all(seats.map(seat => ask(slots[seat.slot], seat.member.figure, system(seat.member), prompt(seat))));
		replies.forEach((r, i) => {
			served.set(seats[i].member.id, r.model);
			rounds.push({ round: name, member: seats[i].member.figure, model: r.model, text: r.text });
		});
		return replies.map(r => r.text);
	};

	const labels = new Map(seats.map((s, i) => [s.member.id, LABELS[i]]));
	const anonymized = (texts: string[]) => texts.map((t, i) => `## Member ${labels.get(seats[i].member.id)}\n${anonymize(t, members, labels)}`).join("\n\n");

	let finals: string[];
	if (mode === "quick") {
		const r1 = await round("rapid analysis", s =>
			[
				`The problem under deliberation:\n${question}`,
				"",
				"First, in ONE sentence, restate this problem through your analytical lens. Then produce a condensed analysis:",
				"- Essential Question (1-2 sentences)\n- Your core analysis (key insight only)\n- Verdict (direct recommendation)\n- Confidence (High/Medium/Low)",
				`Reason via your designated method: ${s.member.reasoningMethod}. Limit: 200 words. Be decisive.`,
			].join("\n"),
		);
		finals = await round("final positions", () =>
			[
				`The problem under deliberation:\n${question}`,
				"",
				"Here are the (anonymized) Round 1 analyses. One of them is your own.",
				anonymized(r1),
				"",
				"Identity is masked: evaluate by argument quality, refer to peers as Member X.",
				"Anti-conformity directive: if your position was correct, defend it. Update only when a specific flaw in your argument is exposed, and name that flaw.",
				"State your final position in 75 words or less, naming the Member you push back on.",
				stanceInstruction(),
			].join("\n"),
		);
	} else {
		const r1 = await round("round 1: independent analysis", s =>
			[
				`The problem under deliberation:\n${question}`,
				"",
				"Start with two lines: your restatement of the problem through your lens, and one alternative framing the original may have missed.",
				`Then reason via your designated method: ${s.member.reasoningMethod}. Do not imitate other members' methods.`,
				"Produce your independent analysis using your Output Format (Standalone). Do not anticipate what others will say. Limit: 400 words.",
			].join("\n"),
		);
		const r2 = await round("round 2: cross-examination", () =>
			[
				`The problem under deliberation:\n${question}`,
				"",
				"Identity is masked in this round. The Round 1 analyses below are labeled Member A, Member B, … One of them is your own. Evaluate by argument quality, not source; do not guess identities.",
				anonymized(r1),
				"",
				"Anti-conformity directive: if your Round 1 position was correct, defend it. Update only when sound reasoning exposes a specific flaw in your earlier argument, and name that flaw.",
				"Respond using your Output Format (Council Round 2):",
				"1. Which member's position do you most disagree with, and why? Engage their specific claims.",
				"2. Which member's insight strengthens your position? How?",
				"3. Restate your position in light of this exchange, noting any changes.",
				"4. Label your key claims: empirical | mechanistic | strategic | ethical | heuristic",
				"Limit: 300 words. Engage at least 2 other members by label.",
			].join("\n"),
		);
		finals = await round("round 3: final crystallization", s =>
			[
				`The problem under deliberation:\n${question}`,
				"",
				"Round 2 cross-examination (labels as before):",
				anonymized(r2),
				"",
				`Final round. State your position declaratively in 100 words or less. No new arguments.${s.member.id === "socrates" ? " You get exactly ONE question; make it count, then state your position." : ""}`,
				stanceInstruction(),
			].join("\n"),
		);
	}

	const stances: { member: string; stance: Stance }[] = [];
	for (const [i, seat] of seats.entries()) {
		let stance = parseStance(finals[i]);
		if (!stance) {
			checkTime("a stance re-prompt");
			const retry = await ask(slots[seat.slot], seat.member.figure, system(seat.member), `Your final statement was:\n${finals[i]}\n\nEmit only your stance line now.\n${stanceInstruction()}`);
			stance = parseStance(retry.text) ?? { option: "abstain", confidence: "low", dealbreaker: false };
		}
		stances.push({ member: seat.member.id, stance });
	}
	const result = tally(stances, options.domainSeat);

	checkTime("the chairman's verdict");
	options.onProgress?.("chairman: verdict");
	const routing = seats.map(s => ({ member: s.member.figure, model: served.get(s.member.id) ?? slots[s.slot][0] }));
	const transcript = rounds.map(r => `### ${r.round} — ${r.member} (${r.model})\n${r.text}`).join("\n\n");
	const chair = await ask(
		chairModels,
		"chairman",
		"You are the Chairman of the Council of High Intelligence. You did not deliberate in this session; you synthesize it.",
		[
			`The original problem:\n${question}`,
			"",
			"The full transcript follows with real names restored (round 2 was anonymized for the members).",
			transcript,
			"",
			`Vote tally (computed, do not recount):\n${formatTally(result)}`,
			result.dealbreakers.length ? `Dealbreakers declared: ${result.dealbreakers.join("; ")}` : "No dealbreakers declared.",
			"",
			"Weigh arguments by validity, not repetition. Surface genuine disagreement; never invent positions no member held. Lead with what the council does not know.",
			"Write the verdict in Markdown with exactly these sections:",
			"## Council Verdict\n### Problem\n### Unresolved Questions\n### Consensus\n### Vote Tally\n### Key Insights by Member\n### Points of Disagreement\n### Minority Report\n### Acceptable Compromises\n### Kill Criteria (each: If <observable> by <when>, the verdict is invalid and we should <action>.)\n### Concrete Next Step (one artifact-producing action)",
			mode === "quick" ? "Keep it brief: this was a quick council." : "",
		].join("\n"),
	);
	return { verdict: chair.text, routing, chairman: chair.model, rounds, tally: result, fallbacks };
}
