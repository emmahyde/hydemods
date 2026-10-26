import { truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { stripControls } from "./eval-summary";

/** Content rows; the header occupies one additional row. */
export const ThoughtPanelLines = 3;
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

export interface ThoughtPanelStyle {
 header(text: string): string;
 line(text: string): string;
}

/** Preserve the original opening and current ending, including an unfinished streaming sentence. */
function excerpt(text: string): string {
 const clean = stripControls(text).replace(/\s+/g, " ").trim();
 let first = "";
 let last = "";
 let count = 0;
 for (const { segment } of sentences.segment(clean)) {
  const sentence = segment.trim();
  if (!sentence) continue;
  if (!count++) first = sentence;
  last = sentence;
 }
 return count < 2 ? first : `${first}${count > 2 ? " ... " : " "}${last}`;
}

/** Collapsed excerpts reserve three content rows; expansion shows the original thought. */
export function thoughtPanelRows(text: string, stale: boolean, width: number, style: ThoughtPanelStyle, expanded = false): string[] {
 const indent = " ".repeat(Math.min(2, Math.max(0, width - 1)));
 const room = Math.max(1, width - indent.length);
 const source = expanded ? stripControls(text) : excerpt(text);
 const wrapped = source.split("\n").filter(line => line.trim()).flatMap(line => wrapTextWithAnsi(line, room));
 const shown = expanded ? wrapped : wrapped.slice(0, ThoughtPanelLines);
 if (!expanded && wrapped.length > ThoughtPanelLines) {
  const dots = ".".repeat(Math.min(3, room));
  shown[ThoughtPanelLines - 1] = `${truncateToWidth(shown[ThoughtPanelLines - 1]!, Math.max(0, room - dots.length), "")}${dots}`;
 }
 const label = !text ? "✻ no thought yet" : stale ? "✻ last thought" : "✻ thinking";
 const header = style.header(truncateToWidth(`${label}${text ? expanded ? " · Ctrl+O collapse" : " · Ctrl+O full thought" : ""}`, Math.max(1, width)));
 const rows = shown.map(line => `${indent}${style.line(line)}`);
 while (rows.length < ThoughtPanelLines) rows.push("");
 return [header, ...rows];
}
