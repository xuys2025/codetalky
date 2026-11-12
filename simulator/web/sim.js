// Browser shell for the simulator: drives the WebAssembly UI and models the
// e-ink panel (1-bit pixels, slow refresh, ghosting) on a canvas.
'use strict';

// Placeholder panel behaviour. Calibrate against the real GDEM0397T81 once it arrives.
const PANEL = {
  partialMs: 260, // small-area update
  fastMs: 420, // page change with the quick waveform
  fullMs: 1300, // full refresh, clears ghosting
  ghost: 0.07, // reflectance lost where a pixel went black -> white without a full refresh
};
const PAPER = [232, 230, 222];
const INK = [30, 30, 30];
const MODE_NAMES = ['局刷', '快刷', '全刷'];

const canvas = document.getElementById('epd');
const ctx = canvas.getContext('2d');
const device = document.getElementById('device');
const $ = (id) => document.getElementById(id);

let sim;
let W = 480;
let H = 800;
let shown; // Float32Array, reflectance per pixel: 0 = ink, 1 = paper
let image;
let pendingRects = [];
let busy = Promise.resolve();
let queued = 0;
let partialsSinceFull = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function unionOf(rects) {
  const u = { x1: W, y1: H, x2: -1, y2: -1 };
  for (const r of rects) {
    u.x1 = Math.min(u.x1, r.x1);
    u.y1 = Math.min(u.y1, r.y1);
    u.x2 = Math.max(u.x2, r.x2);
    u.y2 = Math.max(u.y2, r.y2);
  }
  return u;
}

// Copy the rect out of the RGB565 framebuffer as 1-bit: 1 = paper, 0 = ink.
function captureTarget(rect) {
  const w = rect.x2 - rect.x1 + 1;
  const h = rect.y2 - rect.y1 + 1;
  const out = new Uint8Array(w * h);
  const heap = sim.HEAPU8;
  const base = sim._sim_framebuffer();
  for (let y = 0; y < h; y++) {
    let j = base + ((rect.y1 + y) * W + rect.x1) * 2;
    for (let x = 0; x < w; x++, j += 2) {
      const c = heap[j] | (heap[j + 1] << 8);
      const lum = ((c >> 11) & 0x1f) * 2.47 + ((c >> 5) & 0x3f) * 2.39 + (c & 0x1f) * 0.9;
      out[y * w + x] = lum >= 128 ? 1 : 0;
    }
  }
  return out;
}

