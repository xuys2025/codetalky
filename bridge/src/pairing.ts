// Pairing: a device on the network may connect only after the user has said yes on
// this computer. The device shows a six-digit code; the user runs
// `codetalky pair <code>` here; the bridge then gives the device a token it presents
// from then on. Only a hash of each token is kept, in ~/.codetalky/devices.json.
//
// Known limit: the token travels over plain WebSocket. Anyone who can sniff the
// network could replay it. A challenge-response (HMAC over a nonce) would fix that.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Clock } from './clock.ts';

/** A pairing request waits this long for the user. */
const REQUEST_TTL_MS = 5 * 60 * 1000;

export interface PairedDevice {
  id: string;
  name: string;
  /** sha256 of the token, hex. */
  hash: string;
  pairedAt: number;
}

interface Request {
  deviceId: string;
  name: string;
  code: string;
  since: number;
  grant: (token: string) => void;
  cancelExpiry: () => void;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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

  /** Is this the token the device was given? */
  check(deviceId: string, token: string): boolean {
    const d = this.devices.find((x) => x.id === deviceId);
    if (!d || !/^[0-9a-f]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(d.hash, 'hex'), Buffer.from(sha256(token), 'hex'));
  }

  /** A device asks to pair. grant() is called with its token if the user approves. Returns cancel. */
  request(deviceId: string, name: string, code: string, grant: (token: string) => void): () => void {
    this.drop(deviceId);
    const req: Request = {
      deviceId,
      name,
      code,
      since: this.clock.now(),
      grant,
      cancelExpiry: () => {},
    };
    req.cancelExpiry = this.clock.after(REQUEST_TTL_MS, () => this.drop(deviceId));
    this.requests.push(req);
    this.log(`device "${name}" wants to pair. If its screen shows ${code}, run: codetalky pair ${code}`);
    return () => this.drop(deviceId, req);
  }

  pending(): { deviceId: string; name: string; code: string; since: number }[] {
    return this.requests.map(({ deviceId, name, code, since }) => ({ deviceId, name, code, since }));
  }

  /** The user said yes to the device showing this code. */
  approve(code: string): { deviceId: string; name: string } | null {
    const req = this.requests.find((r) => r.code === code);
    if (!req) return null;
    this.drop(req.deviceId, req);
    const token = randomBytes(32).toString('hex');
    this.devices = this.devices.filter((d) => d.id !== req.deviceId);
    this.devices.push({ id: req.deviceId, name: req.name, hash: sha256(token), pairedAt: Math.floor(this.clock.now() / 1000) });
    this.save();
    this.log(`paired device "${req.name}"`);
    req.grant(token);
    return { deviceId: req.deviceId, name: req.name };
  }

  list(): PairedDevice[] {
    return [...this.devices];
  }

  /** Forget a device by id or name. Its token stops working. */
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
      return Array.isArray(data.devices)
        ? (data.devices as PairedDevice[]).filter((d) => typeof d.id === 'string' && /^[0-9a-f]{64}$/.test(d.hash))
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ devices: this.devices }, null, 2)}\n`);
  }
}
