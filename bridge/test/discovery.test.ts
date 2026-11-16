import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { test } from 'node:test';

import { startDiscovery } from '../src/discovery.ts';

function ask(port: number, text: string, waitMs = 300): Promise<string | null> {
  const sock = createSocket('udp4');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sock.close();
      resolve(null);
    }, waitMs);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg.toString('utf8'));
    });
    sock.send(text, port, '127.0.0.1');
  });
}

test('a find gets the bridge id, name and WebSocket port back', async () => {
  const lines: string[] = [];
  const d = await startDiscovery({ port: 0, wsPort: 8137, hostId: 'abc:8137', hostName: '台式机', log: (l) => lines.push(l) });
  try {
    const reply = await ask(d.port, '{"t":"find","proto":1}');
    assert.ok(reply);
    assert.deepEqual(JSON.parse(reply), { t: 'here', proto: 1, hostId: 'abc:8137', host: '台式机', port: 8137 });
    assert.equal(lines.length, 1);
    await ask(d.port, '{"t":"find","proto":1}');
    assert.equal(lines.length, 1, 'the same device is logged once');
  } finally {
    await d.close();
  }
});

test('anything that is not a find is ignored', async () => {
  const d = await startDiscovery({ port: 0, wsPort: 8137, hostId: 'abc:8137', hostName: 'pc', log: () => {} });
  try {
    assert.equal(await ask(d.port, 'hello'), null);
    assert.equal(await ask(d.port, '{"t":"here"}'), null);
    assert.equal(await ask(d.port, `{"t":"find","pad":"${'x'.repeat(400)}"}`), null);
  } finally {
    await d.close();
  }
});
