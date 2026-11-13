// How Codex's tool calls look on the device. Codex runs shell commands (matched as
// "Bash", or "exec_command" for unified exec), changes files with apply_patch, and
// calls MCP tools; its hooks cover those.

import { join } from 'node:path';

import { LIMITS, type FileChange, type Hunk } from '../protocol.ts';
import { hunksFromPatch, patchStat } from '../claude/text.ts';
import { isRisky, lineOf, showPath, type AskBody, type Counter, type Input, type ToolKit, type ToolResult } from '../claude/tools.ts';
import { parsePatch, type PatchFile } from './patch.ts';
import type { ChangedFile } from './rollout.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const isShell = (tool: string) => tool === 'Bash' || tool === 'exec_command' || tool === 'shell' || tool === 'local_shell';
const isPatch = (tool: string) => tool === 'apply_patch' || tool === 'Edit' || tool === 'Write';

/** The command string, whether Codex sent a string or an argv array. */
function commandOf(input: Input): string {
  const c = input.command ?? input.cmd;
  if (Array.isArray(c)) {
    // ["bash", "-lc", "npm test"] -> "npm test"
    const parts = c.map(String);
    const shellArg = parts.findIndex((p) => p === '-lc' || p === '-c' || p === '/c' || p === '-Command');
    return (shellArg >= 0 ? parts.slice(shellArg + 1) : parts).join(' ');
  }
  return str(c) ?? '';
}

const patchOf = (input: Input): PatchFile[] => parsePatch(str(input.command) ?? str(input.input) ?? str(input.patch) ?? '');

/**
 * Exactly `apply_patch <<'TAG'` + a patch + `TAG`, nothing before or after. Anything
 * else (a cd in front, a second command behind, an unquoted tag the shell would
 * expand) is a shell command and shown as one, so the device never hides what would run.
 */
const PATCH_HEREDOC = /^apply_patch <<'([A-Z_]+)'\n(\*\*\* Begin Patch\n[\s\S]*\n\*\*\* End Patch)\n\1\n?$/;

/**
 * Codex runs apply_patch through the shell too, and its PreToolUse then says Bash.
 * Show such a call as the patch it is, but only if that is all it is.
 */
function normalize(tool: string, input: Input): { tool: string; input: Input } {
  if (!isShell(tool) || typeof input.command !== 'string') return { tool, input };
  const m = PATCH_HEREDOC.exec(input.command);
  if (!m || m[2]!.includes(`\n${m[1]}\n`)) return { tool, input };
  return { tool: 'apply_patch', input: { command: m[2] } };
}

/** A completed apply_patch from Codex's session file, as the device logs it. */
export function changeResult(files: ChangedFile[], cwd: string | undefined): { target: string; result: ToolResult } {
  const result: ToolResult = { hunks: [], files: [], created: files.length > 0 && files.every((f) => f.st === 'A'), add: 0, del: 0 };
  for (const f of files) {
    const path = showPath(f.moveTo ?? f.path, cwd);
    const stat = patchStat(f.hunks);
    result.add! += stat.add;
    result.del! += stat.del;
    result.files.push({ st: f.st, path, add: stat.add, del: stat.del });
    result.hunks.push(...hunksFromPatch(path, f.hunks));
  }
  const first = result.files[0]?.path ?? 'apply_patch';
  return { target: files.length > 1 ? `${first} 等 ${files.length} 个文件` : first, result };
}

function verbOf(tool: string): string {
  if (isShell(tool)) return 'Bash';
  if (isPatch(tool)) return 'Edit';
  if (tool.startsWith('mcp__')) return 'MCP';
  if (tool === 'update_plan') return 'Todo';
  return tool.slice(0, 5);
}

