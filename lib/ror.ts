import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MyPr } from "./url-drawers";

export type RorTier = {
 key: string;
 label: string;
 prs: string[];
 /** What belongs in this tier; fed to the classifier. */
 description?: string;
};

export type RorConfig = {
 /** Reviewer logins (bots without "[bot]"); an approval on the head commit from any one of them is required. */
 approvers: string[];
 /** Restrict to repos owned by these logins; omitted means every repo. */
 owners?: string[];
 heading?: string;
 /** `mcx forward` server name for the Slack MCP. */
 slackServer: string;
 tiers: RorTier[];
 /** Model selector for the classifier, as `call_model` takes it: provider/id, bare id or @role, optional :effort. */
 classifierModel?: string;
 /** PR key -> the classifier's reason. Marks tier entries the model chose rather than the user. */
 autoTiered?: Record<string, string>;
};

/** `tier` is the stored tier key, or null for the section of PRs not yet assigned to any tier. */
export type RorSection = { tier: string | null; label: string; prs: MyPr[] };

export const UNTIERED_LABEL = "Not tiered yet";
// Slack's MCP caps one text element at 5000 characters; leave headroom for its own markup.
export const SLACK_CHUNK_LIMIT = 4000;

export function rorConfigPath(): string {
 return process.env.HYDEMODS_ROR_CONFIG ?? path.join(os.homedir(), ".config", "hydemods", "ror.json");
}

export async function loadRorConfig(file = rorConfigPath()): Promise<RorConfig> {
 let raw: string;
 try {
  raw = await readFile(file, "utf8");
 } catch {
  throw new Error(`No ready-for-review config at ${file}. Create it with "approvers", "slackServer" and "tiers" (see the hydemods README).`);
 }
 const config = JSON.parse(raw) as Partial<RorConfig>;
 if (!Array.isArray(config.approvers) || config.approvers.length === 0) throw new Error(`${file}: "approvers" needs at least one reviewer login.`);
 if (!config.slackServer) throw new Error(`${file}: "slackServer" is required.`);
 if (!Array.isArray(config.tiers) || config.tiers.length === 0) throw new Error(`${file}: "tiers" needs at least one { key, label, prs }.`);
 for (const tier of config.tiers) {
  if (!tier.key || !tier.label || !Array.isArray(tier.prs)) throw new Error(`${file}: every tier needs "key", "label" and "prs".`);
 }
 return config as RorConfig;
}

/** Written to a sibling temp file first so a crash never leaves a half-written tier store. */
export async function saveRorConfig(config: RorConfig, file = rorConfigPath()): Promise<void> {
 await mkdir(path.dirname(file), { recursive: true });
 const tmp = `${file}.${process.pid}.tmp`;
 await writeFile(tmp, `${JSON.stringify(config, null, 1)}\n`);
 await rename(tmp, file);
}

export const prKey = (pr: Pick<MyPr, "repo" | "number">): string => `${pr.repo}#${pr.number}`;

/** Why `pr` is not ready for review, in a fixed order; empty means ready. */
export function rorBlockers(pr: MyPr, approvers: readonly string[]): string[] {
 const logins = approvers.map((a) => a.toLowerCase());
 const out: string[] = [];
 if (pr.isDraft) out.push("draft");
 if (pr.ci !== "pass") out.push(`CI ${pr.ci}`);
 if (pr.unresolvedThreads > 0) out.push(`${pr.unresolvedThreads} unresolved thread${pr.unresolvedThreads === 1 ? "" : "s"}`);
 if (pr.mergeable !== "clean") out.push(pr.mergeable === "conflicts" ? "merge conflicts" : "mergeability unknown");
 if (pr.reviews.some((r) => r.state === "CHANGES_REQUESTED")) out.push("changes requested");
 const bot = pr.reviews.filter((r) => logins.includes(r.login.toLowerCase()));
 if (!bot.some((r) => r.state === "APPROVED" && r.onHead)) {
  if (bot.length === 0) out.push("no approver review");
  else if (bot.some((r) => r.state === "APPROVED")) out.push("approval is on an older commit");
  // An approver requesting changes is already reported above.
  else if (!bot.every((r) => r.state === "CHANGES_REQUESTED")) out.push(`approver review is ${bot[0]!.state.toLowerCase()}`);
 }
 return out;
}

