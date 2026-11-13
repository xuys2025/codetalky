// The hook settings that point Claude Code at the bridge, and merging them into (or
// removing them from) a settings file such as ~/.claude/settings.json.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { RUN_ENV, RUN_HEADER } from '../runs.ts';

/** Events that can wait for the device; the rest answer at once. */
const HELD = new Set(['PreToolUse', 'PermissionRequest']);
const EVENTS = [
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

interface HookHandler {
  type: string;
  url?: string;
  timeout?: number;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks/claude`;
}

/** Settings with one HTTP hook per event, all pointing at the bridge. */
export function hookSettings(port: number, holdSeconds: number): Settings {
  const url = hookUrl(port);
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'http',
            url,
            // Held events get a little more than the hold, so the bridge always answers first.
            timeout: HELD.has(event) ? holdSeconds + 30 : 5,
            // Sessions started by `codetalky claude` carry their run token, so the
            // device can type into their terminal. Empty for plain sessions.
            headers: { [RUN_HEADER]: '$' + RUN_ENV },
            allowedEnvVars: [RUN_ENV],
          },
        ],
      },
    ];
  }
  return { hooks };
}

const ours = (url: string) => (h: HookHandler) => h.type === 'http' && h.url === url;

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
function strip(settings: Settings, url: string): Settings {
  const hooks = settings.hooks;
  if (!hooks) return settings;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !ours(url)(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

/** Add the bridge's hooks to a settings file (replacing an older copy). Returns the backup path. */
export function mergeHooks(file: string, port: number, holdSeconds: number): string | null {
  const url = hookUrl(port);
  const settings = strip(read(file), url);
  const hooks = (settings.hooks ??= {});
  for (const [event, groups] of Object.entries(hookSettings(port, holdSeconds).hooks ?? {})) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return write(file, settings);
}

/** Take the bridge's hooks out of a settings file. Returns the backup path, or null if there was nothing to do. */
export function removeHooks(file: string, port: number): string | null {
  if (!existsSync(file)) return null;
  const before = read(file);
  const after = strip(structuredClone(before), hookUrl(port));
  if (JSON.stringify(after) === JSON.stringify(before)) return null;
  return write(file, after);
}
