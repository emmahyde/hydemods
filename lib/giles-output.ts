import { decode, encode } from '@toon-format/toon';

export interface GilesEnvelope {
  kind: string;
  action?: string;
  content: unknown;
}

/** The adapter's TOON envelope, or undefined for any other text. Nothing inside `content` is rewritten. */
export function gilesEnvelope(text: string): GilesEnvelope | undefined {
  if (!text.startsWith('application: Giles\n')) return undefined;
  try {
    const value = decode(text) as Record<string, unknown>;
    if (value.application !== 'Giles' || typeof value.kind !== 'string' || !('content' in value)) return undefined;
    return { kind: value.kind, ...(typeof value.action === 'string' ? { action: value.action } : {}), content: value.content };
  } catch { return undefined; }
}

/** Encode presentation only. Strings are never parsed as data or rewritten. Existing envelopes pass through unchanged. */
export function gilesOutput(kind: string, content: unknown): string {
  if (typeof content === 'string' && gilesEnvelope(content)) return content;
  return encode({ application: 'Giles', kind, content });
}

/** The original source text of an envelope whose content is a string; any other text is returned as it is. */
export function gilesSource(text: string): string {
  const envelope = gilesEnvelope(text);
  return typeof envelope?.content === 'string' ? envelope.content : text;
}

type Block = { type: string; text?: string };

/** Message content as one string: a string itself, or its text blocks joined by newlines. */
export function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block: Block) => block?.type === 'text' && typeof block.text === 'string').map((block: Block) => block.text).join('\n');
}

/**
 * Wrap message content for the model without touching what is already wrapped. Each text block becomes
 * one envelope holding its exact source string; image and other blocks are carried over unchanged.
 */
export function gilesWrapContent<T>(kind: string, content: T): T {
  if (typeof content === 'string') return gilesOutput(kind, content) as T;
  if (!Array.isArray(content)) return content;
  return content.map((block: Block) => block?.type === 'text' && typeof block.text === 'string' ? { ...block, text: gilesOutput(kind, block.text) } : block) as T;
}
