import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { claudeHooks, mergeHooks, removeHooks } from '../src/claude/hooks.ts';
import { ClaudeSource, DEVICE_GRACE_MS } from '../src/claude/source.ts';
import { claudeTools, dropCd, isRisky, targetOf } from '../src/claude/tools.ts';
import { ManualClock } from '../src/clock.ts';
import { Hub } from '../src/hub.ts';
import { Runs } from '../src/runs.ts';
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

test('answered in the terminal: Claude hangs up and the device leaves the prompt', async () => {
  const { hub, source, get } = setup();
  const gone = new AbortController();
  const reply = source.handle({ session_id: SID, cwd: 'D:\\work\\shop', hook_event_name: 'PermissionRequest', ...edit }, {}, gone.signal);
  await settled(reply);
  const req = (get().ask as { req: string }).req;
  gone.abort();
  assert.deepEqual(await reply, { status: 200 });
  assert.equal(get().state, 'running');
  assert.equal(get().ask, undefined);
  assert.equal(get().say, '已在电脑上处理');
  // A late tap on the device finds nothing to answer.
  assert.equal(hub.act({ t: 'approve', seq: 1, id: SID, req, allow: true }), 'stale');
});

test('answered in the terminal: the tool result also clears the prompt', async () => {
  const { send, get } = setup();
  const reply = send('PermissionRequest', edit);
  await settled(reply);
  assert.equal(get().state, 'approve');
  // The agent didn't hang up, but it ran the tool: someone said yes at the computer.
  await send('PostToolUse', { ...edit, tool_response: { filePath: edit.tool_input.file_path, structuredPatch: [] } });
  assert.deepEqual(await reply, { status: 200 });
  assert.equal(get().state, 'running');
  assert.equal(get().ask, undefined);
});

test('another call of the same tool finishing does not let go of a held one', async () => {
  const { send, get } = setup();
  const a = send('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'tu-a' });
  await settled(a);
  assert.equal(get().state, 'approve');
  // B ran alongside without asking, and finished.
  await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu-b', tool_response: { stdout: '' } });
  await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'tu-c', tool_response: { stdout: '' } });
  assert.equal(await settled(a), 'pending', 'not by name, nor by the same command under another id');
  assert.equal(get().state, 'approve');
  // A itself finished (answered in the terminal): now it goes.
  await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'tu-a', tool_response: { stdout: '' } });
  assert.deepEqual(await a, { status: 200 });
  assert.equal(get().state, 'running');
});

test('another edit of the same file finishing does not let go of a held one', async () => {
  const { send, get } = setup();
  const file = 'D:\\work\\shop\\src\\cart.ts';
  const a = send('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
  await settled(a);
  await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: 'y' }, tool_use_id: 'tu-b', tool_response: {} });
  assert.equal(await settled(a), 'pending');
  assert.equal(get().state, 'approve');
  // The same input (keys in any order, the stated reason aside) is the same call.
  await send('PostToolUse', { tool_name: 'Edit', tool_input: { new_string: 'b', old_string: 'a', file_path: file, description: '改' }, tool_response: {} });
  assert.deepEqual(await a, { status: 200 });
});

