import type { Judge, NoulQuestion } from "@oh-my-pi/pi-ai";

export interface Candidate {
	kind: "tool" | "skill";
	name: string;
	description: string;
	/** Registered but not in the active tool set; may need enabling or discovery before use. */
	inactive?: boolean;
}

export interface Recommendation extends Candidate {
	/** Judge's probability that this candidate materially helps with the task. */
	score: number;
}

export interface RecommendOptions {
	limit?: number;
	threshold?: number;
	signal?: AbortSignal;
}

/** Questions per judge request; batches run concurrently. */
const CHUNK = 40;
const DESCRIPTION_CHARS = 280;

function summarize(description: string): string {
	const flat = description.replace(/\s+/g, " ").trim();
	return flat.length > DESCRIPTION_CHARS ? `${flat.slice(0, DESCRIPTION_CHARS - 1)}…` : flat;
}

/** Prompt marker that asks for recommendations on the rest of the prompt. */
export const RECOMMEND_MARKER = "/recommend-tools";
const MARKER_PATTERN = /(^|\s)\/recommend-tools(?:[ \t]|(?=\s)|$)/g;

/**
 * `text` without every standalone marker, and whether one was present. The marker must stand alone,
 * so `docs/recommend-tools` and `/recommend-toolsx` are left untouched. Only the marker and one
 * following space go; the rest of the prompt, including indentation, is kept as typed.
 */
export function stripRecommendMarker(text: string): { text: string; marked: boolean } {
	let marked = false;
	const stripped = text.replace(MARKER_PATTERN, (_match, lead: string) => {
		marked = true;
		return lead;
	});
	return { text: marked ? stripped.trim() : text, marked };
}

/**
 * Removes and returns every pending marked prompt that is one whole message of `prompt`. A queued
 * batch joins its user messages with a blank line, so a match must fill a whole segment between
 * those joins: pending `fix` never matches an unmarked `fix tests`. Each pending entry is taken at
 * most as many times as its message appears in the batch.
 */
export function takeMarkedPrompts(pending: string[], prompt: string): string[] {
	const taken: string[] = [];
	for (let index = 0; index < pending.length; ) {
		const text = pending[index]!;
		const occurrences = countWholeMessage(prompt, text) - taken.filter(t => t === text).length;
		if (occurrences > 0) {
			taken.push(text);
			pending.splice(index, 1);
		} else index++;
	}
	return taken;
}

function countWholeMessage(prompt: string, text: string): number {
	const joined = `\n\n${prompt}\n\n`;
	const needle = `\n\n${text}\n\n`;
	let count = 0;
	// Step past the needle minus its trailing join, so back-to-back equal messages share a separator.
	for (let at = joined.indexOf(needle); at !== -1; at = joined.indexOf(needle, at + needle.length - 2)) count++;
	return count;
}

export function candidateQuestion(candidate: Candidate): NoulQuestion {
	return {
		type: "noul",
		instructions: `${candidate.kind === "tool" ? "Tool" : "Skill"} \`${candidate.name}\`: ${summarize(candidate.description)}\nWould using this ${candidate.kind} materially help an agent carry out the task?`,
		criteria: {
			true: "It directly serves a step the task needs, better than generic file/shell tools would.",
			false: "It is unrelated, only tangential, or generic tooling any task would use.",
		},
	};
}

/** Ask the judge one yes/no question per candidate and return the strongest matches, best first. */
export async function recommend(judge: Judge, task: string, candidates: readonly Candidate[], options: RecommendOptions = {}): Promise<Recommendation[]> {
	const { limit = 5, threshold = 0.5, signal } = options;
	const chunks: Candidate[][] = [];
	for (let start = 0; start < candidates.length; start += CHUNK) chunks.push(candidates.slice(start, start + CHUNK));
	const scored = await Promise.all(
		chunks.map(async chunk => {
			const questions = Object.fromEntries(chunk.map((candidate, index) => [`c${index}`, candidateQuestion(candidate)]));
			const { answers } = await judge.judge({ state: { task }, questions }, { signal });
			return chunk.map((candidate, index) => {
				const answer = answers[`c${index}`];
				return { ...candidate, score: answer?.type === "noul" ? answer.noul : 0 };
			});
		}),
	);
	return scored
		.flat()
		.filter(entry => entry.score >= threshold)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

export function formatRecommendations(recommendations: readonly Recommendation[]): string {
	if (recommendations.length === 0) return "No tool or skill stood out for this task; generic tools should do.";
	return recommendations
		.map(entry => `- ${entry.kind === "skill" ? `skill://${entry.name}` : entry.name} (${entry.kind}${entry.inactive ? ", inactive" : ""}, ${Math.round(entry.score * 100)}%): ${summarize(entry.description)}`)
		.join("\n");
}
