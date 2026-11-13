// codetalky-bridge: the PC side. Serves devices on ws://<host>:<port>/device and,
// on the same port, the browser simulator.
//
//   node src/main.ts --fake            demo sessions from a scripted fake agent
//   node src/main.ts --fake --speed 4  the same, four times faster

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { fastClock, realClock } from './clock.ts';
import { FakeAgent } from './fake/engine.ts';
import { demoScripts } from './fake/scenario.ts';
import { Hub } from './hub.ts';
import { DEFAULT_QUICK } from './link.ts';
import { startServer } from './server.ts';

const USAGE = `usage: node src/main.ts [--fake] [--speed N] [--host H] [--port P] [--no-sim]

  --fake      run six scripted demo sessions
  --speed N   run the fake agent N times faster (default 1)
  --host H    address to listen on (default 127.0.0.1)
  --port P    port (default 8137)
  --no-sim    do not serve the browser simulator`;

function main(): void {
  let args;
  try {
    args = parseArgs({
      options: {
        fake: { type: 'boolean', default: false },
        speed: { type: 'string', default: '1' },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '8137' },
        'no-sim': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const speed = Number(args.speed);
  const port = Number(args.port);
  if (!(speed > 0) || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(USAGE);
    process.exit(2);
  }

  const clock = speed === 1 ? realClock : fastClock(speed);
  const hub = new Hub(clock);
  const agents = args.fake ? demoScripts().map((script) => new FakeAgent(hub, clock, script)) : [];
  const simDir = args['no-sim'] ? null : fileURLToPath(new URL('../../simulator/web/', import.meta.url));

  startServer(hub, clock, {
    host: args.host,
    port,
    simDir,
    quick: DEFAULT_QUICK,
    tzMinutes: -new Date().getTimezoneOffset(),
    flushMs: 150,
    log: (line) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${line}`),
  }).then(
    (server) => {
      const base = `http://${args.host}:${server.port}`;
      console.log(`CodeTalky bridge on ws://${args.host}:${server.port}/device`);
      if (simDir) console.log(`simulator: ${base}/`);
      if (args.fake) console.log(`fake agent: ${agents.length} sessions${speed === 1 ? '' : `, ${speed}x speed`}`);
      if (args.host !== '127.0.0.1' && args.host !== 'localhost') {
        console.log('warning: no pairing yet — anyone who can reach this port can approve on your behalf');
      }
      const stop = () => {
        for (const agent of agents) agent.stop();
        server.close().then(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
    (err: NodeJS.ErrnoException) => {
      console.error(err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message);
      process.exit(1);
    },
  );
}

main();