test('the device leaving hands every held request back to the terminal, after a grace for it to come back', async () => {
  const { clock, hub, detach, send, get } = setup();
  const reply = send('PermissionRequest', edit);
  await settled(reply);
  // A Wi-Fi blip: it comes back in time, and the request is still there to approve.
  detach();
  clock.advance(DEVICE_GRACE_MS - 1000);
  assert.equal(await settled(reply), 'pending');
  const again = hub.attachDevice();
  clock.advance(DEVICE_GRACE_MS);
  assert.equal(await settled(reply), 'pending');
  assert.equal(get().state, 'approve');
  // Gone for good: the request goes back to the terminal, where it still waits for the user.
  again();
  detach();
  clock.advance(DEVICE_GRACE_MS);
  assert.deepEqual(await reply, { status: 200 });
  assert.deepEqual([get().state, get().there, get().say], ['running', true, '设备断开了，回电脑确认']);
  // Answered there: it goes on, and no longer waits.
  await send('PostToolUse', { ...edit, tool_response: { filePath: edit.tool_input.file_path, structuredPatch: [] } });
  assert.deepEqual([get().state, get().there, get().say], ['running', undefined, undefined]);
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

test('several options picked, or the user’s own words, in the answer Claude expects', async () => {
  const { hub, send, get } = setup();
  const questions = [
    { question: '要支持哪些格式？', header: '格式', options: [{ label: 'CSV' }, { label: 'JSON' }, { label: 'XML' }], multiSelect: true },
    { question: '放在哪个菜单？', header: '菜单', options: [{ label: '文件' }, { label: '工具' }], multiSelect: false },
  ];
  const reply = send('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions } });
  await settled(reply);
  let ask = get().ask;
  assert.ok(ask?.kind === 'question');
  assert.equal(ask.multi, true);
  assert.equal(ask.note, '第 1/2 题 · 格式 · 可以多选');
  assert.equal(hub.act({ t: 'answer', seq: 1, id: SID, req: ask.req, options: [2, 0] }), null);
  ask = get().ask;
  assert.ok(ask?.kind === 'question');
  assert.equal(ask.multi, undefined);
  assert.equal(hub.act({ t: 'answer', seq: 2, id: SID, req: ask.req, text: '右键菜单里' }), null);
  const answers = ((await reply).body as { hookSpecificOutput: { updatedInput: { answers: unknown } } }).hookSpecificOutput.updatedInput.answers;
  assert.deepEqual(answers, { '要支持哪些格式？': 'CSV, XML', '放在哪个菜单？': '右键菜单里' });
});

test('a plan: shown in full, approved (each step still asks), or sent back with what to change', async () => {
  const { hub, send, get } = setup();
  const plan = '## 计划\n\n1. 给购物车加数量字段\n2. 改总价计算\n3. 补测试';
  const input = { plan, planFilePath: 'C:\\Users\\x\\.claude\\plans\\p.md' };
  let reply = send('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: input });
  await settled(reply);
  let ask = get().ask;
  assert.equal(get().state, 'approve');
  assert.ok(ask?.kind === 'plan');
  assert.deepEqual(ask.plan.map((p) => p.text), ['计划', '给购物车加数量字段', '改总价计算', '补测试']);
  assert.equal(ask.until, T0 + 300);
  assert.deepEqual(get().now, { verb: '计划', target: '计划' });

  // Sent back: Claude keeps planning, with the user's words.
  assert.equal(hub.act({ t: 'approve', seq: 1, id: SID, req: ask.req, allow: false, text: '先别动数据库' }), null);
  assert.deepEqual((await reply).body, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: '用户在 CodeTalky 设备上看了计划，要你改：先别动数据库' },
    },
  });
  assert.equal(get().log[0]!.target, '打回：先别动数据库');

  // The revised plan, approved.
  reply = send('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: input });
  await settled(reply);
  ask = get().ask;
  assert.ok(ask?.kind === 'plan');
  assert.equal(hub.act({ t: 'approve', seq: 2, id: SID, req: ask.req, allow: true }), null);
  assert.deepEqual((await reply).body, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] },
    },
  });
  assert.deepEqual([get().state, get().log[0]!.target], ['running', '已批准']);
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
  const backup = mergeHooks(file, claudeHooks(8137, 570));
  assert.equal(backup, `${file}.codetalky.bak`);
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(merged.model, 'opus');
  assert.equal(merged.hooks.Stop.length, 2);
  assert.deepEqual(merged.hooks.PermissionRequest, [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://127.0.0.1:8137/hooks/claude',
          timeout: 600,
          headers: { 'x-codetalky-run': '$CODETALKY_RUN' },
          allowedEnvVars: ['CODETALKY_RUN'],
        },
      ],
    },
  ]);
  // SessionStart takes only command hooks: it goes through the forwarding script.
  const start = merged.hooks.SessionStart[0].hooks[0];
  assert.equal(start.type, 'command');
  assert.match(start.command, /\/hooks\/hook\.mjs" 8137 claude$/);
  mergeHooks(file, claudeHooks(8140, 570)); // again, on another port: replaces, no duplicates
  const again = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(again.hooks.Stop.length, 2);
  assert.equal(again.hooks.SessionStart.length, 1);
  assert.match(again.hooks.SessionStart[0].hooks[0].command, / 8140 claude$/);
  removeHooks(file, claudeHooks(8137, 570));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
  assert.equal(removeHooks(file, claudeHooks(8137, 570)), null);
});

