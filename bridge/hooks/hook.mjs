#!/usr/bin/env node
// Command hooks get the event JSON on stdin and answer with JSON on stdout. This one
// hands the event to the CodeTalky bridge and prints its answer. If the bridge isn't
// running it prints {} (no decision), so the agent carries on exactly as without it.
//
// Codex sends every event through it (its hooks can only be commands). Claude Code uses
// HTTP hooks, except for SessionStart, which only takes commands.
//
//   node hook.mjs <port> [codex|claude]
//
// Plain JavaScript on purpose: it starts for every tool call, so no type stripping.
import { request } from 'node:http';

// Both arguments come from the hook settings `codetalky hooks` wrote.
const port = Number(process.argv[2] || process.env.CODETALKY_PORT || 8137);
const agent = process.argv[3] === 'claude' ? 'claude' : 'codex';
const run = process.env.CODETALKY_RUN || '';

function send(body) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/hooks/${agent}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-codetalky-run': run },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 ? text.trim() : ''));
      },
    );
    // A held permission request can take minutes; the agent's own hook timeout decides.
    req.setTimeout(0);
    req.on('error', () => resolve(''));
    req.end(body);
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const answer = await send(input || '{}');
  process.stdout.write(`${answer.startsWith('{') ? answer : '{}'}\n`);
});
