import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@oh-my-pi/pi-tui';
import type { Component } from '@oh-my-pi/pi-tui';
import { getMarkdownTheme, type Theme } from '@oh-my-pi/pi-tui/theme';
import { stripControls } from './eval-summary';
import { blocksText, gilesEnvelope } from './giles-output';

// Verified against OMP's bundled Nerd Fonts catalog: nf-md-glasses, nf-md-book_open_page_variant,
// nf-md-comment_text_outline, nf-md-alert_outline, nf-md-chip.
const NerdSymbols = { mark: '\u{f02aa}', sources: '\u{f05da}', status: '\u{f0189}', alert: '\u{f002a}', model: '\u{f061a}' };
const AsciiSymbols = { mark: 'G', sources: '[src]', status: '[i]', alert: '[!]', model: '[m]' };

const Failure = /\b(?:error|failed|failure|blocked)\b|\u26a0|\u2717/i;
const MessageType = /^(?:giles|librarian|wiki)-(recall-context|session-notice|status)$/;
/** Custom message types that only feed the widget; the model never sees them. */
export const GilesStatusType = /^(?:giles|librarian|wiki)-status$/;

export interface GilesStatusRow {
  /** The status string exactly as the adapter sent it. */
  text: string;
  failure: boolean;
  model?: string;
  retrieval?: string;
  actions?: number;
  state?: string;
  recalled?: number;
}

export interface GilesSummary {
  model?: string;
  retrieval?: string;
  actions?: number;
  /** Lines describing the current action or outcome; failures keep their complete text. */
  states: { text: string; failure: boolean }[];
  failure: boolean;
  recalled?: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Fields a status string carries. Structured payload fields, when present, take precedence. */
function parseStatus(text: string, payload: Record<string, unknown>): GilesStatusRow {
  const config = /\((\d+)\s+(?:actions|tools),\s*([^)]*)\)/.exec(text);
  const model = /\bmodel:\s*(.+)$/i.exec(text);
  const recalled = /\brecalled\s+(\d+)\s+pages?\b/i.exec(text);
  const label = text.replace(/^\P{L}*(?:Giles|LLM Wiki)\b\s*(?:\([^)]*\))?\s*(?:[\u2014-]\s*)?/u, '').trim();
  const row: GilesStatusRow = { text, failure: payload.failure === true || Failure.test(text) };
  const parsedModel = model?.[1]?.trim();
  const parsedState = config || (model && !recalled) ? undefined : label || undefined;
  const set = <K extends keyof GilesStatusRow>(key: K, value: GilesStatusRow[K] | undefined) => { if (value !== undefined) row[key] = value; };
  set('model', optionalString(payload.model) ?? parsedModel);
  set('retrieval', optionalString(payload.retrieval) ?? config?.[2]?.trim());
  set('actions', typeof payload.actions === 'number' ? payload.actions : config ? Number(config[1]) : undefined);
  set('state', optionalString(payload.state) ?? parsedState);
  set('recalled', typeof payload.recalled === 'number' ? payload.recalled : recalled ? Number(recalled[1]) : undefined);
  return row;
}

const RowFields: readonly (keyof GilesStatusRow)[] = ['text', 'failure', 'model', 'retrieval', 'actions', 'state', 'recalled'];

/** Field-wise, so property insertion order (a merged row lists carried fields first) never reads as a change. */
function statusRowsEqual(a: GilesStatusRow, b: GilesStatusRow): boolean {
  return RowFields.every(field => a[field] === b[field]);
}

/** Everything the Giles widget shows. Fed by the live bus, persisted messages and branch replay; all idempotent. */
export class GilesState {
  recall = '';
  notice = '';
  readonly rows = new Map<string, GilesStatusRow>();

  get empty(): boolean { return !this.recall && !this.notice && this.rows.size === 0; }

  reset(): void {
    this.recall = '';
    this.notice = '';
    this.rows.clear();
  }

  /** Take only what this state lacks: values already held are newer than a replayed record. */
  fillFrom(other: GilesState): void {
    for (const [key, row] of other.rows) if (!this.rows.has(key)) this.rows.set(key, row);
    this.recall ||= other.recall;
    this.notice ||= other.notice;
  }

  /**
   * Last write wins per key; a null or missing text clears the key. A later text for the same key keeps
   * the model, retrieval mode and action count it does not restate, as a status bar row used to be
   * overwritten by "recalled N pages". Returns whether anything changed.
   */
  applyStatus(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const record = payload as Record<string, unknown>;
    const key = optionalString(record.key);
    if (!key) return false;
    if (typeof record.text !== 'string') return this.rows.delete(key);
    const before = this.rows.get(key);
    const parsed = parseStatus(record.text, record);
    const row: GilesStatusRow = { ...(before?.model !== undefined && { model: before.model }), ...(before?.retrieval !== undefined && { retrieval: before.retrieval }), ...(before?.actions !== undefined && { actions: before.actions }), ...parsed };
    if (before && statusRowsEqual(before, row)) return false;
    this.rows.set(key, row);
    return true;
  }

  /** Accepts a Giles, Librarian or wiki custom message of any generation; other types are ignored. */
  applyMessage(customType: string, content: unknown): boolean {
    const kind = MessageType.exec(customType)?.[1];
    if (!kind) return false;
    const text = blocksText(content);
    const envelope = gilesEnvelope(text);
    if (kind === 'status') return this.applyStatus(envelope?.content);
    const source = typeof envelope?.content === 'string' ? envelope.content : text;
    const field = kind === 'recall-context' ? 'recall' : 'notice';
    if (this[field] === source) return false;
    this[field] = source;
    return true;
  }