test('a leading cd into the project is left out of the command shown', () => {
  const cwd = 'C:\\Users\\me\\proj';
  assert.equal(dropCd('cd "C:/Users/me/proj" && npm test', cwd), 'npm test');
  assert.equal(dropCd('cd /c/Users/me/proj; ls', cwd), 'ls');
  assert.equal(dropCd("cd 'c:\\users\\me\\proj\\' && git status", cwd), 'git status');
  // Somewhere else: that matters, keep it.
  assert.equal(dropCd('cd ../other && npm test', cwd), 'cd ../other && npm test');
  assert.equal(dropCd('cd /home/me/Proj && ls', '/home/me/proj'), 'cd /home/me/Proj && ls');
  assert.equal(targetOf('Bash', { command: 'cd /home/me/proj && make' }, '/home/me/proj'), 'make');
});

test('a file ending in a newline is not counted one line long', () => {
  const read = (content: string, numLines: number) =>
    claudeTools.resultOf('Read', { file_path: 'a.txt' }, { type: 'text', file: { filePath: 'a.txt', content, numLines } }, undefined).res;
  // What Claude Code sends: it splits on newlines.
  assert.equal(read('zero\n', 2), '1 行');
  assert.equal(read('a\nb', 2), '2 行');
  assert.equal(read('a\nb\n', 3), '2 行');
});

test('a managed Claude run keeps one entry on the device across /clear', async () => {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  hub.attachDevice();
  const runs = new Runs();
  const source = new ClaudeSource(hub, clock, { holdSeconds: 300, log: () => {}, runs });
  const TOKEN = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const remove = runs.add(TOKEN, 'claude', 'D:\\work\\shop', () => {});
  const ID = 'run-dddddddd';
  assert.deepEqual([hub.get(ID)?.name, hub.get(ID)?.reply], ['shop', true]);
  const send = (sid: string, event: string, extra: Record<string, unknown> = {}) =>
    source.handle({ session_id: sid, cwd: 'D:\\work\\shop', hook_event_name: event, ...extra }, { 'x-codetalky-run': TOKEN });
  await send(SID, 'SessionStart', { source: 'startup' });
  await send(SID, 'UserPromptSubmit', { prompt: '第一件事' });
  assert.equal(hub.list().length, 1);
  // /clear: the session ends and a new one starts in the same terminal.
  await send(SID, 'SessionEnd', { reason: 'clear' });
  await send('11111111-2222-4333-8444-555555555555', 'SessionStart', { source: 'clear' });
  await send('11111111-2222-4333-8444-555555555555', 'UserPromptSubmit', { prompt: '第二件事' });
  assert.deepEqual(hub.list().map((s) => [s.id, s.reply, s.log[0]?.target]), [[ID, true, '第二件事']]);
  // Claude exits, then its terminal closes.
  await send('11111111-2222-4333-8444-555555555555', 'SessionEnd', { reason: 'prompt_input_exit' });
  remove();
  assert.equal(hub.get(ID), undefined, 'nothing to keep: it was not done');
  source.stop();
});

