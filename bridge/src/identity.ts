// Who this bridge is, for the device: a name the user recognises and an id that
// stays the same across restarts and IP changes.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.codetalky');

/** The machine's id, created once in ~/.codetalky/bridge-id. */
export function machineId(dir = CONFIG_DIR): string {
  const file = join(dir, 'bridge-id');
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } catch {
    // first run
  }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${id}\n`);
  } catch {
    // read-only home: the id just won't survive a restart
  }
  return id;
}

/** Two bridges on one machine (a demo) are told apart by port. */
export function bridgeId(port: number, dir = CONFIG_DIR): string {
  return `${machineId(dir)}:${port}`;
}

/** The default name: the computer's network name, which the user can override with --name. */
export function defaultName(): string {
  return hostname();
}
