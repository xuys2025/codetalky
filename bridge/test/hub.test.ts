import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualClock } from '../src/clock.ts';
import { Hub, type SessionControl } from '../src/hub.ts';
import type { SessionSnapshot } from '../src/protocol.ts';

const T0 = 1_794_637_920;

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    name: 'demo',
    agent: 'claude',
    model: 'opus-5.5',
    state: 'running',
    since: T0,
    started: T0,
    reply: true,
    n: { read: 0, edit: 0, new: 0, cmd: 0, add: 0, del: 0 },
    log: [],
    files: [],
    hunks: { total: 0, list: [] },
    ...over,
  };
}

function setup(over: Partial<SessionSnapshot> = {}, control: SessionControl = {}) {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  const calls: string[] = [];
  hub.put(snapshot(over), {
    decide: (req, allow, text) => calls.push(`decide ${req} ${allow}${text ? ` ${text}` : ''}`),
    answer: (req, choice) => calls.push(`answer ${req} ${'option' in choice ? choice.option : JSON.stringify(choice)}`),
    reply: (text) => calls.push(`reply ${text}`),
    ...control,
  });
  return { clock, hub, calls };
}

const approving: Partial<SessionSnapshot> = {
  state: 'approve',
  ask: { kind: 'approve', req: 'r1', verb: 'Edit', target: 'a.ts', until: T0 + 600 },
};

test('unknown session is gone', () => {
  const { hub } = setup();
  assert.equal(hub.act({ t: 'seen', seq: 1, id: 'nope' }), 'gone');
});

test('approve goes to the source when the request matches', () => {
  const { hub, calls } = setup(approving);
  assert.equal(hub.act({ t: 'approve', seq: 1, id: 's1', req: 'r1', allow: true }), null);
  assert.deepEqual(calls, ['decide r1 true']);
});

test('approve of another request is stale', () => {
  const { hub, calls } = setup(approving);
  assert.equal(hub.act({ t: 'approve', seq: 1, id: 's1', req: 'r0', allow: true }), 'stale');
  assert.deepEqual(calls, []);
});

test('approve after the deadline is stale', () => {
  const { hub, clock, calls } = setup(approving);
  clock.advance(601_000);
  assert.equal(hub.act({ t: 'approve', seq: 1, id: 's1', req: 'r1', allow: true }), 'stale');
  assert.deepEqual(calls, []);
});

test('approve when not waiting is stale', () => {
  const { hub } = setup();
  assert.equal(hub.act({ t: 'approve', seq: 1, id: 's1', req: 'r1', allow: false }), 'stale');
});

test('answer checks the request and the option', () => {
  const { hub, calls } = setup({
    state: 'question',
    ask: { kind: 'question', req: 'r2', text: '?', options: [{ label: 'a' }, { label: 'b' }] },
  });
  assert.equal(hub.act({ t: 'answer', seq: 1, id: 's1', req: 'r2', option: 2 }), 'bad');
  assert.equal(hub.act({ t: 'answer', seq: 2, id: 's1', req: 'r9', option: 0 }), 'stale');
  assert.equal(hub.act({ t: 'answer', seq: 3, id: 's1', req: 'r2', option: 1 }), null);
  assert.deepEqual(calls, ['answer r2 1']);
});

test('several options only for a multi-select question; own words for any', () => {
  const single = setup({ state: 'question', ask: { kind: 'question', req: 'r2', text: '?', options: [{ label: 'a' }, { label: 'b' }] } });
  assert.equal(single.hub.act({ t: 'answer', seq: 1, id: 's1', req: 'r2', options: [0, 1] }), 'bad');
  assert.equal(single.hub.act({ t: 'answer', seq: 2, id: 's1', req: 'r2', text: '  ' }), 'bad');
  assert.equal(single.hub.act({ t: 'answer', seq: 3, id: 's1', req: 'r2', text: ' 都不要 ' }), null);
  assert.deepEqual(single.calls, ['answer r2 {"text":"都不要"}']);

  const multi = setup({ state: 'question', ask: { kind: 'question', req: 'r3', text: '?', multi: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] } });
  assert.equal(multi.hub.act({ t: 'answer', seq: 1, id: 's1', req: 'r3', options: [0, 3] }), 'bad');
  assert.equal(multi.hub.act({ t: 'answer', seq: 2, id: 's1', req: 'r3', options: [2, 0, 2] }), null);
  assert.deepEqual(multi.calls, ['answer r3 {"options":[0,2]}'], 'in order, once each');
});

test('a plan is approved like a request, and can be sent back with what to change', () => {
  const plan: Partial<SessionSnapshot> = { state: 'approve', ask: { kind: 'plan', req: 'p1', plan: [{ text: '先改 A' }], until: T0 + 600 } };
  const { hub, calls } = setup(plan);
  assert.equal(hub.act({ t: 'approve', seq: 1, id: 's1', req: 'p1', allow: true, text: '好' }), 'bad', 'words only go with a no');
  assert.equal(hub.act({ t: 'approve', seq: 2, id: 's1', req: 'p1', allow: false, text: ' 先别动数据库 ' }), null);
  assert.deepEqual(calls, ['decide p1 false 先别动数据库']);
});

test('reply is trimmed and length-checked', () => {
  const { hub, calls } = setup();
  assert.equal(hub.act({ t: 'reply', seq: 1, id: 's1', text: '   ' }), 'bad');
  assert.equal(hub.act({ t: 'reply', seq: 2, id: 's1', text: 'x'.repeat(2001) }), 'bad');
  assert.equal(hub.act({ t: 'reply', seq: 3, id: 's1', text: ' 跑一下测试 ' }), null);
  assert.deepEqual(calls, ['reply 跑一下测试']);
});

test('reply to a session that cannot take instructions is unsupported', () => {
  const { hub, calls } = setup({ reply: false });
  assert.equal(hub.act({ t: 'reply', seq: 1, id: 's1', text: '继续' }), 'unsupported');
  assert.deepEqual(calls, []);
});

test('seen turns done into idle', () => {
  const { hub, clock } = setup({ state: 'done', since: T0 - 60 });
  clock.advance(5_000);
  assert.equal(hub.act({ t: 'seen', seq: 1, id: 's1' }), null);
  assert.equal(hub.get('s1')?.state, 'idle');
  assert.equal(hub.get('s1')?.since, T0 + 5);
});

test('subscribers hear about changes and removals', () => {
  const { hub } = setup();
  const events: string[] = [];
  const off = hub.subscribe((e) => events.push(e.type === 'devices' ? e.type : `${e.type} ${e.id}`));
  hub.update('s1', (s) => {
    s.say = 'hi';
  });
  hub.remove('s1');
  off();
  hub.put(snapshot({ id: 's2' }), {});
  assert.deepEqual(events, ['changed s1', 'removed s1']);
});

test('the hub counts devices that are connected', () => {
  const { hub } = setup();
  const detachA = hub.attachDevice();
  const detachB = hub.attachDevice();
  assert.equal(hub.devices(), 2);
  detachA();
  detachA();
  assert.equal(hub.devices(), 1);
  detachB();
  assert.equal(hub.devices(), 0);
});

test('ids longer than the device can hold are refused', () => {
  const { hub } = setup();
  assert.throws(() => hub.put(snapshot({ id: '会'.repeat(16) }), {}));
});