test('a managed run that resumes a session already on the device folds its waiting entry into it', async () => {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  hub.attachDevice();
  const runs = new Runs();
  const source = new ClaudeSource(hub, clock, { holdSeconds: 300, log: () => {}, runs });
  const OLD = '99999999-2222-4333-8444-555555555555';
  // The session was worked on in a plain terminal, in a subfolder.
  await source.handle({ session_id: OLD, cwd: 'D:\\work\\shop\\api', hook_event_name: 'UserPromptSubmit', prompt: '先看看' }, {});
  assert.deepEqual([hub.get(OLD)?.name, hub.get(OLD)?.reply], ['api', false]);

  // `codetalky claude` in the project folder: its entry waits for a session; an instruction is sent to it.
  const TOKEN = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const typed: string[] = [];
  const remove = runs.add(TOKEN, 'claude', 'D:\\work\\shop', (m) => {
    if (m.t === 'type') typed.push(m.text);
  });
  const WAITING = 'run-eeeeeeee';
  const send = (sid: string, event: string, extra: Record<string, unknown> = {}) =>
    source.handle({ session_id: sid, cwd: 'D:\\work\\shop', hook_event_name: event, ...extra }, { 'x-codetalky-run': TOKEN });
  // A fresh session starts, then /resume switches the terminal to the old one.
  await send('77777777-2222-4333-8444-555555555555', 'SessionStart', { source: 'startup' });
  await send('77777777-2222-4333-8444-555555555555', 'SessionEnd', { reason: 'resume' });
  assert.equal(hub.get(WAITING)?.state, 'idle');
  await send(OLD, 'SessionStart', { source: 'resume' });

  // One entry: the resumed session, now taking instructions, named after the folder the terminal opened in.
  assert.deepEqual(
    hub.list().map((s) => [s.id, s.name, s.reply]),
    [[OLD, 'shop', true]],
  );
  assert.equal(hub.act({ t: 'reply', seq: 1, id: OLD, text: '继续', how: 'now' }), null);
  assert.deepEqual(typed, ['继续']);
  remove();
  source.stop();
});

test('a managed session heard from before its terminal reconnects is named after where that terminal was opened', async () => {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  hub.attachDevice();
  const runs = new Runs();
  const source = new ClaudeSource(hub, clock, { holdSeconds: 300, log: () => {}, runs });
  const TOKEN = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  // The bridge restarted: the agent's next hook comes first, from a subfolder it cd'd into.
  await source.handle({ session_id: SID, cwd: 'D:\\work\\shop\\api', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { 'x-codetalky-run': TOKEN });
  assert.deepEqual([hub.get(SID)?.name, hub.get(SID)?.reply], ['api', false]);
  const remove = runs.add(TOKEN, 'claude', 'D:\\work\\shop', () => {});
  assert.deepEqual(hub.list().map((s) => [s.id, s.name, s.reply]), [[SID, 'shop', true]]);
  await source.handle({ session_id: SID, cwd: 'D:\\work\\shop\\web', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { 'x-codetalky-run': TOKEN });
  assert.equal(hub.get(SID)?.name, 'shop');
  remove();
  source.stop();
});

test('a managed terminal that reconnects takes instructions again, and stays overnight while open', async () => {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  hub.attachDevice();
  const runs = new Runs();
  const source = new ClaudeSource(hub, clock, { holdSeconds: 300, log: () => {}, runs });
  const TOKEN = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let remove = runs.add(TOKEN, 'claude', 'D:\\work\\shop', () => {});
  const ID = 'run-eeeeeeee';
  const send = (event: string, extra: Record<string, unknown> = {}) =>
    source.handle({ session_id: SID, cwd: 'D:\\work\\shop', hook_event_name: event, ...extra }, { 'x-codetalky-run': TOKEN });
  await send('SessionStart', { source: 'startup' });
  await send('UserPromptSubmit', { prompt: '第一件事' });
  await send('Stop', { last_assistant_message: '好了' });
  // The launcher's connection to the bridge drops and comes back.
  remove();
  assert.equal(hub.get(ID)!.reply, false);
  remove = runs.add(TOKEN, 'claude', 'D:\\work\\shop', () => {});
  assert.deepEqual([hub.list().length, hub.get(ID)!.reply], [1, true]);
  // A quiet night with the terminal open: the session is still there in the morning.
  clock.advance(14 * 3600 * 1000);
  assert.equal(hub.get(ID)?.reply, true);
  // Once its terminal is closed, a quiet session goes as before.
  remove();
  clock.advance(14 * 3600 * 1000);
  assert.equal(hub.get(ID), undefined);
  source.stop();
});

test('an instruction sent while it is working joins that task instead of starting a new one', async () => {
  const { send, get } = setup();
  await send('UserPromptSubmit', { prompt: '改上限' });
  await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } });
  assert.equal(get().n.cmd, 1);
  await send('UserPromptSubmit', { prompt: '顺便跑下测试' });
  assert.deepEqual([get().state, get().n.cmd, get().log[0]!.target, get().log.length], ['running', 1, '顺便跑下测试', 3]);
  await send('Stop', { last_assistant_message: '好了' });
  await send('UserPromptSubmit', { prompt: '下一件事' });
  assert.equal(get().n.cmd, 0, 'a new task after the report starts over');
});

