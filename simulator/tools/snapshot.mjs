// Render the simulator headlessly and save the screen as a 1-bit PNG. No browser
// needed, so it doubles as a visual check in scripts.
//
// The bridge runs in this process with the fake agent's six demo sessions. The
// bridge and the UI share one manual clock that starts at the moment the mockups
// show (2026-11-14 14:32, UTC+8), so every run gives the same pixels.
//
//   node simulator/tools/snapshot.mjs out.png [actions...]
//
//   --tap x,y    touch and release
//   --hold x,y   touch for a second, then release (long press)
//   --key N      press and release a key (see ct_key_t in ui/include/ct_ui.h)
//   --ms N       let N milliseconds pass
//   --offline    don't connect to the bridge (must come first)
//   --hosts 2    two computers, 台式机 and 笔记本, three demo sessions each
//   --unlink N   computer N (0 or 1) drops off the network
//   --long-report  make the api-server report too long for one screen
//   --verbose    print the frames sent by the device
//
// Actions run in the order given; 300 ms pass after each one.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

import { ManualClock } from '../../bridge/src/clock.ts';
import { FakeAgent } from '../../bridge/src/fake/engine.ts';
import { DEMO_T0, demoScripts } from '../../bridge/src/fake/scenario.ts';
import { Hub } from '../../bridge/src/hub.ts';
import { Glyphs } from '../../bridge/src/glyphs.ts';
import { DEFAULT_QUICK, DeviceLink } from '../../bridge/src/link.ts';

const require = createRequire(import.meta.url);
const createSim = require('../web/gen/codetalky_sim.js');

const [outPath, ...args] = process.argv.slice(2);
if (!outPath || outPath.startsWith('--')) {
  console.error('usage: node snapshot.mjs out.png [--tap x,y] [--hold x,y] [--key N] [--ms N] [--offline] [--hosts 2] [--verbose]');
  process.exit(2);
}
const offline = args.includes('--offline');
const verbose = args.includes('--verbose');
const hostsAt = args.indexOf('--hosts');
const twoHosts = hostsAt >= 0 && args[hostsAt + 1] === '2';
const actions = args.filter(
  (a, i) => a !== '--offline' && a !== '--verbose' && a !== '--long-report' && !(hostsAt >= 0 && (i === hostsAt || i === hostsAt + 1)),
);

// ---- bridges, in process: one per computer ----
const clock = new ManualClock(DEMO_T0 * 1000);
const glyphs = Glyphs.load();
const COMPUTERS = twoHosts
  ? [
      { name: '台式机', sessions: ['codetalky', 'firmware', 'docs-site'] },
      { name: '笔记本', sessions: ['blog-engine', 'landing', 'api-server'] },
    ]
  : [{ name: '台式机', sessions: null }];
const longReport = args.includes('--long-report');
const bridges = COMPUTERS.map((computer, index) => {
  const hub = new Hub(clock);
  for (const script of demoScripts()) {
    if (longReport && script.initial(0).id === 'api-server') {
      // A report too long for one screen, to check paging.
      const report = script.steps[0].report;
      for (let i = 1; i <= 14; i++) report.push({ b: true, lead: `第 ${i} 条`, text: '：补充说明，用来把汇报撑到一屏放不下，检查翻页是否正常。' });
    }
    if (!computer.sessions || computer.sessions.includes(script.initial(0).id)) new FakeAgent(hub, clock, script);
  }
  return { ...computer, index, hub, link: null, toDevice: [], toBridge: [] };
});

// ---- device ----
const flushes = [];
const sim = await createSim({
  onFlush: (x1, y1, x2, y2, last, mode) => flushes.push({ x1, y1, x2, y2, last, mode }),
  onVibrate: (ms) => console.log(`vibrate ${ms} ms`),
  // Called from inside the UI; queue it and deliver between ticks so nothing re-enters LVGL.
  onNetSend: (link, text) => {
    const bridge = bridges[link];
    if (!bridge?.link) return false;
    if (verbose) console.log(`device -> ${bridge.name}: ${text}`);
    bridge.toBridge.push(text);
    return true;
  },
});

function toUi(link, text) {
  const size = sim.lengthBytesUTF8(text) + 1;
  const ptr = sim._malloc(size);
  sim.stringToUTF8(text, ptr, size);
  sim._sim_net_rx(link, ptr, size - 1);
  sim._free(ptr);
}

function deliver() {
  for (;;) {
    let moved = false;
    for (const b of bridges) {
      for (const text of b.toBridge.splice(0)) {
        moved = true;
        if (b.link && !b.link.receive(text)) console.error(`${b.name} dropped the device`);
      }
      for (const text of b.toDevice.splice(0)) {
        moved = true;
        toUi(b.index, text);
      }
    }
    if (!moved) return;
  }
}

const STEP = 33;
const run = (ms) => {
  for (let t = 0; t < ms; t += STEP) {
    clock.advance(STEP);
    deliver();
    sim._sim_tick(STEP);
    deliver();
  }
};

sim._sim_init();
if (!offline) {
  for (const b of bridges) {
    b.link = new DeviceLink(b.hub, clock, (text) => b.toDevice.push(text), {
      hostName: b.name,
      hostId: `demo-${b.index}`,
      quick: DEFAULT_QUICK,
      fixText: (text) => glyphs.fix(text),
      tzMinutes: 480,
      flushMs: 150,
    });
    sim._sim_net_link(b.index, 1);
  }
}
run(1000);

const point = (value) => value.split(',').map(Number);
for (let i = 0; i < actions.length; i += 2) {
  const [flag, value] = [actions[i], actions[i + 1]];
  if (flag === '--tap' || flag === '--hold') {
    const [x, y] = point(value);
    sim._sim_pointer(x, y, 1);
    run(flag === '--hold' ? 1000 : 100);
    sim._sim_pointer(x, y, 0);
    run(300);
  } else if (flag === '--key') {
    sim._sim_key(Number(value), 1);
    run(100);
    sim._sim_key(Number(value), 0);
    run(300);
  } else if (flag === '--ms') {
    run(Number(value));
  } else if (flag === '--unlink') {
    // That computer drops off the network.
    const b = bridges[Number(value)];
    b.link?.close();
    b.link = null;
    sim._sim_net_link(b.index, 0);
    run(1000);
  } else {
    console.error(`unknown option ${flag}`);
    process.exit(2);
  }
}

const w = sim._sim_width();
const h = sim._sim_height();
const base = sim._sim_framebuffer();
const heap = sim.HEAPU8;

// RGB565 -> luminance -> black or white, the same threshold the panel model uses.
const raw = Buffer.alloc((w + 1) * h);
let black = 0;
for (let y = 0; y < h; y++) {
  raw[y * (w + 1)] = 0; // PNG filter type: none
  for (let x = 0; x < w; x++) {
    const j = base + (y * w + x) * 2;
    const c = heap[j] | (heap[j + 1] << 8);
    const r = ((c >> 11) & 0x1f) * 255 / 31;
    const g = ((c >> 5) & 0x3f) * 255 / 63;
    const b = (c & 0x1f) * 255 / 31;
    const isBlack = r * 0.3 + g * 0.59 + b * 0.11 < 128;
    if (isBlack) black++;
    raw[y * (w + 1) + 1 + x] = isBlack ? 0 : 255;
  }
}

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // greyscale
writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]));

const refreshes = flushes.filter((f) => f.last).length;
console.log(`${outPath}: ${w}x${h}, ${(black / (w * h) * 100).toFixed(1)}% black, ${refreshes} refreshes`);
