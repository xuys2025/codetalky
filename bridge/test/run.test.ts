import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { ClaudeSource } from '../src/claude/source.ts';
import { realClock } from '../src/clock.ts';
import { Hub } from '../src/hub.ts';
import { asKeys, resolveCommand } from '../src/run.ts';
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
  let token = '';
  runs.subscribe((e) => (token = e.run));
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

    // Keys for the agent's own prompt are pressed only while that prompt is on its screen.
    assert.equal(await runs.press(token, 'y\r', 'Yes, proceed'), false);
    hub.act({ t: 'reply', seq: 2, id: session.id, text: 'ask' });
    await until('the prompt on the screen', () => screen.includes('Yes, proceed'));
    // An instruction sent meanwhile is not typed into the prompt (its Enter would answer it): it waits.
    hub.act({ t: 'reply', seq: 3, id: session.id, text: '等会儿再说' });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(screen.includes('got: 等会儿再说'), false);
    // A prompt is up, but for another command than the one the device answered: nothing is pressed.
    assert.equal(await runs.press(token, 'y\r', 'Yes, proceed', 'rm -rf build'), false);
    assert.equal(await runs.press(token, 'y\r', 'Yes, proceed', 'npm test'), true);
    await until('the key to arrive', () => screen.includes('got: y'));
    await until('the waiting instruction, once the prompt is gone', () => screen.includes('got: 等会儿再说'));

    // The user's own keyboard still works: the launcher passes it through.
    launcher.stdin.write('exit\r');
    assert.equal(await exited, 0);
    await until('replies to be turned off', () => hub.get(session.id)!.reply === false);
    assert.equal(hub.act({ t: 'reply', seq: 4, id: session.id, text: '还在吗' }), 'unsupported');
  } finally {
    launcher.kill();
    claude.stop();
    await server.close();
  }
});

test('a hook that hangs up is noticed, so its held request can go', async () => {
  const hub = new Hub(realClock);
  let hungUp = false;
  const server = await startServer(hub, realClock, {
    host: '127.0.0.1',
    port: 0,
    simDir: null,
    post: {
      '/hooks/claude': (_body, _headers, gone) =>
        new Promise((resolve) => gone.addEventListener('abort', () => ((hungUp = true), resolve({ status: 200 })))),
    },
    hostName: '测试机',
    hostId: 'test',
    quick: [],
    tzMinutes: 0,
    flushMs: 50,
    log: () => {},
  });
  try {
    const caller = new AbortController();
    const call = fetch(`http://127.0.0.1:${server.port}/hooks/claude`, { method: 'POST', body: '{}', signal: caller.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hungUp, false);
    caller.abort();
    await call;
    await until('the server to notice', () => hungUp, 3000);
  } finally {
    await server.close();
  }
});

test('a request the server cannot read is refused, and the server stays up', async () => {
  const hub = new Hub(realClock);
  const server = await startServer(hub, realClock, {
    host: '127.0.0.1',
    port: 0,
    simDir: null,
    hostName: '测试机',
    hostId: 'test',
    quick: [],
    tzMinutes: 0,
    flushMs: 50,
    log: () => {},
  });
  try {
    const raw = (request: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(server.port, '127.0.0.1', () => socket.end(request));
        let got = '';
        socket.on('data', (d) => (got += d.toString()));
        socket.on('close', () => resolve(got));
        socket.on('error', () => resolve(got));
      });
    assert.match(await raw('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n'), /^HTTP\/1\.1 400/);
    assert.match(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'), /^HTTP\/1\.1 400/);
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 404, 'still answering');
  } finally {
    await server.close();
  }
});

test('npm shims on Windows are run without cmd.exe', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-shim-'));
  mkdirSync(join(dir, 'node_modules', 'a', 'bin'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'b', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'a', 'bin', 'a.exe'), '');
  writeFileSync(join(dir, 'node_modules', 'b', 'bin', 'b.js'), '');
  writeFileSync(join(dir, 'a.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\a\\bin\\a.exe"   %*\r\n');
  // What npm writes for a JavaScript bin (Codex's), node.exe check included.
  writeFileSync(
    join(dir, 'b.cmd'),
    [
      '@ECHO off',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\b\\bin\\b.js" %*',
      '',
    ].join('\r\n'),
  );
  writeFileSync(join(dir, 'c.cmd'), '@ECHO off\r\necho hi\r\n');
  const env = { PATH: dir };
  assert.deepEqual(resolveCommand('a', env), { file: join(dir, 'node_modules', 'a', 'bin', 'a.exe'), prefix: [] });
  assert.deepEqual(resolveCommand('b', env), { file: process.execPath, prefix: [join(dir, 'node_modules', 'b', 'bin', 'b.js')] });
  assert.deepEqual(resolveCommand('c', env).prefix.slice(0, 3), ['/d', '/s', '/c']);
});
