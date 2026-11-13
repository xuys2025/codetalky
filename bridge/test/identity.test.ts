import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { bridgeId, machineId } from '../src/identity.ts';

test('the machine id is made once and then stays the same', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ct-')), 'config');
  const first = machineId(dir);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(machineId(dir), first);
});

test('two bridges on one machine get different ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  assert.notEqual(bridgeId(8137, dir), bridgeId(8138, dir));
  assert.equal(bridgeId(8137, dir), `${machineId(dir)}:8137`);
});