/** Not draft, an approver's latest review approves the current head commit, no reviewer's latest review requests changes, CI green, no open threads, no conflicts. */
export function isReadyForReview(pr: MyPr, approvers: readonly string[]): boolean {
 return rorBlockers(pr, approvers).length === 0;
}

/** One watch line's status for a watched PR; `pr` undefined means it is no longer open. `settled` PRs need no more watching. */
export function rorWatchStatus(pr: MyPr | undefined, approvers: readonly string[]): { settled: boolean; text: string } {
 if (!pr) return { settled: true, text: "closed or merged" };
 const blockers = rorBlockers(pr, approvers);
 return blockers.length ? { settled: false, text: `not ROR: ${blockers.join(", ")}` } : { settled: true, text: "ROR" };
}

export function readyPrs(prs: readonly MyPr[], config: RorConfig): MyPr[] {
 const owners = config.owners?.map((o) => o.toLowerCase());
 return prs.filter((pr) => (!owners || owners.includes(pr.repo.split("/")[0]!.toLowerCase())) && isReadyForReview(pr, config.approvers));
}

/** Tiers in config order, PRs in the user's stored order; untiered PRs last, newest number first. Empty sections are dropped. */
export function groupByTier(ready: readonly MyPr[], tiers: readonly RorTier[]): RorSection[] {
 const byKey = new Map(ready.map((pr) => [prKey(pr), pr]));
 const placed = new Set<string>();
 const sections: RorSection[] = [];
 for (const tier of tiers) {
  const prs: MyPr[] = [];
  for (const key of tier.prs) {
   const pr = byKey.get(key);
   if (pr && !placed.has(key)) {
    placed.add(key);
    prs.push(pr);
   }
  }
  if (prs.length) sections.push({ tier: tier.key, label: tier.label, prs });
 }
 const untiered = ready.filter((pr) => !placed.has(prKey(pr))).sort((a, b) => a.repo.localeCompare(b.repo) || b.number - a.number);
 if (untiered.length) sections.push({ tier: null, label: UNTIERED_LABEL, prs: untiered });
 return sections;
}

