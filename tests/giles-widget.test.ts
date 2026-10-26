import { beforeAll, expect, test } from 'bun:test';
import { initTheme } from '@oh-my-pi/pi-tui/theme';
import type { Theme } from '@oh-my-pi/pi-tui/theme';
import { gilesOutput } from '../lib/giles-output';
import { createGilesWidget, GilesState, recallTitles } from '../lib/giles-widget';

beforeAll(async () => { await initTheme(false); });

const plainTheme = (preset: 'nerd' | 'ascii' = 'nerd') => ({
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getSymbolPreset: () => preset,
  boxRound: { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│' },
}) as unknown as Theme;

const recall = [
  '## Relevant Giles Knowledge (links-first)',
  '',
  '_2 page(s) matched your query, ranked._',
  '',
  '1. **[[concepts/alpha]]** — *concept* — score 56.0 — Alpha page — preview',
  '   ↳ `read /w/alpha.md`',
  '2. **[[sources/beta|Beta title]]** — *source* — score 52.0 — ignored tail',
  '',
  '> "Keep this, exactly."',
].join('\n');

const statusState = () => {
  const state = new GilesState();
  state.applyStatus({ key: 'llm-wiki', text: '🧠 Giles (8 actions, observe + recall active)' });
  state.applyStatus({ key: 'llm-wiki-model', text: '🧠 giles model: m-1' });
  return state;
};

const rows = (state: GilesState, width: number, expanded = false, preset: 'nerd' | 'ascii' = 'nerd') =>
  [...createGilesWidget(state, plainTheme(preset), () => expanded).render(width)];

test('status renders before and without any recall: model, retrieval mode and action count stay visible', () => {
  const state = statusState();
  const out = rows(state, 80).join('\n');
  expect(out).toContain('m-1');
  expect(out).toContain('observe + recall active');
  expect(out).toContain('8 actions');
  expect(out).not.toContain('sources');
  expect(state.recall).toBe('');
});

test('a later status for the same key keeps configuration and shows the new action state', () => {
  const state = statusState();
  state.applyStatus({ key: 'llm-wiki', text: '🧠 Giles — recalled 3 pages for this task' });
  const out = rows(state, 80).join('\n');
  expect(out).toContain('8 actions');
  expect(out).toContain('m-1');
  expect(out).toContain('recalled 3 pages for this task');
  expect(out).toContain('3 sources');
  state.applyStatus({ key: 'llm-wiki', text: null });
  expect(rows(state, 80).join('\n')).not.toContain('recalled 3 pages');
});

test('recall adds the actual page count and titles to the same widget, not a second one', () => {
  const state = statusState();
  state.applyMessage('giles-recall-context', recall);
  const out = rows(state, 100);
  expect(recallTitles(recall)).toEqual(['Alpha page', 'Beta title']);
  expect(out.join('\n')).toContain('2 sources');
  expect(out.join('\n')).toContain('Alpha page  ·  Beta title');
  expect(out.join('\n')).toContain('m-1');
  expect(out.filter(line => line.includes('GILES'))).toHaveLength(1);
});

test('no line exceeds any width and the model stays readable on narrow panes', () => {
  const state = statusState();
  state.applyStatus({ key: 'llm-wiki', text: '🧠 Giles — recalled 3 pages for this task' });
  state.applyMessage('giles-recall-context', recall);
  state.applyMessage('giles-session-notice', 'Giles active. Use `giles (action: search)` to query.');
  for (const expanded of [false, true]) {
    for (const width of [1, 2, 3, 5, 8, 12, 23, 24, 25, 30, 40, 64, 120]) {
      const out = rows(state, width, expanded);
      expect(out.length).toBeGreaterThan(0);
      expect(out.every(line => Bun.stringWidth(line) <= width)).toBe(true);
    }
  }
  expect(rows(state, 24).join(' ')).toContain('m-1');
  expect(rows(state, 12).join(' ')).toContain('m-1');
});

test('an empty widget renders nothing and a cleared state removes it', () => {
  const state = new GilesState();
  expect(state.empty).toBe(true);
  expect(rows(state, 80)).toEqual([]);
  state.applyStatus({ key: 'k', text: 'Giles (1 actions, x)' });
  expect(state.empty).toBe(false);
  state.applyStatus({ key: 'k', text: null });
  expect(state.empty).toBe(true);
});

test('Ctrl+O expansion shows each original status string, the full notice and the recall Markdown', () => {
  const state = statusState();
  state.applyStatus({ key: 'llm-wiki', text: '🧠 Giles — recalled 3 pages for this task' });
  state.applyMessage('giles-recall-context', recall);
  const notice = 'Giles active.\nUse `giles (action: search)` to query.\nSilence these notices.';
  state.applyMessage('giles-session-notice', notice);
  const collapsed = rows(state, 100).join('\n');
  expect(collapsed).not.toContain('Silence these notices');
  expect(collapsed).not.toContain('Keep this, exactly.');
  const expanded = rows(state, 100, true).join('\n');
  expect(expanded).toContain('llm-wiki: 🧠 Giles — recalled 3 pages for this task');
  expect(expanded).toContain('llm-wiki-model: 🧠 giles model: m-1');
  expect(expanded).toContain('Silence these notices.');
  expect(expanded).toContain('Keep this, exactly.');
  expect(expanded).toContain('Ctrl+O collapse');
});

test('the notice shows compactly only while nothing else is known', () => {
  const state = new GilesState();
  state.applyMessage('giles-session-notice', 'Giles active. Use giles.');
  expect(rows(state, 80).join('\n')).toContain('Giles active. Use giles.');
  state.applyStatus({ key: 'llm-wiki', text: 'Giles (2 actions, observe)' });
  expect(rows(state, 80).join('\n')).not.toContain('Use giles.');
});

test('TOON envelopes and historical plain messages yield the same exact source', () => {
  const source = `${recall}\nandrew: "a,b"\napplication: Giles\n`;
  const wrapped = new GilesState();
  const legacy = new GilesState();
  const blocks = new GilesState();
  wrapped.applyMessage('giles-recall-context', gilesOutput('recall-context', source));
  legacy.applyMessage('librarian-recall-context', source);
  blocks.applyMessage('wiki-recall-context', [{ type: 'text', text: gilesOutput('recall-context', source) }, { type: 'image', data: 'x', mimeType: 'image/png' }]);
  expect(wrapped.recall).toBe(source);
  expect(legacy.recall).toBe(source);
  expect(blocks.recall).toBe(source);
  expect(rows(wrapped, 100, true).join('\n')).toContain('Keep this, exactly.');
});

test('status envelopes from the adapter and unrelated messages are applied only when they are status', () => {
  const state = new GilesState();
  expect(state.applyMessage('giles-status', gilesOutput('status', { key: 'llm-wiki', text: 'Giles (8 actions, observe + recall)' }))).toBe(true);
  expect(state.applyMessage('giles-status', gilesOutput('status', { key: 'llm-wiki', text: 'Giles (8 actions, observe + recall)' }))).toBe(false);
  expect(state.applyMessage('other', 'Giles (1 actions, x)')).toBe(false);
  expect(state.applyStatus({ key: '', text: 'x' })).toBe(false);
  expect(state.summary()).toMatchObject({ actions: 8, retrieval: 'observe + recall' });
  expect(state.applyStatus({ key: 'llm-wiki', text: 'Giles (8 actions, observe + recall)' })).toBe(false);
  expect(state.applyStatus({ key: 'llm-wiki', text: 'Giles (9 actions, observe + recall)' })).toBe(true);
  expect(state.applyStatus({ key: 'llm-wiki', text: 'Giles (9 actions, observe + recall)', failure: true })).toBe(true);
  expect(state.applyStatus({ key: 'llm-wiki', text: null })).toBe(true);
  expect(state.applyStatus({ key: 'llm-wiki', text: null })).toBe(false);
});

test('structured status fields win over text parsing', () => {
  const state = new GilesState();
  state.applyStatus({ key: 'k', text: 'free text', model: 'gpt-x', retrieval: 'links-first', actions: 3, state: 'syncing', recalled: 4 });
  expect(state.summary()).toMatchObject({ model: 'gpt-x', retrieval: 'links-first', actions: 3, recalled: 4, states: [{ text: 'syncing', failure: false }] });
});

test('a failure keeps its complete text, is flagged and shows without any recall', () => {
  const state = new GilesState();
  const text = 'Giles setup blocked: write outcome unknown (receipt 001)';
  state.applyStatus({ key: 'llm-wiki', text, failure: true });
  const out = rows(state, 100).join('\n');
  expect(out).toContain(text);
  expect(out).toContain('\u{f002a}');
  expect(state.summary().failure).toBe(true);
  expect(rows(state, 100, true).join('\n')).toContain(`llm-wiki: ${text}`);
});

test('Nerd Font glyphs are used only in the nerd preset; ASCII has none', () => {
  const state = statusState();
  state.applyMessage('giles-recall-context', recall);
  const nerd = rows(state, 100).join('');
  const ascii = rows(state, 100, true, 'ascii').join('');
  expect(nerd).toContain('\u{f02aa}');
  expect(nerd).toContain('\u{f05da}');
  expect(/[\u{e000}-\u{f8ff}\u{f0000}-\u{10ffff}]/u.test(ascii)).toBe(false);
  expect(ascii).toContain('G GILES');
});

test('replaying persisted records fills only what live updates have not set', () => {
  const live = new GilesState();
  live.applyStatus({ key: 'llm-wiki', text: 'Giles (9 actions, fresh)' });
  const persisted = new GilesState();
  persisted.applyStatus({ key: 'llm-wiki', text: 'Giles (1 actions, stale)' });
  persisted.applyStatus({ key: 'llm-wiki-model', text: 'giles model: old' });
  persisted.applyMessage('giles-recall-context', recall);
  live.fillFrom(persisted);
  expect(live.summary()).toMatchObject({ actions: 9, retrieval: 'fresh', model: 'old' });
  expect(live.recall).toBe(recall);
});
