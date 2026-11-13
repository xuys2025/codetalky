// Reads a Claude Code transcript (JSONL) incrementally for what hooks don't carry:
// the model, the git branch, the latest assistant text and the todo list.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

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

export class TranscriptTail {
  readonly path: string;
  readonly state: TranscriptState = {};
  private offset = -1;
  private partial = '';

  constructor(path: string) {
    this.path = path;
  }

  /** Read whatever was appended since last time. Never throws. */
  update(): TranscriptState {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return this.state;
    }
    try {
      const size = fstatSync(fd).size;
      if (this.offset < 0) this.offset = Math.max(0, size - FIRST_READ_MAX);
      if (size < this.offset) this.offset = 0; // rewritten
      if (size === this.offset) return this.state;
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const lines = (this.partial + buf.toString('utf8')).split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) this.take(line);
    } catch {
      // A transcript we can't read just means less detail on the device.
    } finally {
      closeSync(fd);
    }
    return this.state;
  }

  private take(line: string): void {
    if (!line.trim()) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
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