/** Slack-flavoured markdown. Links read `#N` when every PR shares one repo, `owner/repo#N` otherwise. */
export function formatRorMessage(sections: readonly RorSection[], config: Pick<RorConfig, "approvers" | "heading">): string {
 const all = sections.flatMap((s) => s.prs);
 const oneRepo = new Set(all.map((pr) => pr.repo)).size <= 1;
 const heading = config.heading ?? "Ready for review";
 const lines = [
  `**${heading} (${all.length})**`,
  `_Approved by ${config.approvers.join(" or ")} on the latest commit, no change requests, CI passing, no unresolved review threads, no merge conflicts._`,
 ];
 if (all.length === 0) return [...lines, "", "Nothing is ready right now."].join("\n");
 for (const section of sections) {
  lines.push("", `**${section.label} (${section.prs.length})**`, ...section.prs.map((pr) => `- <${pr.url}|${oneRepo ? `#${pr.number}` : prKey(pr)}> ${pr.title}`));
 }
 return lines.join("\n");
}

/** Splits at blank lines (section breaks), falling back to line breaks, so no chunk exceeds `limit`. */
export function splitMessage(text: string, limit = SLACK_CHUNK_LIMIT): string[] {
 const chunks: string[] = [];
 let current = "";
 const push = (piece: string, sep: string) => {
  if (!current) current = piece;
  else if (current.length + sep.length + piece.length <= limit) current += sep + piece;
  else {
   chunks.push(current);
   current = piece;
  }
 };
 for (const block of text.split("\n\n")) {
  if (block.length <= limit) push(block, "\n\n");
  else
   block.split("\n").forEach((line, i) => {
    for (let at = 0; at < Math.max(line.length, 1); at += limit) push(line.slice(at, at + limit), at > 0 ? "" : i === 0 ? "\n\n" : "\n");
   });
 }
 if (current) chunks.push(current);
 return chunks;
}

/**
 * Resolves `owner/repo#N`, `#N`, or `N` against the open PRs. A bare number must match exactly one
 * open PR; a full key is taken as given so closed PRs can still be tiered.
 */
export function resolvePrRefs(refs: readonly string[], open: readonly MyPr[]): string[] {
 return refs.map((ref) => {
  const trimmed = ref.trim();
  if (/^[^/\s]+\/[^#\s]+#\d+$/.test(trimmed)) return trimmed;
  const number = Number(trimmed.replace(/^#/, ""));
  if (!Number.isInteger(number) || number <= 0) throw new Error(`"${ref}" is not a PR reference (use owner/repo#N, #N or N).`);
  const matches = open.filter((pr) => pr.number === number);
  if (matches.length === 1) return prKey(matches[0]!);
  if (matches.length === 0) throw new Error(`No open PR #${number}; use owner/repo#${number}.`);
  throw new Error(`#${number} is ambiguous (${matches.map(prKey).join(", ")}); use owner/repo#${number}.`);
 });
}

/** Moves `keys` to the end of `tierKey`, removing them from every other tier. Returns a new config. A manual move is ground truth, so it drops the keys' auto-tiered marks. */
export function assignTier(config: RorConfig, tierKey: string, keys: readonly string[]): RorConfig {
 if (!config.tiers.some((t) => t.key === tierKey)) throw new Error(`Unknown tier "${tierKey}"; tiers are ${config.tiers.map((t) => t.key).join(", ")}.`);
 const moving = new Set(keys);
 const next: RorConfig = {
  ...config,
  tiers: config.tiers.map((t) => {
   const kept = t.prs.filter((k) => !moving.has(k));
   return t.key === tierKey ? { ...t, prs: [...kept, ...keys] } : { ...t, prs: kept };
  }),
 };
 if (config.autoTiered) next.autoTiered = Object.fromEntries(Object.entries(config.autoTiered).filter(([k]) => !moving.has(k)));
 return next;
}

/** Applies the classifier's successful results: each key goes to the end of its tier and its reason is recorded. Errors are ignored. */
export function applyClassifications(config: RorConfig, results: ReadonlyArray<{ key: string; tier: string; reason: string } | { key: string; error: string }>): RorConfig {
 let next = config;
 const autoTiered = { ...config.autoTiered };
 for (const result of results) {
  if ("error" in result) continue;
  next = assignTier(next, result.tier, [result.key]);
  autoTiered[result.key] = result.reason;
 }
 return { ...next, autoTiered };
}

/* --------------------------------- Slack ---------------------------------- */

export type McpCall = (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;

/** One MCP tool call through `mcx forward`, which carries the server's keychain OAuth. Returns the result text. */
export const mcxCall: McpCall = (server, tool, args) => {
 const { promise, resolve, reject } = Promise.withResolvers<string>();
 execFile(
  "mcx",
  ["forward", "--server", server, "--tool", tool, "--args", JSON.stringify(args)],
  { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  (err, stdout, stderr) => {
   if (err) return reject(new Error(`mcx ${server}/${tool} failed: ${(stderr || err.message).trim()}`));
   try {
    const result: { content?: Array<{ type: string; text?: string }>; isError?: boolean } = JSON.parse(stdout);
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    if (result.isError) return reject(new Error(`${server}/${tool}: ${text}`));
    resolve(text);
   } catch {
    reject(new Error(`mcx ${server}/${tool} returned non-JSON output: ${stdout.slice(0, 200)}`));
   }
  },
 );
 return promise;
};

export function parseSlackUserId(profileText: string): string {
 const id = /User ID:\s*([A-Z0-9]+)/.exec(profileText)?.[1];
 if (!id) throw new Error(`Could not find a Slack user id in the profile response: ${profileText.slice(0, 200)}`);
 return id;
}

/** mcx returns the tool's JSON as text, so slashes may arrive escaped as `\/`. */
export function parseMessageLink(sendText: string): string | undefined {
 return /message_link\W*(https:\/\/[^"\\\s,}]+)/.exec(sendText.replaceAll("\\/", "/"))?.[1];
}

/** DMs `text` to the authenticated Slack user (self), one message per chunk. Returns each message link. */
export async function sendSelfDm(server: string, text: string, call: McpCall = mcxCall): Promise<string[]> {
 const userId = parseSlackUserId(await call(server, "slack_read_user_profile", {}));
 const links: string[] = [];
 for (const message of splitMessage(text)) {
  const sent = await call(server, "slack_send_message", { channel_id: userId, message });
  links.push(parseMessageLink(sent) ?? "(sent; no link returned)");
 }
 return links;
}
