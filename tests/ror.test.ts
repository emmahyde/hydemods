import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assignTier,
	formatRorMessage,
	groupByTier,
	loadRorConfig,
	parseMessageLink,
	readyPrs,
	resolvePrRefs,
	rorWatchStatus,
	saveRorConfig,
	sendSelfDm,
	splitMessage,
	type RorConfig,
} from "../lib/ror";
import type { MyPr } from "../lib/url-drawers";

const approved = [{ login: "review-bot", state: "APPROVED", onHead: true }];

const pr = (over: Partial<MyPr>): MyPr => ({
	number: 1,
	title: "t",
	url: "https://github.com/acme/app/pull/1",
	repo: "acme/app",
	isDraft: false,
	ci: "pass",
	unresolvedThreads: 0,
	mergeable: "clean",
	approved: null,
	reviews: approved,
	additions: 0,
	deletions: 0,
	changedFiles: 0,
	...over,
});

const config = (over: Partial<RorConfig> = {}): RorConfig => ({
	approvers: ["Review-Bot", "platform-bot"],
	slackServer: "slack",
	tiers: [
		{ key: "small", label: "Small", prs: [] },
		{ key: "medium", label: "Medium", prs: [] },
	],
	...over,
});

test("ready requires an approver's approval on the head commit, no change requests, green CI, no threads, no conflicts, not draft", () => {
	const numbers = (prs: MyPr[], cfg = config()) => readyPrs(prs, cfg).map((p) => p.number);
	const prs = [
		pr({ number: 1 }),
		pr({ number: 2, reviews: [{ login: "review-bot", state: "APPROVED", onHead: false }] }),
		pr({ number: 3, reviews: [{ login: "alice", state: "APPROVED", onHead: true }] }),
		pr({ number: 4, reviews: [{ login: "review-bot", state: "CHANGES_REQUESTED", onHead: true }] }),
		pr({ number: 5, ci: "pending" }),
		pr({ number: 6, unresolvedThreads: 1 }),
		pr({ number: 7, mergeable: "unknown" }),
		pr({ number: 8, isDraft: true }),
		pr({ number: 9, repo: "other/lib" }),
		pr({ number: 10, reviews: [{ login: "platform-bot", state: "APPROVED", onHead: true }] }),
		pr({ number: 11, reviews: [...approved, { login: "alice", state: "CHANGES_REQUESTED", onHead: false }] }),
	];
	expect(numbers(prs)).toEqual([1, 9, 10]);
	expect(numbers(prs, config({ owners: ["ACME"] }))).toEqual([1, 10]);
});

test("watch status names every blocker, tells a stale approval from a missing one, and settles on ROR or closed", () => {
	const approvers = config().approvers;
	expect(rorWatchStatus(pr({}), approvers)).toEqual({ settled: true, text: "ROR" });
	expect(rorWatchStatus(undefined, approvers)).toEqual({ settled: true, text: "closed or merged" });
	expect(
		rorWatchStatus(pr({ isDraft: true, ci: "fail", unresolvedThreads: 2, mergeable: "conflicts", reviews: [{ login: "review-bot", state: "APPROVED", onHead: false }] }), approvers),
	).toEqual({ settled: false, text: "not ROR: draft, CI fail, 2 unresolved threads, merge conflicts, approval is on an older commit" });
	expect(rorWatchStatus(pr({ reviews: [] }), approvers).text).toBe("not ROR: no approver review");
	expect(rorWatchStatus(pr({ reviews: [{ login: "Review-Bot", state: "CHANGES_REQUESTED", onHead: true }] }), approvers).text).toBe("not ROR: changes requested");
	expect(rorWatchStatus(pr({ reviews: [{ login: "review-bot", state: "COMMENTED", onHead: true }] }), approvers).text).toBe("not ROR: approver review is commented");
});

test("groups follow the stored tier order, place each PR once, and put untiered PRs last", () => {
	const ready = [pr({ number: 10 }), pr({ number: 11 }), pr({ number: 12 }), pr({ number: 13, repo: "acme/lib" }), pr({ number: 14 })];
	const tiers = [
		{ key: "small", label: "Small", prs: ["acme/app#12", "acme/app#10", "acme/app#999"] },
		{ key: "medium", label: "Medium", prs: ["acme/app#10", "acme/lib#13"] },
		{ key: "empty", label: "Empty", prs: [] },
	];
	const sections = groupByTier(ready, tiers);
	expect(sections.map((s) => [s.tier, s.prs.map((p) => p.number)])).toEqual([
		["small", [12, 10]],
		["medium", [13]],
		[null, [14, 11]],
	]);
});

