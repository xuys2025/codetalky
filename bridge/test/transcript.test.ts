import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RolloutTail } from '../src/codex/rollout.ts';

const said = (text: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }] } } }) + '\n';

function tail() {
  const file = join(mkdtempSync(join(tmpdir(), 'ct-')), 'rollout.jsonl');
  writeFileSync(file, '');
  const t = new RolloutTail(file);
  t.update(); // the first look only catches up
  return { file, t };
}

test('a file rewritten while half a line was pending starts clean, even if it is longer now', () => {
  const { file, t } = tail();
  appendFileSync(file, '{"half":"a line that never ends'); // then the file is rewritten in place
  t.update();
  writeFileSync(file, said('新的一句，比原来那半行长得多，长度判断看不出被重写了'));
  t.update();
  assert.equal(t.text, '新的一句，比原来那半行长得多，长度判断看不出被重写了');
  // And appending after that still works.
  appendFileSync(file, said('接着写'));
  t.update();
  assert.equal(t.text, '接着写');
});

test('a character split between two reads comes out whole', () => {
  const { file, t } = tail();
  const bytes = Buffer.from(said('写好了'));
  const cut = bytes.indexOf(Buffer.from('好')) + 1; // in the middle of 好
  appendFileSync(file, bytes.subarray(0, cut));
  t.update();
  appendFileSync(file, bytes.subarray(cut));
  t.update();
  assert.equal(t.text, '写好了');
});