function paint(rect) {
  const w = rect.x2 - rect.x1 + 1;
  const h = rect.y2 - rect.y1 + 1;
  const data = image.data;
  for (let y = rect.y1; y <= rect.y2; y++) {
    for (let x = rect.x1; x <= rect.x2; x++) {
      const v = shown[y * W + x];
      const o = (y * W + x) * 4;
      data[o] = INK[0] + (PAPER[0] - INK[0]) * v;
      data[o + 1] = INK[1] + (PAPER[1] - INK[1]) * v;
      data[o + 2] = INK[2] + (PAPER[2] - INK[2]) * v;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0, rect.x1, rect.y1, w, h);
}

function fill(rect, fn) {
  const w = rect.x2 - rect.x1 + 1;
  for (let y = rect.y1; y <= rect.y2; y++) {
    for (let x = rect.x1; x <= rect.x2; x++) {
      const i = y * W + x;
      shown[i] = fn(i, (y - rect.y1) * w + (x - rect.x1));
    }
  }
  paint(rect);
}

async function refresh(job) {
  const { rect, target, mode } = job;
  const started = performance.now();
  if (mode === 2) {
    // Whole screen flashes black, then white, then settles on the new image with no ghosting.
    const all = { x1: 0, y1: 0, x2: W - 1, y2: H - 1 };
    const whole = captureTarget(all);
    fill(all, () => 0);
    await sleep(PANEL.fullMs * 0.35);
    fill(all, () => 1);
    await sleep(PANEL.fullMs * 0.35);
    fill(all, (_, k) => whole[k]);
    await sleep(PANEL.fullMs * 0.3);
    partialsSinceFull = 0;
  } else if (mode === 1) {
    // One inverted flash of the changed area, then the new image; old ink leaves a faint trace.
    fill(rect, (i, k) => (target[k] ? 0 : 1));
    await sleep(PANEL.fastMs * 0.45);
    fill(rect, (i, k) => (target[k] ? 1 - PANEL.ghost / 2 : 0));
    await sleep(PANEL.fastMs * 0.55);
    partialsSinceFull++;
  } else {
    await sleep(PANEL.partialMs);
    // Pixels turning white keep a trace of the old ink; traces stay until a full refresh.
    fill(rect, (i, k) => {
      if (!target[k]) return 0;
      return shown[i] < 0.5 ? 1 - PANEL.ghost : shown[i];
    });
    partialsSinceFull++;
  }
  $('st-mode').textContent = MODE_NAMES[mode] ?? String(mode);
  $('st-ms').textContent = `${Math.round(performance.now() - started)} ms`;
  $('st-count').textContent = `${partialsSinceFull} 次局刷`;
}

function onFlush(x1, y1, x2, y2, last, mode) {
  pendingRects.push({ x1, y1, x2, y2 });
  if (!last) return;
  const rect = unionOf(pendingRects);
  pendingRects = [];
  // The panel does one refresh at a time; later frames wait, as on the device.
  const job = { rect, target: captureTarget(rect), mode };
  queued++;
  $('st-queue').textContent = String(queued);
  busy = busy.then(() => refresh(job)).then(() => {
    queued--;
    $('st-queue').textContent = String(queued);
  });
}

function onVibrate(ms) {
  device.classList.add('buzz');
  setTimeout(() => device.classList.remove('buzz'), Math.max(ms, 60));
}

function pointerPos(event) {
  const r = canvas.getBoundingClientRect();
  return [
    Math.round(((event.clientX - r.left) * W) / r.width),
    Math.round(((event.clientY - r.top) * H) / r.height),
  ];
}

function bindInput() {
  let down = false;
  canvas.addEventListener('pointerdown', (e) => {
    down = true;
    canvas.setPointerCapture(e.pointerId);
    sim._sim_pointer(...pointerPos(e), 1);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (down) sim._sim_pointer(...pointerPos(e), 1);
  });
  const release = (e) => {
    if (!down) return;
    down = false;
    sim._sim_pointer(...pointerPos(e), 0);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  for (const button of document.querySelectorAll('button[data-key]')) {
    const key = Number(button.dataset.key);
    let held = false;
    const set = (state) => {
      if (held === state) return;
      held = state;
      button.classList.toggle('held', state);
      sim._sim_key(key, state ? 1 : 0);
    };
    button.addEventListener('pointerdown', (e) => {
      button.setPointerCapture(e.pointerId);
      set(true);
    });
    button.addEventListener('pointerup', () => set(false));
    button.addEventListener('pointercancel', () => set(false));
  }

  // Hold Space = hold BOOT (push-to-talk).
  const boot = $('boot');
  let spaceHeld = false;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || spaceHeld) return;
    e.preventDefault();
    spaceHeld = true;
    boot.classList.add('held');
    sim._sim_key(0, 1);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !spaceHeld) return;
    e.preventDefault();
    spaceHeld = false;
    boot.classList.remove('held');
    sim._sim_key(0, 0);
  });

  $('scale').addEventListener('change', (e) => {
    canvas.style.setProperty('--screen-w', `${e.target.value}px`);
  });
}

async function start() {
  sim = await createCodeTalkySim({ onFlush, onVibrate });
  W = sim._sim_width();
  H = sim._sim_height();
  canvas.width = W;
  canvas.height = H;
  shown = new Float32Array(W * H).fill(1);
  image = ctx.createImageData(W, H);
  paint({ x1: 0, y1: 0, x2: W - 1, y2: H - 1 });

  bindInput();
  sim._sim_init();

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    sim._sim_tick(Math.min(Math.round(now - last), 100));
    last = now;
  }, 33);
}

start().catch((error) => {
  $('st-error').textContent = `仿真器启动失败：${error.message}`;
  console.error(error);
});
