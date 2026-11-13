// One connected device. Transport-agnostic: the WebSocket server feeds it frames,
// and the headless simulator calls it directly.

import type { Clock } from './clock.ts';
import type { Hub } from './hub.ts';
import { fixStrings } from './glyphs.ts';
import type { Pairing } from './pairing.ts';
import { LIMITS, PROTO, parseFromDevice, type SessionSnapshot, type ToDevice } from './protocol.ts';
import { Channel, commitOf, fromHex, linkKeys, newKeyPair, pairCode, pairKey, proofOf, random, same, sharedSecret, type KeyPair } from './secure.ts';

/** This connection's challenge, and this computer's side of a pairing exchange. */
interface Challenge {
  nonce: Buffer;
  keys: KeyPair;
  r: Buffer;
  /** r has been revealed: this exchange can't be used for another pairing attempt. */
  spent: boolean;
}

export interface LinkOptions {
  /** This computer's name on the device, e.g. "台式机". */
  hostName: string;
  /** Stable id of this bridge install, so the device knows it across restarts. */
  hostId: string;
  /** One-tap replies offered on the device. */
  quick: string[];
  /** Minutes ahead of UTC, for the device's clock. */
  tzMinutes: number;
  /** Changes to a session within this window go out as one snapshot. */
  flushMs: number;
  /** Swap characters the device can't draw (see glyphs.ts). Default: send as is. */
  fixText?: (text: string) => string;
  /** Devices must prove they hold their pairing key, or pair first. Unset for connections from this machine. */
  pairing?: Pairing;
  /** Where the random bytes for challenges and pairing come from. Only for repeatable screenshots; default: the OS. */
  entropy?: (bytes: number) => Buffer;
}

export const DEFAULT_QUICK = ['继续下一步', '跑一下测试', '提交这些改动', '先停一下，等我回电脑', '撤销刚才的修改'];

/** Trim a snapshot to what the device is prepared to hold. */
export function forDevice(s: SessionSnapshot): SessionSnapshot {
  return {
    ...s,
    log: s.log.slice(0, LIMITS.log),
    hunks: {
      total: s.hunks.total,
      list: s.hunks.list.slice(0, LIMITS.hunks).map((h) => ({ ...h, lines: h.lines.slice(0, LIMITS.hunkLines) })),
    },
    ask: s.ask?.kind === 'approve' && s.ask.lines ? { ...s.ask, lines: s.ask.lines.slice(0, LIMITS.hunkLines) } : s.ask,
  };
}

export class DeviceLink {
  /** Set once the device has said hello; nothing is sent before that. */
  device: string | null = null;
  private deviceId: string | null = null;
  /** Synced: the device is trusted (this machine) or proved it holds the key, or just paired. */
  private authed = false;
  private cancelPair: (() => void) | null = null;
  private challenge: Challenge | null = null;
  /** Network devices: every frame after auth is encrypted. */
  private channel: Channel | null = null;

  private readonly hub: Hub;
  private readonly clock: Clock;
  private readonly sendText: (text: string) => void;
  private readonly options: LinkOptions;
  private readonly dirty = new Set<string>();
  private cancelFlush: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private detach: (() => void) | null = null;
  private closed = false;

  constructor(hub: Hub, clock: Clock, send: (text: string) => void, options: LinkOptions) {
    this.hub = hub;
    this.clock = clock;
    this.sendText = send;
    this.options = options;
  }

  /** Handle one text frame. Returns false if the device should be disconnected. */
  receive(frame: string): boolean {
    if (this.closed) return false;
    let text = frame;
    if (this.channel) {
      // Once encrypted, anything that isn't the next frame from the device ends the connection.
      const plain = this.channel.open(frame);
      if (plain === null) return false;
      text = plain;
    } else if (frame.startsWith('E')) {
      return false;
    }
    const msg = parseFromDevice(text);
    if (msg === null) return this.device !== null; // ignore junk from a known device, drop strangers
    if (msg.t === 'hello') {
      if (msg.proto !== PROTO) return false;
      if (this.authed) return true; // already through
      this.device = msg.device;
      this.deviceId = msg.deviceId;
      if (!this.options.pairing) {
        this.sync(); // this machine, or in-process: trusted
      } else {
        if (this.deviceId === null) return false; // can't pair without an id
        this.askAuth(false); // also how a device asks for a new pairing code
      }
      return true;
    }
    if (this.device === null) return false;
    if (msg.t === 'auth' || msg.t === 'pair') {
      if (this.authed || !this.options.pairing || !this.challenge) return true;
      if (msg.t === 'auth') this.checkProof(msg.nonce, msg.proof);
      else this.startPairing(msg.pub, msg.r);
      return true;
    }
    if (!this.authed) return true; // actions only count once it has proven who it is
    const err = this.hub.act(msg);
    // State first, then the ack: when the ack arrives the device already shows the truth.
    this.flush();
    this.send(err === null ? { t: 'ack', seq: msg.seq, ok: true } : { t: 'ack', seq: msg.seq, ok: false, err });
    return true;
  }

