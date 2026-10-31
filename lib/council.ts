/**
 * Two-member council: a lead researcher and an analyst take five turns on one question
 * (context, data needs, data, analysis, synthesis), each seeing the transcript so far.
 * Adapted from GenAI_Agents' multi_agent_collaboration_system notebook.
 */

export interface CouncilMember {
	name: string;
	role: string;
	skills: string[];
}

export interface CouncilTurn {
	step: string;
	member: string;
	text: string;
}

export type CouncilComplete = (system: string, prompt: string) => Promise<string>;

export const DEFAULT_LEAD: CouncilMember = {
	name: "Clio",
	role: "Research Specialist",
	skills: ["deep knowledge of the subject's history and background", "understanding context", "identifying trends"],
};

export const DEFAULT_ANALYST: CouncilMember = {
	name: "Data",
	role: "Data Analysis Expert",
	skills: ["interpreting numerical data", "statistical analysis", "data visualization description"],
};

type Seat = "lead" | "analyst";

interface Step {
	step: string;
	seat: Seat;
	/** Whether the member sees the transcript so far; the opening turn answers the question alone. */
	transcript: boolean;
	task: (question: string) => string;
}

const STEPS: Step[] = [
	{ step: "context", seat: "lead", transcript: false, task: q => `Provide relevant context and background information for the following task: ${q}` },
	{ step: "data needs", seat: "analyst", transcript: true, task: () => "Based on the context above, what specific data or statistical information would help answer the question?" },
	{ step: "data", seat: "lead", transcript: true, task: () => "Provide the data or statistics for the needs identified above. Name the source of each figure, or mark it as an estimate." },
	{ step: "analysis", seat: "analyst", transcript: true, task: () => "Analyze the data provided above and describe the trends or insights relevant to the question." },
	{ step: "synthesis", seat: "lead", transcript: true, task: () => "Based on all the context, data and analysis above, provide a comprehensive answer to the question." },
];

export const COUNCIL_STEPS = STEPS.map(s => s.step);

export function memberSystem(member: CouncilMember): string {
	return `You are ${member.name}, a ${member.role}. Your skills include: ${member.skills.join(", ")}. Respond to the task based on your role and skills.`;
}

export function stepPrompt(question: string, turns: CouncilTurn[], task: string, withTranscript: boolean): string {
	if (!withTranscript) return task;
	const lines = [`Question: ${question}`, ""];
	for (const turn of turns) lines.push(`## ${turn.member} (${turn.step})`, turn.text, "");
	lines.push("## Your task", task);
	return lines.join("\n");
}

export interface CouncilOptions {
	lead?: CouncilMember;
	analyst?: CouncilMember;
	/** Checked between turns; a turn already running is not cut short. */
	timeoutMs?: number;
	now?: () => number;
	onTurn?: (turn: CouncilTurn, index: number, total: number) => void;
}

export async function runCouncil(question: string, complete: CouncilComplete, options: CouncilOptions = {}): Promise<{ answer: string; turns: CouncilTurn[] }> {
	const members: Record<Seat, CouncilMember> = { lead: options.lead ?? DEFAULT_LEAD, analyst: options.analyst ?? DEFAULT_ANALYST };
	const now = options.now ?? Date.now;
	const deadline = options.timeoutMs === undefined ? Infinity : now() + options.timeoutMs;
	const turns: CouncilTurn[] = [];
	for (const [index, step] of STEPS.entries()) {
		if (now() > deadline) throw new Error(`Council timed out after ${turns.length} of ${STEPS.length} turns (last: ${turns.at(-1)?.step ?? "none"}).`);
		const member = members[step.seat];
		const text = await complete(memberSystem(member), stepPrompt(question, turns, step.task(question), step.transcript));
		const turn = { step: step.step, member: member.name, text };
		turns.push(turn);
		options.onTurn?.(turn, index, STEPS.length);
	}
	return { answer: turns.at(-1)!.text, turns };
}
