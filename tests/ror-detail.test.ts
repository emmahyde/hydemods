import { expect, test } from "bun:test";
import { formatRorReport, type PrDetail } from "../lib/ror-detail";
import type { MyPr } from "../lib/url-drawers";

const approvers = ["review-bot"];
const HEAD = "bbbbbbbbbb";

const pr = (over: Partial<MyPr>): MyPr => ({
	number: 7,
	title: "fix things",
	url: "https://github.com/acme/app/pull/7",
	repo: "acme/app",
	isDraft: false,
	ci: "pass",
	unresolvedThreads: 0,
	mergeable: "clean",
	approved: null,
	reviews: [{ login: "review-bot", state: "APPROVED", onHead: true }],
	additions: 0,
	deletions: 0,
	changedFiles: 0,
	...over,
});

const thread = (id: string, isResolved: boolean, comments: number) => ({
	id,
	isResolved,
	path: "app/x.rb",
	line: 12,
	first: { totalCount: comments, nodes: [{ author: { login: "alice" }, body: "Please\n  rename   this", url: `https://c/${id}/1` }] },
	last: { nodes: [{ author: { login: "bob" }, url: `https://c/${id}/last` }] },
});

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
	baseRefName: "main",
	headRefOid: HEAD,
	reviewThreads: { nodes: [] },
	latestReviews: { nodes: [{ state: "APPROVED", body: "", url: "https://r/bot", author: { login: "review-bot" }, commit: { oid: HEAD } }] },
	commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
	...over,
});

test("a ready PR is one settled line with its link", () => {
	expect(formatRorReport(pr({}), detail(), approvers)).toEqual({ settled: true, fingerprint: "ROR", lines: ["acme/app#7 fix things -> ROR https://github.com/acme/app/pull/7"] });
});

test("a blocked PR lists each failing check, unresolved thread, change request and stale approval with links", () => {
	const report = formatRorReport(
		pr({ ci: "fail", unresolvedThreads: 1, reviews: [{ login: "review-bot", state: "APPROVED", onHead: false }, { login: "carol", state: "CHANGES_REQUESTED", onHead: true }] }),
		detail({
			reviewThreads: { nodes: [thread("t1", false, 3), thread("t2", true, 1)] },
			latestReviews: {
				nodes: [
					{ state: "APPROVED", body: "", url: "https://r/bot", author: { login: "review-bot" }, commit: { oid: "aaaaaaaaaa" } },
					{ state: "CHANGES_REQUESTED", body: "### High risk &nbsp; | &nbsp; needs **a** `test`", url: "https://r/carol", author: { login: "carol" }, commit: { oid: HEAD } },
				],
			},
			commits: {
				nodes: [
					{
						commit: {
							statusCheckRollup: {
								contexts: {
									nodes: [
										{ __typename: "CheckRun", name: "rspec", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/rspec" },
										{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/lint" },
										{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
										{ __typename: "StatusContext", context: "deploy", state: "ERROR", targetUrl: "https://ci/deploy" },
									],
								},
							},
						},
					},
				],
			},
		}),
		approvers,
	);
	expect(report.settled).toBe(false);
	expect(report.lines).toEqual([
		"acme/app#7 fix things -> not ROR: CI fail, 1 unresolved thread, changes requested, approval is on an older commit https://github.com/acme/app/pull/7",
		"  - CI failure: rspec https://ci/rspec",
		"  - CI error: deploy https://ci/deploy",
		"  - CI pending: build",
		'  - unresolved thread on app/x.rb:12 by @alice: "Please rename this" https://c/t1/1 (3 comments, last by @bob https://c/t1/last)',
		'  - changes requested by @carol: "High risk needs a `test`" https://r/carol',
		"  - @review-bot approved aaaaaaa, head is now bbbbbbb https://r/bot",
	]);
});

test("the fingerprint moves when a new blocker appears but not when a pending check finishes", () => {
	const blocked = pr({ ci: "pending", unresolvedThreads: 1 });
	const withChecks = (names: string[]) =>
		detail({
			reviewThreads: { nodes: [thread("t1", false, 1)] },
			commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: names.map((name) => ({ __typename: "CheckRun" as const, name, status: "QUEUED", conclusion: null, detailsUrl: null })) } } } }] },
		});
	const before = formatRorReport(blocked, withChecks(["a", "b"]), approvers).fingerprint;
	expect(formatRorReport(blocked, withChecks(["b"]), approvers).fingerprint).toBe(before);
	const newThread = detail({ ...withChecks(["b"]), reviewThreads: { nodes: [thread("t1", false, 1), thread("t9", false, 1)] } });
	expect(formatRorReport(pr({ ci: "pending", unresolvedThreads: 2 }), newThread, approvers).fingerprint).not.toBe(before);
});
