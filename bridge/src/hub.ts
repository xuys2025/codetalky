// The bridge's picture of every agent session. Agent sources (the fake agent now,
// Claude Code hooks and the managed terminal later) write sessions into it; device
// links read them and send the user's actions back through act().

import type { Clock } from './clock.ts';
import { LIMITS, type AckError, type DeviceAction, type SessionSnapshot } from './protocol.ts';

/** How a source carries out the user's actions on one of its sessions. */
export interface SessionControl {
  /** Answer the pending permission request. */
  decide?(req: string, allow: boolean): void;
  /** Answer the pending question with one of its options. */
  answer?(req: string, option: number): void;
  /** Give the agent a new instruction. */
  reply?(text: string): void;
}

export type HubEvent = { type: 'changed'; id: string } | { type: 'removed'; id: string } | { type: 'devices' };

interface Entry {
  snapshot: SessionSnapshot;
  control: SessionControl;
}

export class Hub {
  private readonly clock: Clock;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: HubEvent) => void>();
  private deviceCount = 0;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Unix seconds, the unit every timestamp in a snapshot uses. */
  nowSeconds(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  /** Add a session or replace it wholesale. */
  put(snapshot: SessionSnapshot, control: SessionControl): void {
    if (Buffer.byteLength(snapshot.id) > LIMITS.id) {
      throw new Error(`session id longer than ${LIMITS.id} bytes: ${snapshot.id}`);
    }
    this.entries.set(snapshot.id, { snapshot, control });
    this.emit({ type: 'changed', id: snapshot.id });
  }

  /** Change a session in place and tell the devices. */
  update(id: string, change: (snapshot: SessionSnapshot) => void): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    change(entry.snapshot);
    this.emit({ type: 'changed', id });
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.emit({ type: 'removed', id });
  }

  get(id: string): SessionSnapshot | undefined {
    return this.entries.get(id)?.snapshot;
  }

  list(): SessionSnapshot[] {
    return [...this.entries.values()].map((entry) => entry.snapshot);
  }

  /** Devices that have said hello and are still connected. */
  devices(): number {
    return this.deviceCount;
  }

  /** A device finished its hello. Call the returned function when it leaves. */
  attachDevice(): () => void {
    this.deviceCount++;
    this.emit({ type: 'devices' });
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.deviceCount--;
      this.emit({ type: 'devices' });
    };
  }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Carry out something the user did on a device. Returns null on success. */
  act(action: DeviceAction): AckError | null {
    const entry = this.entries.get(action.id);
    if (!entry) return 'gone';
    const { snapshot, control } = entry;
    switch (action.t) {
      case 'approve': {
        const ask = snapshot.ask;
        // The request shown on the device must be the one still pending.
        if (snapshot.state !== 'approve' || ask?.kind !== 'approve' || ask.req !== action.req) return 'stale';
        if (ask.until !== undefined && this.nowSeconds() > ask.until) return 'stale';
        if (!control.decide) return 'unsupported';
        control.decide(action.req, action.allow);
        return null;
      }
      case 'answer': {
        const ask = snapshot.ask;
        if (snapshot.state !== 'question' || ask?.kind !== 'question' || ask.req !== action.req) return 'stale';
        if (action.option < 0 || action.option >= ask.options.length) return 'bad';
        if (!control.answer) return 'unsupported';
        control.answer(action.req, action.option);
        return null;
      }
      case 'reply': {
        const text = action.text.trim();
        if (text.length === 0 || text.length > LIMITS.replyText) return 'bad';
        if (!snapshot.reply || !control.reply) return 'unsupported';
        control.reply(text);
        return null;
      }
      case 'seen':
        if (snapshot.state === 'done') {
          this.update(action.id, (s) => {
            s.state = 'idle';
            s.since = this.nowSeconds();
          });
        }
        return null;
    }
  }

  private emit(event: HubEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
