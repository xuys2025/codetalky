// Speech recognition with Doubao (Volcengine's "大模型流式语音识别"), streaming-input
// mode: samples go up while the user talks, the whole result comes back once the last
// packet is in (more accurate than the word-by-word mode, and the device only shows
// the words after the key is let go anyway).
//
// Protocol: https://www.volcengine.com/docs/6561/1354869 (checked 2026-11-16). Binary
// frames: a 4-byte header (version 1 | header size 1, message type | flags,
// serialization | compression, 0), for client frames an optional 4-byte sequence,
// then a 4-byte payload size and the gzipped payload; all integers big-endian.
//
// Credentials stay on this computer, in ~/.codetalky/doubao.json:
//   { "apiKey": "...", "resourceId": "volc.bigasr.sauc.duration" }
// (apiKey from the new console; or "appKey" + "accessKey" from the old one).

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import WebSocket from 'ws';

import { CONFIG_DIR } from './identity.ts';
import type { Recognition, Recognizer } from './voice.ts';

export const DOUBAO_FILE = join(CONFIG_DIR, 'doubao.json');
export const DOUBAO_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
/** ASR 1.0 and 2.0, hourly and concurrent billing: whichever the key is enabled for. */
export const DOUBAO_RESOURCES = ['volc.seedasr.sauc.duration', 'volc.bigasr.sauc.duration', 'volc.bigasr.sauc.concurrent', 'volc.seedasr.sauc.concurrent'];

export interface DoubaoConfig {
  apiKey?: string;
  appKey?: string;
  accessKey?: string;
  resourceId: string;
  url?: string;
}

export function loadDoubao(file = DOUBAO_FILE): DoubaoConfig | null {
  if (!existsSync(file)) return null;
  const c = JSON.parse(readFileSync(file, 'utf8')) as Partial<DoubaoConfig>;
  if (!c.apiKey && !(c.appKey && c.accessKey)) throw new Error(`${file}: needs apiKey (or appKey and accessKey)`);
  return { ...c, resourceId: c.resourceId ?? DOUBAO_RESOURCES[0]! };
}

// Header fields.
const FULL_CLIENT = 0b0001;
const AUDIO_ONLY = 0b0010;
const FULL_SERVER = 0b1001;
const ERROR = 0b1111;
const POS_SEQ = 0b0001; // a positive sequence number follows the header
const NEG_SEQ = 0b0011; // last packet: a negative sequence number follows
const JSON_SER = 0b0001;
const GZIP = 0b0001;

function frame(type: number, flags: number, serialization: number, seq: number, payload: Buffer): Buffer {
  const body = gzipSync(payload);
  const out = Buffer.alloc(12 + body.length);
  out[0] = (1 << 4) | 1;
  out[1] = (type << 4) | flags;
  out[2] = (serialization << 4) | GZIP;
  out[3] = 0;
  out.writeInt32BE(seq, 4);
  out.writeUInt32BE(body.length, 8);
  body.copy(out, 12);
  return out;
}

interface ServerFrame {
  last: boolean;
  json?: { result?: { text?: string }; audio_info?: { duration?: number } };
  error?: { code: number; message: string };
}

export function parseServerFrame(data: Buffer): ServerFrame | null {
  if (data.length < 8) return null;
  const headerSize = (data[0]! & 0x0f) * 4;
  const type = data[1]! >> 4;
  const flags = data[1]! & 0x0f;
  const gzip = (data[2]! & 0x0f) === GZIP;
  let at = headerSize;
  if (type === ERROR) {
    const code = data.readUInt32BE(at);
    const size = data.readUInt32BE(at + 4);
    let message = data.subarray(at + 8, at + 8 + size);
    if (gzip) message = gunzipSync(message);
    return { last: true, error: { code, message: message.toString('utf8') } };
  }
  if (type !== FULL_SERVER) return null;
  if (flags & 0b0001) at += 4; // sequence
  const size = data.readUInt32BE(at);
  let payload = data.subarray(at + 4, at + 4 + size);
  if (gzip && payload.length > 0) payload = gunzipSync(payload);
  return { last: (flags & 0b0010) !== 0, json: payload.length > 0 ? JSON.parse(payload.toString('utf8')) : {} };
}