/** "src/cart.ts", or "src/cart.ts 等 3 个文件" when a patch touches several. */
function targetOf(tool: string, input: Input, cwd: string | undefined): string {
  if (isShell(tool)) return commandOf(input).replace(/\s+/g, ' ').trim();
  if (isPatch(tool)) {
    const files = patchOf(input);
    if (files.length === 0) return 'apply_patch';
    const first = showPath(files[0]!.moveTo ?? files[0]!.path, cwd);
    return files.length > 1 ? `${first} 等 ${files.length} 个文件` : first;
  }
  if (tool.startsWith('mcp__')) return tool.split('__').slice(2).join('__');
  const first = Object.values(input).find((v): v is string => typeof v === 'string');
  return (first ?? '').replace(/\s+/g, ' ').slice(0, 200);
}

function isFileTool(tool: string): boolean {
  return isPatch(tool);
}

function counterOf(tool: string, created: boolean): Counter | null {
  if (isShell(tool)) return 'cmd';
  if (isPatch(tool)) return created ? 'new' : 'edit';
  return null;
}

/** Device hunks for a patch's files; the line is found in the file where possible. */
function hunksOf(files: PatchFile[], cwd: string | undefined, after: boolean): Hunk[] {
  const hunks: Hunk[] = [];
  for (const f of files) {
    const path = showPath(f.moveTo ?? f.path, cwd);
    const onDisk = cwd ? join(cwd, f.moveTo ?? f.path) : (f.moveTo ?? f.path);
    for (const lines of f.hunks) {
      // Find the hunk in the file: after the change by its first kept or added line,
      // before it by its first kept or removed line.
      const probe = lines.find((l) => l[0] === ' ' || l[0] === (after ? '+' : '-'));
      const at = f.st === 'A' ? 1 : probe && probe.slice(1).trim() ? (lineOf(onDisk, probe.slice(1)) ?? 0) : 0;
      hunks.push({
        file: path,
        line: at,
        add: lines.filter((l) => l[0] === '+').length,
        del: lines.filter((l) => l[0] === '-').length,
        lines: lines.slice(0, LIMITS.hunkLines),
      });
    }
  }
  return hunks;
}

function resultOf(tool: string, input: Input, response: unknown, cwd: string | undefined): ToolResult {
  const out: ToolResult = { hunks: [], files: [], created: false };
  if (isPatch(tool)) {
    const files = patchOf(input);
    out.add = files.reduce((n, f) => n + f.add, 0);
    out.del = files.reduce((n, f) => n + f.del, 0);
    out.created = files.length > 0 && files.every((f) => f.st === 'A');
    out.files = files.map(
      (f): FileChange => ({ st: f.st, path: showPath(f.moveTo ?? f.path, cwd), add: f.add, del: f.del }),
    );
    out.hunks = hunksOf(files, cwd, true);
    return out;
  }
  if (isShell(tool)) {
    const r = (response && typeof response === 'object' ? response : {}) as Input;
    const code = num(r.exit_code) ?? num(r.exitCode) ?? num((r.metadata as Input | undefined)?.exit_code);
    if (code !== undefined && code !== 0) {
      out.res = `退出 ${code}`;
      out.bad = true;
    } else {
      out.res = '完成';
    }
  }
  return out;
}

function askOf(tool: string, input: Input, cwd: string | undefined): AskBody {
  const ask: AskBody = { verb: verbOf(tool), target: targetOf(tool, input, cwd) };
  const why = str(input.description) ?? str(input.justification);
  if (why) ask.why = why;
  if (isPatch(tool)) {
    const files = patchOf(input);
    const hunks = hunksOf(files, cwd, false);
    ask.add = files.reduce((n, f) => n + f.add, 0);
    ask.del = files.reduce((n, f) => n + f.del, 0);
    ask.lines = (hunks[0]?.lines ?? []).slice(0, LIMITS.hunkLines);
    if (hunks[0]?.line) ask.line = hunks[0].line;
  } else if (isShell(tool) && isRisky('Bash', { command: commandOf(input) })) {
    ask.risky = true;
  }
  return ask;
}

export const codexTools: ToolKit = { verbOf, targetOf, isFileTool, counterOf, resultOf, askOf, normalize };
