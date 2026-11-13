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
  /** Several options may be picked (sent together with "确定"). */
  multi?: boolean;
}

/** The agent's plan, waiting to be approved before it starts (Claude Code's plan mode). */
export interface PlanAsk {
  kind: 'plan';
  req: string;
  /** The plan, as paragraphs like a report. */
  plan: Para[];
  until?: number;
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
  /** Running, but stuck on a prompt in its terminal that only the computer can answer (say tells why). */
  there?: boolean;
  n: { read: number; edit: number; new: number; cmd: number; add: number; del: number };
  ctx?: number;
  todos?: { done: number; items: string[] };
  log: LogEntry[];
  files: FileChange[];
  hunks: { total: number; list: Hunk[] };
  ask?: ApproveAsk | QuestionAsk | PlanAsk;
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
  /**
   * Before anything else on a network connection (plain): prove you hold the pairing
   * key for this computer, or pair. nonce: this connection's challenge. pub, commit:
   * this computer's side of a pairing exchange. bad: the proof was refused.
   */
  | { t: 'auth'; host: string; hostId: string; nonce: string; pub: string; commit: string; bad?: boolean }
  /** Pairing (plain): the value committed to in auth. The device can now show the code. */
  | { t: 'pairing'; r: string }
  /** The user approved the code on the computer. The first encrypted frame; the device answers with its own paired once the user confirms there too. */
  | { t: 'paired' };

/** An answer to a question: one option, several (multi), or the user's own words. */
export type Choice = { option: number } | { options: number[] } | { text: string };

export type DeviceAction =
  /** text: for a plan sent back, what to change. */
  | { t: 'approve'; seq: number; id: string; req: string; allow: boolean; text?: string }
  | ({ t: 'answer'; seq: number; id: string; req: string } & Choice)
  | { t: 'reply'; seq: number; id: string; text: string }
  | { t: 'seen'; seq: number; id: string };

export type FromDevice =
  | { t: 'hello'; proto: number; device: string; deviceId: string | null }
  /** Holds the pairing key: proof over the challenge and its own nonce (hex). */
  | { t: 'auth'; nonce: string; proof: string }
  /** Ask to pair: its side of the exchange (hex). It shows the code once the computer reveals its value. */
  | { t: 'pair'; pub: string; r: string }
  /** The user confirmed on the device too that the computer said it paired (sent encrypted). */
  | { t: 'paired' }
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
  const hex = (v: unknown, bytes: number): v is string => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);
  if (msg.t === 'auth') {
    return hex(msg.nonce, 16) && hex(msg.proof, 32) ? { t: 'auth', nonce: msg.nonce, proof: msg.proof } : null;
  }
  if (msg.t === 'pair') {
    return hex(msg.pub, 32) && hex(msg.r, 16) ? { t: 'pair', pub: msg.pub, r: msg.r } : null;
  }
  if (msg.t === 'paired') return { t: 'paired' };
  if (!isSeq(msg.seq) || !isId(msg.id)) return null;
  const base = { seq: msg.seq, id: msg.id };
  switch (msg.t) {
    case 'approve':
      if (typeof msg.req !== 'string' || typeof msg.allow !== 'boolean') return null;
      if (msg.text !== undefined && typeof msg.text !== 'string') return null;
      return { t: 'approve', ...base, req: msg.req, allow: msg.allow, ...(typeof msg.text === 'string' ? { text: msg.text } : {}) };
    case 'answer': {
      if (typeof msg.req !== 'string') return null;
      const given = [msg.option, msg.options, msg.text].filter((v) => v !== undefined).length;
      if (given !== 1) return null;
      if (typeof msg.option === 'number' && Number.isInteger(msg.option)) return { t: 'answer', ...base, req: msg.req, option: msg.option };
      if (Array.isArray(msg.options) && msg.options.length > 0 && msg.options.every((o) => typeof o === 'number' && Number.isInteger(o))) {
        return { t: 'answer', ...base, req: msg.req, options: msg.options as number[] };
      }
      if (typeof msg.text === 'string') return { t: 'answer', ...base, req: msg.req, text: msg.text };
      return null;
    }
    case 'reply':
      if (typeof msg.text !== 'string') return null;
      return { t: 'reply', ...base, text: msg.text };
    case 'seen':
      return { t: 'seen', ...base };
    default:
      return null;
  }
}
