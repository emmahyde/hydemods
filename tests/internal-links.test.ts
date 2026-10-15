import { describe, expect, test } from "bun:test";
import { findInternalUrls, linkInternalUrls, linkTarget, parseLinkTarget } from "../lib/internal-links";

const target = (uri: string) => `T(${uri})`;
const wrap = (uri: string, text: string) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

describe("findInternalUrls", () => {
	test("finds drawer-scheme URLs and drops trailing punctuation and brackets", () => {
		const text = "see xd://eval/judge, then (omp://tools/find.md) and `vault://notes/a b`. not http://x or foo://bar";
		expect(findInternalUrls(text)).toEqual(["xd://eval/judge", "omp://tools/find.md", "vault://notes/a"]);
	});

	test("ignores ANSI styling around and inside the token", () => {
		expect(findInternalUrls("\x1b[4mproc://\x1b[24mbg_1 done")).toEqual(["proc://bg_1"]);
	});
});

describe("linkTarget", () => {
	test("round-trips through parseLinkTarget with encoded characters", () => {
		const link = linkTarget("ab12", "vault://notes/a b?x=1&y=2");
		expect(parseLinkTarget(link)).toEqual({ key: "ab12", uri: "vault://notes/a b?x=1&y=2" });
		expect(parseLinkTarget(`${link}\n`)).toEqual({ key: "ab12", uri: "vault://notes/a b?x=1&y=2" });
	});

	test("rejects foreign or incomplete links", () => {
		expect(parseLinkTarget("https://example.com/open?s=a&u=b")).toBeUndefined();
		expect(parseLinkTarget("hydemods://open?s=a")).toBeUndefined();
		expect(parseLinkTarget("hydemods://close?s=a&u=b")).toBeUndefined();
		expect(parseLinkTarget("not a url")).toBeUndefined();
	});
});

describe("linkInternalUrls", () => {
	test("wraps bare internal URLs and leaves other text alone", () => {
		expect(linkInternalUrls("read xd://eval/judge now", target, wrap)).toBe(`read ${wrap("T(xd://eval/judge)", "xd://eval/judge")} now`);
		expect(linkInternalUrls("plain row", target, wrap)).toBe("plain row");
		expect(linkInternalUrls("https://example.com", target, wrap)).toBe("https://example.com");
	});

	test("passes escape sequences through and keeps styling intact", () => {
		const row = "\x1b[36mxd://a\x1b[39m and \x1b[1momp://b.md\x1b[22m";
		expect(linkInternalUrls(row, target, wrap)).toBe(`\x1b[36m${wrap("T(xd://a)", "xd://a")}\x1b[39m and \x1b[1m${wrap("T(omp://b.md)", "omp://b.md")}\x1b[22m`);
	});

	test("never relinks text already inside an OSC 8 hyperlink", () => {
		const linked = `${wrap("file:///tmp/x", "proc://bg_1")} then proc://bg_2`;
		expect(linkInternalUrls(linked, target, wrap)).toBe(`${wrap("file:///tmp/x", "proc://bg_1")} then ${wrap("T(proc://bg_2)", "proc://bg_2")}`);
		const bel = `\x1b]8;;file:///y\x07omp://z\x1b]8;;\x07`;
		expect(linkInternalUrls(bel, target, wrap)).toBe(bel);
	});
});
