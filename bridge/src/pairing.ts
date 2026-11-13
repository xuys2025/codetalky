// Pairing: a device on the network may connect only after the user has said yes on
// this computer. The device shows a six-digit code that both sides compute from the
// pairing exchange (see secure.ts); the user types it into `codetalky pair` here,
// which only matches if nobody sat in the middle. Both sides then hold the same
// pairing key, which never crosses the network. Keys are kept in ~/.codetalky/devices.json.
//
// A code can only be guessed at by trying exchanges until one comes out the same, so
// exchanges are rationed: the computer reveals its side of one (which is what lets
// the other side work out the code) only while the user has a pairing window open
// (`codetalky pair`), and at most WINDOW_REVEALS times per window. Reconnecting, a new
// device id or a new hello does not give any back.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Clock } from './clock.ts';

/** A revealed pairing request waits this long for the user to type its code. */
const REQUEST_TTL_MS = 5 * 60 * 1000;
/** How long a pairing window stays open after the user starts one. */
export const WINDOW_MS = 5 * 60 * 1000;
/** How many exchanges one window may reveal: the whole of an attacker's guesses (each one in a million). */
export const WINDOW_REVEALS = 3;
/** At most this many devices wait for a window, and this many revealed requests wait for a code. */
export const MAX_PENDING = 3;

/** A device that asked to pair while no window was open. */
interface Waiter {
  deviceId: string;
  name: string;
  reveal: () => void;
}

export interface PairedDevice {
  id: string;
  name: string;
  /** The pairing key, hex. Whoever has it can act as this device: the file is private to this user. */
  key: string;
  pairedAt: number;
}

interface Request {
  deviceId: string;
  name: string;
  code: string;
  key: Buffer;
  since: number;
  grant: () => void;
  cancelExpiry: () => void;
}

export class Pairing {
  private readonly file: string;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private devices: PairedDevice[];
  private readonly requests: Request[] = [];
  private readonly waiters: Waiter[] = [];
  private window: { until: number; reveals: number } | null = null;

  constructor(file: string, clock: Clock, log: (line: string) => void) {
    this.file = file;
    this.clock = clock;
    this.log = log;
    this.devices = this.load();
  }

  /** The key this device was paired with, if it is paired. */
  keyOf(deviceId: string): Buffer | null {
    const d = this.devices.find((x) => x.id === deviceId);
    return d ? Buffer.from(d.key, 'hex') : null;
  }

  /** The user started pairing on this computer: devices may get a code now. */
  open(): { waiting: number } {
    this.window = { until: this.clock.now() + WINDOW_MS, reveals: WINDOW_REVEALS };
    while (this.waiters.length > 0 && this.takeReveal()) this.waiters.shift()!.reveal();
    return { waiting: this.requests.length + this.waiters.length };
  }

  /** A window is open and can still reveal an exchange. */
  isOpen(): boolean {
    return this.window !== null && this.clock.now() <= this.window.until && this.window.reveals > 0;
  }

  /**
   * A device asks to pair. reveal() runs now if a window can take it, or else when the
   * user opens one. Returns cancel, or null if too many devices are already waiting.
   */
  wait(deviceId: string, name: string, reveal: () => void): (() => void) | null {
    if (this.takeReveal()) {
      reveal();
      return () => {};
    }
    if (this.waiters.length >= MAX_PENDING) {
      this.log(`refused a pairing request from "${name}": ${MAX_PENDING} devices are already waiting`);
      return null;
    }
    const waiter: Waiter = { deviceId, name, reveal };
    this.waiters.push(waiter);
    this.log(`device "${name}" wants to pair: run codetalky pair on this computer`);
    return () => {
      const at = this.waiters.indexOf(waiter);
      if (at >= 0) this.waiters.splice(at, 1);
    };
  }

  /**
   * The exchange was revealed: code is what both sides computed; key is what this
   * computer will keep if the user approves, and grant() is called then. Returns cancel.
   */
  request(deviceId: string, name: string, code: string, key: Buffer, grant: () => void): (() => void) | null {
    if (this.requests.length >= MAX_PENDING) {
      this.log(`refused a pairing request from "${name}": ${MAX_PENDING} are already waiting`);
      return null;
    }
    const req: Request = { deviceId, name, code, key, since: this.clock.now(), grant, cancelExpiry: () => {} };
    req.cancelExpiry = this.clock.after(REQUEST_TTL_MS, () => this.drop(deviceId, req));
    this.requests.push(req);
    // The code is never printed: the user has to read it off the device, or the check means nothing.
    this.log(`device "${name}" shows a pairing code: type it into codetalky pair`);
    return () => this.drop(deviceId, req);
  }

  /** Devices waiting to pair (no codes: those are read off the device). */
  pending(): { deviceId: string; name: string; since: number; shown: boolean }[] {
    return [
      ...this.requests.map(({ deviceId, name, since }) => ({ deviceId, name, since, shown: true })),
      ...this.waiters.map(({ deviceId, name }) => ({ deviceId, name, since: 0, shown: false })),
    ];
  }

  /** The user typed the code the device shows. Ends the window. */
  approve(code: string): { deviceId: string; name: string } | null {
    const matching = this.requests.filter((r) => r.code === code);
    // Two requests with the same code: one of them is not the user's device. Pair neither.
    if (matching.length !== 1) return null;
    const req = matching[0]!;
    this.window = null;
    this.drop(req.deviceId, req);
    this.devices = this.devices.filter((d) => d.id !== req.deviceId);
    this.devices.push({ id: req.deviceId, name: req.name, key: req.key.toString('hex'), pairedAt: Math.floor(this.clock.now() / 1000) });
    this.save();
    this.log(`paired device "${req.name}"`);
    req.grant();
    return { deviceId: req.deviceId, name: req.name };
  }

  list(): { id: string; name: string; pairedAt: number }[] {
    return this.devices.map(({ id, name, pairedAt }) => ({ id, name, pairedAt }));
  }

  /** Forget a device by id or name. It has to pair again. */
  remove(idOrName: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== idOrName && d.name !== idOrName);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  private takeReveal(): boolean {
    if (!this.isOpen()) return false;
    this.window!.reveals--;
    return true;
  }

  /** Only ever a request itself: device ids are public, so one connection must not clear another's. */
  private drop(_deviceId: string, req: Request): void {
    const at = this.requests.indexOf(req);
    if (at < 0) return;
    req.cancelExpiry();
    this.requests.splice(at, 1);
  }

  private load(): PairedDevice[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { devices?: unknown };
      // Devices paired the old way (a token's hash, before 11-14) have to pair again.
      return Array.isArray(data.devices)
        ? (data.devices as PairedDevice[]).filter((d) => typeof d.id === 'string' && typeof d.key === 'string' && /^[0-9a-f]{64}$/.test(d.key))
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
  }
}
