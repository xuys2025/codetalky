// Turning what Claude Code writes into what the device shows: model names, patches,
// and the final message as report paragraphs.

import { LIMITS, type Hunk, type Para } from '../protocol.ts';

/** "claude-opus-5-5" -> "opus-5.5", "claude-sonnet-4-5-20250929" -> "sonnet-4.5". */
export function shortModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(model);
  if (m) return m[3] !== undefined ? `${m[1]}-${m[2]}.${m[3]}` : `${m[1]}-${m[2]}`;
  return model.replace(/^claude-/, '');
}

/** One hunk of Claude Code's structuredPatch. */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

const cleanLine = (line: string) => line.replace(/\r$/, '').replace(/\t/g, '  ');

/** Device hunks from a patch, newest file content line numbers. */
export function hunksFromPatch(file: string, patch: PatchHunk[]): Hunk[] {
  return patch.map((h) => {
    const lines = h.lines.filter((l) => /^[ +-]/.test(l)).map(cleanLine);
    return {
      file,
      line: h.newStart,
      add: lines.filter((l) => l.startsWith('+')).length,
      del: lines.filter((l) => l.startsWith('-')).length,
      lines: lines.slice(0, LIMITS.hunkLines),
    };
  });
}

/** Lines added and removed across a patch. */
export function patchStat(patch: PatchHunk[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of patch) {
    for (const l of h.lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  }
  return { add, del };
}

/** A diff for a pending edit, from old_string/new_string (no line numbers known). */
export function diffLines(oldText: string, newText: string): string[] {
  const a = oldText.split('\n').map(cleanLine);
  const b = newText.split('\n').map(cleanLine);
  // Keep the common head and tail as context, show the middle as removed/added.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ctxHead = a.slice(Math.max(0, head - 2), head).map((l) => ` ${l}`);
  const removed = a.slice(head, a.length - tail).map((l) => `-${l}`);
  const added = b.slice(head, b.length - tail).map((l) => `+${l}`);
  const ctxTail = a.slice(a.length - tail, a.length - tail + 2).map((l) => ` ${l}`);
  return [...ctxHead, ...removed, ...added, ...ctxTail];
}

/** Plain text from inline Markdown: **bold**, `code`, [text](url). */
export function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

const MAX_PARAS = 24;
const MAX_PARA = 1500;

/**
 * The agent's final message as report paragraphs. Bullets and numbered items become
 * bullets; a leading **bold** phrase becomes the bold lead. Code blocks and tables
 * are left out: the device can't show them well.
 */
export function reportFromMarkdown(text: string): Para[] {
  const paras: Para[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.trim() === '' || /^\s*\|/.test(line) || /^\s*([-*_])\1{2,}\s*$/.test(line)) continue;
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const body = bullet ? bullet[1]! : line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*>\s?/, '');
    const lead = /^\*\*(.+?)\*\*\s*([:：]?)\s*(.*)$/.exec(body.trim());
    let para: Para;
    if (lead && lead[3]) {
      para = { lead: plain(lead[1]!), text: `${lead[2] === ':' ? '：' : lead[2]}${plain(lead[3])}` };
    } else {
      para = { text: plain(body) };
    }
    if (bullet) para.b = true;
    if (para.text.length > MAX_PARA) para.text = `${para.text.slice(0, MAX_PARA)}…`;
    if (para.text || para.lead) paras.push(para);
    if (paras.length === MAX_PARAS) break;
  }
  return paras;
}

/** First paragraph of a message, flattened, for the "it said" line. */
export function firstWords(text: string, max = 300): string {
  const para = reportFromMarkdown(text).map((p) => `${p.lead ?? ''}${p.text}`)[0] ?? '';
  return para.length > max ? `${para.slice(0, max)}…` : para;
}
