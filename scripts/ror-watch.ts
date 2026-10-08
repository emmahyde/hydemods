// Watches PRs for ready-for-review status. The `ror` tool's "watch" op runs this as a stream monitor.
// stdout carries only changes: each changed PR's status line, plus, for PRs that are not ROR, one indented line per blocker
// with its link (failing checks, unresolved threads, change requests, approver state). The first poll reports every PR.
//
//   bun scripts/ror-watch.ts [--interval <sec>] [--once] <owner/repo#N>...   watch these; exit once all are ROR or closed
//   bun scripts/ror-watch.ts [--interval <sec>] [--once] --full              watch every open PR in ror.json `owners`; runs until killed
import { loadRorConfig, prKey, rorWatchStatus } from "../lib/ror";
import { fetchPrDetails, formatRorReport, type PrDetail } from "../lib/ror-detail";
import { fetchMyPrs, type MyPr } from "../lib/url-drawers";

const args = process.argv.slice(2);
const at = args.indexOf("--interval");
const intervalMs = Math.max(30, at >= 0 ? Number(args[at + 1]) || 300 : 300) * 1000;
const full = args.includes("--full");
const once = args.includes("--once");
const keys = args.filter((a, i) => a.includes("#") && i !== at + 1);
if (full === keys.length > 0) {
	console.error("usage: ror-watch.ts [--interval <sec>] [--once] (--full | <owner/repo#N>...)");
	process.exit(2);
}
/** GitHub computes mergeability lazily, so a fresh fetch often says UNKNOWN; one delayed refetch usually resolves it. */
const MERGEABLE_RETRY_MS = 15_000;

const config = await loadRorConfig();
const owners = config.owners?.map((o) => o.toLowerCase());
const inScope = (pr: MyPr) => !owners || owners.includes(pr.repo.split("/")[0]!.toLowerCase());
const last = new Map<string, string>();

async function openByKey(): Promise<Map<string, MyPr>> {
	const fetch = async () => new Map((await fetchMyPrs()).filter(inScope).map((pr) => [prKey(pr), pr]));
	const open = await fetch();
	const watched = full ? [...open.values()] : keys.flatMap((k) => open.get(k) ?? []);
	if (!watched.some((pr) => pr.mergeable === "unknown")) return open;
	await Bun.sleep(MERGEABLE_RETRY_MS);
	return fetch();
}

async function poll(): Promise<boolean> {
	let open: Map<string, MyPr>;
	try {
		open = await openByKey();
	} catch (err) {
		console.error(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
	// Full mode follows the open set: new PRs join, and PRs seen before but gone now are reported closed once, then dropped.
	const targets = full ? [...new Set([...last.keys(), ...open.keys()])] : keys;
	const notReady = targets.filter((k) => open.has(k) && !rorWatchStatus(open.get(k), config.approvers).settled);
	let details = new Map<string, PrDetail>();
	try {
		details = await fetchPrDetails(notReady);
	} catch (err) {
		console.error(`detail fetch failed (reporting blockers without specifics): ${err instanceof Error ? err.message : String(err)}`);
	}
	const blocked: string[] = [];
	const settledLines: string[] = [];
	let settled = 0;
	for (const key of targets) {
		const pr = open.get(key);
		const report = pr ? formatRorReport(pr, details.get(key), config.approvers) : { settled: true, fingerprint: "closed", lines: [`${key} -> closed or merged`] };
		if (report.settled) settled++;
		if (last.get(key) === report.fingerprint) continue;
		last.set(key, report.fingerprint);
		(report.settled ? settledLines : blocked).push(...report.lines);
	}
	if (full) for (const key of [...last.keys()]) if (!open.has(key)) last.delete(key);
	if (blocked.length || settledLines.length) {
		const watching = full ? open.size : keys.length;
		const ror = full ? watching - notReady.length : settled;
		console.log([`${watching} PRs watched: ${ror} ROR or closed, ${watching - ror} not ROR. Changes:`, ...blocked, ...settledLines].join("\n"));
	}
	return !full && settled === keys.length;
}

for (; ;) {
	const done = await poll();
	if (done && !full) console.log(`All ${keys.length} watched PRs are ROR or closed.`);
	if (done || once) process.exit(0);
	await Bun.sleep(intervalMs);
}
