import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ManualClock } from '../src/clock.ts';
import { FirmwareStore, type FirmwareImage } from '../src/firmware.ts';
import { Hub } from '../src/hub.ts';
import { DeviceLink, HANDSHAKE_MS } from '../src/link.ts';
import { MAX_PENDING, Pairing, WINDOW_MS, WINDOW_REVEALS } from '../src/pairing.ts';
import { parseFromDevice, type SessionSnapshot } from '../src/protocol.ts';
import {
  Channel,
  commitOf,
  linkKeys,
  newKeyPair,
  pairCode,
  pairKey,
  proofOf,
  random,
  sharedSecret,
  type KeyPair,
} from '../src/secure.ts';

const T0 = 1_794_637_920;
const DEVICE = '0123456789abcdef';
const HOST = 'h1';

function setup() {
  const clock = new ManualClock(T0 * 1000);
  const file = join(mkdtempSync(join(tmpdir(), 'ct-')), 'devices.json');
  const pairing = new Pairing(file, clock, () => {});
  return { clock, file, pairing };
}

const KEY = Buffer.alloc(32, 7);

test('a device pairs only when the user types its code, and its key is kept', () => {
  const { pairing, file, clock } = setup();
  let granted = 0;
  pairing.request(DEVICE, '墨水屏', '482159', KEY, () => granted++);
  // The computer never lists codes: the user has to read the one on the device.
  assert.deepEqual(pairing.pending().map((p) => [p.name, p.shown]), [['墨水屏', true]]);
  assert.equal(JSON.stringify(pairing.pending()).includes('482159'), false);
  assert.equal(pairing.keyOf(DEVICE), null);
  assert.equal(pairing.approve('000000'), null);
  assert.deepEqual(pairing.approve('482159'), { deviceId: DEVICE, name: '墨水屏' });
  assert.equal(granted, 1);
  assert.deepEqual(pairing.keyOf(DEVICE), KEY);
  assert.deepEqual(pairing.pending(), []);
  // Kept across restarts, in a file only this user can read (where the OS has such modes).
  assert.deepEqual(new Pairing(file, clock, () => {}).keyOf(DEVICE), KEY);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);
  assert.deepEqual(pairing.list().map((d) => d.name), ['墨水屏']);
  assert.equal(pairing.remove('墨水屏'), true);
  assert.equal(pairing.keyOf(DEVICE), null);
});

test('pairing requests expire after five minutes, and old token pairings are dropped', () => {
  const { pairing, clock, file } = setup();
  pairing.request(DEVICE, 'd', '111111', KEY, () => {});
  clock.advance(5 * 60 * 1000);
  assert.deepEqual(pairing.pending(), []);
  assert.equal(pairing.approve('111111'), null);
  writeFileSync(file, JSON.stringify({ devices: [{ id: DEVICE, name: 'd', hash: 'a'.repeat(64), pairedAt: 1 }] }));
  assert.equal(new Pairing(file, clock, () => {}).keyOf(DEVICE), null);
});

test('only a few requests wait at once, a code two of them share pairs neither, and nobody clears another’s', () => {
  const { pairing } = setup();
  for (let i = 0; i < MAX_PENDING; i++) assert.ok(pairing.request(`d${i}`.padEnd(16, '0'), 'x', `00000${i}`, KEY, () => {}));
  assert.equal(pairing.request('e'.repeat(16), 'x', '123456', KEY, () => {}), null);
  assert.equal(pairing.pending().length, MAX_PENDING);

  const { pairing: other } = setup();
  let granted = 0;
  other.request('a'.repeat(16), '真设备', '482159', KEY, () => granted++);
  // Device ids are public: a second request with the same id doesn't push the first one out.
  other.request('a'.repeat(16), '冒充的', '482159', KEY, () => granted++);
  assert.equal(other.pending().length, 2);
  assert.equal(other.approve('482159'), null);
  assert.equal(granted, 0);
});

