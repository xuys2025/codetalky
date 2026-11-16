// LAN discovery, so nobody types an IP address into the device. The device
// broadcasts {"t":"find"} on UDP; every bridge on the network answers with the id
// and port of its /device endpoint, and the device connects to the sender's address.
// The UDP port number is the same as the bridge's TCP port. See docs/PROTOCOL.md.

import { createSocket } from 'node:dgram';

import { PROTO } from './protocol.ts';

export interface DiscoveryOptions {
  /** UDP port to listen on; the device tries 8137..8140. */
  port: number;
  /** TCP port of the WebSocket endpoint (usually the same number). */
  wsPort: number;
  hostId: string;
  hostName: string;
  log: (line: string) => void;
  /** Print the log lines devices mirror over UDP (firmware debugging without a cable). */
  deviceLog?: boolean;
}

export interface Discovery {
  port: number;
  close(): Promise<void>;
}

/** A find request is tiny; anything bigger is not for us. */
const MAX_REQUEST = 256;
/** A mirrored log line can be longer. */
const MAX_LOG = 1024;

/** Battery and power readings the firmware sends every few seconds while testing. */
interface Diag {
  mv?: number; // battery voltage
  ma?: number; // battery current, negative while draining
  pct?: number;
  cap?: number; // full capacity, mAh
  ps?: string; // Wi-Fi power saving
  chg?: number; // charger: 0 not charging, 1 pre/fast, 2 constant voltage, 3 top-off, -1 unknown
  usb?: number; // 1 while USB power is present
  up?: number; // seconds since boot
  heap?: number; // free internal RAM, KB
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function describeDiag(d: Diag): string {
  const parts: string[] = [];
  const mv = num(d.mv);
  const ma = num(d.ma);
  const cap = num(d.cap);
  if (mv !== null) parts.push(`${(mv / 1000).toFixed(2)} V`);
  if (ma !== null) parts.push(ma < 0 ? `draws ${-ma} mA` : ma > 0 ? `charging ${ma} mA` : '0 mA');
  if (ma !== null && ma < 0 && cap !== null && cap > 0) parts.push(`full battery lasts about ${(cap / -ma).toFixed(1)} h`);
  if (num(d.pct) !== null) parts.push(`battery ${d.pct}%`);
  if (cap !== null && cap > 0) parts.push(`${cap} mAh`);
  if (num(d.usb) !== null) {
    const stage = ['not charging', 'charging', 'charging (constant voltage)', 'topping off'][num(d.chg) ?? -1];
    parts.push(d.usb ? `USB in, ${stage ?? 'charger unknown'}` : 'on battery');
  }
  if (typeof d.ps === 'string') parts.push(`Wi-Fi power saving ${d.ps.slice(0, 32)}`);
  if (num(d.up) !== null) parts.push(`up ${d.up} s`);
  if (num(d.heap) !== null) parts.push(`${d.heap} KB free`);
  return parts.join(', ');
}

export function startDiscovery(o: DiscoveryOptions): Promise<Discovery> {
  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  const reply = Buffer.from(JSON.stringify({ t: 'here', proto: PROTO, hostId: o.hostId, host: o.hostName, port: o.wsPort }));
  const seen = new Set<string>();
  sock.on('message', (msg, from) => {
    if (msg.length > MAX_LOG) return;
    let req: unknown;
    try {
      req = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (typeof req !== 'object' || req === null) return;
    if ((req as { t?: unknown }).t === 'log') {
      const s = (req as { s?: unknown }).s;
      // Strip terminal colour codes and control characters; the Wi-Fi library also
      // prints bare line ends.
      const line = typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m|[\x00-\x1f]/g, '').trimEnd() : '';
      if (o.deviceLog && line !== '') o.log(`device ${from.address}| ${line}`);
      return;
    }
    if (msg.length > MAX_REQUEST) return;
    if ((req as { t?: unknown }).t === 'diag') {
      o.log(`device at ${from.address}: ${describeDiag(req as Diag)}`);
      return;
    }
    if ((req as { t?: unknown }).t !== 'find') return;
    if (!seen.has(from.address)) {
      seen.add(from.address);
      o.log(`device at ${from.address} is looking for computers; answered`);
    }
    sock.send(reply, from.port, from.address);
  });
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(o.port, () => {
      sock.off('error', reject);
      sock.on('error', (err) => o.log(`discovery: ${err.message}`));
      resolve({
        port: sock.address().port,
        close: () => new Promise<void>((done) => sock.close(() => done())),
      });
    });
  });
}
