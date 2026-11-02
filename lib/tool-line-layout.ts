import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

/** A nine-cell tool prefix, a title, and an optional subject docked to the right edge. */
export function formatToolLine(prefix: string, title: string, subject: string | undefined, width: number): string {
	width = Math.max(0, Math.floor(width));
	if (width === 0) return "";

	const prefixWidth = Math.min(9, width);
	const shownPrefix = truncateToWidth(prefix, prefixWidth, "");
	const paddedPrefix = shownPrefix + " ".repeat(prefixWidth - visibleWidth(shownPrefix));
	const contentRoom = width - prefixWidth - 2;
	if (contentRoom <= 0) return shownPrefix.trimEnd();

	if (!subject) {
		const shownTitle = truncateToWidth(title, contentRoom).trimEnd();
		return shownTitle ? `${paddedPrefix}  ${shownTitle}` : shownPrefix.trimEnd();
	}

	// Keep the subject intact until even removing the title cannot make it fit.
	let shownSubject = truncateToWidth(subject, contentRoom);
	for (const close of ["\x1b]8;;\x07", "\x1b]8;;\x1b\\"]) {
		if (subject.includes(close) && shownSubject.includes("\x1b]8;") && !shownSubject.includes(close)) {
			shownSubject += close;
		}
	}
	const subjectWidth = visibleWidth(shownSubject);
	const titleRoom = width - prefixWidth - subjectWidth - 4;
	const shownTitle = titleRoom > 0 ? truncateToWidth(title, titleRoom).trimEnd() : "";
	const left = shownTitle ? `${paddedPrefix}  ${shownTitle}` : paddedPrefix;
	return left + " ".repeat(width - visibleWidth(left) - subjectWidth) + shownSubject;
}