test('the device messages for auth and pairing are checked', () => {
  const pub = 'ab'.repeat(32);
  const r = 'cd'.repeat(16);
  assert.deepEqual(parseFromDevice(`{"t":"pair","pub":"${pub}","r":"${r}"}`), { t: 'pair', pub, r });
  assert.equal(parseFromDevice(`{"t":"pair","pub":"${pub}","r":"cd"}`), null);
  assert.equal(parseFromDevice(`{"t":"pair","code":"482159"}`), null, 'the old way is gone');
  assert.deepEqual(parseFromDevice(`{"t":"auth","nonce":"${r}","proof":"${pub}"}`), { t: 'auth', nonce: r, proof: pub });
  assert.equal(parseFromDevice('{"t":"auth","token":"abc"}'), null);
  assert.deepEqual(parseFromDevice('{"t":"paired"}'), { t: 'paired' });
  assert.deepEqual(parseFromDevice(`{"t":"hello","proto":1,"device":"d","deviceId":"${DEVICE}"}`), {
    t: 'hello',
    proto: 1,
    device: 'd',
    deviceId: DEVICE,
    fw: null,
  });
  assert.equal((parseFromDevice('{"t":"hello","proto":1,"device":"d","deviceId":"NOPE"}') as { deviceId: unknown }).deviceId, null);
  assert.equal((parseFromDevice('{"t":"hello","proto":1,"device":"d","fw":"2ebb56c-1117"}') as { fw: unknown }).fw, '2ebb56c-1117');
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

type Msg = Record<string, unknown> & { t: string };

/**
 * The device's side, as ui/src/ct_proto.c does it: answer auth with a proof if it
 * holds a key for this computer, else pair; show the code once the computer reveals
 * its value; keep the key only once the computer said paired and the user confirmed
 * on the device too; then talk encrypted.
 */
class FakeDevice {
  key: Buffer | null = null;
  code = '';
  got: Msg[] = [];
  /** Whether the user taps "配好了" when the computer says it paired. */
  confirm = true;
  private nonce: Buffer | null = null;
  private auth: Msg | null = null;
  private mine: { keys: KeyPair; r: Buffer } | null = null;
  private channel: Channel | null = null;
  /** The computer has sent an encrypted frame: from now on ours are encrypted too. */
  private confirmed = false;
  private pendingKey: Buffer | null = null;
  readonly link: DeviceLink;
  readonly id: string;
  dropped = false;

  private readonly fw: string | undefined;

  constructor(
    hub: Hub,
    clock: ManualClock,
    pairing: Pairing,
    key: Buffer | null = null,
    id = DEVICE,
    more: { fw?: string; firmware?: FirmwareStore; connected?: Map<string, DeviceLink> } = {},
  ) {
    this.key = key;
    this.id = id;
    this.fw = more.fw;
    this.link = new DeviceLink(hub, clock, (frame) => this.receive(frame), {
      hostName: '台式机',
      hostId: HOST,
      quick: [],
      tzMinutes: 0,
      flushMs: 10,
      pairing,
      drop: () => (this.dropped = true),
      firmware: more.firmware,
      connected: more.connected,
    });
  }

  hello(): boolean {
    return this.send({ t: 'hello', proto: 1, device: '墨水屏', deviceId: this.id, ...(this.fw ? { fw: this.fw } : {}) });
  }

  send(msg: Msg): boolean {
    const text = JSON.stringify(msg);
    return this.link.receive(this.channel && this.confirmed ? this.channel.seal(text) : text);
  }

  kinds(): string[] {
    return this.got.map((m) => m.t);
  }

  private receive(frame: string): void {
    let text = frame;
    if (frame.startsWith('E')) {
      const plain = this.channel?.open(frame) ?? null;
      assert.ok(plain !== null, 'an encrypted frame the device can open');
      text = plain;
      this.confirmed = true;
    }
    const msg = JSON.parse(text) as Msg;
    this.got.push(msg);
    if (msg.t === 'auth') this.onAuth(msg);
    if (msg.t === 'pairing') this.onPairing(msg);
    if (msg.t === 'paired' && this.pendingKey && this.confirm) {
      this.key = this.pendingKey;
      this.pendingKey = null;
      this.send({ t: 'paired' });
    }
  }

  private onAuth(msg: Msg): void {
    this.auth = msg;
    this.channel = null;
    this.confirmed = false;
    const bridgeNonce = Buffer.from(msg.nonce as string, 'hex');
    if (this.key && !msg.bad) {
      this.nonce = random();
      const proof = proofOf(this.key, this.id, HOST, bridgeNonce, this.nonce);
      const k = linkKeys(this.key, bridgeNonce, this.nonce);
      // Ready for the encrypted answer before the plain proof goes (here the answer comes back at once).
      this.channel = new Channel(k.toBridge, k.toDevice);
      this.link.receive(JSON.stringify({ t: 'auth', nonce: this.nonce.toString('hex'), proof: proof.toString('hex') }));
      return;
    }
    // A refusal doesn't erase its key by itself (the device asks the user); here we just stop.
    if (this.key && msg.bad) return;
    this.mine = { keys: newKeyPair(), r: random() };
    this.send({ t: 'pair', pub: this.mine.keys.pub.toString('hex'), r: this.mine.r.toString('hex') });
  }

  private onPairing(msg: Msg): void {
    const auth = this.auth!;
    const mine = this.mine!;
    const bridgeR = Buffer.from(msg.r as string, 'hex');
    const bridgePub = Buffer.from(auth.pub as string, 'hex');
    assert.equal(commitOf(bridgeR).toString('hex'), auth.commit, 'the computer revealed what it committed to');
    const shared = sharedSecret(mine.keys.secret, bridgePub)!;
    this.code = pairCode(mine.keys.pub, bridgePub, mine.r, bridgeR);
    this.pendingKey = pairKey(shared, mine.keys.pub, bridgePub, mine.r, bridgeR);
    const k = linkKeys(this.pendingKey, Buffer.from(auth.nonce as string, 'hex'), mine.r);
    this.channel = new Channel(k.toBridge, k.toDevice);
  }
}

test('a network device pairs by code with both sides confirming, then proves itself on every connection, all encrypted', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  const decided: boolean[] = [];
  hub.put(session('s1'), { decide: (_r, allow) => decided.push(allow) });

  // Without an id it can't pair at all.
  const anon = new DeviceLink(hub, clock, () => {}, { hostName: 'x', hostId: 'x', quick: [], tzMinutes: 0, flushMs: 10, pairing });
  assert.equal(anon.receive('{"t":"hello","proto":1,"device":"d"}'), false);

  const d = new FakeDevice(hub, clock, pairing);
  assert.equal(d.hello(), true);
  // No code until the user starts pairing on the computer.
  assert.deepEqual(d.kinds(), ['auth']);
  assert.deepEqual(pairing.pending().map((p) => p.shown), [false]);
  assert.deepEqual(pairing.open(), { waiting: 1 });
  assert.deepEqual(d.kinds(), ['auth', 'pairing']);
  assert.match(d.code, /^\d{6}$/);
  // Nothing it does counts before it is paired.
  assert.equal(d.link.receive('{"t":"approve","seq":1,"id":"s1","req":"r1","allow":true}'), true);
  assert.deepEqual(decided, []);
  assert.equal(hub.devices(), 0);

  // The computer worked out the same code; the user types it there, then confirms on the device.
  assert.deepEqual(pairing.approve(d.code), { deviceId: DEVICE, name: '墨水屏' });
  assert.equal(pairing.isOpen(), false, 'pairing ends the window');
  assert.deepEqual(d.kinds(), ['auth', 'pairing', 'paired', 'hello', 'session', 'ready']);
  assert.ok(d.key, 'both sides hold the key now');
  assert.deepEqual(pairing.keyOf(DEVICE), d.key);
  assert.equal(hub.devices(), 1);

  assert.equal(d.send({ t: 'approve', seq: 2, id: 's1', req: 'r1', allow: true }), true);
  assert.deepEqual(decided, [true]);
  // Plain frames don't count any more: the connection ends.
  assert.equal(d.link.receive('{"t":"approve","seq":3,"id":"s1","req":"r1","allow":false}'), false);
  assert.deepEqual(decided, [true]);
  d.link.close();

  // Next connection: its proof is enough.
  const again = new FakeDevice(hub, clock, pairing, d.key);
  again.hello();
  assert.deepEqual(again.kinds(), ['auth', 'hello', 'session', 'ready']);
  again.link.close();

  // A wrong key is refused with a new challenge (the device decides what to do about it).
  const wrong = new FakeDevice(hub, clock, pairing, Buffer.alloc(32, 1));
  wrong.hello();
  assert.deepEqual(wrong.kinds(), ['auth', 'auth']);
  assert.equal(wrong.got[1]!.bad, true);
});

test('the computer saying paired is not enough: nothing syncs until the user confirms on the device', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  hub.put(session('s1'), { decide: () => {} });
  pairing.open();
  const d = new FakeDevice(hub, clock, pairing);
  d.confirm = false;
  d.hello();
  pairing.approve(d.code);
  assert.deepEqual(d.kinds(), ['auth', 'pairing', 'paired']);
  assert.equal(d.key, null);
  assert.equal(hub.devices(), 0);
});

