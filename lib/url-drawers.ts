import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Editor completion drawers for OMP's internal URLs: `vault://` (Obsidian vaults, folders, notes) and
 * `pr://` (your own open pull requests, with CI / review-thread / conflict / approval status).
 * Both plug in as autocomplete providers and forward everything else to the wrapped provider.
 */

// Mirrors OMP's editor-provider contract. Only these two methods are overridden.
export type CompletionItem = { value: string; label: string; description?: string };
export type CompletionResult = { items: CompletionItem[]; prefix: string } | null;
export type AppliedCompletion = { lines: string[]; cursorLine: number; cursorCol: number };
export type EditorProvider = {
 getSuggestions(lines: string[], line: number, col: number, signal?: AbortSignal, onPartial?: unknown): Promise<CompletionResult>;
 applyCompletion(lines: string[], line: number, col: number, item: CompletionItem, prefix: string): AppliedCompletion;
};

const DRAWER_LIMIT = 25;

// Same token boundary OMP uses for internal-URL completion.
const VAULT_TOKEN = /(?:^|[\s"'`(<=])(vault:\/\/[^\s"'`()<>]*)$/i;
const PR_TOKEN = /(?:^|[\s"'`(<=])(pr:\/\/[^\s"'`()<>]*)$/i;

function decodeSegment(text: string): string {
 try {
  return decodeURIComponent(text);
 } catch {
  return text;
 }
}

/** Replaces the URL token ending at the cursor and parks the cursor after the inserted text. */
export function replaceToken(lines: string[], line: number, col: number, prefix: string, inserted: string): AppliedCompletion {
 const current = lines[line] ?? "";
 const before = current.slice(0, col - prefix.length);
 const next = [...lines];
 next[line] = before + inserted + current.slice(col);
 return { lines: next, cursorLine: line, cursorCol: before.length + inserted.length };
}

/**
 * Wraps `inner` in a Proxy so optional hooks (inline hints, sync slash completion, …) keep hitting the
 * original instance, whose methods rely on private fields. When `enabled()` is false the drawer is inert,
 * so a settings toggle takes effect without reinstalling the provider.
 */
function drawerProvider(
 inner: EditorProvider,
 enabled: () => boolean,
 tokenPattern: RegExp,
 scheme: string,
 suggest: (token: string, signal?: AbortSignal) => Promise<CompletionResult>,
 inserted: (item: CompletionItem) => string,
): EditorProvider {
 const getSuggestions: EditorProvider["getSuggestions"] = async (lines, line, col, signal, onPartial) => {
  const token = enabled() ? tokenPattern.exec((lines[line] ?? "").slice(0, col))?.[1] : undefined;
  if (token === undefined) return inner.getSuggestions(lines, line, col, signal, onPartial);
  if (signal?.aborted) return null;
  return suggest(token, signal);
 };
 const applyCompletion: EditorProvider["applyCompletion"] = (lines, line, col, item, prefix) => {
  if (!item.value.startsWith(scheme) || !prefix.toLowerCase().startsWith(scheme)) {
   return inner.applyCompletion(lines, line, col, item, prefix);
  }
  return replaceToken(lines, line, col, prefix, inserted(item));
 };
 return new Proxy(inner, {
  get(target, prop, receiver) {
   if (prop === "getSuggestions") return getSuggestions;
   if (prop === "applyCompletion") return applyCompletion;
   const value = Reflect.get(target, prop, receiver);
   return typeof value === "function" ? value.bind(target) : value;
  },
 });
}

/* -------------------------------------------------------------------------- */
/*                                 vault://                                   */
/* -------------------------------------------------------------------------- */

const OBSIDIAN_REGISTRY = path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");

// Obsidian names a vault after its folder. Read the registry file directly: spawning the Obsidian
// CLI per keystroke is far too slow.
let vaultRootsCache: { mtimeMs: number; roots: Map<string, string> } | undefined;

/** Vault name -> absolute root, from Obsidian's registry (empty when Obsidian is not installed). */
export async function loadVaultRoots(): Promise<Map<string, string>> {
 let mtimeMs: number;
 try {
  mtimeMs = (await fs.stat(OBSIDIAN_REGISTRY)).mtimeMs;
 } catch {
  return new Map();
 }
 if (vaultRootsCache?.mtimeMs === mtimeMs) return vaultRootsCache.roots;
 const roots = new Map<string, string>();
 try {
  const registry: { vaults?: Record<string, { path?: unknown }> } = JSON.parse(await fs.readFile(OBSIDIAN_REGISTRY, "utf8"));
  for (const entry of Object.values(registry.vaults ?? {})) {
   if (typeof entry.path === "string") roots.set(path.basename(entry.path), entry.path);
  }
 } catch {
  // Malformed registry: offer nothing rather than break the editor.
 }
 vaultRootsCache = { mtimeMs, roots };
 return roots;
}

// Encode per segment, as OMP's vault handler does, so spaces survive the whitespace-delimited token.
const encodeVaultPath = (relative: string): string => relative.split("/").map(encodeURIComponent).join("/");

// Prefix matches outrank substring matches; non-matches are dropped.
function matchRank(name: string, query: string): number {
 if (!query) return 1;
 const lower = name.toLowerCase();
 if (lower.startsWith(query)) return 2;
 return lower.includes(query) ? 1 : 0;
}

/** Completions for a `vault://…` token: vault names, then folders and files inside the chosen vault. */
export async function vaultCompletions(token: string, roots: Map<string, string>): Promise<CompletionResult> {
 const query = token.slice("vault://".length);
 const slash = query.indexOf("/");

 if (slash === -1) {
  const needle = decodeSegment(query).toLowerCase();
  const items = [...roots.entries()]
   .map(([name, root]) => ({ name, root, rank: matchRank(name, needle) }))
   .filter((v) => v.rank > 0)
   .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
   .map((v) => ({ value: `vault://${encodeURIComponent(v.name)}/`, label: `${v.name}/`, description: v.root.replace(os.homedir(), "~") }));
  return items.length > 0 ? { items, prefix: token } : null;
 }

 const vaultName = decodeSegment(query.slice(0, slash));
 const root = roots.get(vaultName);
 if (!root) return null;

 const rest = query.slice(slash + 1);
 const lastSlash = rest.lastIndexOf("/");
 const dirRel = lastSlash === -1 ? "" : decodeSegment(rest.slice(0, lastSlash));
 const partial = decodeSegment(rest.slice(lastSlash + 1)).toLowerCase();
 const dirAbs = path.resolve(root, dirRel);
 if (dirAbs !== root && !dirAbs.startsWith(root + path.sep)) return null;

 let entries: Dirent[];
 try {
  entries = await fs.readdir(dirAbs, { withFileTypes: true });
 } catch {
  return null;
 }

 const base = `vault://${encodeURIComponent(vaultName)}/`;
 const items = entries
  .filter((e) => (e.isDirectory() || e.isFile()) && (partial.startsWith(".") || !e.name.startsWith(".")))
  .map((e) => ({ entry: e, dir: e.isDirectory(), rank: matchRank(e.name, partial) }))
  .filter((v) => v.rank > 0)
  .sort((a, b) => b.rank - a.rank || Number(b.dir) - Number(a.dir) || a.entry.name.localeCompare(b.entry.name))
  .slice(0, DRAWER_LIMIT)
  .map(({ entry, dir }) => {
   const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
   return {
    value: `${base}${encodeVaultPath(rel)}${dir ? "/" : ""}`,
    label: `${entry.name}${dir ? "/" : ""}`,
    description: dir ? "folder" : entry.name.endsWith(".md") ? "note" : "file",
   };
  });
 return items.length > 0 ? { items, prefix: token } : null;
}

/** Folders keep the cursor on the URL so the next Tab reopens the drawer one level down; files end the token. */
export function withVaultDrawer(inner: EditorProvider, enabled: () => boolean): EditorProvider {
 return drawerProvider(
  inner,
  enabled,
  VAULT_TOKEN,
  "vault://",
  async (token) => vaultCompletions(token, await loadVaultRoots()),
  (item) => (item.value.endsWith("/") ? item.value : `${item.value} `),
 );
}

/* -------------------------------------------------------------------------- */
/*                                    pr://                                   */
/* -------------------------------------------------------------------------- */

export type MyPr = {
 number: number;
 title: string;
 repo: string;
 isDraft: boolean;
 ci: "pass" | "fail" | "pending" | "none";
 unresolvedThreads: number;
 mergeable: "clean" | "conflicts" | "unknown";
 /** null when no approver pattern is configured, so the status column is omitted. */
 approved: boolean | null;
};

export type GqlPr = {
 number: number;
 title: string;
 isDraft: boolean;
 mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
 repository: { nameWithOwner: string; owner: { login: string } };
 reviewThreads: { nodes: Array<{ isResolved: boolean }> };
 latestReviews: { nodes: Array<{ state: string; author: { login: string } | null }> };
 commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
};

const PR_FRESH_MS = 60_000;
const PR_RETRY_MS = 15_000;

// viewer.pullRequests is "PRs I authored", so no username lookup is needed. Bounded work:
// 100 PRs x (100 threads + 20 reviews) stays far under GitHub's node limit.
const PR_QUERY = `query {
  viewer {
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title isDraft mergeable
        repository { nameWithOwner owner { login } }
        reviewThreads(first: 100) { nodes { isResolved } }
        latestReviews(first: 20) { nodes { state author { login } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/** Project one GraphQL node. `approver` matches the login of a reviewer whose approval should be surfaced. */
export function toMyPr(pr: GqlPr, approver: RegExp | undefined): MyPr {
 const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
 return {
  number: pr.number,
  title: pr.title,
  repo: pr.repository.nameWithOwner,
  isDraft: pr.isDraft,
  ci: !rollup ? "none" : rollup === "SUCCESS" ? "pass" : rollup === "FAILURE" || rollup === "ERROR" ? "fail" : "pending",
  unresolvedThreads: pr.reviewThreads.nodes.filter((t) => !t.isResolved).length,
  mergeable: pr.mergeable === "MERGEABLE" ? "clean" : pr.mergeable === "CONFLICTING" ? "conflicts" : "unknown",
  approved: approver ? pr.latestReviews.nodes.some((r) => r.state === "APPROVED" && approver.test(r.author?.login ?? "")) : null,
 };
}

/** Status columns in display order; the approved column only exists when an approver is configured. */
export function prStatusCells(pr: MyPr): string[] {
 const ci = { pass: "✓ CI", fail: "✗ CI", pending: "… CI", none: "– CI" }[pr.ci];
 const threads = pr.unresolvedThreads === 0 ? "✓ threads" : `✗ ${pr.unresolvedThreads} unresolved`;
 const merge = { clean: "✓ mergeable", conflicts: "✗ conflicts", unknown: "? mergeable" }[pr.mergeable];
 const cells = [ci, threads, merge];
 if (pr.approved !== null) cells.push(`${pr.approved ? "✓" : "–"} approved`);
 return cells;
}

// OMP's drawer caps the label column at 32 cells and collapses whitespace runs in labels and descriptions,
// but a label-only row gets the full drawer width. So each PR row is a single label laid out as a table,
// padded with U+2800 (renders blank, one cell wide, and is not `\s`, so the padding survives).
const CELL_PAD = "\u2800";
// Cursor prefix (2), OMP's own safety margin (2), and the drawer's scrollbar gutter (2).
const ROW_CHROME = 6;
const MIN_TITLE_WIDTH = 16;

/** Pad `text` to `width` cells, or cut it to fit with a trailing ellipsis. */
function fitCell(text: string, width: number): string {
 const w = Bun.stringWidth(text);
 if (w <= width) return text + CELL_PAD.repeat(width - w);
 let out = "";
 let used = 0;
 for (const ch of text) {
  const cw = Bun.stringWidth(ch);
  if (used + cw > width - 1) break;
  out += ch;
  used += cw;
 }
 return `${out}…${CELL_PAD.repeat(width - 1 - used)}`;
}

/** One aligned row per PR: `#N title` column sized to the widest title that fits, then repo and status columns. */
function prRows(prs: readonly MyPr[], width: number): string[] {
 const rows = prs.map((pr) => [`#${pr.number} ${pr.isDraft ? "[draft] " : ""}${pr.title}`, pr.repo, ...prStatusCells(pr)]);
 const columns = Math.max(...rows.map((r) => r.length));
 const widths = Array.from({ length: columns }, (_, i) => Math.max(0, ...rows.map((r) => Bun.stringWidth(r[i] ?? ""))));
 // Title gap is two pad cells; each later column is joined by " · ".
 const rest = widths.slice(1).reduce((sum, w) => sum + w, 0) + 2 + 3 * (columns - 2);
 widths[0] = Math.min(widths[0], Math.max(MIN_TITLE_WIDTH, width - ROW_CHROME - rest));
 return rows.map((r) => {
  // The last column needs no trailing padding.
  const [title, ...others] = r.map((cell, i) => (i === r.length - 1 ? cell : fitCell(cell, widths[i])));
  return `${title}${CELL_PAD.repeat(2)}${others.join(" · ")}`;
 });
}

function prRank(pr: MyPr, query: string): number {
 if (!query) return 1;
 const key = `${pr.repo}/${pr.number}`.toLowerCase();
 if (query.includes("/")) return key.startsWith(query) ? 3 : pr.repo.toLowerCase().startsWith(query) ? 2 : 0;
 if (String(pr.number).startsWith(query)) return 3;
 return `${pr.repo} ${pr.title}`.toLowerCase().includes(query) ? 1 : 0;
}

/**
 * Drawer entries for a `pr://…` token. Equal ranks keep the input (most recently updated) order.
 * `width` is the terminal width the rows are fitted to.
 */
export function prCompletions(token: string, prs: readonly MyPr[], width = process.stdout.columns || 120): CompletionResult {
 const query = decodeSegment(token.slice("pr://".length)).toLowerCase();
 const shown = prs
  .map((pr) => ({ pr, rank: prRank(pr, query) }))
  .filter((v) => v.rank > 0)
  .sort((a, b) => b.rank - a.rank)
  .slice(0, DRAWER_LIMIT)
  .map(({ pr }) => pr);
 if (shown.length === 0) return null;
 const labels = prRows(shown, width);
 return { items: shown.map((pr, i) => ({ value: `pr://${pr.repo}/${pr.number}`, label: labels[i] })), prefix: token };
}

// gh's own auth identifies the viewer.
//   HYDEMODS_PR_OWNERS=org1,org2   restrict to those repo owners
//   HYDEMODS_PR_APPROVER=<regex>   case-insensitive match on a reviewer login (bots appear without "[bot]");
//                                  adds an "approved" column that lights up when that reviewer's latest review approves
function ghMyPrs(): Promise<MyPr[]> {
 const owners = (process.env.HYDEMODS_PR_OWNERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
 const approverSource = process.env.HYDEMODS_PR_APPROVER?.trim();
 const approver = approverSource ? new RegExp(approverSource, "i") : undefined;
 const { promise, resolve, reject } = Promise.withResolvers<MyPr[]>();
 execFile("gh", ["api", "graphql", "-f", `query=${PR_QUERY}`], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
  if (err) return reject(err);
  try {
   // Shape is fixed by PR_QUERY above; a mismatch throws into the catch and backs off.
   const response: { data: { viewer: { pullRequests: { nodes: GqlPr[] } } } } = JSON.parse(stdout);
   const nodes = response.data.viewer.pullRequests.nodes;
   const scoped = owners.length === 0 ? nodes : nodes.filter((n) => owners.includes(n.repository.owner.login.toLowerCase()));
   resolve(scoped.map((n) => toMyPr(n, approver)));
  } catch (parseErr) {
   reject(parseErr);
  }
 });
 return promise;
}

// Stale-while-revalidate: the query takes seconds, far too slow to block every keystroke.
let prCache: { at: number; prs: MyPr[] } | undefined;
let prInflight: Promise<void> | undefined;
let prFailedAt = 0;

/** Starts (or joins) a background fetch. Failures back off for a few seconds and keep any stale list. */
export function refreshMyPrs(): Promise<void> {
 prInflight ??= ghMyPrs()
  .then((prs) => {
   prCache = { at: Date.now(), prs };
  })
  .catch(() => {
   prFailedAt = Date.now();
  })
  .finally(() => {
   prInflight = undefined;
  });
 return prInflight;
}

async function getMyPrs(signal?: AbortSignal): Promise<MyPr[]> {
 const now = Date.now();
 if (prCache && now - prCache.at < PR_FRESH_MS) return prCache.prs;
 if (now - prFailedAt >= PR_RETRY_MS) {
  const pending = refreshMyPrs();
  if (!prCache) {
   const aborted = Promise.withResolvers<void>();
   signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
   await Promise.race([pending, aborted.promise]);
  }
 }
 return prCache?.prs ?? [];
}

export function withPrDrawer(inner: EditorProvider, enabled: () => boolean): EditorProvider {
 return drawerProvider(
  inner,
  enabled,
  PR_TOKEN,
  "pr://",
  async (token, signal) => {
   const prs = await getMyPrs(signal);
   return signal?.aborted ? null : prCompletions(token, prs);
  },
  (item) => `${item.value} `,
 );
}