/** About 200 ms per packet, as the docs recommend. */
const PACKET_BYTES = 6400;
const RESULT_TIMEOUT_MS = 15000;

export class Doubao implements Recognizer {
  readonly name = 'doubao';
  private readonly config: DoubaoConfig;
  private readonly uid: string;

  constructor(config: DoubaoConfig, uid = 'codetalky') {
    this.config = config;
    this.uid = uid;
  }

  start(): Recognition {
    const headers: Record<string, string> = {
      'X-Api-Resource-Id': this.config.resourceId,
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Connect-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    };
    if (this.config.apiKey) headers['X-Api-Key'] = this.config.apiKey;
    else {
      headers['X-Api-App-Key'] = this.config.appKey!;
      headers['X-Api-Access-Key'] = this.config.accessKey!;
    }
    const ws = new WebSocket(this.config.url ?? DOUBAO_URL, { headers });
    let seq = 1;
    let pending = Buffer.alloc(0);
    let logId = '';
    let cancelled = false;
    let ended = false;
    let settle: ((r: { text: string } | { error: Error }) => void) | null = null;
    const outcome = new Promise<{ text: string } | { error: Error }>((resolve) => (settle = resolve));
    const done = (r: { text: string } | { error: Error }) => {
      settle?.(r);
      settle = null;
      ws.removeAllListeners('close');
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    };
    const fail = (message: string) => done({ error: new Error(logId ? `${message} (logid ${logId})` : message) });

    const sendAudio = (last: boolean) => {
      while (pending.length >= PACKET_BYTES || (last && pending.length >= 0)) {
        const chunk = pending.subarray(0, Math.min(PACKET_BYTES, pending.length));
        pending = pending.subarray(chunk.length);
        const isLast = last && pending.length === 0;
        seq++;
        ws.send(frame(AUDIO_ONLY, isLast ? NEG_SEQ : POS_SEQ, 0, isLast ? -seq : seq, chunk));
        if (isLast) break;
      }
    };

    ws.on('upgrade', (res) => {
      logId = String(res.headers['x-tt-logid'] ?? '');
    });
    ws.on('unexpected-response', (_req, res) => {
      logId = String(res.headers['x-tt-logid'] ?? '');
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString('utf8')));
      res.on('end', () => fail(`Doubao refused the connection: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
    });
    ws.on('open', () => {
      if (cancelled) return;
      const request = {
        user: { uid: this.uid },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        // ddc: drops filler words ("嗯", "那个") and repeats: instructions read cleaner.
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: true },
      };
      ws.send(frame(FULL_CLIENT, POS_SEQ, JSON_SER, seq, Buffer.from(JSON.stringify(request))));
      sendAudio(ended);
    });
    ws.on('message', (data: Buffer) => {
      let f: ServerFrame | null;
      try {
        f = parseServerFrame(data);
      } catch (e) {
        fail(`bad frame from Doubao: ${(e as Error).message}`);
        return;
      }
      if (f === null) return;
      if (f.error) {
        fail(`Doubao error ${f.error.code}: ${f.error.message}`);
      } else if (f.last) {
        done({ text: f.json?.result?.text ?? '' });
      }
    });
    ws.on('error', (e) => fail(`Doubao connection: ${e.message}`));
    ws.on('close', (code) => fail(`Doubao closed the connection (${code}) without a result`));

    return {
      push: (pcm) => {
        if (cancelled || ended) return;
        pending = Buffer.concat([pending, pcm]);
        if (ws.readyState === WebSocket.OPEN) sendAudio(false);
      },
      finish: async () => {
        ended = true;
        if (ws.readyState === WebSocket.OPEN) sendAudio(true);
        const timer = setTimeout(() => fail('Doubao did not answer in time'), RESULT_TIMEOUT_MS);
        const r = await outcome;
        clearTimeout(timer);
        if ('error' in r) throw r.error;
        return r.text;
      },
      cancel: () => {
        cancelled = true;
        done({ text: '' });
      },
    };
  }
}