test('codes are rationed: a few exchanges per window the user opens, however often anyone reconnects', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  // Someone trying for a matching code: a new connection, a new device id, every time.
  let reveals = 0;
  const attempt = (i: number) => {
    const a = new FakeDevice(hub, clock, pairing, null, i.toString(16).padStart(16, '0'));
    a.hello();
    reveals += a.kinds().filter((k) => k === 'pairing').length;
    a.link.close();
  };
  for (let i = 0; i < 50; i++) attempt(i);
  assert.equal(reveals, 0, 'no window, no codes');
  pairing.open();
  for (let i = 50; i < 100; i++) attempt(i);
  assert.equal(reveals, WINDOW_REVEALS);
  // Spent reveals don't come back by reconnecting, nor when the window runs out.
  clock.advance(WINDOW_MS + 1);
  pairing.open();
  for (let i = 100; i < 150; i++) attempt(i);
  assert.equal(reveals, 2 * WINDOW_REVEALS);
});

test('devices that ask while no window is open wait for one; too many waiting are turned away', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  const waiting = Array.from({ length: MAX_PENDING }, (_, i) => new FakeDevice(hub, clock, pairing, null, `${i}`.padStart(16, 'a')));
  for (const w of waiting) w.hello();
  const late = new FakeDevice(hub, clock, pairing, null, 'f'.repeat(16));
  late.hello();
  assert.deepEqual(late.kinds(), ['auth'], 'its pair was refused');
  // Closing a waiting connection takes it off the list.
  waiting[0]!.link.close();
  pairing.open();
  assert.deepEqual(waiting.map((w) => w.kinds().includes('pairing')), [false, true, true]);
});

