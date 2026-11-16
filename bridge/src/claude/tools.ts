// How Claude Code's tool calls look on the device: a short verb, a target, a result,
// and for pending permission requests, what exactly would change.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import { LIMITS, type ApproveAsk, type FileChange, type Hunk } from '../protocol.ts';
import { diffLines, hunksFromPatch, patchStat, type PatchHunk } from './text.ts';

export type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The device's verb column is about five characters wide. */
const VERBS: Record<string, string> = {
  PowerShell: 'Shell',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  NotebookRead: 'Read',
  WebFetch: 'Fetch',
  WebSearch: 'Web',
  TodoWrite: 'Todo',
  Task: 'Agent',
  ToolSearch: 'Tools',
  AskUserQuestion: '问',
  ExitPlanMode: '计划',
};

export function verbOf(tool: string): string {
  if (tool.startsWith('mcp__')) return 'MCP';
  return VERBS[tool] ?? tool.slice(0, 5);
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'NotebookRead']);

export function isFileTool(tool: string): boolean {
  return FILE_TOOLS.has(tool);
}

/** A path as the user thinks of it: relative to the project, with forward slashes. */
export function showPath(path: string, cwd: string | undefined): string {
  let p = path;
  if (cwd && isAbsolute(p)) {
    const rel = relative(cwd, p);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) p = rel;
  }
  return p.replace(/\\/g, '/');
}

const oneLine = (s: string, max = 200) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

const CD = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*/;
const normDir = (p: string) => {
  // Git Bash spells C:\x as /c/x.
  const d = p.replace(/\\/g, '/').replace(/^\/([a-zA-Z])(\/|$)/, '$1:/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(d) ? d.toLowerCase() : d;
};

/**
 * Claude Code often starts a command with `cd "<project>" &&`. On a one-line screen
 * that shows only the path, so drop it when it is the session's own directory.
 */
export function dropCd(command: string, cwd: string | undefined): string {
  const m = CD.exec(command);
  if (!m || !cwd) return command;
  const dir = m[1] ?? m[2] ?? m[3] ?? '';
  const rest = command.slice(m[0].length);
  return rest && normDir(dir) === normDir(cwd) ? rest : command;
}

/** What the tool works on: a file, a command, a pattern, a URL. */
export function targetOf(tool: string, input: Input, cwd: string | undefined): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (isFileTool(tool) && path) return showPath(path, cwd);
  const command = str(input.command);
  const pick =
    (command === undefined ? undefined : dropCd(command, cwd)) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    str(input.description) ??
    str(input.skill) ??
    str(input.prompt) ??
    path ??
    Object.values(input).find((v): v is string => typeof v === 'string');
  if (tool.startsWith('mcp__') && pick === undefined) return tool.split('__').slice(2).join('__');
  return oneLine(pick ?? '');
}

export type Counter = 'read' | 'edit' | 'new' | 'cmd';

export function counterOf(tool: string, created: boolean): Counter | null {
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Write':
      return created ? 'new' : 'edit';
    case 'Bash':
    case 'PowerShell':
      return 'cmd';
    default:
      return null;
  }
}

export interface ToolResult {
  res?: string;
  /** Lines added and removed in total; undefined for tools that don't change files. */
  add?: number;
  del?: number;
  hunks: Hunk[];
  /** The files it changed (Codex's apply_patch can change several at once). */
  files: FileChange[];
  /** It made a new file (counts as "new" rather than "edit"). */
  created: boolean;
  /** It failed (a command that exited non-zero). */
  bad?: boolean;
}

/** How one agent's tool calls look on the device. */
export interface ToolKit {
  verbOf(tool: string): string;
  targetOf(tool: string, input: Input, cwd: string | undefined): string;
  /** The log shows just the file name for these. */
  isFileTool(tool: string): boolean;
  counterOf(tool: string, created: boolean): Counter | null;
  resultOf(tool: string, input: Input, response: unknown, cwd: string | undefined): ToolResult;
  askOf(tool: string, input: Input, cwd: string | undefined): AskBody;
  /** A call that is really another tool (Codex runs apply_patch through the shell). */
  normalize?(tool: string, input: Input): { tool: string; input: Input };
}

const lineCount = (text: string) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);

