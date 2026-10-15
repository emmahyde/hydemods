import { describe, expect, test } from "bun:test";
import { findInternalUrls, installInternalLinks, linkInternalUrls, linkTarget, parseLinkTarget, uninstallInternalLinks } from "../lib/internal-links";
import { installMessageBackgrounds, type ThemeLookups } from "../lib/message-bg";

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

describe("installInternalLinks over installMessageBackgrounds (extension reload)", () => {
	// Mirrors ensureBackgrounds in index.ts: backgrounds wrap first, links on top. A reload runs the
	// same sequence again in the same process against the same prototypes.
	type Proto = { render(width: number): readonly string[]; renderTranscriptStableRows(count: number, width: number): readonly string[] };
	const theme = (): ThemeLookups => ({
		getBgHex: () => "#000000",
		getBgAnsi: () => "",
		getColorMode: () => "truecolor" as never,
		bg: (_c, text) => text,
		bgFill: (_c, text) => text,
	});
	const generation = (t: ThemeLookups, proto: Proto, calls: string[], name: string, peelLinksFirst: boolean) => {
		if (peelLinksFirst) uninstallInternalLinks(proto);
		installMessageBackgrounds(t, proto, {
			hexFor: () => {
				calls.push(`bg:${name}`);
				return undefined;
			},
			liveTheme: () => t,
		});
		installInternalLinks(
			proto,
			() => {
				calls.push(`links:${name}`);
				return target;
			},
			wrap,
		);
	};
	const reloadTwice = (peelLinksFirst: boolean) => {
		const t = theme();
		const original = (width: number) => [`xd://a ${width}`];
		const proto: Proto = { render: original, renderTranscriptStableRows: (_n, width) => original(width) };
		const calls: string[] = [];
		generation(t, proto, calls, "one", peelLinksFirst);
		generation(t, proto, calls, "two", peelLinksFirst);
		calls.length = 0;
		const rows = proto.render.call({ message: { role: "assistant" } }, 40);
		return { calls: calls.sort(), rows, proto, original };
	};

	test("peeling the links wrapper first leaves exactly one wrapper of each at the current generation", () => {
		const { calls, rows, proto, original } = reloadTwice(true);
		expect(rows[0]).toContain(wrap("T(xd://a)", "xd://a"));
		expect(calls).toEqual(["bg:two", "links:two"]);
		uninstallInternalLinks(proto);
		expect(proto.render).not.toBe(original); // generation-two backgrounds wrapper still underneath
		expect(proto.render.call({ message: { role: "assistant" } }, 40)).toEqual(["xd://a 40"]);
	});

	test("without peeling, the stale generation-one backgrounds wrapper comes back (the bug)", () => {
		expect(reloadTwice(false).calls).toEqual(["bg:one", "links:two"]);
	});
});