test('a network device that neither proves itself nor pairs in time is dropped', () => {
  const { clock, pairing } = setup();
  const d = new FakeDevice(new Hub(clock), clock, pairing);
  d.hello();
  clock.advance(HANDSHAKE_MS - 1);
  assert.equal(d.dropped, false);
  clock.advance(1);
  assert.equal(d.dropped, true);
  // One that got through is left alone.
  pairing.open();
  const ok = new FakeDevice(new Hub(clock), clock, pairing);
  ok.hello();
  pairing.approve(ok.code);
  clock.advance(HANDSHAKE_MS);
  assert.equal(ok.dropped, false);
});

test('frames that were changed, replayed or come from someone without the key end the connection', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  hub.put(session('s1'), { decide: () => {} });
  pairing.open();
  const d = new FakeDevice(hub, clock, pairing);
  d.hello();
  pairing.approve(d.code);

  // What a listener on the network sees: no JSON, nothing readable.
  const sniffed: string[] = [];
  const spy = new FakeDevice(hub, clock, pairing, d.key);
  const realSend = spy.link.receive.bind(spy.link);
  spy.link.receive = (frame: string) => (sniffed.push(frame), realSend(frame));
  spy.hello();
  spy.send({ t: 'seen', seq: 1, id: 's1' });
  const last = sniffed.at(-1)!;
  assert.match(last, /^E[A-Za-z0-9+/=]+$/);
  assert.equal(last.includes('seen'), false);

  // Replaying it: the counter has moved on.
  assert.equal(spy.link.receive(last), false);

  const other = new FakeDevice(hub, clock, pairing, d.key);
  other.hello();
  const frame = (() => {
    let f = '';
    const send = other.link.receive.bind(other.link);
    other.link.receive = (x: string) => ((f = x), true);
    other.send({ t: 'seen', seq: 2, id: 's1' });
    other.link.receive = send;
    return f;
  })();
  // One bit changed.
  const bytes = Buffer.from(frame.slice(1), 'base64');
  bytes[bytes.length - 1]! ^= 1;
  assert.equal(other.link.receive(`E${bytes.toString('base64')}`), false);
});

test('someone in the middle who swaps the keys ends up with codes that do not match', () => {
  // The device talks to the attacker (who poses as the computer), and the attacker to the computer.
  const bridge = { keys: newKeyPair(), r: random() };
  const device = { keys: newKeyPair(), r: random() };
  const toDevice = { keys: newKeyPair(), r: random() }; // committed to before the device's values arrive
  const toBridge = { keys: newKeyPair(), r: random() }; // chosen before the computer reveals bridge.r
  const deviceCode = pairCode(device.keys.pub, toDevice.keys.pub, device.r, toDevice.r);
  const bridgeCode = pairCode(toBridge.keys.pub, bridge.keys.pub, toBridge.r, bridge.r);
  assert.notEqual(deviceCode, bridgeCode);
  // Without anyone in the middle, both sides agree, and so do their keys.
  const a = sharedSecret(device.keys.secret, bridge.keys.pub)!;
  const b = sharedSecret(bridge.keys.secret, device.keys.pub)!;
  assert.deepEqual(a, b);
  // A key that makes the shared secret all zeros is refused.
  assert.equal(sharedSecret(bridge.keys.secret, Buffer.alloc(32)), null);
});

