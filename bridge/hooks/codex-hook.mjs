#!/usr/bin/env node
// Codex runs hooks as commands: event JSON on stdin, answer JSON on stdout. This one
// hands the event to the CodeTalky bridge and prints its answer. If the bridge isn't
// running it prints {} (no decision), so Codex carries on exactly as without it.
//
// Plain JavaScript on purpose: it starts for every tool call, so no type stripping.
import { request } from 'node:http';

// The port comes as the first argument, from the hook settings `codetalky hooks --codex` wrote.
const port = Number(process.argv[2] || process.env.CODETALKY_PORT || 8137);
const run = process.env.CODETALKY_RUN || '';

function send(body) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/hooks/codex',
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
    // A held permission request can take minutes; Codex's own hook timeout decides.
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
