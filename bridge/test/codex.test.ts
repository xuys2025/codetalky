import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HOOK_SCRIPT, codexHooks } from '../src/claude/hooks.ts';
import { ClaudeSource } from '../src/claude/source.ts';
import { ManualClock } from '../src/clock.ts';
import { parsePatch } from '../src/codex/patch.ts';
import { codexTools } from '../src/codex/tools.ts';
import { Hub } from '../src/hub.ts';

const T0 = 1_794_637_920;
const SID = '019a0c5e-7b1d-7f00-9c11-2b4f6a8d0e33';

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/cart.ts',
  '@@ export function total(items) {',
  '   let sum = 0;',
  '-  for (const it of items) sum += it.price;',
  '+  for (const it of items) sum += it.price * (it.qty ?? 1);',
  '   return sum;',
  '*** Add File: test/cart.test.ts',
  "+import { total } from '../src/cart.ts';",
  '+test();',
  '*** Delete File: old.js',
  '*** End Patch',
].join('\n');

test('apply_patch patches are read into files and hunks', () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(
    files.map((f) => [f.st, f.path, f.add, f.del, f.hunks.length]),
    [
      ['M', 'src/cart.ts', 1, 1, 1],
      ['A', 'test/cart.test.ts', 2, 0, 1],
      ['D', 'old.js', 0, 0, 0],
    ],
  );
  assert.deepEqual(files[0]!.hunks[0], [
    '   let sum = 0;',
    '-  for (const it of items) sum += it.price;',
    '+  for (const it of items) sum += it.price * (it.qty ?? 1);',
    '   return sum;',
  ]);
  assert.equal(parsePatch('*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n-x\n+y\n*** End Patch')[0]!.moveTo, 'b');
});

test('Codex tools look like Claude ones on the device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'cart.ts'), 'export function total(items) {\n  let sum = 0;\n  for (const it of items) sum += it.price;\n  return sum;\n}\n');
  const input = { command: PATCH };
  assert.equal(codexTools.verbOf('apply_patch'), 'Edit');
  assert.equal(codexTools.targetOf('apply_patch', input, dir), 'src/cart.ts 等 3 个文件');
  const ask = codexTools.askOf('apply_patch', input, dir);
  assert.equal(ask.add, 3);
  assert.equal(ask.del, 1);
  assert.equal(ask.line, 2, 'found where the hunk starts in the file');
  assert.equal(ask.lines?.length, 4);
  const shell = codexTools.askOf('Bash', { command: 'git push origin main', description: '推送' }, dir);
  assert.deepEqual(shell, { verb: 'Bash', target: 'git push origin main', why: '推送', risky: true });
  assert.equal(codexTools.targetOf('Bash', { command: ['bash', '-lc', 'npm test'] }, dir), 'npm test');
  const failed = codexTools.resultOf('Bash', { command: 'npm test' }, { exit_code: 1 }, dir);
  assert.deepEqual([failed.res, failed.bad], ['退出 1', true]);
});

test('a Codex session: approval held for the device, patch recorded, report shown', async () => {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  hub.attachDevice();
  const codex = new ClaudeSource(hub, clock, { holdSeconds: 300, log: () => {}, agent: 'codex', tools: codexTools });
  const send = (event: string, extra: Record<string, unknown> = {}) =>
    codex.handle({ session_id: SID, cwd: tmpdir(), model: 'gpt-5.5-codex', hook_event_name: event, ...extra });
  await send('SessionStart', { source: 'startup' });
  let s = hub.get(SID)!;
  assert.equal(s.agent, 'codex');
  assert.equal(s.model, 'gpt-5.5-codex');
  await send('UserPromptSubmit', { turn_id: 't1', prompt: '支持数量' });

  const reply = codex.handle({
    session_id: SID,
    cwd: tmpdir(),
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: '跑测试' },
  });
  s = hub.get(SID)!;
  assert.equal(s.state, 'approve');
  assert.ok(s.ask?.kind === 'approve');
  hub.act({ t: 'approve', seq: 1, id: SID, req: s.ask.req, allow: true });
  assert.deepEqual((await reply).body, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });

  await send('PostToolUse', { tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_response: 'Success' });
  s = hub.get(SID)!;
  assert.deepEqual(s.n, { read: 0, edit: 1, new: 0, cmd: 0, add: 3, del: 1 });
  assert.deepEqual(
    s.files.map((f) => [f.st, f.path]),
    [
      ['D', 'old.js'],
      ['A', 'test/cart.test.ts'],
      ['M', 'src/cart.ts'],
    ],
  );
  assert.equal(s.log[0]!.target, 'cart.ts 等 3 个文件');
  assert.equal(s.hunks.total, 2);

  await send('Stop', { turn_id: 't1', stop_hook_active: false, last_assistant_message: '改好了：\n- 每项按数量累加' });
  s = hub.get(SID)!;
  assert.equal(s.state, 'done');
  assert.deepEqual(s.report, [{ text: '改好了：' }, { b: true, text: '每项按数量累加' }]);
  codex.stop();
});

test('Codex hook settings call the forwarding script with the port', () => {
  const set = codexHooks(8137, 570);
  const handler = set.hooks.PermissionRequest![0]!.hooks[0]!;
  assert.equal(handler.type, 'command');
  assert.match(handler.command!, /\/hooks\/hook\.mjs" 8137 codex$/);
  assert.equal(handler.timeout, 600);
  assert.equal(set.hooks.SessionEnd![0]!.hooks[0]!.timeout, 3);
  assert.equal(set.isOurs(handler), true);
  // Set up earlier on another port, or with the script's old name: still ours, so it gets replaced.
  assert.equal(set.isOurs({ type: 'command', command: 'node "D:/x/bridge/hooks/codex-hook.mjs" 8140' }), true);
  assert.equal(set.isOurs({ type: 'command', command: 'node "D:/x/bridge/hooks/hook.mjs" 8137 claude' }), false);
  assert.equal(set.isOurs({ type: 'command', command: 'python other.py' }), false);
});

function runHook(port: number, input: string, env: Record<string, string> = {}, args: string[] = []): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, String(port), ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', () => resolve(out.trim()));
    child.stdin.end(input);
  });
}

test('the forwarding script passes the event and the run token, and the answer back', async () => {
  let got: { path: unknown; body: string; run: unknown } | null = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got = { path: req.url, body, run: req.headers['x-codetalky-run'] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no"}}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const out = await runHook(port, '{"hook_event_name":"PermissionRequest"}', { CODETALKY_RUN: 'tok' }, ['codex']);
    assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'deny');
    assert.deepEqual(got, { path: '/hooks/codex', body: '{"hook_event_name":"PermissionRequest"}', run: 'tok' });
    // Claude Code's SessionStart goes through the same script, to its own endpoint.
    await runHook(port, '{"hook_event_name":"SessionStart"}', { CODETALKY_RUN: 'tok2' }, ['claude']);
    assert.deepEqual(got, { path: '/hooks/claude', body: '{"hook_event_name":"SessionStart"}', run: 'tok2' });
  } finally {
    server.close();
  }
});

test('with no bridge running, the forwarding script stays out of the way', async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  server.close(); // nothing listens there now
  assert.equal(await runHook(port, '{"hook_event_name":"Stop"}'), '{}');
});
