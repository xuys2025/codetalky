import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualClock } from '../src/clock.ts';
import { FakeAgent } from '../src/fake/engine.ts';
import { DEMO_T0, demoScripts } from '../src/fake/scenario.ts';
import { Hub } from '../src/hub.ts';
import { LIMITS, type SessionSnapshot } from '../src/protocol.ts';

/** Characters of code that fit in the device's diff box (18 px JetBrains Mono, 480 px screen). */
const DIFF_COLUMNS = 37;
/** Monospace columns: CJK and other wide characters take two. */
const columns = (text: string) => [...text].reduce((n, ch) => n + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);

/** Everything a snapshot promises the device, checked after every change. */
function checkSnapshot(s: SessionSnapshot): void {
  const where = `${s.id} (${s.state})`;
  assert.ok(Buffer.byteLength(s.id) <= LIMITS.id, where);
  assert.equal(
    s.files.reduce((sum, f) => sum + f.add, 0),
    s.n.add,
    `${where}: files add up to n.add`,
  );
  assert.equal(
    s.files.reduce((sum, f) => sum + f.del, 0),
    s.n.del,
    `${where}: files add up to n.del`,
  );
  for (let i = 1; i < s.log.length; i++) {
    assert.ok(s.log[i - 1]!.at >= s.log[i]!.at, `${where}: log is newest first`);
  }
  assert.ok(s.hunks.list.length <= s.hunks.total, `${where}: hunk total`);
  const allLines = [...s.hunks.list.flatMap((h) => h.lines), ...(s.ask?.kind === 'approve' ? (s.ask.lines ?? []) : [])];
  for (const line of allLines) assert.match(line, /^[ +-]/, `${where}: diff line "${line}"`);
  for (const h of s.hunks.list) assert.ok(h.lines.length <= LIMITS.hunkLines, `${where}: hunk fits without trimming`);
  for (const line of allLines) {
    assert.ok(columns(line.slice(1)) <= DIFF_COLUMNS, `${where}: diff line too wide for the screen: "${line}"`);
  }
  if (s.todos) assert.ok(s.todos.done <= s.todos.items.length, `${where}: todos`);
  assert.ok(s.since >= s.started || s.state === 'approve' || s.state === 'question', `${where}: since after started`);
  switch (s.state) {
    case 'approve':
      assert.equal(s.ask?.kind, 'approve', where);
      break;
    case 'question':
      assert.equal(s.ask?.kind, 'question', where);
      break;
    case 'done':
      assert.ok(s.report && s.report.length > 0, `${where}: has a report`);
      break;
    case 'error':
      assert.ok(s.err, `${where}: has a reason`);
      break;
    default:
      assert.equal(s.ask, undefined, `${where}: no stale ask`);
  }
}

function demo() {
  const clock = new ManualClock(DEMO_T0 * 1000);
  const hub = new Hub(clock);
  const changes: string[] = [];
  hub.subscribe((e) => {
    const s = hub.get(e.id);
    if (s) checkSnapshot(s);
    changes.push(e.id);
  });
  const agents = demoScripts().map((script) => new FakeAgent(hub, clock, script));
  for (const s of hub.list()) checkSnapshot(s);
  const get = (id: string) => {
    const s = hub.get(id);
    assert.ok(s, id);
    return s;
  };
  /** Advance a second at a time until `done` holds; fails after `limit` seconds. */
  const until = (what: string, done: () => boolean, limit = 600) => {
    for (let i = 0; i < limit && !done(); i++) clock.advance(1000);
    assert.ok(done(), `timed out waiting for ${what}`);
  };
  const req = (id: string) => {
    const ask = get(id).ask;
    assert.ok(ask, `${id} is asking`);
    return ask.req;
  };
  return { clock, hub, agents, changes, get, until, req };
}

test('the demo opens the way the mockups look', () => {
  const { get } = demo();
  const t0 = DEMO_T0;
  assert.equal(get('codetalky').state, 'approve');
  assert.equal(get('codetalky').since, t0 - 120);
  assert.deepEqual(
    { ...get('codetalky').n },
    { read: 12, edit: 3, new: 1, cmd: 2, add: 86, del: 21 },
  );
  assert.equal(get('blog-engine').state, 'question');
  assert.equal(get('blog-engine').since, t0 - 300);
  assert.equal(get('firmware').state, 'running');
  assert.equal(get('firmware').n.add, 132);
  assert.equal(get('firmware').n.del, 40);
  assert.equal(get('landing').state, 'running');
  assert.equal(get('api-server').state, 'done');
  assert.equal(get('api-server').since - get('api-server').started, 12.5 * 60);
  assert.deepEqual({ read: get('api-server').n.read, edit: get('api-server').n.edit }, { read: 9, edit: 5 });
  assert.equal(get('docs-site').state, 'error');
  assert.equal(get('docs-site').reply, false);
});

test('codetalky: approve, then it tests, commits and reports', () => {
  const { hub, get, until, req } = demo();
  assert.equal(hub.act({ t: 'approve', seq: 1, id: 'codetalky', req: req('codetalky'), allow: true }), null);
  assert.equal(get('codetalky').state, 'running');
  until('report', () => get('codetalky').state === 'done');
  const s = get('codetalky');
  assert.equal(s.report?.[0]?.text, '设备上的批准现在来得及点了。');
  assert.equal(s.todos?.done, 5);
  assert.ok(s.files.some((f) => f.path === 'test/hooks.test.ts' && f.st === 'A'));
  assert.equal(s.hunks.list[0]?.file, 'test/hooks.test.ts');
});

