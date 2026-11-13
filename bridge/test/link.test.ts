import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualClock } from '../src/clock.ts';
import { Hub } from '../src/hub.ts';
import { DeviceLink, forDevice } from '../src/link.ts';
import type { SessionSnapshot, ToDevice } from '../src/protocol.ts';

const T0 = 1_794_637_920;

function snapshot(id: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    name: id,
    agent: 'codex',
    model: 'gpt-5',
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

function setup() {
  const clock = new ManualClock(T0 * 1000);
  const hub = new Hub(clock);
  const out: ToDevice[] = [];
  const link = new DeviceLink(hub, clock, (text) => out.push(JSON.parse(text) as ToDevice), {
    quick: ['继续下一步'],
    tzMinutes: 480,
    flushMs: 150,
  });
  return { clock, hub, link, out };
}

const hello = JSON.stringify({ t: 'hello', proto: 1, device: 'test' });
const kinds = (out: ToDevice[]) => out.map((m) => (m.t === 'session' ? `session ${m.s.id}` : m.t));

test('hello is answered with time, every session, then ready', () => {
  const { hub, link, out } = setup();
  hub.put(snapshot('a'), {});
  hub.put(snapshot('b'), {});
  assert.equal(link.receive(hello), true);
  assert.equal(link.device, 'test');
  assert.deepEqual(kinds(out), ['hello', 'session a', 'session b', 'ready']);
  assert.deepEqual(out[0], { t: 'hello', proto: 1, time: T0, tz: 480, quick: ['继续下一步'] });
});

test('a device speaking another protocol version is dropped', () => {
  const { link, out } = setup();
  assert.equal(link.receive(JSON.stringify({ t: 'hello', proto: 2, device: 'x' })), false);
  assert.deepEqual(out, []);
});

test('actions before hello drop the connection, junk after hello does not', () => {
  const { hub, link } = setup();
  hub.put(snapshot('a'), {});
  assert.equal(link.receive(JSON.stringify({ t: 'seen', seq: 1, id: 'a' })), false);
  assert.equal(link.receive('not json'), false);
  assert.equal(link.receive(hello), true);
  assert.equal(link.receive('not json'), true);
});

test('changes to one session within the window go out once', () => {
  const { hub, clock, link, out } = setup();
  hub.put(snapshot('a'), {});
  link.receive(hello);
  out.length = 0;
  hub.update('a', (s) => {
    s.say = 'one';
  });
  hub.update('a', (s) => {
    s.say = 'two';
  });
  assert.equal(out.length, 0);
  clock.advance(150);
  assert.deepEqual(kinds(out), ['session a']);
  assert.equal(out[0]?.t === 'session' && out[0].s.say, 'two');
});

test('removed sessions are reported as gone', () => {
  const { hub, clock, link, out } = setup();
  hub.put(snapshot('a'), {});
  link.receive(hello);
  out.length = 0;
  hub.remove('a');
  clock.advance(150);
  assert.deepEqual(out, [{ t: 'gone', id: 'a' }]);
});

test('the changed session is sent before the ack', () => {
  const { hub, link, out } = setup();
  hub.put(snapshot('a', { state: 'done' }), {});
  link.receive(hello);
  out.length = 0;
  assert.equal(link.receive(JSON.stringify({ t: 'seen', seq: 7, id: 'a' })), true);
  assert.deepEqual(kinds(out), ['session a', 'ack']);
  assert.equal(out[0]?.t === 'session' && out[0].s.state, 'idle');
  assert.deepEqual(out[1], { t: 'ack', seq: 7, ok: true });
});

test('a refused action is acked with the reason', () => {
  const { hub, link, out } = setup();
  hub.put(snapshot('a'), {});
  link.receive(hello);
  out.length = 0;
  link.receive(JSON.stringify({ t: 'approve', seq: 3, id: 'a', req: 'r1', allow: true }));
  assert.deepEqual(out, [{ t: 'ack', seq: 3, ok: false, err: 'stale' }]);
});

test('nothing is sent after close', () => {
  const { hub, clock, link, out } = setup();
  hub.put(snapshot('a'), {});
  link.receive(hello);
  out.length = 0;
  link.close();
  hub.update('a', (s) => {
    s.say = 'late';
  });
  clock.advance(1000);
  assert.deepEqual(out, []);
  assert.equal(link.receive(hello), false);
});

test('snapshots are trimmed to what the device holds', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `+line ${i}`);
  const s = snapshot('a', {
    log: Array.from({ length: 60 }, (_, i) => ({ at: T0 - i, verb: 'Read', target: `f${i}` })),
    hunks: { total: 9, list: Array.from({ length: 9 }, () => ({ file: 'f', line: 1, add: 20, del: 0, lines })) },
  });
  const trimmed = forDevice(s);
  assert.equal(trimmed.log.length, 48);
  assert.equal(trimmed.hunks.list.length, 6);
  assert.equal(trimmed.hunks.list[0]?.lines.length, 14);
  assert.equal(trimmed.hunks.total, 9);
  assert.equal(s.log.length, 60, 'the original is left alone');
});
