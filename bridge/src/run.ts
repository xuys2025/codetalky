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
import WebSocket from 'ws';

import { RUN_ENV, type ToRun } from './runs.ts';

const RECONNECT_MS = 3000;
/** Claude Code treats a fast burst of keys as a paste; Enter right after it would be part of it. */
const ENTER_DELAY_MS = 150;

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

  // The user's keyboard and screen, passed straight through.
  const stdin = process.stdin;
  const raw = stdin.isTTY === true;
  if (raw) stdin.setRawMode(true);
  stdin.resume();
  const onInput = (data: Buffer) => term.write(data.toString('utf8'));
  stdin.on('data', onInput);
  term.onData(out);
  const onResize = () => term.resize(process.stdout.columns || cols, process.stdout.rows || rows);
  process.stdout.on('resize', onResize);

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
      if (msg.t !== 'type' || typeof msg.text !== 'string') return;
      const keys = asKeys(msg.text);
      if (!keys) return;
      term.write(keys);
      setTimeout(() => term.write('\r'), ENTER_DELAY_MS);
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
      resolveExit(exitCode);
    });
  });
}
