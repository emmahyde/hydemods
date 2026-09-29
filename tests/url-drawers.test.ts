import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prCompletions, prStatusCells, toMyPr, vaultCompletions, withPrDrawer, withVaultDrawer, type EditorProvider, type GqlPr, type MyPr } from "../lib/url-drawers";

const pr = (over: Partial<MyPr>): MyPr => ({ number: 1, title: "t", repo: "o/r", isDraft: false, ci: "pass", unresolvedThreads: 0, mergeable: "clean", approved: null, ...over });

const gql = (over: Partial<GqlPr> = {}): GqlPr => ({
	number: 7,
	title: "t",
	isDraft: false,
	mergeable: "MERGEABLE",
	repository: { nameWithOwner: "o/r", owner: { login: "o" } },
	reviewThreads: { nodes: [] },
	latestReviews: { nodes: [] },
	commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	...over,
});

test("vault drawer lists folders before notes, hides dotfiles, and percent-encodes spaces", async () => {
	const root = mkdtempSync(join(tmpdir(), "vault-"));
	mkdirSync(join(root, "Deep Notes"));
	mkdirSync(join(root, ".obsidian"));
	writeFileSync(join(root, "alpha.md"), "");
	writeFileSync(join(root, "data.csv"), "");
	const roots = new Map([["my vault", root]]);

	const result = await vaultCompletions("vault://my%20vault/", roots);
	expect(result?.items.map((i) => i.value)).toEqual(["vault://my%20vault/Deep%20Notes/", "vault://my%20vault/alpha.md", "vault://my%20vault/data.csv"]);
	expect(result?.items.map((i) => i.description)).toEqual(["folder", "note", "file"]);

	// Typing a dot opts in to hidden entries, which then outrank names that merely contain a dot.
	expect((await vaultCompletions("vault://my%20vault/.", roots))?.items[0]?.label).toBe(".obsidian/");
});

test("vault drawer ranks prefix above substring and refuses to leave the vault root", async () => {
	const root = mkdtempSync(join(tmpdir(), "vault-"));
	writeFileSync(join(root, "daily.md"), "");
	writeFileSync(join(root, "my-daily.md"), "");
	const roots = new Map([["v", root]]);

	expect((await vaultCompletions("vault://v/da", roots))?.items.map((i) => i.label)).toEqual(["daily.md", "my-daily.md"]);
	expect(await vaultCompletions("vault://v/../", roots)).toBeNull();
	expect(await vaultCompletions("vault://v/%2e%2e/", roots)).toBeNull();
	expect(await vaultCompletions("vault://missing/", roots)).toBeNull();
});

test("pr drawer filters by number prefix, owner/repo path, and title text", () => {
	const prs = [
		pr({ number: 714, repo: "acme/app", title: "Fix sweep bug" }),
		pr({ number: 12, repo: "acme/tool", title: "Add flag" }),
		pr({ number: 1300, repo: "acme/tool", title: "Bump" }),
	];
	const values = (token: string) => prCompletions(token, prs)?.items.map((i) => i.value);

	expect(values("pr://")).toEqual(["pr://acme/app/714", "pr://acme/tool/12", "pr://acme/tool/1300"]);
	expect(values("pr://71")).toEqual(["pr://acme/app/714"]);
	expect(values("pr://acme/tool/1")).toEqual(["pr://acme/tool/12", "pr://acme/tool/1300"]);
	expect(values("pr://SWEEP")).toEqual(["pr://acme/app/714"]);
	expect(values("pr://nothing")).toBeUndefined();
});

test("status maps CI rollup states and counts only unresolved threads", () => {
	const ci = (state: string | null) => toMyPr(gql({ commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } }), undefined).ci;
	expect([ci("SUCCESS"), ci("FAILURE"), ci("ERROR"), ci("PENDING"), ci("EXPECTED"), ci(null)]).toEqual(["pass", "fail", "fail", "pending", "pending", "none"]);

	const threads = toMyPr(gql({ reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] } }), undefined);
	expect(threads.unresolvedThreads).toBe(2);
	expect(toMyPr(gql({ mergeable: "CONFLICTING" }), undefined).mergeable).toBe("conflicts");
	expect(toMyPr(gql({ mergeable: "UNKNOWN" }), undefined).mergeable).toBe("unknown");
});

