// Browser shell for the simulator: drives the WebAssembly UI and models the
// e-ink panel on a canvas.
//
// Panel model. Like the SSD1677, the panel remembers what it was last told to show
// and only drives pixels whose value changes. Every frame from LVGL is compared with
// that, and only the box around the changed pixels is refreshed: first in black and
// white, then, once the page has been still for a moment, the grey overlay for just
// the pixels that were redrawn. Pixels that did not change keep what they show,
// ghosting included. The firmware's panel driver must follow the same rule: the UI
// rebuilds whole screens, so without the comparison every clock tick would redrive
// the entire panel.
'use strict';

// Placeholder panel behaviour. Calibrate against the real panel once it arrives.
const PANEL = {
  partialMs: 260, // small-area update
  fastMs: 420, // page change with the quick waveform
  fullMs: 1300, // full refresh, clears ghosting
  ghost: 0.07, // reflectance lost where a pixel went black -> white without a full refresh
  overlayDelayMs: 450, // how long the page must be still before the grey pass
  overlayMs: 180, // the grey overlay pass itself (12 frames in the vendor waveform)
};
const PAPER = [232, 230, 222];
const INK = [30, 30, 30];
const LEVEL_SHOWN = [0, 1 / 3, 2 / 3, 1]; // reflectance of grey levels 0 (black) .. 3 (white)
const MODE_NAMES = ['局刷', '快刷', '全刷', '灰度叠加'];

const canvas = document.getElementById('epd');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

let sim;
let W = 480;
let H = 800;
let shown; // Float32Array: what each pixel physically shows, 0 = ink, 1 = paper
let driven; // Uint8Array: grey level each pixel was last told to show
let needsGrey; // Uint8Array: 1 = redrawn in black and white, still owes its grey pass
let image;
let pendingRects = [];
let busy = Promise.resolve();
let queued = 0;
let partialsSinceFull = 0;
let overlayRect = null; // area with pixels waiting for their grey pass
let overlayTimer = null;
let greyEnabled = true;
let socket = null; // open WebSocket to the bridge, or null
let buzzTimer = null;

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

const widthOf = (r) => r.x2 - r.x1 + 1;
const heightOf = (r) => r.y2 - r.y1 + 1;

// Grey level per pixel of the framebuffer inside rect: 0 black, 1 dark, 2 light, 3 white.
// Levels 0-1 are black and 2-3 white in the black-and-white pass.
function levelsOf(rect) {
  const w = widthOf(rect);
  const h = heightOf(rect);
  const out = new Uint8Array(w * h);
  const heap = sim.HEAPU8;
  const base = sim._sim_framebuffer();
  for (let y = 0; y < h; y++) {
    let j = base + ((rect.y1 + y) * W + rect.x1) * 2;
    for (let x = 0; x < w; x++, j += 2) {
      const c = heap[j] | (heap[j + 1] << 8);
      const lum = ((c >> 11) & 0x1f) * 2.47 + ((c >> 5) & 0x3f) * 2.39 + (c & 0x1f) * 0.9;
      out[y * w + x] = lum >= 213 ? 3 : lum >= 128 ? 2 : lum >= 43 ? 1 : 0;
    }
  }
  return out;
}

// The smallest box inside rect where the new levels differ from what the panel shows.
function changedBox(rect, levels) {
  const w = widthOf(rect);
  const box = { x1: W, y1: H, x2: -1, y2: -1 };
  for (let y = 0; y < heightOf(rect); y++) {
    const row = (rect.y1 + y) * W + rect.x1;
    for (let x = 0; x < w; x++) {
      if (levels[y * w + x] !== driven[row + x]) {
        if (rect.x1 + x < box.x1) box.x1 = rect.x1 + x;
        if (rect.x1 + x > box.x2) box.x2 = rect.x1 + x;
        if (rect.y1 + y < box.y1) box.y1 = rect.y1 + y;
        box.y2 = rect.y1 + y;
      }
    }
  }
  return box.x2 < 0 ? null : box;
}

function paint(rect) {
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
  ctx.putImageData(image, 0, 0, rect.x1, rect.y1, widthOf(rect), heightOf(rect));
}

// fn(i, k): i indexes the whole screen, k the rect.
function fill(rect, fn) {
  const w = widthOf(rect);
  for (let y = rect.y1; y <= rect.y2; y++) {
    for (let x = rect.x1; x <= rect.x2; x++) {
      const i = y * W + x;
      shown[i] = fn(i, (y - rect.y1) * w + (x - rect.x1));
    }
  }
  paint(rect);
}

// Once the page has been still for a moment, give the redrawn pixels their grey level.
async function overlay() {
  if (!overlayRect) return;
  const rect = overlayRect;
  overlayRect = null;
  let owed = 0;
  for (let y = rect.y1; y <= rect.y2; y++) {
    for (let x = rect.x1; x <= rect.x2; x++) owed += needsGrey[y * W + x];
  }
  if (owed === 0) return;
  if (!greyEnabled) {
    for (let y = rect.y1; y <= rect.y2; y++) needsGrey.fill(0, y * W + rect.x1, y * W + rect.x2 + 1);
    return;
  }
  const started = performance.now();
  await sleep(PANEL.overlayMs);
  fill(rect, (i) => {
    if (!needsGrey[i]) return shown[i];
    needsGrey[i] = 0;
    return LEVEL_SHOWN[driven[i]];
  });
  $('st-mode').textContent = MODE_NAMES[3];
  $('st-ms').textContent = `${Math.round(performance.now() - started)} ms`;
  $('st-area').textContent = `${owed} 个像素`;
}

