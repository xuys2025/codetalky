// codetalky-bridge: the PC side. Serves devices on ws://<host>:<port>/device, takes
// Claude Code hook events on http://127.0.0.1:<port>/hooks/claude and, on the same
// port, serves the browser simulator. Run one on every computer whose agents the
// device should see; the device connects to each and shows which computer a session
// is on.
//
//   node src/main.ts                    real Claude Code sessions (through hooks)
//   node src/main.ts --fake             plus six scripted demo sessions
//   node src/main.ts hooks              print the hook settings for Claude Code
//   node src/main.ts hooks --merge F    add them to settings file F (backup first)
//   node src/main.ts hooks --remove F   take them out again

import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CODEX_KEYS, ClaudeSource } from './claude/source.ts';
import { claudeHooks, codexHooks, mergeHooks, removeHooks } from './claude/hooks.ts';
import { codexTools } from './codex/tools.ts';
import { fastClock, realClock } from './clock.ts';
import { FakeAgent } from './fake/engine.ts';
import { demoScripts } from './fake/scenario.ts';
import { Hub } from './hub.ts';
import { Glyphs } from './glyphs.ts';
import { join } from 'node:path';

import { bridgeId, CONFIG_DIR, defaultName } from './identity.ts';
import { Pairing } from './pairing.ts';
import { DEFAULT_QUICK } from './link.ts';
import { runManaged } from './run.ts';
import { Runs } from './runs.ts';
import { startServer, type PostReply } from './server.ts';
import { startDiscovery } from './discovery.ts';

const USAGE = `usage: node src/main.ts [--name N] [--fake] [--fake-only IDS] [--speed N] [--hold S]
                        [--host H] [--port P] [--no-sim] [--insecure-lan]
       node src/main.ts hooks [--codex] [--merge FILE | --remove FILE] [--port P] [--hold S]
       node src/main.ts claude [claude's own options]     (or codex, or run -- CMD ...)

  --name N        this computer's name on the device, e.g. 台式机 (default: the computer name)
  --fake          also run six scripted demo sessions
  --fake-only IDS run only these demo sessions, e.g. codetalky,firmware
  --speed N       run the demo sessions N times faster (default 1)
  --hold S        how long a permission request or question waits for the device
                  before Claude Code asks in the terminal instead (default 570 seconds)
  --host H        address to listen on (default 0.0.0.0: devices on the network find this
                  computer by themselves; 127.0.0.1 keeps it to this machine)
  --port P        port (default 8137)
  --no-sim        do not serve the browser simulator
  --insecure-lan  let devices from other machines in without pairing. Testing only:
                  anyone on the network could approve on your behalf.
  --require-pairing  make devices on this machine pair too (to try pairing in the simulator)

  pair            start pairing: devices on the network get a code for 5 minutes;
                  type the code the device shows when asked
  pair CODE       pair the device whose screen shows CODE (pairing must be open)
  devices         list paired devices
  unpair ID       forget a paired device (by id or name)

  hooks           print hook settings that send Claude Code's events to the bridge
  --codex         the same for Codex (merge into ~/.codex/hooks.json, then trust them with /hooks)
  --merge FILE    add them to a Claude Code settings file, e.g. ~/.claude/settings.json
                  (a copy of the old file is kept as FILE.codetalky.bak)
  --remove FILE   take them out of that file again

  claude, codex   start the agent in this terminal as usual, and let the device send it
                  instructions (the bridge must be running; CODETALKY_PORT if not 8137)`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

interface ServeOptions {
  name: string;
  fake: string[] | null;
  speed: number;
  hold: number;
  host: string;
  port: number;
  sim: boolean;
  insecureLan: boolean;
  requirePairing: boolean;
}

/** `codetalky claude ...`, `codetalky codex ...`, `codetalky run -- CMD ...`: everything after goes to the agent. */
function launch(argv: string[]): boolean {
  const [command, ...rest] = argv;
  let agent: string | undefined;
  let args = rest;
  if (command === 'claude' || command === 'codex') {
    agent = command;
  } else if (command === 'run') {
    const start = rest[0] === '--' ? 1 : 0;
    agent = rest[start];
    args = rest.slice(start + 1);
    if (!agent) fail('run: which command?');
  } else {
    return false;
  }
  const port = Number(process.env.CODETALKY_PORT ?? 8137);
  runManaged({ port, agent, args }).then((code) => process.exit(code));
  return true;
}

