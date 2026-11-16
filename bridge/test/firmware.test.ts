import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FirmwareStore, readImage } from '../src/firmware.ts';

/** The start of an ESP-IDF app image: header, first segment header, esp_app_desc_t. */
function fakeImage(project: string, elfSha: string, size = 4096): Buffer {
  const data = Buffer.alloc(size, 0x5a);
  data[0] = 0xe9;
  data.fill(0, 32, 32 + 256);
  data.writeUInt32LE(0xabcd5432, 32);
  data.write('1', 32 + 16); // the app version: the same for every build
  data.write(project, 32 + 48);
  data.write(elfSha, 32 + 144, 'hex');
  return data;
}

function file(data: Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ct-fw-')), 'codetalky.bin');
  writeFileSync(path, data);
  return path;
}

test('a CodeTalky image is read with its version and hash, and served at its own path only', () => {
  const data = fakeImage('codetalky', '91a5e4f2e30e66a8ea3a8e64303ed80a74b3eace4abdb2c20eb008b1835e8e5b');
  const image = readImage(file(data));
  assert.equal(image.version, '91a5e4f2e3', 'the build: start of the ELF hash');
  assert.equal(image.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(image.path, `/firmware/${image.sha256}.bin`);

  const store = new FirmwareStore();
  assert.equal(store.serve(image.path), null, 'nothing before it is offered');
  store.offer(image);
  assert.deepEqual(store.serve(image.path), data);
  assert.equal(store.serve('/firmware/other.bin'), null);
});

test('files that are not CodeTalky firmware are refused', () => {
  assert.throws(() => readImage(file(fakeImage('xiaozhi', '00'.repeat(32)))), /not CodeTalky/);
  assert.throws(() => readImage(file(Buffer.alloc(4096, 0))), /not an ESP-IDF app image/);
  assert.throws(() => readImage(file(Buffer.alloc(10, 0xe9))), /not a firmware image/);
});
