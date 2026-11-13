// HTTP + WebSocket front door. Devices connect to /device; with simDir set, the
// same port also serves the browser simulator so one command runs the whole demo.

import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';

import type { Clock } from './clock.ts';
import type { Hub } from './hub.ts';
import { DeviceLink, type LinkOptions } from './link.ts';

export interface ServerOptions extends LinkOptions {
  host: string;
  port: number;
  /** Directory of the browser simulator to serve at /, or null. */
  simDir: string | null;
  log: (line: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function serveFile(root: string, req: IncomingMessage, res: ServerResponse): void {
  const fail = (status: number) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(status));
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405);
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return fail(400);
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, `.${path}`);
  if (file !== root && !file.startsWith(root + sep)) return fail(403);
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return fail(404);
    size = stat.size;
  } catch {
    return fail(404);
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

/**
 * A page on some other site must not be able to open a socket to the bridge and
 * click "approve" on the user's behalf. Browsers always send Origin; devices do not.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(hub: Hub, clock: Clock, options: ServerOptions): Promise<RunningServer> {
  const simRoot = options.simDir === null ? null : resolve(options.simDir);
  const http: Server = createServer((req, res) => {
    if (simRoot === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('CodeTalky bridge');
      return;
    }
    serveFile(simRoot, req, res);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/device' || !originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const peer = req.socket.remoteAddress ?? '?';
      const link = new DeviceLink(hub, clock, (text) => ws.send(text), options);
      options.log(`device connected from ${peer}`);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // audio frames: phase 3
        const known = link.device !== null;
        if (!link.receive(data.toString())) {
          ws.close(4000, 'protocol');
        } else if (!known && link.device !== null) {
          options.log(`device ${peer} is "${link.device}"`);
        }
      });
      ws.on('close', () => {
        link.close();
        options.log(`device ${peer} disconnected`);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  return new Promise((resolveStart, rejectStart) => {
    http.once('error', rejectStart);
    http.listen(options.port, options.host, () => {
      http.off('error', rejectStart);
      resolveStart({
        port: (http.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets.clients) ws.terminate();
            sockets.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
