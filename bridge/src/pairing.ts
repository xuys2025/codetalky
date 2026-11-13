// Pairing: a device on the network may connect only after the user has said yes on
// this computer. The device shows a six-digit code that both sides compute from the
// pairing exchange (see secure.ts); the user runs `codetalky pair <code>` here, which
// only matches if nobody sat in the middle. Both sides then hold the same pairing
// key, which never crosses the network. Keys are kept in ~/.codetalky/devices.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Clock } from './clock.ts';

/** A pairing request waits this long for the user. */
const REQUEST_TTL_MS = 5 * 60 * 1000;
/**
 * At most this many requests wait at once. Codes have six digits: someone on the
 * network who could park thousands of requests would likely hold one with whatever
 * code the user types. Beyond this, new requests are refused until old ones go.
 */
export const MAX_PENDING = 3;

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

  /**
   * A device asks to pair. code is what both sides computed; key is what this
   * computer will keep if the user approves, and grant() is called then. Returns cancel.
   */
  request(deviceId: string, name: string, code: string, key: Buffer, grant: () => void): (() => void) | null {
    this.drop(deviceId);
    if (this.requests.length >= MAX_PENDING) {
      this.log(`refused a pairing request from "${name}": ${MAX_PENDING} are already waiting (see codetalky pair)`);
      return null;
    }
    const req: Request = { deviceId, name, code, key, since: this.clock.now(), grant, cancelExpiry: () => {} };
    req.cancelExpiry = this.clock.after(REQUEST_TTL_MS, () => this.drop(deviceId));
    this.requests.push(req);
    // The code is not printed: the user has to read it off the device, or the check means nothing.
    this.log(`device "${name}" wants to pair: run codetalky pair <the code on its screen>`);
    return () => this.drop(deviceId, req);
  }

  pending(): { deviceId: string; name: string; code: string; since: number }[] {
    return this.requests.map(({ deviceId, name, code, since }) => ({ deviceId, name, code, since }));
  }

  /** The user typed the code the device shows. */
  approve(code: string): { deviceId: string; name: string } | null {
    const matching = this.requests.filter((r) => r.code === code);
    // Two requests with the same code: one of them is not the user's device. Pair neither.
    if (matching.length !== 1) return null;
    const req = matching[0]!;
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

  private drop(deviceId: string, only?: Request): void {
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const r = this.requests[i]!;
      if (r.deviceId === deviceId && (!only || r === only)) {
        r.cancelExpiry();
        this.requests.splice(i, 1);
      }
    }
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
