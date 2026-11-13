import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mergeHooks, removeHooks } from '../src/claude/hooks.ts';
import { ClaudeSource } from '../src/claude/source.ts';
import { isRisky } from '../src/claude/tools.ts';
import { ManualClock } from '../src/clock.ts';
import { Hub } from '../src/hub.ts';
import type { PostReply } from '../src/server.ts';

const T0 = 1_794_637_920;
const SID = '0b7c6a52-1f7e-4c55-9a43-0e7f00c0ffee';

function setup(withDevice = true) {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  const source = new ClaudeSource(hub, clock, { holdSeconds: 300, log: () => {} });
  const detach = withDevice ? hub.attachDevice() : () => {};
  const send = (event: string, extra: Record<string, unknown> = {}) =>
    source.handle({ session_id: SID, cwd: 'D:\\work\\shop', hook_event_name: event, ...extra });
  const get = () => {
    const s = hub.get(SID);
    assert.ok(s, 'session exists');
    return s;
  };
  return { clock, hub, source, detach, send, get };
}

/** Whether a promise has settled, without waiting for it. */
async function settled(p: Promise<PostReply>): Promise<PostReply | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setImmediate(() => r('pending')))]);
}

const edit = {
  tool_name: 'Edit',
  tool_input: { file_path: 'D:\\work\\shop\\src\\cart.ts', old_string: 'const max = 10;', new_string: 'const max = 20;\nconst min = 1;' },
};

test('with no device connected, permission requests go straight to the terminal', async () => {
  const { send, get } = setup(false);
  assert.deepEqual(await send('PermissionRequest', edit), { status: 200 });
  assert.equal(get().state, 'idle');
  assert.equal(get().name, 'shop');
  assert.equal(get().reply, false);
});

test('a permission request waits for the device and carries the decision back', async () => {
  const { hub, send, get } = setup();
  const reply = send('PermissionRequest', edit);
  assert.equal(await settled(reply), 'pending');
  const s = get();
  assert.equal(s.state, 'approve');
  assert.ok(s.ask?.kind === 'approve');
  assert.equal(s.ask.verb, 'Edit');
  assert.equal(s.ask.target, 'src/cart.ts');
  assert.deepEqual(s.ask.lines, ['-const max = 10;', '+const max = 20;', '+const min = 1;']);
  assert.equal(s.ask.add, 2);
  assert.equal(s.ask.del, 1);
  assert.equal(s.ask.until, T0 + 300);
  assert.equal(hub.act({ t: 'approve', seq: 1, id: SID, req: s.ask.req, allow: true }), null);
  assert.deepEqual(await reply, {
    status: 200,
    body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
  });
  assert.equal(get().state, 'running');
  assert.equal(get().ask, undefined);
});

test('a denial is logged and tells Claude why', async () => {
  const { hub, send, get } = setup();
  const reply = send('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push origin main', description: '推到远端' } });
  await settled(reply);
  const ask = get().ask;
  assert.ok(ask?.kind === 'approve');
  assert.equal(ask.risky, true);
  assert.equal(ask.why, '推到远端');
  hub.act({ t: 'approve', seq: 1, id: SID, req: ask.req, allow: false });
  const body = (await reply).body as { hookSpecificOutput: { decision: { behavior: string; message: string } } };
  assert.equal(body.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(body.hookSpecificOutput.decision.message, /拒绝/);
  assert.equal(get().log[0]?.res, '已拒绝');
});

test('nobody answers: after the hold the terminal asks instead', async () => {
  const { clock, send, get } = setup();
  const reply = send('PermissionRequest', edit);
  await settled(reply);
  clock.advance(299_000);
  assert.equal(await settled(reply), 'pending');
  clock.advance(1_000);
  assert.deepEqual(await reply, { status: 200 });
  assert.equal(get().state, 'running');
  assert.match(get().say ?? '', /回电脑/);
});

test('the device leaving hands every held request back to the terminal', async () => {
  const { detach, send, get } = setup();
  const reply = send('PermissionRequest', edit);
  await settled(reply);
  detach();
  assert.deepEqual(await reply, { status: 200 });
  assert.equal(get().state, 'running');
});