function main(): void {
  if (launch(process.argv.slice(2))) return;
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        fake: { type: 'boolean', default: false },
        'fake-only': { type: 'string' },
        speed: { type: 'string', default: '1' },
        hold: { type: 'string', default: '570' },
        host: { type: 'string', default: '0.0.0.0' },
        port: { type: 'string', default: '8137' },
        'no-sim': { type: 'boolean', default: false },
        'insecure-lan': { type: 'boolean', default: false },
        'require-pairing': { type: 'boolean', default: false },
        codex: { type: 'boolean', default: false },
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
    const set = args.codex ? codexHooks(port, hold) : claudeHooks(port, hold);
    // PowerShell and cmd hand "~/.claude/settings.json" over as is.
    const home = (file: string) => file.replace(/^~(?=$|[\\/])/, homedir());
    if (args.merge) {
      const file = home(args.merge);
      const backup = mergeHooks(file, set);
      console.log(`added CodeTalky hooks to ${file}${backup ? ` (old file kept as ${backup})` : ''}`);
      if (args.codex) console.log('Codex runs new hooks only after you trust them: start codex and type /hooks once.');
    } else if (args.remove) {
      const file = home(args.remove);
      const backup = removeHooks(file, set);
      console.log(backup ? `removed CodeTalky hooks from ${file} (old file kept as ${backup})` : `no CodeTalky hooks in ${file}`);
    } else {
      console.log(JSON.stringify({ hooks: set.hooks }, null, 2));
    }
    return;
  }
  if (command === 'pair' || command === 'devices' || command === 'unpair') {
    pairingCommand(port, command, rest);
    return;
  }
  if (command !== undefined) fail(`unknown command ${command}`);
  const only = args['fake-only'];
  serve({
    name: (args.name ?? defaultName()).trim() || defaultName(),
    fake: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : args.fake ? [] : null,
    speed,
    hold,
    host: args.host,
    port,
    sim: !args['no-sim'],
    insecureLan: args['insecure-lan'],
    requirePairing: args['require-pairing'],
  });
}

