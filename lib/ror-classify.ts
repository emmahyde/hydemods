import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { prKey, rorConfigPath, type RorConfig } from "./ror";
import type { MyPr } from "./url-drawers";

export type PrEvidence = {
	key: string;
	title: string;
	body: string;
	files: Array<{ path: string; additions: number; deletions: number; changeType: string }>;
	diff: string;
};

export type Complete = (system: string, prompt: string) => Promise<string>;

export type Classification = { key: string; tier: string; reason: string } | { key: string; error: string };

export type TierExample = { key: string; title: string; tier: string };

export const DIFF_LIMIT = 24_000;

export const RUBRIC = `You sort pull requests into review tiers. The one underlying axis is RISK, always: how much spread the change has, how many areas of impact or touchsites it has.

Ask, in order:
1. What PRE-EXISTING behavior does this change modify, as opposed to add beside? New code nothing calls yet is low risk; edits to code that already runs are not.
2. How many callers, flows or users pass through what it modifies?
3. If it is wrong, how wide is the failure and how silent? A loud, local failure is cheaper than a quiet, widespread one.

These are NOT risk signals: line count, file count, file type, a migration being present, the word "ux" in the title, the commit type (feat/fix/chore). A large diff can be low risk and a one-line change can be high risk.

Major UX changes belong in the tier that asks for a human, but most UX changes do not matter enough; only a change that substantially alters how users work through a flow counts.

The tiers' meanings come from their descriptions below. Choose exactly one tier.`;

const SYSTEM = "You are a careful code-review triage assistant. Answer with a single JSON object and nothing else.";

export function rorGuidancePath(): string {
	return process.env.HYDEMODS_ROR_GUIDANCE ?? path.join(path.dirname(rorConfigPath()), "ror-guidance.md");
}

export async function loadGuidance(file = rorGuidancePath()): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return "";
	}
}

export const gh = (args: string[]): Promise<string> => {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile("gh", args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
		if (err) return reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(stderr || err.message).trim()}`));
		resolve(stdout);
	});
	return promise;
};

const EVIDENCE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      body
      files(first: 100) { nodes { path additions deletions changeType } }
    }
  }
}`;

export async function fetchPrEvidence(pr: MyPr): Promise<PrEvidence> {
	const [owner, name] = pr.repo.split("/");
	const [meta, diff] = await Promise.all([
		gh(["api", "graphql", "-f", `query=${EVIDENCE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr.number}`]),
		gh(["pr", "diff", String(pr.number), "-R", pr.repo]),
	]);
	// gh's output follows EVIDENCE_QUERY; JSON.parse returns any, so annotating the const needs no cast.
	const parsed: { data?: { repository?: { pullRequest?: { body: string | null; files: { nodes: PrEvidence["files"] } } } } } = JSON.parse(meta);
	const node = parsed.data?.repository?.pullRequest;
	if (!node) throw new Error(`No pull request data for ${prKey(pr)}.`);
	return {
		key: prKey(pr),
		title: pr.title,
		body: node.body ?? "",
		files: node.files.nodes,
		diff: diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n[diff truncated]` : diff,
	};
}

/** Sections, in order: rubric, tiers, guidance, ground-truth examples, then the PR under review. */
export function buildPrompt(
	evidence: PrEvidence,
	tiers: RorConfig["tiers"],
	guidance: string,
	examples: readonly TierExample[],
): { system: string; prompt: string } {
	const parts = [RUBRIC];
	parts.push(`# Tiers\n${tiers.map((t) => `- ${t.key} (${t.label})${t.description ? `: ${t.description}` : ""}`).join("\n")}`);
	if (guidance.trim()) parts.push(`# Calibration from the user\nThis is the user's own calibration. Where it conflicts with the defaults above, it wins.\n\n${guidance.trim()}`);
	if (examples.length) {
		parts.push(`# Ground truth examples\nThe user's own already-tiered open PRs:\n${examples.map((e) => `- ${e.key} "${e.title}" -> ${e.tier}`).join("\n")}`);
	}
	const files = evidence.files.map((f) => `- ${f.path} (${f.changeType}, +${f.additions}/-${f.deletions})`).join("\n");
	parts.push(
		`# Pull request to classify\nKey: ${evidence.key}\nTitle: ${evidence.title}\n\nBody:\n${evidence.body.trim() || "(empty)"}\n\nFiles:\n${files || "(none)"}\n\nDiff:\n${evidence.diff}`,
	);
	parts.push(`Reply with strict JSON only: {"tier": "<one of: ${tiers.map((t) => t.key).join(", ")}>", "reason": "<one sentence naming the touchsites/callers affected>"}`);
	return { system: SYSTEM, prompt: parts.join("\n\n") };
}

/** Tolerates code fences or prose around the single JSON object. */
export function parseClassification(text: string, tierKeys: readonly string[]): { tier: string; reason: string } {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("No JSON object in the model reply.");
	let parsed: { tier?: unknown; reason?: unknown };
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new Error("The model reply is not valid JSON.");
	}
	if (typeof parsed.tier !== "string" || !tierKeys.includes(parsed.tier)) {
		throw new Error(`Unknown tier ${JSON.stringify(parsed.tier)}; tiers are ${tierKeys.join(", ")}.`);
	}
	if (typeof parsed.reason !== "string" || !parsed.reason.trim()) throw new Error("The model reply has no reason.");
	return { tier: parsed.tier, reason: parsed.reason.trim() };
}

export async function classifyPrs(
	prs: readonly MyPr[],
	config: RorConfig,
	deps: { complete: Complete; guidance: string; examples: readonly TierExample[]; fetchEvidence?: (pr: MyPr) => Promise<PrEvidence>; concurrency?: number },
): Promise<Classification[]> {
	const fetchEvidence = deps.fetchEvidence ?? fetchPrEvidence;
	const tierKeys = config.tiers.map((t) => t.key);
	const results: Classification[] = new Array(prs.length);
	let next = 0;
	const worker = async () => {
		while (next < prs.length) {
			const index = next++;
			const pr = prs[index];
			const key = prKey(pr);
			try {
				const { system, prompt } = buildPrompt(await fetchEvidence(pr), config.tiers, deps.guidance, deps.examples);
				results[index] = { key, ...parseClassification(await deps.complete(system, prompt), tierKeys) };
			} catch (err) {
				results[index] = { key, error: err instanceof Error ? err.message : String(err) };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, deps.concurrency ?? 4), prs.length) }, worker));
	return results;
}
