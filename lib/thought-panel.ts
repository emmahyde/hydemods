import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

/** Thought lines the panel shows; with its header it is always one row taller. */
export const ThoughtPanelLines = 8;

export interface ThoughtPanelStyle {
 header(text: string): string;
 line(text: string): string;
}

/**
 * The thought panel's rows: a header, then a rolling window of exactly `size` lines. The newest
 * thought's last lines scroll up from the bottom; a short or missing thought is padded with blank
 * rows, so the chrome under the transcript keeps one height for the whole session. A `stale`
 * thought is the last turn's, kept until the new turn thinks rather than collapsing the panel.
 */
export function thoughtPanelRows(text: string, stale: boolean, width: number, style: ThoughtPanelStyle, size = ThoughtPanelLines): string[] {
 const wrapped = text.split("\n").filter(line => line.trim()).flatMap(line => wrapTextWithAnsi(line, Math.max(10, width - 4)));
 const shown = wrapped.slice(-size);
 const earlier = wrapped.length - shown.length;
 const label = !text ? "✻ no thought yet" : stale ? "✻ last thought" : "✻ thinking";
 const header = style.header(`${label}${earlier > 0 ? ` · ${earlier} earlier line${earlier === 1 ? "" : "s"}` : ""}`);
 const rows = shown.map(line => `  ${style.line(line)}`);
 while (rows.length < size) rows.push("");
 return [header, ...rows];
}
