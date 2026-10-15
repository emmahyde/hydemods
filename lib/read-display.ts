// Display-only presentation of a file excerpt a Read returned. Nothing here touches the
// result handed to the model: it takes strings in and returns new ones.
import { extensionOf, stripComments, stripLineNumbers } from "./source-text";

// `[path#<snapshot>]` on the first line. The snapshot token is hex of either case.
const SNAPSHOT_HEADER = /^\[([^\]#\r\n]+)#[\da-f]+\]\r?(?:\n|$)/i;

export type ReadExcerptInput = {
	/** Model-facing result text, possibly starting with a snapshot header. */
	text: string;
	/** Host display metadata; preferred over `text` for the body when present. */
	displayContent?: { text: string };
	/** Requested file path without its selector. */
	path?: string;
	/** Requested selector (`664-687`), shown only in the bracket header. */
	selector?: string;
	/** True when the surrounding row already names the file. */
	filenameShown: boolean;
};

export type ReadExcerptDisplay = {
	/** `[path:selector]`, or `[path]` without a selector; absent when the file is already named. */
	header?: string;
	/** Source without snapshot header, line-number gutter or comment-only lines. */
	body: string;
};

export function presentReadExcerpt(input: ReadExcerptInput): ReadExcerptDisplay {
	const source = (input.displayContent?.text ?? input.text).replace(/\r\n/g, "\n");
	const sourceHeader = SNAPSHOT_HEADER.exec(source);
	const path = input.path ?? sourceHeader?.[1] ?? SNAPSHOT_HEADER.exec(input.text)?.[1];
	const rest = sourceHeader ? source.slice(sourceHeader[0].length) : source;
	const body = stripComments(stripLineNumbers(rest, 1).text, path ? extensionOf(path) : undefined);
	if (input.filenameShown || !path) return { body };
	return { header: `[${path}${input.selector ? `:${input.selector}` : ""}]`, body };
}
