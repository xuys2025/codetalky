// Render the simulator headlessly and save the screen as a 1-bit PNG.
// No browser needed, so it doubles as a visual check in scripts.
//
//   node simulator/tools/snapshot.mjs out.png [--tap x,y] [--key N] [--ms 500]
//
// Actions run in the order given; --ms advances the clock (default 300 after each action).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const require = createRequire(import.meta.url);
const createSim = require('../web/gen/codetalky_sim.js');

const [outPath, ...args] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node snapshot.mjs out.png [--tap x,y] [--key N] [--ms 500]');
  process.exit(2);
}

const flushes = [];
const sim = await createSim({
  onFlush: (x1, y1, x2, y2, last, mode) => flushes.push({ x1, y1, x2, y2, last, mode }),
  onVibrate: (ms) => console.log(`vibrate ${ms} ms`),
});

const run = (ms) => {
  for (let t = 0; t < ms; t += 33) sim._sim_tick(33);
};

sim._sim_init();
run(300);

for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = [args[i], args[i + 1]];
  if (flag === '--tap') {
    const [x, y] = value.split(',').map(Number);
    sim._sim_pointer(x, y, 1);
    run(100);
    sim._sim_pointer(x, y, 0);
    run(300);
  } else if (flag === '--key') {
    sim._sim_key(Number(value), 1);
    run(100);
    sim._sim_key(Number(value), 0);
    run(300);
  } else if (flag === '--ms') {
    run(Number(value));
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

console.log(`${outPath}: ${w}x${h}, ${(black / (w * h) * 100).toFixed(1)}% black, ${flushes.length} flushes`);