function serve(o: ServeOptions): void {
  const log = (line: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${line}`);
  const hub = new Hub(realClock);
  const runs = new Runs();
  const pairing = new Pairing(join(CONFIG_DIR, 'devices.json'), realClock, log);
  const claude = new ClaudeSource(hub, realClock, { holdSeconds: o.hold, log, runs });
  const codex = new ClaudeSource(hub, realClock, { holdSeconds: o.hold, log, runs, agent: 'codex', tools: codexTools, terminalKeys: CODEX_KEYS });
  const demoClock = o.speed === 1 ? realClock : fastClock(o.speed);
  const scripts = o.fake === null ? [] : demoScripts().filter((s) => o.fake!.length === 0 || o.fake!.includes(s.initial(0).id));
  const agents = scripts.map((script) => new FakeAgent(hub, demoClock, script));
  const simDir = o.sim ? fileURLToPath(new URL('../../simulator/web/', import.meta.url)) : null;
  const glyphs = Glyphs.load();

  startServer(hub, realClock, {
    host: o.host,
    port: o.port,
    simDir,
    post: {
      '/hooks/claude': (body, headers, gone) => claude.handle(body, headers, gone),
      '/hooks/codex': (body, headers, gone) => codex.handle(body, headers, gone),
      '/pairing': (body) => Promise.resolve(pairingControl(pairing, body)),
    },
    runs,
    allowRemoteDevices: o.insecureLan,
    pairing,
    requirePairing: o.requirePairing,
    hostName: o.name,
    hostId: bridgeId(o.port),
    quick: DEFAULT_QUICK,
    fixText: glyphs.fix.bind(glyphs),
    tzMinutes: -new Date().getTimezoneOffset(),
    flushMs: 150,
    log,
  }).then(
    async (server) => {
      const lan = o.host !== '127.0.0.1' && o.host !== 'localhost' && o.host !== '::1';
      const local = o.host === '0.0.0.0' || o.host === '::' ? '127.0.0.1' : o.host;
      console.log(`CodeTalky bridge "${o.name}" on ws://${o.host}:${server.port}/device`);
      console.log(`Claude Code hooks: http://127.0.0.1:${server.port}/hooks/claude (set up with: node src/main.ts hooks)`);
      if (simDir) console.log(`simulator: http://${local}:${server.port}/`);
      if (o.fake !== null) console.log(`fake agent: ${agents.length} sessions${o.speed === 1 ? '' : `, ${o.speed}x speed`}`);
      // Devices on the network find this computer by a UDP broadcast on the same port number.
      const discovery = lan
        ? await startDiscovery({ port: server.port, wsPort: server.port, hostId: bridgeId(o.port), hostName: o.name, log }).catch(
            (err: Error) => {
              console.log(`devices cannot find this computer by themselves (UDP ${server.port}: ${err.message})`);
              return null;
            },
          )
        : null;
      if (o.insecureLan) {
        console.log('warning: --insecure-lan: no pairing yet, anyone who can reach this port can approve on your behalf');
      } else if (lan) {
        console.log('devices on the network find this computer by themselves; the first time, run "codetalky pair" here to pair');
      }
      const stop = () => {
        for (const agent of agents) agent.stop();
        claude.stop();
        codex.stop();
        Promise.all([server.close(), discovery?.close()]).then(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
    (err: NodeJS.ErrnoException) => {
      console.error(err.code === 'EADDRINUSE' ? `port ${o.port} is already in use` : err.message);
      process.exit(1);
    },
  );
}

/** What `codetalky pair/devices/unpair` ask the running bridge to do. */
function pairingControl(pairing: Pairing, body: unknown): PostReply {
  const b = (body ?? {}) as { action?: unknown; code?: unknown; id?: unknown };
  switch (b.action) {
    case 'open':
      return { status: 200, body: pairing.open() };
    case 'pending':
      return { status: 200, body: { pending: pairing.pending() } };
    case 'approve': {
      const done = typeof b.code === 'string' ? pairing.approve(b.code) : null;
      return done ? { status: 200, body: done } : { status: 404, body: { error: 'no device is showing that code' } };
    }
    case 'devices':
      return { status: 200, body: { devices: pairing.list().map(({ id, name, pairedAt }) => ({ id, name, pairedAt })) } };
    case 'unpair':
      return typeof b.id === 'string' && pairing.remove(b.id) ? { status: 200, body: {} } : { status: 404, body: { error: 'no such device' } };
    default:
      return { status: 400, body: { error: 'unknown action' } };
  }
}

/** `codetalky pair`: open a pairing window on the running bridge, then ask for the code the device shows. */
async function pairInteractively(port: number): Promise<void> {
  const call = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/pairing`, { method: 'POST', body: JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json()) as Record<string, unknown> };
  };
  let opened;
  try {
    opened = await call({ action: 'open' });
  } catch {
    console.error(`the bridge is not running on port ${port}`);
    process.exit(1);
  }
  const waiting = Number(opened.data.waiting ?? 0);
  console.log(`Pairing is open for 5 minutes${waiting ? ` (${waiting} device(s) waiting)` : ''}.`);
  console.log('Look at the device: it shows a 6-digit code. Type that code here (never one from anywhere else).');
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  for (let tries = 0; tries < 3; tries++) {
    const code = (await lines.question('code: ')).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      console.log('six digits, please');
      continue;
    }
    const done = await call({ action: 'approve', code });
    if (done.ok) {
      console.log(`paired "${String(done.data.name)}". Now confirm on the device too.`);
      lines.close();
      return;
    }
    console.log('no device is showing that code. Check the screen again (if it never matches, someone may be in between).');
  }
  lines.close();
  process.exitCode = 1;
}

function pairingCommand(port: number, command: string, rest: string[]): void {
  if (command === 'pair' && !rest[0]) {
    void pairInteractively(port);
    return;
  }
  const body =
    command === 'pair' ? { action: 'approve', code: rest[0] } : command === 'devices' ? { action: 'devices' } : { action: 'unpair', id: rest[0] ?? '' };
  fetch(`http://127.0.0.1:${port}/pairing`, { method: 'POST', body: JSON.stringify(body) })
    .then(async (res) => {
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        console.error(String(data.error ?? res.status));
        process.exit(1);
      }
      if (command === 'pair') {
        console.log(`paired "${String(data.name)}". Now confirm on the device too.`);
      } else if (command === 'devices') {
        const devices = data.devices as { id: string; name: string; pairedAt: number }[];
        console.log(
          devices.length
            ? devices.map((d) => `${d.id}  ${d.name}  ${new Date(d.pairedAt * 1000).toLocaleString()}`).join('\n')
            : 'no paired devices',
        );
      } else {
        console.log('unpaired');
      }
    })
    .catch(() => {
      console.error(`the bridge is not running on port ${port}`);
      process.exit(1);
    });
}

main();
