// HTTP + WebSocket front door. Devices connect to /device; with simDir set, the
// same port also serves the browser simulator so one command runs the whole demo.

import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import type { Clock } from './clock.ts';
import type { Hub } from './hub.ts';
import { DeviceLink, type LinkOptions } from './link.ts';
import type { Pairing } from './pairing.ts';
import { parseFromRun, type Runs, type ToRun } from './runs.ts';

/** Handles a POST from an agent hook; headers carry the managed-run token. */
/** gone: fires if the caller hangs up before the reply. */
export type PostHandler = (body: unknown, headers: IncomingHttpHeaders, gone: AbortSignal) => Promise<PostReply>;

/** Answer to a POST from an agent hook. */
export interface PostReply {
  status: number;
  body?: unknown;
}

export interface ServerOptions extends LinkOptions {
  host: string;
  port: number;
  /** Directory of the browser simulator to serve at /, or null. */
  simDir: string | null;
  /** JSON POST endpoints for agent hooks, by path. Only reachable from this machine. */
  post?: Record<string, PostHandler>;
  /** Managed runs, whose launchers connect to /run. */
  runs?: Runs;
  /** Devices from other machines must pair (or show their token) first. Without it they are refused. */
  pairing?: Pairing;
  /** Make devices on this machine pair too (to try the pairing screens in the simulator). */
  requirePairing?: boolean;
  /** Let devices from other machines in without pairing. Testing only. */
  allowRemoteDevices?: boolean;
  log: (line: string) => void;
}

/** Hook payloads carry whole tool inputs (a Write can hold a large file). */
const MAX_POST = 8 * 1024 * 1024;

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
    const url = new URL(origin);
    // The simulator page served by one bridge may connect to the other bridges on
    // this machine (several "computers" in a demo); pages from anywhere else may not.
    return url.host === req.headers.host || url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Agent hooks run on this machine and never send Origin. Refusing anything else keeps
 * web pages (which always send Origin) and other machines on the network out.
 */
function handlePost(
  handler: PostHandler,
  req: IncomingMessage,
  res: ServerResponse,
  log: (line: string) => void,
): void {
  if (!isLoopback(req) || req.headers.origin !== undefined) {
    sendJson(res, 403, { error: 'forbidden' });
    req.resume();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_POST) tooBig = true;
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooBig) return sendJson(res, 413, { error: 'too large' });
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    // The agent hangs up on a held request when it gets its answer elsewhere, e.g.
    // someone answered the same prompt in the terminal.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    handler(body, req.headers, gone.signal).then(
      (reply) => {
        if (!res.destroyed) sendJson(res, reply.status, reply.body);
      },
      (err: unknown) => {
        log(`hook handler failed: ${(err as Error).message}`);
        if (!res.destroyed) sendJson(res, 500, { error: 'internal' });
      },
    );
  });
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** The path of a request, or null if it can't be read (a malformed request must not take the bridge down). */
function pathOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? '/', 'http://x').pathname;
  } catch {
    return null;
  }
}

/** How often device connections are checked (a dead one goes within two of these). */
export const HEARTBEAT_MS = 15_000;

/** At most this many devices from the network may be connected and not yet proven or paired. */
export const MAX_UNPROVEN = 8;

export function startServer(hub: Hub, clock: Clock, options: ServerOptions): Promise<RunningServer> {
  const simRoot = options.simDir === null ? null : resolve(options.simDir);
  const links = new Set<DeviceLink>();
  const connected = new Map<string, DeviceLink>();
  // Heartbeat: a device that restarts or loses Wi-Fi leaves its TCP connection open on
  // this side for minutes. Ping every HEARTBEAT_MS; no pong by the next round, it's gone.
  const alive = new Map<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const [ws, ok] of alive) {
      if (!ok) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const http: Server = createServer((req, res) => {
    const path = pathOf(req);
    if (path === null) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.end('bad request');
      return;
    }
    const post = options.post?.[path];
    if (post && req.method === 'POST') {
      handlePost(post, req, res, options.log);
      return;
    }
    // Firmware on offer: devices on the network download it (they check its hash).
    if (path.startsWith('/firmware/') && req.method === 'GET') {
      const image = options.firmware?.serve(path) ?? null;
      if (image === null) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('no such firmware');
        return;
      }
      options.log(`device at ${req.socket.remoteAddress ?? '?'} is downloading the firmware`);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': image.length, 'cache-control': 'no-store' });
      res.end(image);
      return;
    }
    if (simRoot === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('CodeTalky bridge');
      return;
    }
    serveFile(simRoot, req, res);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    const path = pathOf(req);
    if (path === null) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Launchers of managed runs: this machine only, never a web page.
    if (path === '/run' && options.runs) {
      const runs = options.runs;
      if (!isLoopback(req) || req.headers.origin !== undefined) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        let remove: (() => void) | null = null;
        let token = '';
        ws.on('message', (data, isBinary) => {
          const msg = isBinary ? null : parseFromRun(data.toString());
          if (!msg) return;
          if (msg.t === 'pressed') {
            if (remove) runs.pressed(token, msg.id, msg.ok);
            return;
          }
          if (remove) return;
          token = msg.run;
          remove = runs.add(msg.run, msg.agent, msg.cwd, (out: ToRun) => ws.send(JSON.stringify(out)));
          options.log(`managed ${msg.agent || 'agent'} started in ${msg.cwd}`);
        });
        ws.on('close', () => remove?.());
        ws.on('error', () => ws.terminate());
      });
      return;
    }
    const remote = !isLoopback(req);
    const mustPair = (remote && !options.allowRemoteDevices) || options.requirePairing === true;
    const remoteRefused = mustPair && !options.pairing;
    if (path !== '/device' || !originAllowed(req) || remoteRefused) {
      if (remoteRefused) options.log(`refused a device from ${req.socket.remoteAddress ?? '?'}: pairing is not set up`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Connections that haven't proven anything yet cost a key exchange each: keep them few.
    if (mustPair && [...links].filter((l) => l.pending).length >= MAX_UNPROVEN) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const peer = req.socket.remoteAddress ?? '?';
      const link = new DeviceLink(hub, clock, (text) => ws.send(text), {
        ...options,
        pairing: mustPair ? options.pairing : undefined,
        connected,
        drop: (why) => (why === 'superseded' ? ws.terminate() : ws.close(4001, 'handshake timeout')),
      });
      links.add(link);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      options.log(`device connected from ${peer}`);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // audio frames: phase 3
        const known = link.device !== null;
        if (!link.receive(data.toString())) {
          ws.close(4000, 'protocol');
        } else if (!known && link.device !== null) {
          options.log(`device ${peer} is "${link.device}"${link.firmware ? `, firmware ${link.firmware}` : ''}`);
        }
      });
      ws.on('close', () => {
        alive.delete(ws);
        link.close();
        links.delete(link);
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
            clearInterval(heartbeat);
            for (const ws of sockets.clients) ws.terminate();
            sockets.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