function scheduleOverlay(rect) {
  overlayRect = overlayRect ? unionOf([overlayRect, rect]) : rect;
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => {
    busy = busy.then(overlay);
  }, PANEL.overlayDelayMs);
}

async function refresh(job) {
  const { box, levels, before, mode } = job;
  const started = performance.now();
  const white = (k) => levels[k] >= 2;
  if (mode === 2) {
    // Whole screen flashes black, then white, then settles on the new image with no ghosting.
    fill(box, () => 0);
    await sleep(PANEL.fullMs * 0.35);
    fill(box, () => 1);
    await sleep(PANEL.fullMs * 0.35);
    fill(box, (i, k) => (white(k) ? 1 : 0));
    await sleep(PANEL.fullMs * 0.3);
    partialsSinceFull = 0;
  } else if (mode === 1) {
    // One inverted flash of the box, then the new image; old ink leaves a faint trace.
    fill(box, (i, k) => (white(k) ? 0 : 1));
    await sleep(PANEL.fastMs * 0.45);
    fill(box, (i, k) => (white(k) ? 1 - PANEL.ghost / 2 : 0));
    await sleep(PANEL.fastMs * 0.55);
    partialsSinceFull++;
  } else {
    await sleep(PANEL.partialMs);
    // Only pixels whose level changed are driven; the rest keep what they show.
    fill(box, (i, k) => {
      if (levels[k] === before[k]) return shown[i];
      if (!white(k)) return 0;
      return shown[i] < 0.5 ? 1 - PANEL.ghost : 1;
    });
    partialsSinceFull++;
  }
  // Redrawn pixels that should be grey get it in the overlay pass.
  const w = widthOf(box);
  for (let y = box.y1; y <= box.y2; y++) {
    for (let x = box.x1; x <= box.x2; x++) {
      const k = (y - box.y1) * w + (x - box.x1);
      if (mode !== 0 || levels[k] !== before[k]) {
        needsGrey[y * W + x] = levels[k] === 1 || levels[k] === 2 ? 1 : 0;
      }
    }
  }
  $('st-mode').textContent = MODE_NAMES[mode] ?? String(mode);
  $('st-ms').textContent = `${Math.round(performance.now() - started)} ms`;
  $('st-count').textContent = `${partialsSinceFull} 次局刷`;
  $('st-area').textContent = `${widthOf(box)} × ${heightOf(box)}`;
}

function onFlush(x1, y1, x2, y2, last, mode) {
  pendingRects.push({ x1, y1, x2, y2 });
  if (!last) return;
  const whole = { x1: 0, y1: 0, x2: W - 1, y2: H - 1 };
  const rect = mode === 2 ? whole : unionOf(pendingRects);
  pendingRects = [];
  const levels = levelsOf(rect);
  const box = mode === 2 ? rect : changedBox(rect, levels);
  if (!box) {
    $('st-area').textContent = '没有变化，不刷';
    return;
  }
  // Cut the new levels and the panel's current ones down to the box, and tell the
  // panel the new image right away so the next frame is compared against it.
  const w = widthOf(box);
  const rw = widthOf(rect);
  const next = new Uint8Array(w * heightOf(box));
  const before = new Uint8Array(next.length);
  for (let y = 0; y < heightOf(box); y++) {
    for (let x = 0; x < w; x++) {
      const i = (box.y1 + y) * W + box.x1 + x;
      const k = y * w + x;
      next[k] = levels[(box.y1 - rect.y1 + y) * rw + (box.x1 - rect.x1 + x)];
      before[k] = driven[i];
      driven[i] = next[k];
    }
  }
  // The panel does one refresh at a time; later frames wait, as on the device.
  const job = { box, levels: next, before, mode };
  queued++;
  $('st-queue').textContent = String(queued);
  busy = busy.then(() => refresh(job)).then(() => {
    queued--;
    $('st-queue').textContent = String(queued);
  });
  scheduleOverlay(box);
}

// ---- link to the bridge: the same server that serves this page ----

function toUi(text) {
  const size = sim.lengthBytesUTF8(text) + 1;
  const ptr = sim._malloc(size);
  sim.stringToUTF8(text, ptr, size);
  sim._sim_net_rx(ptr, size - 1);
  sim._free(ptr);
}

function onNetSend(text) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(text);
  return true;
}

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/device`;
  $('st-link').textContent = '连接中';
  const ws = new WebSocket(url);
  ws.onopen = () => {
    socket = ws;
    $('st-link').textContent = '已连接';
    sim._sim_net_link(1);
  };
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') toUi(event.data);
  };
  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
      sim._sim_net_link(0);
    }
    $('st-link').textContent = '未连接，2 秒后重试';
    setTimeout(connect, 2000);
  };
}

// The motor buzzes; the screen does not move. Shown as a lamp in the side panel.
function onVibrate(ms) {
  const lamp = $('st-buzz');
  lamp.textContent = `● ${ms} ms`;
  lamp.classList.add('on');
  clearTimeout(buzzTimer);
  buzzTimer = setTimeout(() => lamp.classList.remove('on'), Math.max(ms, 150));
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
  $('grey').addEventListener('change', (e) => {
    greyEnabled = e.target.checked;
  });
}

async function start() {
  sim = await createCodeTalkySim({ onFlush, onVibrate, onNetSend });
  W = sim._sim_width();
  H = sim._sim_height();
  canvas.width = W;
  canvas.height = H;
  shown = new Float32Array(W * H).fill(1);
  driven = new Uint8Array(W * H).fill(3);
  needsGrey = new Uint8Array(W * H);
  image = ctx.createImageData(W, H);
  paint({ x1: 0, y1: 0, x2: W - 1, y2: H - 1 });

  bindInput();
  sim._sim_init();
  connect();

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
