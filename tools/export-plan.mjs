// Save the plan document exported from Claude Docs as a local Markdown file.
//
//   node tools/export-plan.mjs <session-transcript.jsonl> <out.md> [image-dir-name]
//
// The Docs export tool returns the file as base64 inside its tool result. Rather than
// retyping it, this reads the most recent export result out of the session transcript.
// Embedded diagrams are not part of a Markdown export; their placeholders are replaced
// with links to PNGs expected in <image-dir-name>/ next to the output file.
import { readFileSync, writeFileSync } from 'node:fs';

const [transcript, outPath, imageDir = '计划书-图'] = process.argv.slice(2);
if (!transcript || !outPath) {
  console.error('usage: node export-plan.mjs <transcript.jsonl> <out.md> [image-dir-name]');
  process.exit(2);
}

const lines = readFileSync(transcript, 'utf8').split('\n');
let b64 = null;
for (let i = lines.length - 1; i >= 0 && !b64; i--) {
  if (!lines[i].includes('bytes_b64')) continue;
  const matches = [...lines[i].matchAll(/bytes_b64\\*"\s*:\s*\\*"([A-Za-z0-9+/=]{200,})/g)];
  if (matches.length) b64 = matches[matches.length - 1][1];
}
if (!b64) {
  console.error('no export result found in the transcript');
  process.exit(1);
}

let text = Buffer.from(b64, 'base64').toString('utf8');
const images = [
  ['系统架构', 'architecture.png'],
  ['软件分层', 'layers.png'],
  ['路线图', 'roadmap.png'],
];
let replaced = 0;
text = text.replace(/&#91;embedded content: (.+?)\\\]/g, (whole, caption) => {
  const hit = images.find(([key]) => caption.startsWith(key));
  if (!hit) return whole;
  replaced++;
  return `![${caption}](${imageDir}/${hit[1]})`;
});

writeFileSync(outPath, text, 'utf8');
console.log(`${outPath}: ${Buffer.byteLength(text)} bytes, ${text.split('\n').length} lines, ${replaced} diagram links`);
console.log(`first line: ${text.split('\n')[0]}`);