test("message uses #N links for one repo and owner/repo#N once repos mix", () => {
	const one = formatRorMessage([{ tier: "small", label: "Small", prs: [pr({ number: 5, title: "Fix it", url: "U5" })] }], config());
	const [heading, , ...body] = one.split("\n");
	expect(heading).toBe("**Ready for review (1)**");
	expect(body.join("\n")).toBe("\n**Small (1)**\n- <U5|#5> Fix it");
	const mixed = formatRorMessage([{ tier: null, label: "Not tiered yet", prs: [pr({ number: 5, url: "U5" }), pr({ number: 6, repo: "acme/lib", url: "U6" })] }], config());
	expect(mixed).toContain("- <U5|acme/app#5> t\n- <U6|acme/lib#6> t");
	const empty = formatRorMessage([], config({ heading: "Mine" })).split("\n");
	expect([empty[0], ...empty.slice(2)]).toEqual(["**Mine (0)**", "", "Nothing is ready right now."]);
});

test("long messages split at section breaks first, then at lines, never past the limit", () => {
	expect(splitMessage("aaaa\n\nbbbb\n\ncccc", 10)).toEqual(["aaaa\n\nbbbb", "cccc"]);
	expect(splitMessage("head\n\nl1xx\nl2xx\nl3xx", 10)).toEqual(["head\n\nl1xx", "l2xx\nl3xx"]);
	const long = splitMessage(`h\n\n${"x".repeat(30)}`, 10);
	for (const chunk of long) expect(chunk.length).toBeLessThanOrEqual(10);
	expect(long.join("").replaceAll("\n", "")).toBe(`h${"x".repeat(30)}`);
});

test("bare PR numbers resolve only when exactly one open PR has that number", () => {
	const open = [pr({ number: 5 }), pr({ number: 6 }), pr({ number: 6, repo: "acme/lib" })];
	expect(resolvePrRefs(["5", "#5", "acme/app#6", "gone/repo#1"], open)).toEqual(["acme/app#5", "acme/app#5", "acme/app#6", "gone/repo#1"]);
	expect(() => resolvePrRefs(["6"], open)).toThrow("ambiguous (acme/app#6, acme/lib#6)");
	expect(() => resolvePrRefs(["7"], open)).toThrow("No open PR #7");
	expect(() => resolvePrRefs(["abc"], open)).toThrow("not a PR reference");
});

test("assigning a tier moves PRs to its end and out of every other tier", () => {
	const start = config({
		tiers: [
			{ key: "small", label: "Small", prs: ["a/b#1", "a/b#2"] },
			{ key: "medium", label: "Medium", prs: ["a/b#3", "a/b#1"] },
		],
	});
	expect(assignTier(start, "medium", ["a/b#2", "a/b#3"]).tiers.map((t) => t.prs)).toEqual([["a/b#1"], ["a/b#1", "a/b#2", "a/b#3"]]);
	expect(() => assignTier(start, "huge", ["a/b#1"])).toThrow('Unknown tier "huge"; tiers are small, medium');
});

test("config round-trips and rejects missing required fields", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ror-"));
	const file = join(dir, "nested", "ror.json");
	await saveRorConfig(config(), file);
	expect(await loadRorConfig(file)).toEqual(config());
	writeFileSync(join(dir, "single.json"), JSON.stringify({ approver: "x", slackServer: "s", tiers: config().tiers }));
	await expect(loadRorConfig(join(dir, "single.json"))).rejects.toThrow('"approvers" needs at least one');

	const bad = join(dir, "bad.json");
	writeFileSync(bad, JSON.stringify({ approvers: ["x"], tiers: [] }));
	await expect(loadRorConfig(bad)).rejects.toThrow('"slackServer" is required');
	await expect(loadRorConfig(join(dir, "missing.json"))).rejects.toThrow("No ready-for-review config");
});

test("self DM looks up the signed-in Slack user and sends one message per chunk", async () => {
	const calls: Array<[string, string, Record<string, unknown>]> = [];
	const fake = async (server: string, tool: string, args: Record<string, unknown>) => {
		calls.push([server, tool, args]);
		if (tool === "slack_read_user_profile") return '{"result":"User ID: U123ABC\\nUsername: me"}';
		return `message_link: "https://example.slack.com/archives/D1/p${calls.length}"\nmessage_context: {}`;
	};
	const links = await sendSelfDm("slack", `a\n\n${"b".repeat(3999)}`, fake);
	expect(calls.map(([, tool, args]) => [tool, args.channel_id])).toEqual([
		["slack_read_user_profile", undefined],
		["slack_send_message", "U123ABC"],
		["slack_send_message", "U123ABC"],
	]);
	expect(links).toEqual(["https://example.slack.com/archives/D1/p2", "https://example.slack.com/archives/D1/p3"]);
	expect(parseMessageLink('{"message_link":"https://x.slack.com/archives/D/p1","ok":true}')).toBe("https://x.slack.com/archives/D/p1");
	expect(parseMessageLink('{"message_link":"https:\\/\\/x.slack.com\\/archives\\/D\\/p1"}')).toBe("https://x.slack.com/archives/D/p1");
	expect(parseMessageLink('{"ok":true}')).toBeUndefined();
});
