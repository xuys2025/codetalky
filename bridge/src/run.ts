// `codetalky claude ...` / `codetalky codex ...`: run an agent in a pseudo-terminal
// that the user uses exactly as before, and that the bridge can type into when the
// device sends an instruction.
//
// The agent gets a run token in CODETALKY_RUN; its hooks send it back to the bridge
// as a header, which is how the bridge knows the session can take instructions.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { spawn } from '@lydell/node-pty';
import xterm from '@xterm/headless';
import WebSocket from 'ws';

import { RUN_ENV, type FromRun, type ToRun } from './runs.ts';

const RECONNECT_MS = 3000;
/** Claude Code treats a fast burst of keys as a paste; Enter right after it would be part of it. */
const ENTER_DELAY_MS = 150;
/**
 * The agent's permission prompt is on the screen (Claude Code's and Codex's). Typed
 * into that, an instruction's Enter (or a "y" in it) would answer the prompt, so an
 * instruction waits until the prompt is gone.
 */
export const PROMPT_UP = /No, and tell \w+ what to do differently|Yes, proceed|Press enter to confirm/i;
const PROMPT_POLL_MS = 400;

/** Find a command on PATH. npm's .cmd shims on Windows are followed to the program they start. */
export function resolveCommand(name: string, env: NodeJS.ProcessEnv = process.env): { file: string; prefix: string[] } {
  if (process.platform !== 'win32') return { file: name, prefix: [] };
  const exts = isAbsolute(name) || extname(name) ? [''] : ['.exe', '.cmd', '.bat', ''];
  const dirs = isAbsolute(name) ? [''] : [process.cwd(), ...(env.PATH ?? env.Path ?? '').split(delimiter)];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? join(dir, name + ext) : name + ext;
      if (!existsSync(file)) continue;
      const kind = extname(file).toLowerCase();
      if (kind === '.cmd' || kind === '.bat') {
        // npm shim: "%dp0%\node_modules\...\bin\claude.exe"   %*
        //       or "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
        // Run the target directly: cmd.exe would mangle arguments with & or quotes.
        // (The second kind first checks for "%dp0%\node.exe": that is the interpreter, not the target.)
        const shim = readFileSync(file, 'utf8');
        for (const [, target] of shim.matchAll(/"%dp0%\\([^"]+?\.(?:exe|js|mjs|cjs))"/gi)) {
          if (/^node\.exe$/i.test(target!)) continue;
          const real = resolve(dirname(file), target!);
          if (existsSync(real)) return /\.exe$/i.test(real) ? { file: real, prefix: [] } : { file: process.execPath, prefix: [real] };
        }
        return { file: env.ComSpec ?? 'cmd.exe', prefix: ['/d', '/s', '/c', file] };
      }
      return { file, prefix: [] };
    }
  }
  return { file: name, prefix: [] };
}

/** An instruction as keystrokes: one line (the prompt box would take a newline as Enter). */
export function asKeys(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

export interface RunOptions {
  port: number;
  agent: string;
  args: string[];
  /** For tests: where the terminal's output goes (default: this process's stdout). */
  out?: (data: string) => void;
}

/** Run the agent until it exits. Resolves with its exit code. */
export function runManaged(o: RunOptions): Promise<number> {
  const token = randomUUID();
  const { file, prefix } = resolveCommand(o.agent);
  const out = o.out ?? ((data: string) => process.stdout.write(data));
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const term = spawn(file, [...prefix, ...o.args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, [RUN_ENV]: token } as Record<string, string>,
  });

  // A copy of the screen, so keys for a prompt are only pressed while the prompt is up.
  const screen = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });

  // The user's keyboard and screen, passed straight through.
  const stdin = process.stdin;
  const raw = stdin.isTTY === true;
  if (raw) stdin.setRawMode(true);
  stdin.resume();
  const onInput = (data: Buffer) => term.write(data.toString('utf8'));
  stdin.on('data', onInput);
  term.onData((data) => {
    out(data);
    screen.write(data);
  });
  const onResize = () => {
    const c = process.stdout.columns || cols;
    const r = process.stdout.rows || rows;
    term.resize(c, r);
    screen.resize(c, r);
  };
  process.stdout.on('resize', onResize);

  /** The visible screen as text, once everything written so far has been drawn. */
  const screenText = () =>
    new Promise<string>((ready) =>
      screen.write('', () => {
        const b = screen.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < screen.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
        ready(lines.join('\n'));
      }),
    );
  const press = async (keys: string, expect: string): Promise<boolean> => {
    let pattern: RegExp;
    try {
      pattern = new RegExp(expect, 'i');
    } catch {
      return false;
    }
    if (!pattern.test(await screenText())) return false;
    term.write(keys);
    return true;
  };
  // Instructions are typed one after another, each once no prompt is up.
  let typing: Promise<void> = Promise.resolve();
  const typeLine = (keys: string) => {
    typing = typing.then(async () => {
      while (!done && PROMPT_UP.test(await screenText())) await new Promise((r) => setTimeout(r, PROMPT_POLL_MS));
      if (done) return;
      term.write(keys);
      await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
      if (!done) term.write('\r');
    });
  };

  // The bridge: say which run this is, then type whatever it sends.
  let socket: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let done = false;
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${o.port}/run`);
    socket = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', run: token, agent: o.agent, cwd: process.cwd() })));
    ws.on('message', (data) => {
      let msg: ToRun;
      try {
        msg = JSON.parse(data.toString()) as ToRun;
      } catch {
        return;
      }
      if (msg.t === 'press' && typeof msg.keys === 'string' && typeof msg.expect === 'string') {
        void press(msg.keys, msg.expect).then((ok) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'pressed', id: msg.id, ok } satisfies FromRun));
        });
        return;
      }
      if (msg.t !== 'type' || typeof msg.text !== 'string') return;
      const keys = asKeys(msg.text);
      if (keys) typeLine(keys);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (!done) retry = setTimeout(connect, RECONNECT_MS);
    });
  };
  connect();

  return new Promise((resolveExit) => {
    term.onExit(({ exitCode }) => {
      done = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      stdin.off('data', onInput);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.off('resize', onResize);
      screen.dispose();
      resolveExit(exitCode);
    });
  });
}