/** Read a finished tool call's response for the log: line counts, hunks, a short result. */
export function resultOf(tool: string, input: Input, response: unknown, cwd: string | undefined): ToolResult {
  const r = (response && typeof response === 'object' ? response : {}) as Input;
  const out: ToolResult = { hunks: [], files: [], created: false };
  const file = showPath(str(r.filePath) ?? str(input.file_path) ?? '', cwd);
  const patch = Array.isArray(r.structuredPatch) ? (r.structuredPatch as PatchHunk[]) : null;
  const fromPatch = () => {
    if (!patch) return;
    const stat = patchStat(patch);
    out.add = stat.add;
    out.del = stat.del;
    out.hunks = hunksFromPatch(file, patch);
  };
  switch (tool) {
    case 'Read': {
      const f = r.file as Input | undefined;
      let lines = num(f?.numLines);
      const content = str(f?.content);
      // Claude Code counts the empty "line" after a final newline: "zero\n" is 2 lines to it.
      if (lines !== undefined && content?.endsWith('\n') && content.split('\n').length === lines) lines -= 1;
      if (lines !== undefined) out.res = `${lines} 行`;
      break;
    }
    case 'Grep': {
      if (r.mode === 'files_with_matches' && num(r.numFiles) !== undefined) out.res = `${r.numFiles} 个文件`;
      else if (r.mode === 'count' && num(r.numMatches) !== undefined) out.res = `${r.numMatches} 处`;
      else if (num(r.numLines) !== undefined) out.res = `${r.numLines} 行`;
      break;
    }
    case 'Glob':
      if (num(r.numFiles) !== undefined) out.res = `${r.numFiles} 个`;
      break;
    case 'Bash':
    case 'PowerShell':
      out.res = r.interrupted === true ? '中断' : '完成';
      break;
    case 'Write':
      if (r.type === 'create' || (patch !== null && patch.length === 0)) {
        const content = str(r.content) ?? str(input.content) ?? '';
        out.created = r.type === 'create';
        out.add = lineCount(content);
        out.del = 0;
        const lines = content.split('\n').slice(0, LIMITS.hunkLines).map((l) => `+${l.replace(/\r$/, '').replace(/\t/g, '  ')}`);
        if (lines.length > 0) out.hunks = [{ file, line: 1, add: out.add, del: 0, lines }];
      } else {
        fromPatch(); // an overwrite has a patch like an edit
      }
      break;
    case 'Edit':
    case 'MultiEdit':
      fromPatch();
      break;
    case 'WebFetch':
      if (num(r.code) !== undefined) out.res = String(r.code);
      break;
    case 'Agent':
    case 'Task':
      // A background subagent's call returns at once; it reports back later.
      out.res = r.status === 'async_launched' ? '后台' : '完成';
      break;
    default:
      break;
  }
  if (out.add !== undefined && file && (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write')) {
    out.files = [{ st: out.created ? 'A' : 'M', path: file, add: out.add, del: out.del ?? 0 }];
  }
  return out;
}

/**
 * Commands that can't be taken back, or reach outside this machine, need a long
 * press on the device instead of a tap.
 */
const RISKY = [
  /\brm\s/,
  /\brmdir\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+(--|\.)/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\b[^|;&]*\s(--force(-with-lease)?|-f)\b/,
  /\bsudo\b/,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bRemove-Item\b/i,
  /\bdel\s/i,
  /\bmkfs\b|\bdd\s+if=/,
  /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bchmod\s+-R\b|\bchown\s+-R\b/,
];

export function isRisky(tool: string, input: Input): boolean {
  if (tool !== 'Bash' && tool !== 'PowerShell') return false;
  const command = str(input.command) ?? '';
  return RISKY.some((re) => re.test(command));
}

/** Line number (1-based) where text starts in the file, if it can be found. */
export function lineOf(path: string, text: string): number | undefined {
  try {
    if (statSync(path).size > 2 * 1024 * 1024) return undefined;
    const content = readFileSync(path, 'utf8');
    const at = content.indexOf(text);
    if (at < 0) return undefined;
    return content.slice(0, at).split('\n').length;
  } catch {
    return undefined;
  }
}

export type AskBody = Omit<ApproveAsk, 'kind' | 'req' | 'until'>;

const countLines = (lines: string[]) => ({
  add: lines.filter((l) => l.startsWith('+')).length,
  del: lines.filter((l) => l.startsWith('-')).length,
});

/** What a pending permission request would do, for the approve screen. */
export function askOf(tool: string, input: Input, cwd: string | undefined): AskBody {
  const ask: AskBody = { verb: verbOf(tool), target: targetOf(tool, input, cwd) };
  const path = str(input.file_path);
  if ((tool === 'Edit' || tool === 'MultiEdit') && path) {
    const edits =
      tool === 'MultiEdit' && Array.isArray(input.edits)
        ? (input.edits as Input[])
        : [{ old_string: input.old_string, new_string: input.new_string }];
    const lines = edits.flatMap((e) => diffLines(str(e.old_string) ?? '', str(e.new_string) ?? ''));
    Object.assign(ask, countLines(lines));
    ask.lines = lines.slice(0, LIMITS.hunkLines);
    const first = str(edits[0]?.old_string);
    if (first) {
      const start = lineOf(path, first);
      if (start !== undefined) ask.line = start;
    }
  } else if (tool === 'Write' && path) {
    const content = str(input.content) ?? '';
    ask.add = lineCount(content);
    ask.del = 0;
    ask.lines = content
      .split('\n')
      .slice(0, LIMITS.hunkLines)
      .map((l) => `+${l.replace(/\r$/, '').replace(/\t/g, '  ')}`);
    ask.line = 1;
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    const why = str(input.description);
    if (why) ask.why = why;
  } else if (tool === 'WebFetch') {
    const why = str(input.prompt);
    if (why) ask.why = oneLine(why, 300);
  }
  if (isRisky(tool, input)) ask.risky = true;
  return ask;
}

export const claudeTools: ToolKit = { verbOf, targetOf, isFileTool, counterOf, resultOf, askOf };
