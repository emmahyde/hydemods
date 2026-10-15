import { uriHyperlink } from "@oh-my-pi/pi-tui/render/hyperlink";
import { DRAWER_SCHEMES } from "./drawer-types";

/** `hydemods://open?s=<host>&u=<uri>`: the scheme the macOS handler app forwards to the owning OMP process. */
export const LINK_SCHEME = "hydemods";

/** Bare internal URL token, as it appears in prose or tool output. Trailing punctuation is left out. */
const INTERNAL_URL = new RegExp(`\\b(?:${DRAWER_SCHEMES.join("|")})://[^\\s"'\`()<>\\[\\]]*[^\\s"'\`()<>\\[\\].,;:!?]`, "g");
/** CSI/OSC escape sequences; OSC 8 opens and closes are told apart below so linked text is never relinked. */
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Every internal URL in `text`, in order, without ANSI noise. */
export function findInternalUrls(text: string): string[] {
	return [...text.replace(ESCAPE, "").matchAll(INTERNAL_URL)].map(match => match[0]);
}

/** Click target for `uri` on host `key`. The handler app decodes `u` and connects to `<links dir>/<key>.sock`. */
export function linkTarget(key: string, uri: string): string {
	return `${LINK_SCHEME}://open?s=${encodeURIComponent(key)}&u=${encodeURIComponent(uri)}`;
}

/** Inverse of `linkTarget`; undefined for anything that is not a well-formed open link. */
export function parseLinkTarget(target: string): { key: string; uri: string } | undefined {
	let url: URL;
	try { url = new URL(target.trim()); } catch { return undefined; }
	if (url.protocol !== `${LINK_SCHEME}:` || url.hostname !== "open") return undefined;
	const key = url.searchParams.get("s");
	const uri = url.searchParams.get("u");
	return key && uri ? { key, uri } : undefined;
}

/**
 * Wraps every bare internal URL in `row` in an OSC 8 hyperlink to `target(uri)`. Escape sequences
 * are passed through untouched and text already inside an OSC 8 link is left alone, so the row's
 * visible width and styling never change. `wrap` defaults to pi-tui's policy-aware `uriHyperlink`.
 */
export function linkInternalUrls(row: string, target: (uri: string) => string, wrap: (uri: string, text: string) => string = uriHyperlink): string {
	if (!row.includes("://")) return row;
	let out = "";
	let inLink = false;
	let last = 0;
	const plain = (segment: string) => (inLink ? segment : segment.replace(INTERNAL_URL, uri => wrap(target(uri), uri)));
	for (const match of row.matchAll(ESCAPE)) {
		out += plain(row.slice(last, match.index));
		const sequence = match[0];
		if (sequence.startsWith("\x1b]8;")) inLink = !/^\x1b\]8;;(?:\x07|\x1b\\)$/.test(sequence);
		out += sequence;
		last = match.index + sequence.length;
	}
	return out + plain(row.slice(last));
}

type Rows = { render(width: number): readonly string[]; renderTranscriptStableRows?(count: number, width: number): readonly string[] };

const INSTALLED = Symbol.for("hydemods.internalLinks");

/**
 * Restores the renderers `installInternalLinks` wrapped. Call this before reinstalling any wrapper
 * underneath it (message backgrounds): the links wrapper saved that wrapper as its original, so
 * uninstalling later would resurrect the stale one and drop the fresh one.
 */
export function uninstallInternalLinks(proto: object): void {
	(proto as Record<symbol, (() => void) | undefined>)[INSTALLED]?.();
}

/**
 * Wraps a component prototype's row renderers with `linkInternalUrls`. `target` returning undefined
 * (no handler installed, links off) leaves rows untouched. Reinstalling restores the previous
 * originals first so wrappers never stack across extension reloads.
 */
export function installInternalLinks(
	proto: Rows,
	target: () => ((uri: string) => string) | undefined,
	wrap: (uri: string, text: string) => string = uriHyperlink,
): () => void {
	uninstallInternalLinks(proto);
	const holder = proto as unknown as Record<symbol, (() => void) | undefined>;
	const originals = { render: proto.render, stable: proto.renderTranscriptStableRows };
	const link = (rows: readonly string[]) => {
		const resolve = target();
		return resolve ? rows.map(row => linkInternalUrls(row, resolve, wrap)) : rows;
	};
	proto.render = function(this: Rows, width) { return link(originals.render.call(this, width)); };
	if (originals.stable) proto.renderTranscriptStableRows = function(this: Rows, count, width) { return link(originals.stable!.call(this, count, width)); };
	const uninstall = () => {
		proto.render = originals.render;
		if (originals.stable) proto.renderTranscriptStableRows = originals.stable;
		holder[INSTALLED] = undefined;
	};
	holder[INSTALLED] = uninstall;
	return uninstall;
}

/** Same as `installInternalLinks` for one component instance (tool cards are built per result). */
export function linkComponentRows<T extends { render(width: number): readonly string[] }>(component: T, target: () => ((uri: string) => string) | undefined): T {
	const original = component.render.bind(component);
	component.render = (width: number) => {
		const resolve = target();
		const rows = original(width);
		return resolve ? rows.map(row => linkInternalUrls(row, resolve)) : rows;
	};
	return component;
}
