/**
 * Copies of OMP internals that the extension loader does not expose.
 *
 * An extension can only import `@oh-my-pi/*` specifiers the running host maps into its module table; any
 * other subpath fails to resolve and the whole extension is rejected ("Cannot find package ..."). These
 * helpers live in unmapped modules (`pi-tui/tools/read`, `pi-tui/tools/default-renderer`), so they are
 * reproduced here from OMP v18.4.3. Everything they need is imported from mapped entry points.
 */
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatOutputPaneLines, plainToolCard, styleToolOutputLine, type StatusLineOptions, type ToolCardPhase } from "@oh-my-pi/pi-tui/render";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { RenderResultOptions } from "@oh-my-pi/pi-tui/tools";

/* ------------------------- packages/tui/src/tools/read.ts ------------------------- */

// Line-range selector grammar: `N`, `N-M`, `N-`, `N+K`, `N..M`, optional `L` prefixes, comma lists.
const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;
// Path splitting only peels complete selectors (not a trailing `+` or `L`).
const RANGE_SELECTOR_CHUNK = `${LINE_RANGE_CHUNK_SOURCE}(?<=[\\d.-])`;
const RANGE_LIST_SRC = `${RANGE_SELECTOR_CHUNK}(?:,${RANGE_SELECTOR_CHUNK})*`;
const TAIL_CHUNK_SRC = String.raw`-\d+`;
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC}|raw|conflicts|img)$`, "i");
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC})$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;

/** Split a filesystem path from its trailing read selector (`src/a.ts:10-20` -> `src/a.ts`, `10-20`). */
export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
 const colon = rawPath.lastIndexOf(":");
 if (colon <= 0) return { path: rawPath };

 const candidate = rawPath.slice(colon + 1);
 if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };

 let basePath = rawPath.slice(0, colon);
 let sel = candidate;

 // A compound trailing selector is one line range (or tail) plus one `raw`, in either order.
 const innerColon = basePath.lastIndexOf(":");
 if (innerColon > 0) {
  const innerCandidate = basePath.slice(innerColon + 1);
  const innerIsRaw = FILE_RAW_ONLY_RE.test(innerCandidate);
  const outerIsRaw = FILE_RAW_ONLY_RE.test(candidate);
  const innerIsRange = FILE_LINE_RANGE_ONLY_RE.test(innerCandidate);
  const outerIsRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
  if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
   sel = `${innerCandidate}:${candidate}`;
   basePath = basePath.slice(0, innerColon);
  }
 }

 return { path: basePath, sel };
}

/** The filesystem path a read result came from, when its source was a plain path. */
export function readSourceFsPath(details: { meta?: { source?: { type?: unknown; value?: unknown } } } | undefined): string | undefined {
 const source = details?.meta?.source;
 return source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
}

/* ------------------- packages/tui/src/tools/default-renderer.ts ------------------- */

export interface FallbackToolRenderInput {
 label: string;
 args: unknown;
 result?: { output: string; isError?: boolean };
 options: RenderResultOptions;
}

/**
 * OMP's generic tool card, trimmed to the plain-text path: status line, a one-line argument preview when
 * collapsed, and the output pane. The host version also draws JSON trees from `tools/json-tree` (unmapped);
 * here JSON args and output render as text instead.
 */
export function renderFallbackToolCard(input: FallbackToolRenderInput, uiTheme: Theme) {
 const { options, result } = input;
 const status: StatusLineOptions = {
  icon: options.isPartial ? (options.spinnerFrame !== undefined ? "running" : "pending") : result?.isError ? "error" : "done",
  spinnerFrame: options.spinnerFrame,
  title: input.label,
 };
 const phase: ToolCardPhase = options.isPartial ? (options.spinnerFrame !== undefined ? "running" : "partial") : result?.isError ? "error" : "success";

 return plainToolCard(
  uiTheme,
  ({ contentWidth }) => {
   const body: string[] = [];
   const args = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? input.args : undefined;
   if (!options.expanded && args && Object.keys(args).length > 0) {
    const budget = Math.max(20, contentWidth - Bun.stringWidth(uiTheme.tree.last) - 2);
    body.push(` ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("dim", truncateToWidth(JSON.stringify(args), budget))}`);
   }
   if (result) {
    const text = result.output.trimEnd();
    if (!text) {
     body.push(uiTheme.fg("dim", "(no output)"));
    } else {
     body.push(
      ...formatOutputPaneLines(
       {
        lines: text.split("\n"),
        expanded: options.expanded,
        collapsedMaxLines: 4,
        expandedMaxLines: 12,
        styleLine: (line) => truncateToWidth(styleToolOutputLine(line, uiTheme), contentWidth),
        showExpandHintWhenUncapped: true,
       },
       uiTheme,
      ).lines,
     );
    }
   }
   return { status, phase, body };
  },
  { paddingX: 1, paddingY: 1, ignoreTight: true },
 );
}
