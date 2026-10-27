import { afterEach, expect, test } from 'bun:test';
import { displayToolLabel } from '../lib/tool-labels';
import { callLabel, callSubject, setSkillNames, toolBullets } from '../lib/tool-rows';

afterEach(() => setSkillNames([]));

test('search calls retain their namespace across direct and device forms', () => {
  const web = callLabel('web_search', { query: 'rendering' });
  const skill = callLabel('write', { path: 'xd://skill_search', content: '{"task":"rendering"}' });
  expect(web).toBe('WEB:SEARCH');
  expect(skill).toBe('SKILL:SEARCH');
  expect(callLabel('skill_search', { task: 'rendering' })).toBe(skill);
});

test('Giles group devices retain the action instead of merging unrelated operations', () => {
  const feedback = callLabel('write', { path: 'xd://giles_feedback', content: '{"action":"submit","args":{"feedback":"Keep this"}}' });
  const recall = callLabel('giles_wiki', { action: 'recall', args: { query: 'Keep this' } });
  expect(feedback).toBe('GILES:FB');
  expect(recall).toBe('GILES:RECALL');
  expect(feedback).not.toBe(recall);
  // Same in-device name on two devices stays two operations.
  expect(callLabel('giles_wiki', { action: 'status' })).toBe('GILES:STATUS');
  expect(callLabel('giles_retro', { action: 'status' })).toBe('GILES:RETRO_STATUS');
  // Doc-topic reads name the device.
  expect(callLabel('read', { path: 'xd://giles_work/finish' })).toBe('GILES:WORK');
  // Rows from the retired single device keep their labels.
  expect(callLabel('write', { path: 'xd://giles', content: '{"action":"feedback_submit","args":{}}' })).toBe(feedback);
});

test('direct, device and historical forms of one operation share a canonical label', () => {
  const feedback = callLabel('giles_feedback', { feedback: 'x' });
  expect(feedback).toBe('GILES:FB');
  expect(callLabel('xd__giles_feedback', {})).toBe(feedback);
  expect(callLabel('write', { path: 'xd://librarian_feedback', content: '{}' })).toBe(feedback);
  expect(callLabel('librarian_feedback', {})).toBe(feedback);
  expect(callLabel('write', { path: 'xd://librarian', content: '{"action":"recall"}' })).toBe('GILES:RECALL');
  expect(callLabel('xd__wiki_observe', {})).toBe('GILES:OBSERVE');
  expect(callLabel('mcp__linear_get_issue', {})).toBe('LINEAR:GET_ISSUE');
  expect(callLabel('write', { path: 'xd://mcp__linear_save_issue', content: '{}' })).toBe('LINEAR:SAVE_ISSUE');
});

test('tool rows preserve textual namespaces and compact Giles work actions', () => {
  for (const label of ['WEB:SEARCH', 'SKILL:SEARCH', 'READ', 'WRITE', 'EDIT', 'JS', 'PYTHON3']) {
    expect(displayToolLabel(label)).toBe(label);
  }
  expect(displayToolLabel(callLabel('giles_work', { action: 'check' }))).toBe('GILES:WK:CHK');
  expect(displayToolLabel(callLabel('giles_work', { action: 'finish' }))).toBe('GILES:WK:FIN');
  expect(displayToolLabel(callLabel('giles_retro', { action: 'status' }))).toBe('GILES:RETRO:STATUS');
  expect(displayToolLabel(callLabel('giles_work', { action: 'resume' }))).toBe('GILES:WK:RESUME');
  expect(displayToolLabel(callLabel('giles_knowledge', { action: 'search' }))).toBe('GILES:KNWLG:SEARCH');
});

test('skill identity survives namespaces and resource reads even when acronyms collide', () => {
  setSkillNames(['agents/session-retro', 'agents/source-review']);
  const first = { path: 'skill://agents/session-retro' };
  const second = { path: 'skill://agents/source-review' };
  expect(callLabel('read', first)).not.toBe(callLabel('read', second));
  expect(callSubject('read', first)).toBe('agents/session-retro');
  expect(callSubject('read', second)).toBe('agents/source-review');
  expect(callLabel('read', { path: 'skill://agents/session-retro/REFERENCE.md' })).toBe(callLabel('read', first));
  // Both abbreviate to the same acronym, so neither is silently chosen: each displays its whole identity.
  expect(displayToolLabel(callLabel('read', first))).toBe('/agents/session-retro');
  expect(displayToolLabel(callLabel('read', second))).toBe('/agents/source-review');
});

test('a skill resource resolves through the registry, not through its path shape', () => {
  setSkillNames(['model-native-prompt', 'agents/audit', 'agents']);
  const resource = { path: 'skill://model-native-prompt/references/dispatch.md' };
  expect(callSubject('read', resource)).toBe('model-native-prompt');
  expect(callLabel('read', resource)).toBe('/model-native-prompt');
  expect(displayToolLabel(callLabel('read', resource))).toBe('/MNP');
  // The longest registered prefix wins; selectors never become part of a name.
  expect(callSubject('read', { path: 'skill://agents/audit/rules/a.md:raw' })).toBe('agents/audit');
  expect(callSubject('read', { path: 'skill://agents/other/x.md' })).toBe('agents');
  expect(callSubject('read', { path: 'skill://model-native-prompt/SKILL.md:1-40' })).toBe('model-native-prompt');
});

test('an unregistered skill keeps its first segment, and never borrows a registered skill\'s acronym', () => {
  setSkillNames([]);
  const unknown = { path: 'skill://model-native-prompt/references/dispatch.md' };
  expect(callSubject('read', unknown)).toBe('model-native-prompt');
  expect(displayToolLabel(callLabel('read', unknown))).toBe('/MNP');
  setSkillNames(['multi-node-planner']);
  expect(displayToolLabel('/multi-node-planner')).toBe('/MNP');
  expect(displayToolLabel(callLabel('read', unknown))).toBe('/model-native-prompt');
});

test('acronyms qualify with their namespace on collision and stay display-only', () => {
  setSkillNames(['agents/session-retro', 'claude/skill-review', 'unique-tool']);
  expect(displayToolLabel('/agents/session-retro')).toBe('/ASR');
  expect(displayToolLabel('/claude/skill-review')).toBe('/CSR');
  expect(displayToolLabel('/unique-tool')).toBe('/UT');
  // The canonical label the call keeps is the full identity, so nothing executable is derived from the acronym.
  expect(callLabel('read', { path: 'skill://claude/skill-review/SKILL.md' })).toBe('/claude/skill-review');
});

test('burst summaries retain complete namespace labels rather than splitting at their colon', () => {
  const result = toolBullets('GILES:FB: Captured the direction\nWEB:SEARCH: Found the source', ['GILES:FB', 'WEB:SEARCH']);
  expect(result).toContain('GILES:FB: Captured the direction');
  expect(result).toContain('WEB:SEARCH: Found the source');
});

test('summary lines parse by their longest canonical label when one label prefixes another', () => {
  const labels = ['GILES', 'GILES:FB', 'GILES:FB_CHECK'];
  const result = toolBullets('GILES:FB_CHECK: Verified criteria\nGILES: Recalled notes\nGILES:FB: Filed feedback', labels);
  expect(result).toBe('GILES: Recalled notes\nGILES:FB: Filed feedback\nGILES:FB_CHECK: Verified criteria');
  expect(toolBullets('GILES:FB: Filed feedback', ['GILES:FB_CHECK', 'GILES:FB'])).toBe('GILES:FB: Filed feedback');
});
