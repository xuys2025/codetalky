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

test('a device reporting its battery is logged, not answered', async () => {
  const lines: string[] = [];
  const d = await startDiscovery({ port: 0, wsPort: 8137, hostId: 'abc:8137', hostName: 'pc', log: (l) => lines.push(l) });
  try {
    const reply = await ask(d.port, '{"t":"diag","mv":3987,"ma":-85,"pct":79,"cap":1200,"ps":"modem","up":120,"heap":150}');
    assert.equal(reply, null);
    assert.equal(lines.length, 1);
    const [line = ''] = lines;
    assert.match(line, /3\.99 V, draws 85 mA, full battery lasts about 14\.1 h, battery 79%, 1200 mAh/);
    assert.match(line, /Wi-Fi power saving modem/);
  } finally {
    await d.close();
  }
});

test('mirrored device log lines are printed only when asked for', async () => {
  const lines: string[] = [];
  const quiet = await startDiscovery({ port: 0, wsPort: 8137, hostId: 'abc:8137', hostName: 'pc', log: (l) => lines.push(l) });
  try {
    assert.equal(await ask(quiet.port, '{"t":"log","s":"I (1200) main: hello\\n"}'), null);
    assert.equal(lines.length, 0);
  } finally {
    await quiet.close();
  }
  const d = await startDiscovery({ port: 0, wsPort: 8137, hostId: 'abc:8137', hostName: 'pc', log: (l) => lines.push(l), deviceLog: true });
  try {
    const long = 'x'.repeat(500);
    assert.equal(await ask(d.port, `{"t":"log","s":"\\u001b[0;32mI (1200) main: ${long}\\u001b[0m\\n"}`), null);
    assert.deepEqual(lines, [`device 127.0.0.1| I (1200) main: ${long}`]);
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
