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
}

export interface Discovery {
  port: number;
  close(): Promise<void>;
}

/** A find request is tiny; anything bigger is not for us. */
const MAX_REQUEST = 256;

export function startDiscovery(o: DiscoveryOptions): Promise<Discovery> {
  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  const reply = Buffer.from(JSON.stringify({ t: 'here', proto: PROTO, hostId: o.hostId, host: o.hostName, port: o.wsPort }));
  const seen = new Set<string>();
  sock.on('message', (msg, from) => {
    if (msg.length > MAX_REQUEST) return;
    let req: unknown;
    try {
      req = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (typeof req !== 'object' || req === null || (req as { t?: unknown }).t !== 'find') return;
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
