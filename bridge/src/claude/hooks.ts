// The hook settings that point an agent at the bridge, and merging them into (or
// removing them from) its settings file: ~/.claude/settings.json for Claude Code,
// ~/.codex/hooks.json for Codex.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RUN_ENV, RUN_HEADER } from '../runs.ts';

/** Events that can wait for the device; the rest answer at once. */
const HELD = new Set(['PreToolUse', 'PermissionRequest']);
const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd'];

/** The command hook that forwards an event to the bridge: every Codex event, and Claude Code's SessionStart. */
export const HOOK_SCRIPT = fileURLToPath(new URL('../../hooks/hook.mjs', import.meta.url));

const hookCommand = (script: string, port: number, agent: 'claude' | 'codex') => `node "${script.replace(/\\/g, '/')}" ${port} ${agent}`;

/** Ours whatever port it was set up for (codex-hook.mjs is the script's old name). */
function isOurCommand(h: HookHandler, agent: 'claude' | 'codex'): boolean {
  if (h.type !== 'command' || typeof h.command !== 'string') return false;
  const tail = agent === 'claude' ? ' claude' : '( codex)?';
  return new RegExp(`[\\\\/]hooks[\\\\/](codex-)?hook\\.mjs" \\d+${tail}$`).test(h.command.trim());
}

interface HookHandler {
  type: string;
  url?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/** One agent's hooks for the bridge, and how to recognise them in a settings file. */
export interface HookSet {
  hooks: Record<string, HookGroup[]>;
  isOurs: (handler: HookHandler) => boolean;
}

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks/claude`;
}

/** Held events get a little more than the hold, so the bridge always answers first. */
const timeoutFor = (event: string, holdSeconds: number) => (HELD.has(event) ? holdSeconds + 30 : 5);

/**
 * Claude Code: one HTTP hook per event, all pointing at the bridge. SessionStart takes
 * only command hooks, so that one goes through the forwarding script; without it a new
 * session would stay invisible until its first prompt.
 */
export function claudeHooks(port: number, holdSeconds: number, script = HOOK_SCRIPT): HookSet {
  const url = hookUrl(port);
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of CLAUDE_EVENTS) {
    if (event === 'SessionStart') {
      // A command hook inherits the session's environment, run token included.
      hooks[event] = [{ hooks: [{ type: 'command', command: hookCommand(script, port, 'claude'), timeout: 5 }] }];
      continue;
    }
    hooks[event] = [
      {
        hooks: [
          {
            type: 'http',
            url,
            timeout: timeoutFor(event, holdSeconds),
            // Sessions started by `codetalky claude` carry their run token, so the
            // device can type into their terminal. Empty for plain sessions.
            headers: { [RUN_HEADER]: '$' + RUN_ENV },
            allowedEnvVars: [RUN_ENV],
          },
        ],
      },
    ];
  }
  // Any port, so setting up again on another port replaces the old hooks.
  const ours = /^http:\/\/127\.0\.0\.1:\d+\/hooks\/claude$/;
  return { hooks, isOurs: (h) => (h.type === 'http' && typeof h.url === 'string' && ours.test(h.url)) || isOurCommand(h, 'claude') };
}

/** Codex: command hooks only, so the forwarding script carries each event to the bridge. */
export function codexHooks(port: number, holdSeconds: number, script = HOOK_SCRIPT): HookSet {
  const command = hookCommand(script, port, 'codex');
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of CODEX_EVENTS) {
    const timeout = event === 'SessionEnd' ? 3 : timeoutFor(event, holdSeconds);
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout }] }];
  }
  return { hooks, isOurs: (h) => isOurCommand(h, 'codex') };
}

/** The Claude Code settings, as `codetalky hooks` prints them. */
export function hookSettings(port: number, holdSeconds: number): Settings {
  return { hooks: claudeHooks(port, holdSeconds).hooks };
}

function read(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Settings;
}

function write(file: string, settings: Settings): string | null {
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.codetalky.bak`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return backup;
}

/** Remove the bridge's hooks from settings, leaving everything else alone. */
function strip(settings: Settings, set: HookSet): Settings {
  const hooks = settings.hooks;
  if (!hooks) return settings;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !set.isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

/** Add the bridge's hooks to a settings file (replacing an older copy). Returns the backup path. */
export function mergeHooks(file: string, set: HookSet): string | null {
  const settings = strip(read(file), set);
  const hooks = (settings.hooks ??= {});
  for (const [event, groups] of Object.entries(set.hooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return write(file, settings);
}

/** Take the bridge's hooks out of a settings file. Returns the backup path, or null if there was nothing to do. */
export function removeHooks(file: string, set: HookSet): string | null {
  if (!existsSync(file)) return null;
  const before = read(file);
  const after = strip(structuredClone(before), set);
  if (JSON.stringify(after) === JSON.stringify(before)) return null;
  return write(file, after);
}
