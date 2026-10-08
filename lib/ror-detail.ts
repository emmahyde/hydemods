import { prKey, rorWatchStatus } from "./ror";
import { gh } from "./ror-classify";
import type { MyPr } from "./url-drawers";

type GqlComment = { author: { login: string } | null; body?: string; url: string };
type GqlThread = {
	id: string;
	isResolved: boolean;
	path: string;
	line: number | null;
	first: { totalCount: number; nodes: GqlComment[] };
	last: { nodes: GqlComment[] };
};
type GqlReview = { state: string; body: string; url: string; author: { login: string } | null; commit: { oid: string } | null };
type GqlCheck =
	| { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; detailsUrl: string | null }
	| { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };

/** What `fetchPrDetails` returns per PR: enough to name every blocker with a link. */
export type PrDetail = {
	baseRefName: string;
	headRefOid: string;
	reviewThreads: { nodes: GqlThread[] };
	latestReviews: { nodes: GqlReview[] };
	commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: GqlCheck[] } } | null } }> };
};

const DETAIL_FIELDS = `
  baseRefName headRefOid
  reviewThreads(first: 100) { nodes { id isResolved path line
    first: comments(first: 1) { totalCount nodes { author { login } body url } }
    last: comments(last: 1) { nodes { author { login } url } } } }
  latestReviews(first: 20) { nodes { state body url author { login } commit { oid } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl } } } } } } }`;

const KEY = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
/** Aliased PRs per GraphQL request; each carries up to 100 threads and 100 checks. */
const BATCH = 10;

/** Fetches blocker detail for `keys` (owner/repo#N), BATCH PRs per request. PRs GitHub can't return are left out. */
export async function fetchPrDetails(keys: readonly string[]): Promise<Map<string, PrDetail>> {
	const out = new Map<string, PrDetail>();
	for (let i = 0; i < keys.length; i += BATCH) {
		const batch = keys.slice(i, i + BATCH);
		const fields = batch.map((key, j) => {
			const m = KEY.exec(key);
			if (!m) throw new Error(`Not an owner/repo#N key: ${key}`);
			return `p${j}: repository(owner: ${JSON.stringify(m[1])}, name: ${JSON.stringify(m[2])}) { pullRequest(number: ${m[3]}) { ${DETAIL_FIELDS} } }`;
		});
		const data: Record<string, { pullRequest: PrDetail | null } | null> = JSON.parse(await gh(["api", "graphql", "-f", `query=query { ${fields.join("\n")} }`])).data;
		batch.forEach((key, j) => {
			const pr = data[`p${j}`]?.pullRequest;
			if (pr) out.set(key, pr);
		});
	}
	return out;
}

const SNIPPET = 160;
/** One line of plain text: entities, headings, emphasis and table pipes (a review bot's header is all of these) dropped. */
const snippet = (body: string | undefined): string => {
	const flat = (body ?? "").replace(/&nbsp;/g, " ").replace(/[#*|]+/g, " ").replace(/\s+/g, " ").trim();
	return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET)}…` : flat;
};
const quoted = (body: string | undefined) => (snippet(body) ? `: "${snippet(body)}"` : "");
const who = (c: { author: { login: string } | null }) => `@${c.author?.login ?? "ghost"}`;
const MAX_PENDING_NAMES = 5;

function checkLines(detail: PrDetail): { failing: string[]; lines: string[] } {
	const contexts = detail.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
	const failing: string[] = [];
	const lines: string[] = [];
	const pending: string[] = [];
	for (const c of contexts) {
		const [name, url, state] =
			c.__typename === "CheckRun"
				? [c.name, c.detailsUrl, c.status !== "COMPLETED" ? "pending" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? "") ? "ok" : (c.conclusion ?? "failed").toLowerCase()]
				: [c.context, c.targetUrl, c.state === "SUCCESS" ? "ok" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : c.state.toLowerCase()];
		if (state === "ok") continue;
		if (state === "pending") pending.push(name);
		else {
			failing.push(name);
			lines.push(`CI ${state}: ${name}${url ? ` ${url}` : ""}`);
		}
	}
	if (pending.length) {
		const more = pending.length > MAX_PENDING_NAMES ? ` (+${pending.length - MAX_PENDING_NAMES} more)` : "";
		lines.push(`CI pending: ${pending.slice(0, MAX_PENDING_NAMES).join(", ")}${more}`);
	}
	return { failing, lines };
}

/**
 * One PR's watch report: a header line, then (when not ROR and `detail` is known) one indented line per blocker with its link.
 * `fingerprint` changes only when the PR's status or its specific blockers do (not when one of several pending checks finishes).
 */
export function formatRorReport(pr: MyPr, detail: PrDetail | undefined, approvers: readonly string[]): { settled: boolean; fingerprint: string; lines: string[] } {
	const status = rorWatchStatus(pr, approvers);
	const header = `${prKey(pr)} ${pr.title} -> ${status.text} ${pr.url}`;
	if (status.settled || !detail) return { settled: status.settled, fingerprint: status.text, lines: [header] };
	const logins = approvers.map((a) => a.toLowerCase());
	const lines: string[] = [];
	const marks: string[] = [status.text];
	if (pr.isDraft) lines.push("draft: mark it ready for review");
	if (pr.ci !== "pass") {
		const checks = checkLines(detail);
		lines.push(...(checks.lines.length ? checks.lines : [pr.ci === "none" ? "CI: no checks reported on the head commit" : `CI ${pr.ci}`]));
		marks.push(...checks.failing);
	}
	for (const t of detail.reviewThreads.nodes) {
		if (t.isResolved) continue;
		const first = t.first.nodes[0];
		const last = t.last.nodes[0];
		const where = `${t.path}${t.line ? `:${t.line}` : ""}`;
		const replies = t.first.totalCount > 1 && last ? ` (${t.first.totalCount} comments, last by ${who(last)} ${last.url})` : "";
		lines.push(`unresolved thread on ${where}${first ? ` by ${who(first)}${quoted(first.body)} ${first.url}` : ""}${replies}`);
		marks.push(t.id);
	}
	if (pr.mergeable === "conflicts") lines.push(`merge conflicts with ${detail.baseRefName}`);
	else if (pr.mergeable === "unknown") lines.push("GitHub has not computed mergeability yet");
	const reviews = detail.latestReviews.nodes;
	for (const r of reviews.filter((r) => r.state === "CHANGES_REQUESTED")) {
		lines.push(`changes requested by ${who(r)}${quoted(r.body)} ${r.url}`);
		marks.push(r.url);
	}
	const bot = reviews.filter((r) => r.author && logins.includes(r.author.login.toLowerCase()));
	if (!bot.some((r) => r.state === "APPROVED" && r.commit?.oid === detail.headRefOid)) {
		if (bot.length === 0) lines.push(`no review yet from ${approvers.join(" or ")}`);
		for (const r of bot) {
			if (r.state === "APPROVED") lines.push(`${who(r)} approved ${r.commit?.oid.slice(0, 7) ?? "an older commit"}, head is now ${detail.headRefOid.slice(0, 7)} ${r.url}`);
			else if (r.state !== "CHANGES_REQUESTED") lines.push(`${who(r)} review is ${r.state.toLowerCase()}${quoted(r.body)} ${r.url}`);
			marks.push(`${r.url}:${r.state}`);
		}
	}
	return { settled: false, fingerprint: marks.join("|"), lines: [header, ...lines.map((l) => `  - ${l}`)] };
}
