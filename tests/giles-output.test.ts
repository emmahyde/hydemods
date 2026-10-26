import { expect, test } from 'bun:test';
import { decode } from '@toon-format/toon';
import { blocksText, gilesEnvelope, gilesOutput, gilesSource, gilesWrapContent } from '../lib/giles-output';

test('TOON preserves quoted source text, receipt identity and uncertainty', () => {
  const content = { source: '## Librarian\n> "Keep this, exactly."\n001\ntrue', receipt: '001', status: 'unknown', attempted: false, findings: [{ path: 'a,b.md', score: 0 }, { path: 'quoted"file.md', score: null }] };
  expect(decode(gilesOutput('feedback', content))).toEqual({ application: 'Giles', kind: 'feedback', content });
});

test('plain source text remains a string rather than inferred JSON or YAML', () => {
  for (const content of ['{"receipt":"001"}', 'active: true\ncount: 2', '', 'Error: write outcome unknown']) {
    expect(decode(gilesOutput('notice', content))).toEqual({ application: 'Giles', kind: 'notice', content });
  }
});

test('an adapter envelope is never wrapped again, and its optional action survives parsing', () => {
  const once = gilesOutput('result', 'source\nline "two"');
  expect(gilesOutput('result', once)).toBe(once);
  expect(gilesOutput('error', once)).toBe(once);
  const withAction = 'application: Giles\nkind: result\naction: recall\ncontent: "x"';
  expect(gilesEnvelope(withAction)).toEqual({ kind: 'result', action: 'recall', content: 'x' });
  expect(gilesOutput('result', withAction)).toBe(withAction);
});

test('text that only resembles an envelope is a plain source string and is wrapped losslessly', () => {
  const lookalike = 'application: Giles\nnot an envelope';
  expect(gilesEnvelope(lookalike)).toBeUndefined();
  expect(gilesSource(lookalike)).toBe(lookalike);
  expect(decode(gilesOutput('notice', lookalike))).toEqual({ application: 'Giles', kind: 'notice', content: lookalike });
});

test('gilesSource unwraps string content and leaves structured content wrapped', () => {
  expect(gilesSource(gilesOutput('recall-context', '## Recall\n"quoted"'))).toBe('## Recall\n"quoted"');
  const status = gilesOutput('status', { key: 'llm-wiki', text: 'Giles (8 actions, x)' });
  expect(gilesSource(status)).toBe(status);
});

test('block content is wrapped per text block, once, and images pass through unchanged', () => {
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const adapter = gilesOutput('result', 'already wrapped');
  const historical = [{ type: 'text', text: 'Historical "librarian" result' }, image, { type: 'text', text: adapter }];
  const wrapped: Array<{ type: string; text?: string }> = gilesWrapContent('result', historical);
  expect(wrapped).toHaveLength(3);
  expect(wrapped[1]).toBe(image);
  expect(decode(wrapped[0]!.text!)).toEqual({ application: 'Giles', kind: 'result', content: 'Historical "librarian" result' });
  expect(wrapped[2]!.text).toBe(adapter);
  expect(blocksText(gilesWrapContent('result', gilesWrapContent('result', historical)))).toBe(blocksText(wrapped));
});

test('string content wraps once and non-text content is returned as it is', () => {
  const once = gilesWrapContent('notice', 'plain');
  expect(decode(once)).toEqual({ application: 'Giles', kind: 'notice', content: 'plain' });
  expect(gilesWrapContent('notice', once)).toBe(once);
  const other = { not: 'content' };
  expect(gilesWrapContent('notice', other)).toBe(other);
  expect(blocksText(undefined)).toBe('');
});
