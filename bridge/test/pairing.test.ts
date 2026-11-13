import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ManualClock } from '../src/clock.ts';
import { Hub } from '../src/hub.ts';
import { DeviceLink } from '../src/link.ts';
import { Pairing } from '../src/pairing.ts';
import { parseFromDevice, type SessionSnapshot, type ToDevice } from '../src/protocol.ts';

const T0 = 1_794_637_920;
const DEVICE = '0123456789abcdef';

function setup() {
  const clock = new ManualClock(T0 * 1000);
  const file = join(mkdtempSync(join(tmpdir(), 'ct-')), 'devices.json');
  const pairing = new Pairing(file, clock, () => {});
  return { clock, file, pairing };
}

test('a device pairs only when the user approves its code, and its token then works', () => {
  const { pairing, file, clock } = setup();
  let token = '';
  pairing.request(DEVICE, '墨水屏', '482159', (t) => (token = t));
  assert.deepEqual(pairing.pending().map((p) => p.code), ['482159']);
  assert.equal(pairing.approve('000000'), null);
  assert.deepEqual(pairing.approve('482159'), { deviceId: DEVICE, name: '墨水屏' });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(pairing.check(DEVICE, token), true);
  assert.equal(pairing.check(DEVICE, 'f'.repeat(64)), false);
  assert.equal(pairing.check('fedcba9876543210', token), false);
  assert.deepEqual(pairing.pending(), []);
  // Only a hash is stored, and it survives a restart.
  assert.equal(readFileSync(file, 'utf8').includes(token), false);
  assert.equal(new Pairing(file, clock, () => {}).check(DEVICE, token), true);
  assert.equal(pairing.remove('墨水屏'), true);
  assert.equal(pairing.check(DEVICE, token), false);
});

test('pairing requests expire after five minutes', () => {
  const { pairing, clock } = setup();
  pairing.request(DEVICE, 'd', '111111', () => {});
  clock.advance(5 * 60 * 1000);
  assert.deepEqual(pairing.pending(), []);
  assert.equal(pairing.approve('111111'), null);
});

test('the device messages for auth and pairing are checked', () => {
  assert.deepEqual(parseFromDevice('{"t":"pair","code":"482159"}'), { t: 'pair', code: '482159' });
  assert.equal(parseFromDevice('{"t":"pair","code":"48215"}'), null);
  assert.deepEqual(parseFromDevice(`{"t":"hello","proto":1,"device":"d","deviceId":"${DEVICE}"}`), {
    t: 'hello',
    proto: 1,
    device: 'd',
    deviceId: DEVICE,
  });
  assert.equal((parseFromDevice('{"t":"hello","proto":1,"device":"d","deviceId":"NOPE"}') as { deviceId: unknown }).deviceId, null);
});

function session(id: string): SessionSnapshot {
  return {
    id,
    name: id,
    agent: 'claude',
    model: 'm',
    state: 'approve',
    since: T0,
    started: T0,
    reply: false,
    n: { read: 0, edit: 0, new: 0, cmd: 0, add: 0, del: 0 },
    log: [],
    files: [],
    hunks: { total: 0, list: [] },
    ask: { kind: 'approve', req: 'r1', verb: 'Bash', target: 'x' },
  };
}

test('a network device: auth, a refused token, pairing, then the usual sync', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  const decided: boolean[] = [];
  hub.put(session('s1'), { decide: (_r, allow) => decided.push(allow) });
  const out: ToDevice[] = [];
  const link = new DeviceLink(hub, clock, (t) => out.push(JSON.parse(t) as ToDevice), {
    hostName: '台式机',
    hostId: 'h1',
    quick: [],
    tzMinutes: 0,
    flushMs: 10,
    pairing,
  });
  const kinds = () => out.map((m) => m.t);

  // Without an id it can't pair at all.
  const anon = new DeviceLink(hub, clock, () => {}, { hostName: 'x', hostId: 'x', quick: [], tzMinutes: 0, flushMs: 10, pairing });
  assert.equal(anon.receive('{"t":"hello","proto":1,"device":"d"}'), false);

  assert.equal(link.receive(`{"t":"hello","proto":1,"device":"墨水屏","deviceId":"${DEVICE}"}`), true);
  assert.deepEqual(out, [{ t: 'auth', host: '台式机', hostId: 'h1' }]);
  // Nothing it does counts before it proves who it is.
  assert.equal(link.receive('{"t":"approve","seq":1,"id":"s1","req":"r1","allow":true}'), true);
  assert.deepEqual(decided, []);
  assert.equal(hub.devices(), 0);

  link.receive(`{"t":"auth","token":"${'a'.repeat(64)}"}`);
  assert.deepEqual(out.at(-1), { t: 'auth', host: '台式机', hostId: 'h1', bad: true });

  link.receive('{"t":"pair","code":"482159"}');
  assert.deepEqual(pairing.pending().map((p) => [p.name, p.code]), [['墨水屏', '482159']]);
  out.length = 0;
  pairing.approve('482159');
  assert.deepEqual(kinds(), ['paired', 'hello', 'session', 'ready']);
  const token = (out[0] as { token: string }).token;
  assert.equal(hub.devices(), 1);

  link.receive('{"t":"approve","seq":2,"id":"s1","req":"r1","allow":true}');
  assert.deepEqual(decided, [true]);
  link.close();

  // Next time: the token is enough.
  const again: ToDevice[] = [];
  const next = new DeviceLink(hub, clock, (t) => again.push(JSON.parse(t) as ToDevice), {
    hostName: '台式机',
    hostId: 'h1',
    quick: [],
    tzMinutes: 0,
    flushMs: 10,
    pairing,
  });
  next.receive(`{"t":"hello","proto":1,"device":"墨水屏","deviceId":"${DEVICE}"}`);
  next.receive(`{"t":"auth","token":"${token}"}`);
  assert.deepEqual(
    again.map((m) => m.t),
    ['auth', 'hello', 'session', 'ready'],
  );
});
