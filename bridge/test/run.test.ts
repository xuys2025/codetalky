import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { ClaudeSource } from '../src/claude/source.ts';
import { realClock } from '../src/clock.ts';
import { Hub } from '../src/hub.ts';
import { asKeys } from '../src/run.ts';
import { Runs, parseFromRun } from '../src/runs.ts';
import { startServer } from '../src/server.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

async function until(what: string, ok: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('instructions become one line of keystrokes', () => {
  assert.equal(asKeys('  跑一下测试 \n然后提交\n'), '跑一下测试 然后提交');
  assert.equal(asKeys('a\x1b[2Jb\x07'), 'a[2Jb');
});

test('launchers must say hello with a run token', () => {
  assert.equal(parseFromRun('{"t":"hello","run":"nope"}'), null);
  assert.deepEqual(parseFromRun('{"t":"hello","run":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","agent":"claude","cwd":"D:\\\\x"}'), {
    t: 'hello',
    run: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    agent: 'claude',
    cwd: 'D:\\x',
  });
});

test('a managed run: the device types into the agent running in its terminal', { timeout: 60000 }, async () => {
  const hub = new Hub(realClock);
  const runs = new Runs();
  const claude = new ClaudeSource(hub, realClock, { holdSeconds: 60, log: () => {}, runs });
  const server = await startServer(hub, realClock, {
    host: '127.0.0.1',
    port: 0,
    simDir: null,
    post: { '/hooks/claude': (body, headers) => claude.handle(body, headers) },
    runs,
    hostName: '测试机',
    hostId: 'test',
    quick: [],
    tzMinutes: 0,
    flushMs: 50,
    log: () => {},
  });
  const env = { ...process.env, CODETALKY_PORT: String(server.port), FAKE_PORT: String(server.port) };
  const launcher = spawn(process.execPath, [MAIN, 'run', '--', process.execPath, FAKE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let screen = '';
  launcher.stdout.on('data', (d: Buffer) => (screen += d.toString('utf8')));
  const exited = new Promise<number | null>((r) => launcher.on('exit', (code) => r(code)));
  try {
    await until('the session to become managed', () => hub.list().some((s) => s.reply));
    const session = hub.list().find((s) => s.reply)!;
    assert.equal(session.agent, 'claude');

    assert.equal(hub.act({ t: 'reply', seq: 1, id: session.id, text: '跑一下测试' }), null);
    await until('the agent to get the line', () => screen.includes('got: 跑一下测试'));
    await until('the prompt in the log', () => hub.get(session.id)!.log.some((e) => e.verb === '你' && e.target === '跑一下测试'));

    // The user's own keyboard still works: the launcher passes it through.
    launcher.stdin.write('exit\r');
    assert.equal(await exited, 0);
    await until('replies to be turned off', () => hub.get(session.id)!.reply === false);
    assert.equal(hub.act({ t: 'reply', seq: 2, id: session.id, text: '还在吗' }), 'unsupported');
  } finally {
    launcher.kill();
    claude.stop();
    await server.close();
  }
});
