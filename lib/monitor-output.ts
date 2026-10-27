import { Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeTerminalText } from "./tool-output";

/** Collapse physical rows, not source lines: long log records must not fill the screen. */
export function monitorOutputComponent(heading: string, output: string, expanded: boolean) {
	const lines = sanitizeTerminalText(output).split("\n");
	return {
		render(width: number): string[] {
			const room = Math.max(1, width - 2);
			const header = ` ${truncateToWidth(heading, room)}`;
			if (expanded) return [header, ...new Text(lines.join("\n"), 1, 0).render(width)];
			// len=0: no body; len=1: one row; len=3: three rows; overflow folds after six.
			const body = output ? lines.slice(0, 6).map(line => ` ${truncateToWidth(line, room)}`) : [];
			const folded = lines.length > 6 || lines.some(line => truncateToWidth(line, room) !== line);
			return [header, ...body, ...(folded ? [` ${truncateToWidth("… more (Ctrl+O)", room)}`] : [])];
		},
		invalidate() {},
	};
}
