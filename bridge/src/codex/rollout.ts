// Reads a Codex session file (its "rollout", JSONL, named in every hook's
// transcript_path) incrementally, for what Codex's hooks don't carry: the files
// apply_patch changed (Codex fires no PostToolUse for it) and what Codex says as it
// works. Only "item_completed" events are used: typed items (the ones Codex's app
// server sends its clients), not the raw model traffic around them.

import { JsonlTail } from '../claude/transcript.ts';
import type { PatchHunk } from '../claude/text.ts';

export interface ChangedFile {
  /** As Codex wrote it (absolute). */
  path: string;
  st: 'A' | 'M' | 'D';
  moveTo?: string;
  hunks: PatchHunk[];
}

/** One completed apply_patch: its id matches the tool_use_id its hooks carried. */
export interface CompletedChange {
  id: string;
  files: ChangedFile[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** "@@ -3 +3,2 @@\n two\n+one\n" -> hunks. */
export function parseUnifiedDiff(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | null = null;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      hunk = {
        oldStart: Number(head[1]),
        oldLines: head[2] === undefined ? 1 : Number(head[2]),
        newStart: Number(head[3]),
        newLines: head[4] === undefined ? 1 : Number(head[4]),
        lines: [],
      };
      hunks.push(hunk);
    } else if (hunk && /^[ +-]/.test(line)) {
      hunk.lines.push(line);
    }
  }
  return hunks;
}

/** A whole file's text as one hunk of added (or removed) lines. */
function wholeFile(content: string, sign: '+' | '-'): PatchHunk[] {
  const lines = content.replace(/\n$/, '').split('\n');
  if (content === '') return [];
  return [{ oldStart: sign === '-' ? 1 : 0, oldLines: sign === '-' ? lines.length : 0, newStart: sign === '+' ? 1 : 0, newLines: sign === '+' ? lines.length : 0, lines: lines.map((l) => sign + l) }];
}

export function changedFiles(changes: unknown): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const [path, raw] of Object.entries(obj(changes))) {
    const c = obj(raw);
    if (c.type === 'add') files.push({ path, st: 'A', hunks: wholeFile(str(c.content) ?? '', '+') });
    else if (c.type === 'delete') files.push({ path, st: 'D', hunks: wholeFile(str(c.content) ?? '', '-') });
    else if (c.type === 'update') {
      const file: ChangedFile = { path, st: 'M', hunks: parseUnifiedDiff(str(c.unified_diff) ?? '') };
      const moveTo = str(c.move_path);
      if (moveTo) file.moveTo = moveTo;
      files.push(file);
    }
  }
  return files;
}

/** What happened since the last look. */
export interface RolloutNews {
  changes: CompletedChange[];
  /** A turn was interrupted (Esc, or no to a prompt): Codex stopped without a Stop hook. */
  aborted: boolean;
}

export class RolloutTail extends JsonlTail {
  /** Latest thing Codex said. */
  text: string | undefined;
  private news: RolloutNews = { changes: [], aborted: false };
  private primed = false;

  /** Read what was appended; returns what happened since last time. */
  update(): RolloutNews {
    this.read();
    const out = this.news;
    this.news = { changes: [], aborted: false };
    // The first read catches up on history (a resumed session, or a bridge started
    // mid-session): that happened before anyone was watching.
    if (!this.primed) {
      this.primed = true;
      return { changes: [], aborted: false };
    }
    return out;
  }

  protected take(entry: Record<string, unknown>): void {
    if (entry.type !== 'event_msg') return;
    const p = obj(entry.payload);
    if (p.type === 'turn_aborted') {
      this.news.aborted = true;
      return;
    }
    // A later turn started: an earlier interruption is old news.
    if (p.type === 'task_started') this.news.aborted = false;
    if (p.type !== 'item_completed') return;
    const item = obj(p.item);
    if (item.type === 'AgentMessage' && Array.isArray(item.content)) {
      const text = (item.content as unknown[])
        .map(obj)
        .map((c) => str(c.text) ?? '')
        .join('')
        .trim();
      if (text) this.text = text;
    } else if (item.type === 'FileChange' && item.status === 'completed') {
      const files = changedFiles(item.changes);
      if (files.length > 0) this.news.changes.push({ id: str(item.id) ?? '', files });
    }
  }
}