test('requests made at the same time are shown one after another', async () => {
  const { hub, send, get } = setup();
  const first = send('PermissionRequest', edit);
  const second = send('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await settled(first);
  const a = get().ask;
  assert.ok(a?.kind === 'approve' && a.verb === 'Edit');
  hub.act({ t: 'approve', seq: 1, id: SID, req: a.req, allow: true });
  await first;
  assert.equal(await settled(second), 'pending');
  const b = get().ask;
  assert.ok(b?.kind === 'approve' && b.target === 'npm test');
  assert.equal(get().state, 'approve');
  hub.act({ t: 'approve', seq: 2, id: SID, req: b.req, allow: true });
  assert.equal(((await second).body as { hookSpecificOutput: { decision: { behavior: string } } }).hookSpecificOutput.decision.behavior, 'allow');
});

test('a question with two parts is answered one part at a time', async () => {
  const { hub, send, get } = setup();
  const questions = [
    { question: '筛选条件存在哪里？', header: '存储', options: [{ label: '浏览器本地', description: '最简单' }, { label: '数据库' }], multiSelect: false },
    { question: '要不要迁移旧数据？', header: '迁移', options: [{ label: '要' }, { label: '不要' }], multiSelect: false },
  ];
  const reply = send('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions } });
  await settled(reply);
  let ask = get().ask;
  assert.ok(ask?.kind === 'question');
  assert.equal(get().state, 'question');
  assert.equal(ask.text, '筛选条件存在哪里？');
  assert.equal(ask.note, '第 1/2 题 · 存储');
  assert.deepEqual(ask.options, [{ label: '浏览器本地', desc: '最简单' }, { label: '数据库' }]);
  assert.equal(hub.act({ t: 'answer', seq: 1, id: SID, req: ask.req, option: 1 }), null);
  assert.equal(await settled(reply), 'pending');
  const firstReq = ask.req;
  ask = get().ask;
  assert.ok(ask?.kind === 'question');
  assert.notEqual(ask.req, firstReq);
  assert.equal(ask.text, '要不要迁移旧数据？');
  hub.act({ t: 'answer', seq: 2, id: SID, req: ask.req, option: 0 });
  assert.deepEqual(await reply, {
    status: 200,
    body: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { questions, answers: { '筛选条件存在哪里？': '数据库', '要不要迁移旧数据？': '要' } },
      },
    },
  });
  assert.equal(get().state, 'running');
  assert.deepEqual(
    get().log.slice(0, 2).map((e) => e.target),
    ['要', '数据库'],
  );
});