test("approval column appears only when an approver is configured and matches the latest approving reviewer", () => {
	const reviews = { latestReviews: { nodes: [{ state: "APPROVED", author: { login: "Review-Bot" } }, { state: "COMMENTED", author: { login: "alice" } }] } };
	const approver = /^review-bot$/i;

	expect(toMyPr(gql(reviews), undefined).approved).toBeNull();
	expect(toMyPr(gql(reviews), approver).approved).toBe(true);
	expect(toMyPr(gql({ latestReviews: { nodes: [{ state: "COMMENTED", author: { login: "review-bot" } }] } }), approver).approved).toBe(false);
	expect(toMyPr(gql({ latestReviews: { nodes: [{ state: "APPROVED", author: null }] } }), approver).approved).toBe(false);

	expect(prStatusCells(pr({ approved: null }))).toEqual(["✓ CI", "✓ threads", "✓ mergeable"]);
	expect(prStatusCells(pr({ approved: true, ci: "fail", unresolvedThreads: 3, mergeable: "conflicts" }))).toEqual(["✗ CI", "✗ 3 unresolved", "✗ conflicts", "✓ approved"]);
});

test("pr rows keep full titles, align every column, and survive OMP's whitespace collapsing", () => {
	const prs = [
		pr({ number: 1411, title: "refactor(github): replace GitHub event labels with stable keys", unresolvedThreads: 1 }),
		pr({ number: 7, title: "short", repo: "acme/longer-repo" }),
	];
	const labels = (width: number) => prCompletions("pr://", prs, width)?.items.map((i) => i.label) ?? [];
	// What OMP's select list does to a label before drawing it.
	const drawn = (label: string) => label.replace(/\s+/g, " ");

	const wide = labels(200).map(drawn);
	expect(wide[0]).toContain("replace GitHub event labels with stable keys");
	expect(wide[1].indexOf("acme/longer-repo")).toBe(wide[0].indexOf("o/r"));
	for (const cell of ["CI", "mergeable"]) expect(wide[1].indexOf(cell)).toBe(wide[0].indexOf(cell));

	// Narrow terminals cut the title, never the status, and every row still fits.
	const narrow = labels(80);
	expect(narrow[0]).toContain("…");
	expect(narrow.every((l) => Bun.stringWidth(l) <= 76 && l.endsWith("mergeable"))).toBe(true);
});

const inner = (): EditorProvider & { calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		getSuggestions: async () => {
			calls.push("suggest");
			return null;
		},
		applyCompletion: (lines, cursorLine, cursorCol) => {
			calls.push("apply");
			return { lines, cursorLine, cursorCol };
		},
	};
};

test("a disabled drawer defers to the wrapped provider, and other text is never intercepted", async () => {
	const off = inner();
	await withVaultDrawer(off, () => false).getSuggestions(["vault://"], 0, 8);
	await withPrDrawer(off, () => false).getSuggestions(["pr://"], 0, 5);
	expect(off.calls).toEqual(["suggest", "suggest"]);

	const on = inner();
	await withVaultDrawer(on, () => true).getSuggestions(["read src/file"], 0, 13);
	await withPrDrawer(on, () => true).getSuggestions(["see #123"], 0, 8);
	expect(on.calls).toEqual(["suggest", "suggest"]);
});

test("picking a vault folder keeps the cursor inside the URL; a file or PR ends the token with a space", () => {
	const line = "open vault://v/Fo";
	const vault = withVaultDrawer(inner(), () => true);
	expect(vault.applyCompletion([line], 0, line.length, { value: "vault://v/Folder/", label: "Folder/" }, "vault://v/Fo")).toEqual({ lines: ["open vault://v/Folder/"], cursorLine: 0, cursorCol: 22 });
	expect(vault.applyCompletion([line], 0, line.length, { value: "vault://v/Fo.md", label: "Fo.md" }, "vault://v/Fo").lines).toEqual(["open vault://v/Fo.md "]);

	const prLine = "review pr://7 please";
	const prs = withPrDrawer(inner(), () => true);
	// Cursor sits right after the token; text following it is preserved.
	expect(prs.applyCompletion([prLine], 0, 13, { value: "pr://o/r/7", label: "#7" }, "pr://7")).toEqual({ lines: ["review pr://o/r/7  please"], cursorLine: 0, cursorCol: 18 });
});
