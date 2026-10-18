// Fenced blocks with no language tag are the ones the host leaves unhighlighted: ASCII mockups,
// logs, diagrams. They render as indented plain text between two grey fence rows, so they blend
// into the prose around them. This tints their body rows and hangs a green bar on the left.

const FENCE = /^```(\S*)\s*$/;
const SGR = /\x1b\[[0-9;]*m/g;
const BAR = "\x1b[38;2;156;219;117m▎\x1b[39m";

/** Whether each row is the body of an untagged fenced block, judged from the rendered rows. */
export function plainBlockRows(rows: readonly string[]): boolean[] {
	const body = new Array<boolean>(rows.length).fill(false);
	let open: "tagged" | "plain" | undefined;
	for (const [index, row] of rows.entries()) {
		const text = row.replace(SGR, "").trimEnd();
		const fence = FENCE.exec(text);
		if (!open) {
			if (fence) open = fence[1] ? "tagged" : "plain";
			continue;
		}
		if (text === "```") { open = undefined; continue; }
		if (open === "plain") body[index] = true;
	}
	return body;
}

/**
 * `rows` with the body of every untagged fenced block on a `tint` background (full width) and a
 * left bar in place of the first indent column. Rows are returned unchanged when none exist.
 */
export function stylePlainBlocks(rows: readonly string[], width: number, tint: string, visible: (row: string) => number): readonly string[] {
	const body = plainBlockRows(rows);
	if (!body.includes(true)) return rows;
	return rows.map((row, index) => {
		if (!body[index]) return row;
		// The host indents code by two columns; a bar takes that place, or is added when it did not indent.
		const barred = row.startsWith("  ") ? `${BAR} ${row.slice(2)}` : `${BAR} ${row}`;
		const pad = " ".repeat(Math.max(0, width - visible(barred)));
		// The tint resumes after every reset inside the row, or colored text would cut it short.
		return `${tint}${barred.replace(/\x1b\[(?:0|49)?m/g, `$&${tint}`)}${pad}\x1b[49m`;
	});
}
