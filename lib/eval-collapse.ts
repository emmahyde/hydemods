import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { outputBlockContentWidth } from "@oh-my-pi/pi-tui/render";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { cappedRenderPayload, collapseTextLines } from "./tool-output";

type Result = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };
type Cell = { output: string; hasMarkdown?: boolean; status?: string };
type Options = { expanded: boolean; limit: number; width?: number; theme: Theme; output?: string };

/** Reserve the fold glyph even when a content row reaches the right edge. */
export function fitCollapseLine(line: string, width: number): string {
	const match = /^(.*?)(\s+(?:\x1b\[[0-9;]*m)*(?:\[\.\.\.\]|⋯\d*)(?:\x1b\[[0-9;]*m)*)$/.exec(line);
	if (!match) return truncateToWidth(line, width);
	const marker = match[2];
	if (visibleWidth(marker) >= width) return truncateToWidth("[...]", width);
	return truncateToWidth(match[1].trimEnd(), width - visibleWidth(marker)) + marker;
}

/** Shorten cloned output only; the original result remains the expansion source. */
export function compactEvalResult<T extends Result>(result: T, options: Options): T {
	if (options.output !== undefined) result = { ...result, content: [{ type: "text", text: options.output }, ...result.content.filter(block => block.type !== "text")] };
	if (options.expanded) return result;
	const width = options.width === undefined ? undefined : outputBlockContentWidth(options.width);
	const compact = (output: string, markdown = false): string => {
		if (cappedRenderPayload(output) === undefined) return output;
		const rows = markdown && width !== undefined
			? new Markdown(output, 0, 0, getMarkdownTheme()).render(width)
			: output.split(/\r?\n/).flatMap(line => width === undefined ? [line] : wrapTextWithAnsi(line.replace(/\t/g, "  "), width));
		const shown = collapseTextLines([...rows], options.limit, false, { marker: () => options.theme.fg("dim", "[...]") });
		return shown.map(line => width === undefined ? line : fitCollapseLine(line, width)).join("\n");
	};
	const details = result.details as { cells?: Cell[] } | undefined;
	if (details?.cells?.length) return { ...result, details: { ...details,
		cells: details.cells.map(cell => ({ ...cell,
			output: compact(cell.output, cell.hasMarkdown === true && cell.status !== "error"),
			...(options.width !== undefined && cappedRenderPayload(cell.output) !== undefined ? { hasMarkdown: false } : {}),
		})),
	} };
	return { ...result, content: result.content.map(block => block.type === "text" && typeof block.text === "string"
		? { ...block, text: compact(block.text) } : block) };
}