test('a round of work: prompt, tools, todos, report', async () => {
  const { send, get, hub } = setup();
  await send('SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
  assert.equal(get().model, 'opus-5.5');
  await send('UserPromptSubmit', { prompt: '给购物车加数量上限\n第二行不显示' });
  assert.equal(get().state, 'running');
  assert.equal(get().log[0]?.target, '给购物车加数量上限');
  await send('PreToolUse', {
    tool_name: 'TodoWrite',
    tool_input: { todos: [{ content: '读代码', status: 'completed' }, { content: '改上限', status: 'in_progress' }] },
  });
  assert.deepEqual(get().todos, { done: 1, items: ['读代码', '改上限'] });
  await send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'D:\\work\\shop\\src\\cart.ts' } });
  assert.deepEqual(get().now, { verb: 'Read', target: 'src/cart.ts' });
  await send('PostToolUse', {
    tool_name: 'Read',
    tool_input: { file_path: 'D:\\work\\shop\\src\\cart.ts' },
    tool_response: { type: 'text', file: { filePath: 'D:\\work\\shop\\src\\cart.ts', numLines: 88 } },
  });
  await send('PostToolUse', {
    ...edit,
    tool_response: {
      filePath: 'D:\\work\\shop\\src\\cart.ts',
      structuredPatch: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 2, lines: ['-const max = 10;', '+const max = 20;', '+const min = 1;'] }],
    },
  });
  await send('PostToolUse', {
    tool_name: 'Write',
    tool_input: { file_path: 'D:\\work\\shop\\test\\cart.test.ts', content: 'a\nb\nc\n' },
    tool_response: { type: 'create', filePath: 'D:\\work\\shop\\test\\cart.test.ts', content: 'a\nb\nc\n', structuredPatch: [] },
  });
  await send('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'exit 1' });
  let s = get();
  assert.deepEqual(s.n, { read: 1, edit: 1, new: 1, cmd: 0, add: 5, del: 1 });
  assert.deepEqual(
    s.log.slice(0, 4).map((e) => [e.verb, e.target, e.res ?? `+${e.add} -${e.del}`, e.bad ?? false]),
    [
      ['Bash', 'npm test', '失败', true],
      ['Write', 'cart.test.ts', '+3 -0', false],
      ['Edit', 'cart.ts', '+2 -1', false],
      ['Read', 'cart.ts', '88 行', false],
    ],
  );
  assert.deepEqual(s.files, [
    { st: 'A', path: 'test/cart.test.ts', add: 3, del: 0 },
    { st: 'M', path: 'src/cart.ts', add: 2, del: 1 },
  ]);
  assert.equal(s.hunks.total, 2);
  assert.deepEqual(s.hunks.list[1], { file: 'src/cart.ts', line: 12, add: 2, del: 1, lines: ['-const max = 10;', '+const max = 20;', '+const min = 1;'] });
  await send('Stop', { last_assistant_message: '上限改好了。\n\n- **上限**：从 10 改成 20。\n- **测试**：新增 1 个。' });
  s = get();
  assert.equal(s.state, 'done');
  assert.deepEqual(s.report, [
    { text: '上限改好了。' },
    { b: true, lead: '上限', text: '：从 10 改成 20。' },
    { b: true, lead: '测试', text: '：新增 1 个。' },
  ]);
  assert.equal(s.say, '上限改好了。');
  assert.equal(hub.act({ t: 'seen', seq: 1, id: SID }), null);
  assert.equal(get().state, 'idle');
  await send('UserPromptSubmit', { prompt: '再加个下限' });
  assert.deepEqual(get().n, { read: 0, edit: 0, new: 0, cmd: 0, add: 0, del: 0 });
  assert.equal(get().report, undefined);
  await send('SessionEnd', { reason: 'prompt_input_exit' });
  assert.equal(hub.get(SID), undefined);
});

test('a one-shot run keeps its report until it is seen', async () => {
  const { hub, send, get } = setup();
  await send('UserPromptSubmit', { prompt: 'x' });
  await send('Stop', { last_assistant_message: '做完了。' });
  await send('SessionEnd', { reason: 'other' });
  assert.equal(get().state, 'done');
  assert.equal(hub.act({ t: 'seen', seq: 1, id: SID }), null);
  assert.equal(hub.get(SID), undefined);
});

test('a session that ends while working goes at once', async () => {
  const { hub, send } = setup();
  await send('UserPromptSubmit', { prompt: 'x' });
  await send('SessionEnd', { reason: 'prompt_input_exit' });
  assert.equal(hub.get(SID), undefined);
});

test('junk is refused', async () => {
  const { source } = setup();
  assert.equal((await source.handle({ hello: 1 })).status, 400);
  assert.equal((await source.handle(null)).status, 400);
});

test('risky commands need a long press, ordinary ones do not', () => {
  const bash = (command: string) => isRisky('Bash', { command });
  assert.equal(bash('git push origin main'), true);
  assert.equal(bash('rm -rf build'), true);
  assert.equal(bash('git reset --hard HEAD~1'), true);
  assert.equal(bash('git push --force-with-lease'), true);
  assert.equal(bash('npm test'), false);
  assert.equal(bash('tail -f log.txt'), false);
  assert.equal(bash('git status'), false);
  assert.equal(isRisky('Edit', { command: 'rm -rf /' }), false);
});

test('hook settings are merged into a settings file and taken out again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  const file = join(dir, 'settings.json');
  const original = {
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] },
  };
  writeFileSync(file, JSON.stringify(original));
  const backup = mergeHooks(file, 8137, 570);
  assert.equal(backup, `${file}.codetalky.bak`);
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(merged.model, 'opus');
  assert.equal(merged.hooks.Stop.length, 2);
  assert.deepEqual(merged.hooks.PermissionRequest, [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:8137/hooks/claude', timeout: 600 }] }]);
  mergeHooks(file, 8137, 570); // again: no duplicates
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop.length, 2);
  removeHooks(file, 8137);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
  assert.equal(removeHooks(file, 8137), null);
});
