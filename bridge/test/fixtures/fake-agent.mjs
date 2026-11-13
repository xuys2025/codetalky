// Stands in for Claude Code in tests: reports to the bridge's hook URL the way Claude
// Code's HTTP hooks do (with the run token from its environment as a header), then
// answers every line typed into its terminal.
import { createInterface } from 'node:readline';

const port = process.env.FAKE_PORT;
const token = process.env.CODETALKY_RUN ?? '';
const session = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function hook(event, extra = {}) {
  await fetch(`http://127.0.0.1:${port}/hooks/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-codetalky-run': token },
    body: JSON.stringify({ session_id: session, cwd: process.cwd(), hook_event_name: event, ...extra }),
  });
}

await hook('SessionStart', { source: 'startup' });
process.stdout.write('ready> ');
const lines = createInterface({ input: process.stdin });
let asking = false;
lines.on('line', async (line) => {
  const text = line.trim();
  if (text === 'exit') process.exit(0);
  if (!text) return;
  if (text === 'ask') {
    // A permission prompt like Codex's, answered by a key; it goes from the screen once answered.
    asking = true;
    process.stdout.write('Would you like to run the following command?\n  1. Yes, proceed (y)\nready> ');
    return;
  }
  if (asking) {
    asking = false;
    process.stdout.write('\x1b[2J\x1b[H');
  }
  await hook('UserPromptSubmit', { prompt: text });
  process.stdout.write(`got: ${text}\nready> `);
});