const EXPLORE = { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'Explore' };
const WORKER = { agent_id: 'f0e1d2c3b4a5f6e7d', agent_type: 'general-purpose' };

test('a subagent works as part of its session: marked, only its changes logged, its to-dos its own', async () => {
  const { send, get } = setup();
  await send('UserPromptSubmit', { prompt: '查查购物车哪里用了上限' });
  await send('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: '找用法', status: 'in_progress' }] } });
  await send('PreToolUse', { tool_name: 'Agent', tool_input: { description: '找上限的用法', prompt: '…', subagent_type: 'Explore' } });
  assert.deepEqual(get().now, { verb: 'Agent', target: '找上限的用法' });
  // It works in its own worktree: that is not where the session is.
  const tree = { ...EXPLORE, cwd: 'D:\\work\\shop\\.claude\\worktrees\\agent-a1b2' };
  await send('PreToolUse', { ...tree, tool_name: 'Read', tool_input: { file_path: 'D:\\work\\shop\\.claude\\worktrees\\agent-a1b2\\src\\cart.ts' } });
  assert.deepEqual(get().now, { verb: 'Read', target: 'Explore › src/cart.ts' });
  await send('PreToolUse', { ...tree, tool_name: 'TodoWrite', tool_input: { todos: [{ content: '它自己的', status: 'pending' }] } });
  assert.deepEqual(get().todos, { done: 0, items: ['找用法'] });
  await send('PostToolUse', {
    ...tree,
    tool_name: 'Read',
    tool_input: { file_path: 'D:\\work\\shop\\.claude\\worktrees\\agent-a1b2\\src\\cart.ts' },
    tool_response: { type: 'text', file: { numLines: 88 } },
  });
  await send('PostToolUseFailure', { ...tree, tool_name: 'Grep', tool_input: { pattern: 'max' }, error: 'bad path' });
  await send('PostToolUse', { ...tree, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { interrupted: false } });
  await send('PostToolUse', { tool_name: 'Agent', tool_input: { description: '找上限的用法' }, tool_response: { status: 'completed' } });
  const s = get();
  assert.equal(s.name, 'shop');
  assert.deepEqual(s.n, { read: 1, edit: 0, new: 0, cmd: 1, add: 0, del: 0 });
  assert.deepEqual(
    s.log.slice(0, 3).map((e) => [e.verb, e.target, e.res]),
    [
      ['Agent', '找上限的用法', '完成'],
      ['Bash', 'Explore › npm test', '完成'],
      ['你', '查查购物车哪里用了上限', undefined],
    ],
  );
  await send('Stop', { last_assistant_message: '用在两处。', background_tasks: [], session_crons: [] });
  assert.equal(get().state, 'done');
});

test('a background subagent: the turn ends, the session works on until it reports back', async () => {
  const { hub, send, get } = setup();
  await send('UserPromptSubmit', { prompt: '后台跑测试，你先歇着' });
  await send('PreToolUse', { tool_name: 'Agent', tool_input: { description: '跑全部测试', prompt: '…', run_in_background: true } });
  await send('PostToolUse', { tool_name: 'Agent', tool_input: { description: '跑全部测试' }, tool_response: { status: 'async_launched', agentId: WORKER.agent_id } });
  assert.equal(get().log[0]?.res, '后台');
  const background = [
    { id: 't1', type: 'subagent', status: 'running', description: '跑全部测试', agent_type: 'general-purpose' },
    { id: 't2', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' },
  ];
  await send('Stop', { last_assistant_message: '测试在后台跑，跑完告诉你。', background_tasks: background });
  let s = get();
  assert.equal(s.state, 'running');
  assert.deepEqual(s.now, { verb: 'Agent', target: '后台：跑全部测试' });
  assert.equal(s.say, '测试在后台跑，跑完告诉你。');
  await send('PreToolUse', { ...WORKER, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.deepEqual(get().now, { verb: 'Bash', target: '子代理 › npm test' });

  // It asks for something; the session's own turn ending again doesn't take that off the device.
  const asked = send('PermissionRequest', { ...WORKER, tool_name: 'Bash', tool_input: { command: 'npm run e2e' }, tool_use_id: 'toolu_9' });
  assert.equal(await settled(asked), 'pending');
  s = get();
  assert.equal(s.state, 'approve');
  assert.ok(s.ask?.kind === 'approve');
  assert.equal(s.ask.why, '子代理要做这一步');
  await send('Stop', { last_assistant_message: '还在等。', background_tasks: background });
  assert.equal(await settled(asked), 'pending');
  assert.equal(get().state, 'approve');
  const req = get().ask!.req;
  hub.act({ t: 'approve', seq: 1, id: SID, req, allow: true });
  assert.deepEqual(await asked, { status: 200, body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } });
  assert.equal(get().state, 'running');

  // Done: Claude Code wakes the session with its report (not the user's words, not a new task)...
  const counts = get().n;
  await send('UserPromptSubmit', {
    prompt: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "跑全部测试" finished</summary>\n</task-notification>',
  });
  assert.deepEqual([get().log[0]?.verb, get().log[0]?.target], ['后台', 'Agent "跑全部测试" finished']);
  assert.deepEqual(get().n, counts);
  // ...and it stops for good.
  await send('Stop', { last_assistant_message: '测试全过了。', background_tasks: background.slice(1) });
  s = get();
  assert.equal(s.state, 'done');
  assert.equal(s.now, undefined);
  // A background shell (a dev server) never counted: the session is done.
});

test('waiting at the computer for one agent: another agent working says nothing about it', async () => {
  const { send, get } = setup(false); // no device: requests go to the terminal
  await send('UserPromptSubmit', { prompt: '两个子代理一起干' });
  await send('Notification', { ...EXPLORE, notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(get().there, true);
  await send('PreToolUse', { ...WORKER, tool_name: 'Read', tool_input: { file_path: 'D:\\work\\shop\\a.ts' } });
  await send('PostToolUse', { tool_name: 'Glob', tool_input: { pattern: '*.ts' }, tool_response: {} });
  assert.equal(get().there, true, 'still waiting for the Explore agent’s answer');
  await send('PostToolUse', { ...EXPLORE, tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, tool_response: {} });
  assert.equal(get().there, undefined);
});

test('a subagent seen first (the bridge started meanwhile) shows its session at work; its hand-back is not the user', async () => {
  const { send, get } = setup();
  await send('PreToolUse', {
    ...WORKER,
    transcript_path: 'D:\\nowhere\\0b7c6a52.jsonl',
    tool_name: 'Grep',
    tool_input: { pattern: 'max' },
  });
  assert.equal(get().state, 'running');
  assert.deepEqual(get().now, { verb: 'Grep', target: '子代理 › max' });
  await send('UserPromptSubmit', { prompt: '<agent-message from="f0e1d2c3b4a5f6e7d">\n  找到了两处\n</agent-message>' });
  assert.deepEqual([get().log[0]?.verb, get().log[0]?.target], ['Agent', '子代理交回结果']);
  assert.equal(get().log.some((e) => e.verb === '你'), false);
});

test('the option Claude suggests reads “（推荐）” on the device; the answer keeps its own label', async () => {
  const { hub, send, get } = setup();
  const reply = send('PreToolUse', {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '现在解冻吗？', header: '解冻', multiSelect: false, options: [{ label: '现在解冻 (Recommended)', description: '马上摘标签' }, { label: '等全部做完' }] }] },
  });
  const ask = get().ask;
  assert.ok(ask?.kind === 'question');
  assert.deepEqual(ask.options.map((o) => o.label), ['现在解冻（推荐）', '等全部做完']);
  hub.act({ t: 'answer', seq: 1, id: SID, req: ask.req, option: 0 });
  const body = (await reply).body as { hookSpecificOutput: { updatedInput: { answers: Record<string, string> } } };
  assert.deepEqual(body.hookSpecificOutput.updatedInput.answers, { '现在解冻吗？': '现在解冻 (Recommended)' });
});
