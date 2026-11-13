// Pairing and the encrypted link for devices on the network (docs/PROTOCOL.md, 配对).
// The device side is ui/src/ct_secure.c and ct_proto.c; change both together.
//
// Pairing works like Bluetooth's numeric comparison. Both sides make a one-off
// X25519 key; the computer also commits to a random value before it sees the
// device's. The six-digit code is computed by each side from both sides' keys and
// random values, so someone in the middle who swaps keys ends up with codes that
// don't match, and the user (who types the device's code on the computer) won't
// approve. The pairing key is derived on both sides and never sent.
//
// Every later connection: the computer sends a fresh challenge, the device proves it
// holds the pairing key, and both derive this connection's keys from it. From then on
// every frame is ChaCha20-Poly1305 (RFC 8439) with a per-direction counter as nonce.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

/** Bytes in a challenge or a commit-reveal random value. */
export const NONCE_BYTES = 16;
export const KEY_BYTES = 32;

/** A label or a variable-length string, prefixed with its length so parts can't run together. */
const lp = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([Math.min(b.length, 255)]), b.subarray(0, 255)]);
};

/** BLAKE2b-512 of a label and the parts, cut to size. */
export function derive(label: string, parts: Buffer[], size = KEY_BYTES): Buffer {
  const h = createHash('blake2b512');
  h.update(lp(label));
  for (const p of parts) h.update(p);
  return h.digest().subarray(0, size);
}

export const commitOf = (r: Buffer): Buffer => derive('codetalky commit', [r]);

/** The six digits both sides show or type. */
export function pairCode(devicePub: Buffer, bridgePub: Buffer, deviceR: Buffer, bridgeR: Buffer): string {
  const n = derive('codetalky code', [devicePub, bridgePub, deviceR, bridgeR], 4).readUInt32LE(0);
  return String(n % 1_000_000).padStart(6, '0');
}

export function pairKey(shared: Buffer, devicePub: Buffer, bridgePub: Buffer, deviceR: Buffer, bridgeR: Buffer): Buffer {
  return derive('codetalky key', [shared, devicePub, bridgePub, deviceR, bridgeR]);
}

/** What the device sends to show it holds the key. */
export function proofOf(key: Buffer, deviceId: string, hostId: string, bridgeNonce: Buffer, deviceNonce: Buffer): Buffer {
  return derive('codetalky proof', [key, lp(deviceId), lp(hostId), bridgeNonce, deviceNonce]);
}

/** This connection's two keys. */
export function linkKeys(key: Buffer, bridgeNonce: Buffer, deviceNonce: Buffer): { toBridge: Buffer; toDevice: Buffer } {
  return {
    toBridge: derive('codetalky device->bridge', [key, bridgeNonce, deviceNonce]),
    toDevice: derive('codetalky bridge->device', [key, bridgeNonce, deviceNonce]),
  };
}

export const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

export interface KeyPair {
  secret: KeyObject;
  pub: Buffer;
}

/** PKCS#8 wrapping of a raw 32-byte X25519 private key (RFC 8410). */
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** A fresh key pair; from given secret bytes only where results must repeat (rendering screenshots). */
export function newKeyPair(secret?: Buffer): KeyPair {
  const privateKey = secret
    ? createPrivateKey({ key: Buffer.concat([X25519_PKCS8, secret]), format: 'der', type: 'pkcs8' })
    : generateKeyPairSync('x25519').privateKey;
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  return { secret: privateKey, pub: Buffer.from(x ?? '', 'base64url') };
}

/** The X25519 shared secret, or null for a bad public key (wrong size, or one that makes it all zeros). */
export function sharedSecret(secret: KeyObject, theirPub: Buffer): Buffer | null {
  if (theirPub.length !== KEY_BYTES) return null;
  try {
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: theirPub.toString('base64url') }, format: 'jwk' });
    const s = diffieHellman({ privateKey: secret, publicKey: pub });
    return s.every((b) => b === 0) ? null : s;
  } catch {
    return null;
  }
}

export const random = (n = NONCE_BYTES): Buffer => randomBytes(n);

/** Hex of exactly n bytes, or null. */
export function fromHex(v: unknown, n: number): Buffer | null {
  return typeof v === 'string' && v.length === n * 2 && /^[0-9a-f]+$/.test(v) ? Buffer.from(v, 'hex') : null;
}

const nonceOf = (n: bigint): Buffer => {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(n, 0);
  return b;
};

/** Frames on an encrypted link: "E" + base64(tag || ciphertext). */
export class Channel {
  private sent = 0n;
  private got = 0n;
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;

  constructor(sendKey: Buffer, recvKey: Buffer) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
  }

  seal(text: string): string {
    const c = createCipheriv('chacha20-poly1305', this.sendKey, nonceOf(this.sent++), { authTagLength: 16 });
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `E${Buffer.concat([c.getAuthTag(), body]).toString('base64')}`;
  }

  /** The text, or null if the frame isn't the next one from the other side. */
  open(frame: string): string | null {
    if (!frame.startsWith('E')) return null;
    const raw = Buffer.from(frame.slice(1), 'base64');
    if (raw.length < 16) return null;
    try {
      const d = createDecipheriv('chacha20-poly1305', this.recvKey, nonceOf(this.got), { authTagLength: 16 });
      d.setAuthTag(raw.subarray(0, 16));
      const text = Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
      this.got++;
      return text;
    } catch {
      return null;
    }
  }
}
