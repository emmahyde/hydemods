/**
 * Detects a streaming `edit` call that has degenerated into repeating apply_patch markers
 * ("*** End Patch" thousands of times until the output cap). The hashline edit format never
 * contains these markers, so a few of them, or an implausibly large input, mean a runaway.
 */
const MARKER = "*** End Patch";
const MAX_MARKERS = 3;
const MAX_CHARS = 96 * 1024;

export type RunawayEdit = { markers: number; kb: number };

export function runawayEdit(parts: ReadonlyArray<{ type: string; name?: string; arguments?: unknown }>): RunawayEdit | undefined {
 for (const part of parts) {
  if (part.type !== "toolCall" || part.name !== "edit" || !part.arguments || typeof part.arguments !== "object" || !("input" in part.arguments)) continue;
  const input = part.arguments.input;
  if (typeof input !== "string") continue;
  const markers = input.split(MARKER).length - 1;
  if (markers >= MAX_MARKERS || input.length >= MAX_CHARS) return { markers, kb: Math.round(input.length / 1024) };
 }
 return undefined;
}
