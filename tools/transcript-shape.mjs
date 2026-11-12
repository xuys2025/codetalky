// Summarise the *structure* of a Claude Code transcript (no message content is printed).
// Usage: node transcript-shape.mjs <file.jsonl>
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const file = process.argv[2];
const types = {};
const models = {};
const blockTypes = {};
const toolNames = {};
const resultKeys = {}; // tool name -> set of toolUseResult keys
const toolById = new Map();
const topKeys = new Set();
const usageKeys = new Set();
let lines = 0;
let editPatchSample = null;

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  lines++;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  types[e.type] = (types[e.type] || 0) + 1;
  Object.keys(e).forEach((k) => topKeys.add(k));
  const msg = e.message;
  if (e.type === 'assistant' && msg) {
    if (msg.model) models[msg.model] = (models[msg.model] || 0) + 1;
    if (msg.usage) Object.keys(msg.usage).forEach((k) => usageKeys.add(k));
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      blockTypes[b.type] = (blockTypes[b.type] || 0) + 1;
      if (b.type === 'tool_use') {
        toolNames[b.name] = (toolNames[b.name] || 0) + 1;
        toolById.set(b.id, b.name);
      }
    }
  }
  if (e.type === 'user' && msg && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b.type !== 'tool_result') continue;
      const name = toolById.get(b.tool_use_id) || '?';
      const r = e.toolUseResult;
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        (resultKeys[name] ||= new Set());
        Object.keys(r).forEach((k) => resultKeys[name].add(k));
        if (!editPatchSample && Array.isArray(r.structuredPatch) && r.structuredPatch[0]) {
          const h = r.structuredPatch[0];
          editPatchSample = { hunkKeys: Object.keys(h), lineCount: Array.isArray(h.lines) ? h.lines.length : null };
        }
      }
    }
  }
}

console.log(JSON.stringify({
  lines,
  types,
  topLevelKeys: [...topKeys].sort(),
  models,
  assistantBlockTypes: blockTypes,
  usageKeys: [...usageKeys].sort(),
  toolNames,
  toolUseResultKeys: Object.fromEntries(Object.entries(resultKeys).map(([k, v]) => [k, [...v].sort()])),
  editPatchSample,
}, null, 1));
