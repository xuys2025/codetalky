import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { diffLines, hunksFromPatch, patchStat, reportFromMarkdown, shortModel } from '../src/claude/text.ts';
import { TranscriptTail } from '../src/claude/transcript.ts';

test('model names are shortened the way the device shows them', () => {
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5.5');
  assert.equal(shortModel('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
  assert.equal(shortModel('claude-fable-5-2'), 'fable-5.2');
  assert.equal(shortModel('claude-opus-4-1-20250805'), 'opus-4.1');
  assert.equal(shortModel('claude-haiku-5-5[1m]'), 'haiku-5.5');
  assert.equal(shortModel('gpt-5'), 'gpt-5');
});

test('a structured patch becomes device hunks with counts', () => {
  const patch = [
    { oldStart: 40, oldLines: 3, newStart: 40, newLines: 4, lines: [' a', '-b', '+c', '+d', ' e', '\\ No newline at end of file'] },
  ];
  assert.deepEqual(hunksFromPatch('src/x.ts', patch), [
    { file: 'src/x.ts', line: 40, add: 2, del: 1, lines: [' a', '-b', '+c', '+d', ' e'] },
  ]);
  assert.deepEqual(patchStat(patch), { add: 2, del: 1 });
});

test('a pending edit is shown as context, removed and added lines', () => {
  assert.deepEqual(diffLines('a\nb\nold\nc', 'a\nb\nnew\nnew2\nc'), [' a', ' b', '-old', '+new', '+new2', ' c']);
});

test('the final message becomes report paragraphs', () => {
  const md = [
    '给订单列表接口加了**分页**。',
    '',
    '## 改了这些',
    '- **接口**：新增 `page` 和 `size`。',
    '- **测试**: 补了 4 个',
    '1. 旧客户端不用动',
    '```ts',
    'const x = 1;',
    '```',
    '| a | b |',
    '要我继续吗？',
  ].join('\n');
  assert.deepEqual(reportFromMarkdown(md), [
    { text: '给订单列表接口加了分页。' },
    { text: '改了这些' },
    { b: true, lead: '接口', text: '：新增 page 和 size。' },
    { b: true, lead: '测试', text: '：补了 4 个' },
    { b: true, text: '旧客户端不用动' },
    { text: '要我继续吗？' },
  ]);
});

test('the transcript is read incrementally for model, branch, text and todos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  const file = join(dir, 's.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    file,
    line({ type: 'user', gitBranch: 'feat/x', message: { content: 'hi' } }) +
      line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: '先看看。' }] } }),
  );
  const tail = new TranscriptTail(file);
  assert.deepEqual(tail.update(), { branch: 'feat/x', model: 'claude-opus-5-5', text: '先看看。' });
  appendFileSync(
    file,
    line({
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: '写测试', status: 'pending' },
                { content: '读代码', status: 'completed' },
                { content: '改代码', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    }) + '{"type":"assistant","mess', // a line still being written
  );
  assert.deepEqual(tail.update().todos, { done: 1, items: ['读代码', '改代码', '写测试'] });
  assert.equal(tail.update().text, '先看看。');
  assert.deepEqual(new TranscriptTail(join(dir, 'missing.jsonl')).update(), {});
});