test('codetalky: deny twice, and it writes the ideas down instead', () => {
  const { hub, get, until, req } = demo();
  const first = req('codetalky');
  hub.act({ t: 'approve', seq: 1, id: 'codetalky', req: first, allow: false });
  // It says why first, so the refusal is the second entry.
  assert.equal(get('codetalky').log[1]?.res, '已拒绝');
  until('second request', () => get('codetalky').state === 'approve');
  const second = req('codetalky');
  assert.notEqual(second, first);
  const ask = get('codetalky').ask;
  assert.equal(ask?.kind === 'approve' && ask.add, 3);
  assert.equal(hub.act({ t: 'approve', seq: 2, id: 'codetalky', req: first, allow: true }), 'stale');
  hub.act({ t: 'approve', seq: 3, id: 'codetalky', req: second, allow: false });
  until('report', () => get('codetalky').state === 'done');
  assert.equal(get('codetalky').report?.[0]?.text, '钩子代码没有改。');
});

test('codetalky: nobody answers, so the hook gives up after 600 s', () => {
  const { get, until } = demo();
  until('timeout', () => get('codetalky').log.some((e) => e.target === '没等到批准，这一步先跳过。'), 481);
  until('second request', () => get('codetalky').state === 'approve');
});

test('blog-engine: every answer leads to a report', () => {
  const reports = [0, 1, 2].map((option) => {
    const { hub, get, until, req } = demo();
    assert.equal(hub.act({ t: 'answer', seq: 1, id: 'blog-engine', req: req('blog-engine'), option }), null);
    assert.equal(get('blog-engine').log[1]?.verb, '答');
    until('report', () => get('blog-engine').state === 'done');
    return get('blog-engine').report?.[0]?.text;
  });
  assert.equal(new Set(reports).size, 3);
});

test('firmware: tests fail, get fixed, then a push needs a long press', () => {
  const { hub, get, until, req } = demo();
  until('push request', () => get('firmware').state === 'approve', 120);
  const ask = get('firmware').ask;
  assert.ok(ask?.kind === 'approve');
  assert.equal(ask.verb, 'Bash');
  assert.equal(ask.target, 'git push origin fix/refresh');
  assert.equal(ask.risky, true);
  assert.equal(ask.lines, undefined);
  assert.ok(get('firmware').log.some((e) => e.target === 'pytest tests/refresh' && e.res === '6 个全过'));
  hub.act({ t: 'approve', seq: 1, id: 'firmware', req: req('firmware'), allow: true });
  until('report', () => get('firmware').state === 'done');
  assert.equal(get('firmware').report?.at(-1)?.text, '已推送到 fix/refresh，可以开合并请求了。');
});

test('landing finishes by itself', () => {
  const { get, until } = demo();
  until('report', () => get('landing').state === 'done', 120);
});

test('docs-site recovers after 50 s and cannot take instructions', () => {
  const { hub, clock, get, until } = demo();
  assert.equal(hub.act({ t: 'reply', seq: 1, id: 'docs-site', text: '继续下一步' }), 'unsupported');
  clock.advance(49_000);
  assert.equal(get('docs-site').state, 'error');
  clock.advance(1_000);
  assert.equal(get('docs-site').state, 'running');
  assert.equal(get('docs-site').err, undefined);
  until('report', () => get('docs-site').state === 'done', 120);
});

test('api-server: a reply starts another round, quick replies do what they say', () => {
  const { hub, clock, get, until } = demo();
  assert.equal(hub.act({ t: 'seen', seq: 1, id: 'api-server' }), null);
  assert.equal(get('api-server').state, 'idle');
  clock.advance(10_000);
  assert.equal(hub.act({ t: 'reply', seq: 2, id: 'api-server', text: '继续下一步' }), null);
  const s = get('api-server');
  assert.equal(s.state, 'running');
  assert.equal(s.started, DEMO_T0 + 10);
  assert.equal(s.report, undefined);
  assert.equal(s.log[1]?.verb, '你');
  until('frontend report', () => get('api-server').state === 'done');
  assert.equal(get('api-server').report?.[0]?.text, '前端订单列表接上分页了，每页 20 条。');
  hub.act({ t: 'reply', seq: 3, id: 'api-server', text: '提交这些改动' });
  until('commit', () => get('api-server').state === 'done');
  assert.equal(get('api-server').log[0]?.res, '已提交');
});

test('a reply while busy is queued, not lost', () => {
  const { hub, get, until } = demo();
  assert.equal(get('landing').state, 'running');
  assert.equal(hub.act({ t: 'reply', seq: 1, id: 'landing', text: '跑一下测试' }), null);
  assert.equal(get('landing').log[0]?.verb, '你');
  until('acknowledgement', () => get('landing').say?.startsWith('收到') === true, 30);
});

test('stop() leaves a session where it is', () => {
  const { agents, clock, get } = demo();
  const before = get('landing').log.length;
  for (const agent of agents) agent.stop();
  clock.advance(600_000);
  assert.equal(get('landing').log.length, before);
});
