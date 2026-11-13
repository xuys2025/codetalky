// One connected device. Transport-agnostic: the WebSocket server feeds it frames,
// and the headless simulator calls it directly.

import type { Clock } from './clock.ts';
import type { Hub } from './hub.ts';
import { LIMITS, PROTO, parseFromDevice, type SessionSnapshot, type ToDevice } from './protocol.ts';

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
  receive(text: string): boolean {
    if (this.closed) return false;
    const msg = parseFromDevice(text);
    if (msg === null) return this.device !== null; // ignore junk from a known device, drop strangers
    if (msg.t === 'hello') {
      if (msg.proto !== PROTO) return false;
      this.device = msg.device;
      this.sync();
      return true;
    }
    if (this.device === null) return false;
    const err = this.hub.act(msg);
    // State first, then the ack: when the ack arrives the device already shows the truth.
    this.flush();
    this.send(err === null ? { t: 'ack', seq: msg.seq, ok: true } : { t: 'ack', seq: msg.seq, ok: false, err });
    return true;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.detach?.();
    this.cancelFlush?.();
    this.cancelFlush = null;
  }

  private sync(): void {
    this.dirty.clear();
    this.send({
      t: 'hello',
      proto: PROTO,
      host: this.options.hostName,
      hostId: this.options.hostId,
      time: this.hub.nowSeconds(),
      tz: this.options.tzMinutes,
      quick: this.options.quick,
    });
    for (const snapshot of this.hub.list()) this.send({ t: 'session', s: forDevice(snapshot) });
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
      this.send(snapshot ? { t: 'session', s: forDevice(snapshot) } : { t: 'gone', id });
    }
    this.dirty.clear();
  }

  private send(msg: ToDevice): void {
    if (!this.closed) this.sendText(JSON.stringify(msg));
  }
}
