// codetalky-bridge: the PC side. Serves devices on ws://<host>:<port>/device, takes
// Claude Code hook events on http://127.0.0.1:<port>/hooks/claude and, on the same
// port, serves the browser simulator.
//
//   node src/main.ts                    real Claude Code sessions (through hooks)
//   node src/main.ts --fake             plus six scripted demo sessions
//   node src/main.ts hooks              print the hook settings for Claude Code
//   node src/main.ts hooks --merge F    add them to settings file F (backup first)
//   node src/main.ts hooks --remove F   take them out again

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ClaudeSource } from './claude/source.ts';
import { hookSettings, mergeHooks, removeHooks } from './claude/hooks.ts';
import { fastClock, realClock } from './clock.ts';
import { FakeAgent } from './fake/engine.ts';
import { demoScripts } from './fake/scenario.ts';
import { Hub } from './hub.ts';
import { DEFAULT_QUICK } from './link.ts';
import { startServer } from './server.ts';

const USAGE = `usage: node src/main.ts [--fake] [--speed N] [--hold S] [--host H] [--port P] [--no-sim]
       node src/main.ts hooks [--merge FILE | --remove FILE] [--port P] [--hold S]

  --fake         also run six scripted demo sessions
  --speed N      run the demo sessions N times faster (default 1)
  --hold S       how long a permission request or question waits for the device
                 before Claude Code asks in the terminal instead (default 570 seconds)
  --host H       address to listen on (default 127.0.0.1)
  --port P       port (default 8137)
  --no-sim       do not serve the browser simulator
  --insecure-lan let devices connect from other machines. There is no pairing yet:
                 anyone on the network could approve on your behalf. Testing only.

  hooks          print hook settings that send Claude Code's events to the bridge
  --merge FILE   add them to a Claude Code settings file, e.g. ~/.claude/settings.json
                 (a copy of the old file is kept as FILE.codetalky.bak)
  --remove FILE  take them out of that file again`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        fake: { type: 'boolean', default: false },
        speed: { type: 'string', default: '1' },
        hold: { type: 'string', default: '570' },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '8137' },
        'no-sim': { type: 'boolean', default: false },
        'insecure-lan': { type: 'boolean', default: false },
        merge: { type: 'string' },
        remove: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    fail((e as Error).message);
  }
  const args = parsed.values;
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const speed = Number(args.speed);
  const hold = Number(args.hold);
  const port = Number(args.port);
  if (!(speed > 0) || !Number.isInteger(port) || port < 0 || port > 65535 || !(hold >= 10)) fail('bad option value');

  const [command, ...rest] = parsed.positionals;
  if (command === 'hooks') {
    if (rest.length > 0) fail(`unexpected ${rest.join(' ')}`);
    if (args.merge) {
      const backup = mergeHooks(args.merge, port, hold);
      console.log(`added CodeTalky hooks to ${args.merge}${backup ? ` (old file kept as ${backup})` : ''}`);
    } else if (args.remove) {
      const backup = removeHooks(args.remove, port);
      console.log(backup ? `removed CodeTalky hooks from ${args.remove} (old file kept as ${backup})` : `no CodeTalky hooks in ${args.remove}`);
    } else {
      console.log(JSON.stringify(hookSettings(port, hold), null, 2));
    }
    return;
  }
  if (command !== undefined) fail(`unknown command ${command}`);
  serve(args, { speed, hold, port });
}

function serve(
  args: { fake: boolean; host: string; 'no-sim': boolean; 'insecure-lan': boolean },
  n: { speed: number; hold: number; port: number },
): void {
  const log = (line: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${line}`);
  const hub = new Hub(realClock);
  const claude = new ClaudeSource(hub, realClock, { holdSeconds: n.hold, log });
  const demoClock = n.speed === 1 ? realClock : fastClock(n.speed);
  const agents = args.fake ? demoScripts().map((script) => new FakeAgent(hub, demoClock, script)) : [];
  const simDir = args['no-sim'] ? null : fileURLToPath(new URL('../../simulator/web/', import.meta.url));

  startServer(hub, realClock, {
    host: args.host,
    port: n.port,
    simDir,
    post: { '/hooks/claude': (body) => claude.handle(body) },
    allowRemoteDevices: args['insecure-lan'],
    quick: DEFAULT_QUICK,
    tzMinutes: -new Date().getTimezoneOffset(),
    flushMs: 150,
    log,
  }).then(
    (server) => {
      console.log(`CodeTalky bridge on ws://${args.host}:${server.port}/device`);
      console.log(`Claude Code hooks: http://127.0.0.1:${server.port}/hooks/claude (set up with: node src/main.ts hooks)`);
      if (simDir) console.log(`simulator: http://${args.host}:${server.port}/`);
      if (args.fake) console.log(`fake agent: ${agents.length} sessions${n.speed === 1 ? '' : `, ${n.speed}x speed`}`);
      if (args['insecure-lan']) {
        console.log('warning: --insecure-lan: no pairing yet, anyone who can reach this port can approve on your behalf');
      } else if (args.host !== '127.0.0.1' && args.host !== 'localhost') {
        console.log('note: devices on other machines are refused until pairing exists (or pass --insecure-lan)');
      }
      const stop = () => {
        for (const agent of agents) agent.stop();
        claude.stop();
        server.close().then(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
    (err: NodeJS.ErrnoException) => {
      console.error(err.code === 'EADDRINUSE' ? `port ${n.port} is already in use` : err.message);
      process.exit(1);
    },
  );
}

main();
