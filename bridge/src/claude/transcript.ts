// Reads a Claude Code transcript (JSONL) incrementally for what hooks don't carry:
// the model, the git branch, the latest assistant text and the todo list.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface TranscriptState {
  model?: string;
  branch?: string;
  /** Latest assistant text block. */
  text?: string;
  todos?: { done: number; items: string[] };
}

/** Don't read more than this much of an existing transcript the first time. */
const FIRST_READ_MAX = 4 * 1024 * 1024;

interface Todo {
  content?: unknown;
  status?: unknown;
}

export function todosFrom(input: unknown): TranscriptState['todos'] | undefined {
  const list = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(list)) return undefined;
  const items: string[] = [];
  let done = 0;
  // The device shows done ones first, then the current one; keep Claude's order otherwise.
  const ordered = [...(list as Todo[])].sort((a, b) => rank(a.status) - rank(b.status));
  for (const t of ordered) {
    if (typeof t.content !== 'string') continue;
    items.push(t.content);
    if (t.status === 'completed') done++;
  }
  return { done, items };
}

const rank = (status: unknown) => (status === 'completed' ? 0 : status === 'in_progress' ? 1 : 2);

/** A line longer than this is dropped rather than kept growing in memory. */
const MAX_LINE = 8 * 1024 * 1024;
/** How much of what was read last is kept to notice a file rewritten in place. */
const SEEN_BYTES = 64;

/** Reads a JSONL file incrementally: each update() hands over the lines appended since the last one. */
export abstract class JsonlTail {
  readonly path: string;
  private offset = -1;
  private partial = '';
  /** Keeps a character split between two reads whole. */
  private decoder = new StringDecoder('utf8');
  /** Which file this is (a new one under the same name starts over). */
  private identity = '';
  /** Inside a line too long to keep: skip to its end. */
  private skipping = false;
  /** The last bytes read, ending at offset: if they changed, the file was rewritten in place. */
  private seen = Buffer.alloc(0);

  constructor(path: string) {
    this.path = path;
  }

  /** Read what was appended since last time, at most FIRST_READ_MAX at once. Never throws. */
  protected read(): void {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const stat = fstatSync(fd);
      const size = stat.size;
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (this.offset < 0) {
        this.offset = Math.max(0, size - FIRST_READ_MAX);
        this.skipping = this.offset > 0; // started mid-file: the first line is a fragment
      } else if (size < this.offset || identity !== this.identity || !this.unchanged(fd)) {
        // Rewritten or replaced: start over, with nothing left of the old file.
        this.offset = 0;
        this.partial = '';
        this.decoder = new StringDecoder('utf8');
        this.skipping = false;
        this.seen = Buffer.alloc(0);
      }
      this.identity = identity;
      if (size === this.offset) return;
      const buf = Buffer.alloc(Math.min(size - this.offset, FIRST_READ_MAX));
      const got = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += got;
      this.seen = Buffer.from(Buffer.concat([this.seen, buf.subarray(0, got)]).subarray(-SEEN_BYTES));
      const lines = (this.partial + this.decoder.write(buf.subarray(0, got))).split('\n');
      this.partial = lines.pop() ?? '';
      if (this.skipping && lines.length > 0) {
        lines.shift();
        this.skipping = false;
      }
      if (this.partial.length > MAX_LINE) {
        this.partial = '';
        this.skipping = true;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.take(entry);
      }
    } catch {
      // A transcript we can't read just means less detail on the device.
    } finally {
      closeSync(fd);
    }
  }

  /** The bytes before offset are still the ones read last time. */
  private unchanged(fd: number): boolean {
    if (this.seen.length === 0) return true;
    const now = Buffer.alloc(this.seen.length);
    const got = readSync(fd, now, 0, now.length, this.offset - this.seen.length);
    return got === now.length && now.equals(this.seen);
  }

  protected abstract take(entry: Record<string, unknown>): void;
}

export class TranscriptTail extends JsonlTail {
  readonly state: TranscriptState = {};

  update(): TranscriptState {
    this.read();
    return this.state;
  }

  protected take(entry: Record<string, unknown>): void {
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) this.state.branch = entry.gitBranch;
    if (entry.type !== 'assistant') return;
    const message = entry.message as { model?: unknown; content?: unknown } | undefined;
    if (typeof message?.model === 'string' && !message.model.startsWith('<')) this.state.model = message.model;
    if (!Array.isArray(message?.content)) return;
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.state.text = block.text;
      } else if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        const todos = todosFrom(block.input);
        if (todos) this.state.todos = todos;
      }
    }
  }
}
