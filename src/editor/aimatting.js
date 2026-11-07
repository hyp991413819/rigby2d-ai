// SPDX-License-Identifier: MIT OR Apache-2.0
// Smart matting for generated images: an AI background-removal model (best for arbitrary
// backgrounds) plus connected-component colour-key variants (pixel-exact for the pure
// black/white/coloured backgrounds the panel generates). All variants return an RGBA canvas.

/** The AI matting model bundled with the app (public/models/matting). */
export const LOCAL_MODEL_NAME = 'matting';
export const LOCAL_MODEL_URL = '/models/matting/config.json';

/** Whether the bundled model files are present (no network request involved). */
export async function checkLocalModel() {
  try {
    const res = await fetch(LOCAL_MODEL_URL, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

let worker = null;
function mattingWorker() {
  worker ??= new Worker(new URL('./matting.worker.js', import.meta.url), { type: 'module' });
  return worker;
}

/** Runs the AI model in a worker; resolves with a canvas at the source resolution. */
export function aiMatte(canvas, onProgress = () => {}, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = mattingWorker();
    let settled = false;
    const cleanup = () => {
      w.onmessage = null;
      w.onerror = null;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try { w.terminate(); } catch { /* already gone */ }
      worker = null;
      reject(new Error('AI model loading timed out'));
    }, timeoutMs);
    w.onmessage = ({ data }) => {
      if (data.type === 'download') onProgress({ kind: 'download', loaded: data.loaded, total: data.total });
      else if (data.type === 'status') onProgress({ kind: 'status', text: data.text });
      else if (data.type === 'missing') {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('LOCAL_MODEL_MISSING'));
      }
      else if (data.type === 'error') {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(data.text));
      } else if (data.type === 'done') {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          const tmp = document.createElement('canvas');
          tmp.width = data.width;
          tmp.height = data.height;
          tmp.getContext('2d').putImageData(new ImageData(data.pixels, data.width, data.height), 0, 0);
          const out = document.createElement('canvas');
          out.width = canvas.width;
          out.height = canvas.height;
          out.getContext('2d').drawImage(tmp, 0, 0, out.width, out.height);
          resolve(out);
        } catch (e) { reject(e); }
      }
    };
    w.onerror = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(e.message || 'Matting worker failed'));
    };
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const pixels = new Uint8ClampedArray(src.data);
    w.postMessage({ pixels, width: canvas.width, height: canvas.height }, [pixels.buffer]);
  });
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const smooth = (a) => a * a * (3 - 2 * a);

function parseColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Separable box blur of an alpha plane (O(w*h)), then an optional min-filter edge shrink. */
function filterAlpha(alpha, w, h, blur, erode) {
  let a = alpha;
  if (blur > 0) {
    const r = Math.max(1, Math.min(32, Math.round(blur)));
    const tmp = new Float32Array(a.length);
    const out = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const pre = new Float64Array(w + 1);
      for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + a[row + x];
      for (let x = 0; x < w; x++) {
        const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
        tmp[row + x] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
      }
    }
    for (let x = 0; x < w; x++) {
      const pre = new Float64Array(h + 1);
      for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
        out[y * w + x] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
      }
    }
    a = out;
  }
  if (erode > 0) {
    const src = a;
    a = new Float32Array(src.length);
    const r = Math.max(1, Math.round(erode));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let mn = 1;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
        if (src[yy * w + xx] < mn) mn = src[yy * w + xx];
      }
      a[y * w + x] = mn;
    }
  }
  return a;
}

/**
 * Removes a solid background WITHOUT eating dark parts of the subject: only pixels of the
 * background colour that are CONNECTED to the image border are removed (flood fill), then the
 * binary mask is feathered for smooth edges. Dark areas inside the character stay opaque.
 * With connected=false the old global colour distance is used (subject may touch the border).
 */
export function chromaMatte(source, { mode = 'black', tolerance = 18, feather = 16, erode = 0, despill = true, keyColor = '#000000', connected = true } = {}) {
  const w = source.width, h = source.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const key = parseColor(keyColor);
  const bgColor = mode === 'black' ? [0, 0, 0] : mode === 'white' ? [255, 255, 255] : key;
  const t = Math.max(0, tolerance), f = Math.max(1, feather);

  const keyDist = new Float32Array(w * h);
  const candidate = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let dist;
    if (mode === 'black') dist = Math.max(r, g, b);
    else if (mode === 'white') dist = 255 - Math.min(r, g, b);
    else dist = Math.sqrt((r - key[0]) ** 2 + (g - key[1]) ** 2 + (b - key[2]) ** 2) / 1.732;
    keyDist[p] = dist;
    candidate[p] = dist <= t ? 1 : 0;
  }

  let alpha;
  if (connected) {
    const bgMask = new Float32Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const push = (p) => {
      if (candidate[p] && !bgMask[p]) { bgMask[p] = 1; queue[tail++] = p; }
    };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (head < tail) {
      const p = queue[head++], x = p % w, y = (p - x) / w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    // Feather the binary background mask symmetrically on both sides of the boundary.
    // Scale the feather to the image so small previews do not lose their subject.
    const radius = Math.max(1, Math.min(32, Math.round(f / 2), Math.round(Math.min(w, h) / 32)));
    const soft = filterAlpha(bgMask, w, h, radius, 0);
    alpha = new Float32Array(soft.length);
    for (let p = 0; p < alpha.length; p++) alpha[p] = 1 - soft[p];
  } else {
    alpha = new Float32Array(w * h);
    for (let p = 0; p < alpha.length; p++) {
      let a = (keyDist[p] - t) / f;
      a = a <= 0 ? 0 : a >= 1 ? 1 : a;
      alpha[p] = smooth(a);
    }
  }
  if (erode > 0) alpha = filterAlpha(alpha, w, h, 0, erode);

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = alpha[p];
    if (despill && a > 0 && a < 1) {
      const s = Math.max(a, 0.001);
      d[i] = clamp255((d[i] - (1 - a) * bgColor[0]) / s);
      d[i + 1] = clamp255((d[i + 1] - (1 - a) * bgColor[1]) / s);
      d[i + 2] = clamp255((d[i + 2] - (1 - a) * bgColor[2]) / s);
    }
    d[i + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Light alpha polish for AI masks. */
export function polishAlpha(source, { feather = 0, erode = 0 } = {}) {
  if (!feather && !erode) return source;
  const w = source.width, h = source.height;
  const ctx = source.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const alpha = new Float32Array(w * h);
  for (let i = 3, p = 0; i < d.length; i += 4, p++) alpha[p] = d[i] / 255;
  const A = filterAlpha(alpha, w, h, feather, erode);
  for (let i = 3, p = 0; i < d.length; i += 4, p++) d[i] = Math.round(A[p] * 255);
  ctx.putImageData(img, 0, 0);
  return source;
}

/**
 * Unified entry point. The AI weights are loaded from the app's own static files, so no
 * download is needed at runtime; a missing model is reported as a clear error.
 */
export async function runMatte(source, options, onProgress) {
  if (options.method === 'ai') {
    const out = await aiMatte(source, onProgress, { timeoutMs: options.timeoutMs });
    return polishAlpha(out, { feather: Math.min(8, Math.round(options.feather / 4)), erode: options.erode });
  }
  return chromaMatte(source, options);
}

/** Loads an image URL/data URL into a canvas (same-origin sources only). */
export function canvasFromUrl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Cannot load the image for matting'));
    img.src = src;
  });
}