  close(): void {
    this.closed = true;
    this.cancelPair?.();
    this.unsubscribe?.();
    this.detach?.();
    this.cancelFlush?.();
    this.cancelFlush = null;
  }

  /** A fresh challenge, and a fresh pairing exchange in case the device has no key. */
  private askAuth(bad: boolean): void {
    this.cancelPair?.();
    this.cancelPair = null;
    const take = this.options.entropy ?? random;
    const c: Challenge = { nonce: take(16), keys: newKeyPair(this.options.entropy ? take(32) : undefined), r: take(16), spent: false };
    this.challenge = c;
    this.send({
      t: 'auth',
      host: this.fix(this.options.hostName),
      hostId: this.options.hostId,
      nonce: c.nonce.toString('hex'),
      pub: c.keys.pub.toString('hex'),
      commit: commitOf(c.r).toString('hex'),
      ...(bad ? { bad } : {}),
    });
  }

  private checkProof(nonceHex: string, proofHex: string): void {
    const c = this.challenge!;
    const key = this.options.pairing!.keyOf(this.deviceId!);
    const deviceNonce = fromHex(nonceHex, 16);
    const proof = fromHex(proofHex, 32);
    if (!key || !deviceNonce || !proof || !same(proof, proofOf(key, this.deviceId!, this.options.hostId, c.nonce, deviceNonce))) {
      this.askAuth(true);
      return;
    }
    this.secure(key, deviceNonce);
    this.sync();
  }

  private startPairing(pubHex: string, rHex: string): void {
    const c = this.challenge!;
    const devicePub = fromHex(pubHex, 32);
    const deviceR = fromHex(rHex, 16);
    const shared = devicePub ? sharedSecret(c.keys.secret, devicePub) : null;
    // One pairing attempt per exchange: the device asks for a new one with hello.
    if (c.spent || !devicePub || !deviceR || !shared) return;
    c.spent = true;
    const code = pairCode(devicePub, c.keys.pub, deviceR, c.r);
    const key = pairKey(shared, devicePub, c.keys.pub, deviceR, c.r);
    this.send({ t: 'pairing', r: c.r.toString('hex') });
    this.cancelPair = this.options.pairing!.request(this.deviceId!, this.device!, code, key, () => {
      this.cancelPair = null;
      this.secure(key, deviceR);
      this.send({ t: 'paired' });
      this.sync();
    });
  }

  /** From here on every frame is encrypted with this connection's keys. */
  private secure(key: Buffer, deviceNonce: Buffer): void {
    const keys = linkKeys(key, this.challenge!.nonce, deviceNonce);
    this.channel = new Channel(keys.toDevice, keys.toBridge);
    this.challenge = null;
  }

  private sync(): void {
    this.authed = true;
    this.dirty.clear();
    this.send({
      t: 'hello',
      proto: PROTO,
      host: this.fix(this.options.hostName),
      hostId: this.options.hostId,
      time: this.hub.nowSeconds(),
      tz: this.options.tzMinutes,
      quick: this.options.quick.map((q) => this.fix(q)),
    });
    for (const snapshot of this.hub.list()) this.send({ t: 'session', s: this.prepare(snapshot) });
    this.send({ t: 'ready' });
    this.detach ??= this.hub.attachDevice();
    this.unsubscribe ??= this.hub.subscribe((event) => {
      if (event.type === 'devices') return;
      this.dirty.add(event.id);
      this.cancelFlush ??= this.clock.after(this.options.flushMs, () => this.flush());
    });
  }

  private flush(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    for (const id of this.dirty) {
      const snapshot = this.hub.get(id);
      this.send(snapshot ? { t: 'session', s: this.prepare(snapshot) } : { t: 'gone', id });
    }
    this.dirty.clear();
  }

  private fix(text: string): string {
    return this.options.fixText ? this.options.fixText(text) : text;
  }

  /** A snapshot as the device gets it: trimmed to its limits, in characters it can draw. */
  private prepare(snapshot: SessionSnapshot): SessionSnapshot {
    const trimmed = forDevice(snapshot);
    return this.options.fixText ? fixStrings(trimmed, this.options.fixText) : trimmed;
  }

  private send(msg: ToDevice): void {
    if (this.closed) return;
    const text = JSON.stringify(msg);
    this.sendText(this.channel ? this.channel.seal(text) : text);
  }
}