  summary(): GilesSummary {
    const out: GilesSummary = { states: [], failure: false };
    for (const row of this.rows.values()) {
      if (row.model !== undefined) out.model = row.model;
      if (row.retrieval !== undefined) out.retrieval = row.retrieval;
      if (row.actions !== undefined) out.actions = row.actions;
      if (row.recalled !== undefined) out.recalled = row.recalled;
      if (row.failure) out.failure = true;
      const text = row.failure ? stripControls(row.text).trim() : row.state;
      if (text && !out.states.some(state => state.text === text)) out.states.push({ text, failure: row.failure });
    }
    return out;
  }
}

/** Page titles from the recall's link lines; the Markdown itself is never rewritten. */
export function recallTitles(recall: string): string[] {
  return [...stripControls(recall).matchAll(/^\s*(?:-|\d+\.)\s+\*\*\[\[([^\]]+)\]\]\*\*\s+\u2014\s+\*[^*]+\*\s+\u2014\s+(.+)$/gm)].map(match => {
    const alias = match[1]!.split('|')[1];
    const tail = match[2]!.replace(/^score\s+[\d.]+\s+\u2014\s+/, '');
    return alias ?? tail.split(' \u2014 ')[0]!.trim();
  });
}

export function createGilesWidget(state: GilesState, theme: Theme, expanded: () => boolean): Component {
  let markdown: Markdown | undefined;
  let markdownSource = '';
  const sourceView = (): Markdown => {
    if (!markdown || markdownSource !== state.recall) {
      markdownSource = state.recall;
      markdown = new Markdown(state.recall, 0, 0, getMarkdownTheme());
    }
    return markdown;
  };

  const lines = (width: number, sym: typeof NerdSymbols, titles: string[], summary: GilesSummary): string[] => {
    const out: string[] = [];
    const wrap = (text: string) => out.push(...wrapTextWithAnsi(text, width));
    const meta = [summary.model && `${sym.model} ${summary.model}`, summary.retrieval, summary.actions !== undefined && `${summary.actions} ${summary.actions === 1 ? 'action' : 'actions'}`].filter(Boolean).join('  \u00b7  ');
    if (meta) wrap(theme.fg('muted', meta));
    if (expanded()) {
      const section = (name: string) => out.push(theme.fg('dim', truncateToWidth(`\u2500\u2500 ${name}`, width)));
      if (state.rows.size) {
        section('Status');
        for (const [key, row] of state.rows) wrap(theme.fg(row.failure ? 'error' : 'text', `${row.failure ? sym.alert : sym.status} ${key}: ${stripControls(row.text)}`));
      }
      if (state.notice) {
        section('Notice');
        wrap(theme.fg('muted', stripControls(state.notice)));
      }
      if (state.recall) {
        section('Recall');
        out.push(...sourceView().render(width));
      }
      return out;
    }
    for (const entry of summary.states) wrap(theme.fg(entry.failure ? 'error' : 'text', `${entry.failure ? sym.alert : sym.status} ${entry.text}`));
    if (state.recall) {
      const fallback = stripControls(state.recall).split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').trim() ?? 'Recall';
      wrap(theme.fg('text', `${sym.sources}  ${titles.join('  \u00b7  ') || fallback}`));
    }
    if (!out.length && state.notice) wrap(theme.fg('muted', `${sym.status} ${stripControls(state.notice).replace(/\s+/g, ' ').trim()}`));
    return out;
  };

  return {
    render(width: number): readonly string[] {
      if (width < 1 || state.empty) return [];
      const sym = theme.getSymbolPreset() === 'ascii' ? AsciiSymbols : NerdSymbols;
      const summary = state.summary();
      const titles = state.recall ? recallTitles(state.recall) : [];
      const matched = /_(\d+) page\(s\) matched/.exec(state.recall)?.[1];
      const pages = titles.length || (matched ? Number(matched) : summary.recalled ?? 0);
      const count = pages ? ` \u00b7 ${pages} ${pages === 1 ? 'source' : 'sources'}` : '';
      const heading = `${theme.fg(summary.failure ? 'error' : 'accent', theme.bold(`${sym.mark} GILES`))}${theme.fg('muted', count)}`;
      if (width < 24) return [heading, ...lines(width, sym, titles, summary)].map(line => truncateToWidth(line, width));
      const inner = width - 4;
      const corners = theme.boxRound;
      const hint = width >= 64 ? `Ctrl+O ${expanded() ? 'collapse' : 'details'}` : 'Ctrl+O';
      const gap = Math.max(1, inner - visibleWidth(heading) - visibleWidth(hint));
      const title = truncateToWidth(`${heading}${' '.repeat(gap)}${theme.fg('dim', hint)}`, inner);
      const border = (line: string) => theme.fg('borderAccent', line);
      const frame = (line: string) => {
        const clipped = truncateToWidth(line, inner);
        return `${border(corners.vertical)} ${theme.bg('customMessageBg', clipped + ' '.repeat(Math.max(0, inner - visibleWidth(clipped))))} ${border(corners.vertical)}`;
      };
      return [
        border(corners.topLeft + corners.horizontal.repeat(width - 2) + corners.topRight),
        frame(title),
        ...lines(inner, sym, titles, summary).map(frame),
        border(corners.bottomLeft + corners.horizontal.repeat(width - 2) + corners.bottomRight),
      ];
    },
    invalidate() { markdown?.invalidate(); },
  };
}
