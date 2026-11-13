// Wire protocol between a CodeTalky device and the bridge. See docs/PROTOCOL.md.
// The device-side parser is ui/src/ct_proto.c; change both together and bump PROTO.

export const PROTO = 1;

export type SessionState = 'idle' | 'running' | 'approve' | 'question' | 'done' | 'error';

/** One step the agent took. Times are Unix seconds. */
export interface LogEntry {
  at: number;
  verb: string;
  target: string;
  add?: number;
  del?: number;
  /** Short result shown when there is no add/del: "通过", "88 行". */
  res?: string;
  bad?: boolean;
}

export interface FileChange {
  st: 'M' | 'A' | 'D';
  path: string;
  add: number;
  del: number;
}

export interface Hunk {
  file: string;
  line: number;
  add: number;
  del: number;
  /** Each line starts with ' ', '+' or '-'. */
  lines: string[];
}

export interface ApproveAsk {
  kind: 'approve';
  req: string;
  verb: string;
  target: string;
  add?: number;
  del?: number;
  line?: number;
  lines?: string[];
  why?: string;
  /** After this time the device can no longer answer. */
  until?: number;
  /** The device asks for a long press before approving. */
  risky?: boolean;
}

export interface QuestionAsk {
  kind: 'question';
  req: string;
  text: string;
  note?: string;
  options: { label: string; desc?: string }[];
}

/** One paragraph of the agent's final message. */
export interface Para {
  b?: boolean;
  lead?: string;
  text: string;
}

export interface SessionSnapshot {
  id: string;
  name: string;
  agent: 'claude' | 'codex';
  model: string;
  branch?: string;
  state: SessionState;
  since: number;
  started: number;
  /** Whether the device may send it new instructions. */
  reply: boolean;
  now?: { verb: string; target: string; add?: number; del?: number };
  say?: string;
  n: { read: number; edit: number; new: number; cmd: number; add: number; del: number };
  ctx?: number;
  todos?: { done: number; items: string[] };
  log: LogEntry[];
  files: FileChange[];
  hunks: { total: number; list: Hunk[] };
  ask?: ApproveAsk | QuestionAsk;
  report?: Para[];
  err?: string;
}

export type AckError = 'gone' | 'stale' | 'unsupported' | 'bad';

export type ToDevice =
  /** host: this computer's name as the user knows it; hostId: stays the same across restarts and IP changes. */
  | { t: 'hello'; proto: number; host: string; hostId: string; time: number; tz: number; quick: string[] }
  | { t: 'session'; s: SessionSnapshot }
  | { t: 'gone'; id: string }
  | { t: 'ready' }
  | { t: 'ack'; seq: number; ok: boolean; err?: AckError }
  /** Before anything else on a network connection: show your token, or ask to pair. bad: the token was refused. */
  | { t: 'auth'; host: string; hostId: string; bad?: boolean }
  /** The user approved pairing on the computer: keep this token for hostId. */
  | { t: 'paired'; token: string };

export type DeviceAction =
  | { t: 'approve'; seq: number; id: string; req: string; allow: boolean }
  | { t: 'answer'; seq: number; id: string; req: string; option: number }
  | { t: 'reply'; seq: number; id: string; text: string }
  | { t: 'seen'; seq: number; id: string };

export type FromDevice =
  | { t: 'hello'; proto: number; device: string; deviceId: string | null }
  /** The token this computer gave it when they paired. */
  | { t: 'auth'; token: string }
  /** Ask to pair; the device shows the code, the user types it on the computer. */
  | { t: 'pair'; code: string }
  | DeviceAction;

/** Limits the bridge applies before sending, so the device can size its buffers. */
export const LIMITS = {
  id: 47,
  log: 48,
  hunks: 6,
  hunkLines: 14,
  replyText: 2000,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= LIMITS.id;
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/** Parse one frame from a device. Returns null for anything malformed. */
export function parseFromDevice(text: string): FromDevice | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(msg)) return null;
  if (msg.t === 'hello') {
    if (typeof msg.proto !== 'number' || typeof msg.device !== 'string') return null;
    const deviceId = typeof msg.deviceId === 'string' && /^[0-9a-f]{16,32}$/.test(msg.deviceId) ? msg.deviceId : null;
    return { t: 'hello', proto: msg.proto, device: msg.device.slice(0, 32), deviceId };
  }
  if (msg.t === 'auth') {
    return typeof msg.token === 'string' && msg.token.length <= 128 ? { t: 'auth', token: msg.token } : null;
  }
  if (msg.t === 'pair') {
    return typeof msg.code === 'string' && /^\d{6}$/.test(msg.code) ? { t: 'pair', code: msg.code } : null;
  }
  if (!isSeq(msg.seq) || !isId(msg.id)) return null;
  const base = { seq: msg.seq, id: msg.id };
  switch (msg.t) {
    case 'approve':
      if (typeof msg.req !== 'string' || typeof msg.allow !== 'boolean') return null;
      return { t: 'approve', ...base, req: msg.req, allow: msg.allow };
    case 'answer':
      if (typeof msg.req !== 'string' || typeof msg.option !== 'number' || !Number.isInteger(msg.option)) return null;
      return { t: 'answer', ...base, req: msg.req, option: msg.option };
    case 'reply':
      if (typeof msg.text !== 'string') return null;
      return { t: 'reply', ...base, text: msg.text };
    case 'seen':
      return { t: 'seen', ...base };
    default:
      return null;
  }
}