test('a pairing exchange is used once: asking again needs a new hello', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  pairing.open();
  const d = new FakeDevice(hub, clock, pairing);
  d.hello();
  const first = d.code;
  // The same exchange again (its value is already revealed): ignored.
  d.send({ t: 'pair', pub: newKeyPair().pub.toString('hex'), r: random().toString('hex') });
  assert.deepEqual(d.kinds(), ['auth', 'pairing']);
  // A new hello: a new challenge, a new exchange, a new code; the old request is gone.
  d.hello();
  assert.deepEqual(d.kinds(), ['auth', 'pairing', 'auth', 'pairing']);
  assert.equal(pairing.pending().length, 1);
  if (first !== d.code) assert.equal(pairing.approve(first), null);
  assert.ok(pairing.approve(d.code));
});

function image(version: string): FirmwareImage {
  return { data: Buffer.alloc(1000, 1), sha256: 'ab'.repeat(32), version, path: `/firmware/${'ab'.repeat(32)}.bin` };
}

test('new firmware is offered only to paired devices that can update, over their encrypted link', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  const store = new FirmwareStore();
  pairing.open();
  const d = new FakeDevice(hub, clock, pairing, null, DEVICE, { fw: 'v1', firmware: store });
  d.hello();
  // Before pairing completes, nothing is offered.
  assert.equal(store.offer(image('v2')), 0);
  pairing.approve(d.code);
  assert.equal(d.link.firmware, 'v1');

  assert.equal(store.offer(image('v2')), 1);
  const update = d.got.at(-1)!;
  assert.deepEqual(update, { t: 'update', path: image('v2').path, size: 1000, sha256: 'ab'.repeat(32), version: 'v2' });
  // It already runs this one: not offered again.
  assert.equal(store.offer(image('v1')), 0);
  d.link.close();
  assert.equal(store.offer(image('v3')), 0, 'a closed link hears nothing');

  // A device that does not say which firmware it runs cannot update itself.
  const old = new FakeDevice(hub, clock, pairing, d.key, DEVICE, { firmware: store });
  old.hello();
  assert.deepEqual(old.kinds(), ['auth', 'hello', 'ready']);
  assert.equal(store.offer(image('v4')), 0);
  assert.ok(!old.kinds().includes('update'));
});

test('a device that was off when firmware was sent gets it once when it connects', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  const store = new FirmwareStore();
  pairing.open();
  const d = new FakeDevice(hub, clock, pairing, null, DEVICE, { fw: 'v1', firmware: store });
  d.hello();
  pairing.approve(d.code);
  d.link.close();
  assert.equal(store.offer(image('v2')), 0, 'nobody is connected');

  const back = new FakeDevice(hub, clock, pairing, d.key, DEVICE, { fw: 'v1', firmware: store });
  back.hello();
  assert.equal(back.got.at(-1)!.t, 'update', 'offered on connecting');
  assert.equal(back.got.filter((m) => m.t === 'update').length, 1);
  back.link.close();

  // Back on v1 again (the install failed or rolled back): not offered a second time.
  const again = new FakeDevice(hub, clock, pairing, d.key, DEVICE, { fw: 'v1', firmware: store });
  again.hello();
  assert.ok(!again.kinds().includes('update'));
  // A new `codetalky firmware` offers again.
  assert.equal(store.offer(image('v3')), 1);
});

test('a device that connects again and proves itself replaces its old, likely dead, connection', () => {
  const { clock, pairing } = setup();
  const hub = new Hub(clock);
  const store = new FirmwareStore();
  const connected = new Map<string, DeviceLink>();
  pairing.open();
  const first = new FakeDevice(hub, clock, pairing, null, DEVICE, { fw: 'v1', firmware: store, connected });
  first.hello();
  pairing.approve(first.code);
  assert.equal(hub.devices(), 1);

  // It restarted without saying goodbye; the new connection proves itself with the key.
  const again = new FakeDevice(hub, clock, pairing, first.key, DEVICE, { fw: 'v2', firmware: store, connected });
  again.hello();
  assert.equal(first.dropped, true, 'the old connection is let go');
  assert.equal(again.dropped, false);
  assert.equal(hub.devices(), 1, 'counted once');
  assert.equal(store.offer(image('v3')), 1, 'only the live connection hears about firmware');
  assert.equal(again.got.at(-1)!.t, 'update');

  // Someone who only knows the device id can't push it off: without the key it never gets that far.
  const stranger = new FakeDevice(hub, clock, pairing, Buffer.alloc(32, 9), DEVICE, { connected });
  stranger.hello();
  assert.equal(again.dropped, false);
  assert.equal(connected.get(DEVICE), again.link);
});
