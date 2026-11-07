// SPDX-License-Identifier: MIT OR Apache-2.0
// AI image generation panel: text-to-image through a configurable SenseNova (SenseTime) API.
// The endpoint, key, model and request/response shape are all user-configurable so any
// OpenAI-compatible or SenseNova image API can be used. Generated images can be imported
// straight into the open project as image slots.

import { dialog } from './helpui.js';
import { h } from './widgets.js';
import { translateUiText as tr } from './i18n.js';
import { isDesktop, openExternal } from './platform.js';
import { selBone } from './app.js';
import { importPngs } from './io.js';
import { runMatte, canvasFromUrl, checkLocalModel, chromaMatte } from './aimatting.js';
import { listTemplates, getTemplate } from './spinetemplate.js';
import { openTemplateLibrary, poseReferenceUrl, TEMPLATE_KEY } from './templatelibui.js';
import { assembleTemplate, exportAssembled } from './templatebuild.js';

const STORAGE_KEY = 'rigby.ai-image.config';

// Defaults follow the official SenseNova docs: https://platform.sensenova.cn/docs
// POST https://token.sensenova.cn/v1/images/generations with an sk- key in a Bearer header.
const DEFAULTS = {
  baseUrl: 'https://token.sensenova.cn/v1',
  apiKey: '',
  model: 'sensenova-u1.5-lite',
  path: '/images/generations',
  editPath: '/images/edits',
  auth: 'bearer',
  extraHeaders: '',
  extraBody: '',
  imageField: '',
  size: '2048x2048',
  responseFormat: 'b64_json',
  outputFormat: 'png',
  watermark: false,
  promptExtend: true,
  proxyPath: '/sensenova',
  prompt: '',
  // Prepended to every prompt: a pure black background makes the subject easy to key out later.
  fixedPrompt: '纯黑背景（#000000），画面仅包含主体与均匀纯黑背景；背景无渐变、无阴影、无投影、无反光、无环境元素、无文字水印；主体完整居中、轮廓清晰锐利、边缘干净，与黑色背景高对比，便于后期抠图。',
};

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    saved = {};
  }
  const cfg = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  for (const k of Object.keys(DEFAULTS)) if (typeof cfg[k] !== typeof DEFAULTS[k]) cfg[k] = DEFAULTS[k];
  // Config saved before the docs were followed used a wrong host/model; keep the key and prompt.
  if (cfg.baseUrl === 'https://api.sensenova.cn/v1') cfg.baseUrl = DEFAULTS.baseUrl;
  if (cfg.model === 'SenseNova-Image') cfg.model = DEFAULTS.model;
  delete cfg.n;
  delete cfg.negativePrompt;
  return cfg;
}

function saveConfig(cfg) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // Settings are a convenience; a blocked storage just means they last for this session.
  }
}

/** fetch through the Tauri HTTP plugin on the desktop (no CORS), or the browser's fetch. */
async function httpFetch(url, init) {
  const fetcher = isDesktop ? (await import('@tauri-apps/plugin-http')).fetch : globalThis.fetch;
  return fetcher(url, init);
}

/** Body for POST /v1/images/generations, per platform.sensenova.cn/docs. */
function requestBody(cfg, prompt) {
  const body = {
    model: cfg.model || DEFAULTS.model,
    prompt,
    n: 1, // the SenseNova image API only supports n = 1
    size: cfg.size,
    response_format: cfg.responseFormat,
    output_format: cfg.outputFormat,
    watermark: !!cfg.watermark,
    prompt_extend: !!cfg.promptExtend,
  };
  if (cfg.extraBody.trim()) {
    let extra;
    try {
      extra = JSON.parse(cfg.extraBody);
    } catch (e) {
      throw new Error(`Extra body: ${e.message}`);
    }
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
  }
  return body;
}

async function postJson(cfg, body, apiPath = cfg.path) {
  let base = cfg.baseUrl.replace(/\/+$/, '');
  // Browser: the dev server proxies /sensenova/* to the official host (a direct call fails the
  // CORS preflight). Desktop goes straight out through the Tauri HTTP plugin.
  if (!isDesktop && cfg.proxyPath) {
    try {
      const u = new URL(base);
      if (u.hostname === 'token.sensenova.cn') base = cfg.proxyPath.replace(/\/+$/, '') + u.pathname.replace(/\/+$/, '');
    } catch {
      // A relative base is already a proxy path.
    }
  }
  const url = base + (apiPath.startsWith('/') ? apiPath : '/' + apiPath);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.auth === 'bearer' && cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey.replace(/^Bearer\s+/i, '')}`;
  if (cfg.extraHeaders.trim()) {
    let extra;
    try {
      extra = JSON.parse(cfg.extraHeaders);
    } catch (e) {
      throw new Error(`Extra headers: ${e.message}`);
    }
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(headers, extra);
  }
  const res = await httpFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      // Some backends close the body on errors.
    }
    throw new Error(`HTTP ${res.status} ${res.statusText || ''}${detail ? ' — ' + detail : ''}`);
  }
  return res.json();
}

function pathValue(obj, path) {
  return path.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
}

/** Pulls image URLs / base64 strings out of the many response shapes image APIs use. */
function imagesFrom(json, field) {
  if (field) {
    const v = pathValue(json, field);
    const list = Array.isArray(v) ? v : v ? [v] : [];
    return list
      .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.url || x.b64_json || x.image || x.image_url || x.content : ''))
      .map((s) => String(s).trim())
      .filter(Boolean);
  }
  const out = [];
  const push = (s) => {
    const v = String(s ?? '').trim();
    if (v) out.push(v);
  };
  // Common OpenAI-compatible / SenseNova shapes first: data[], images[], output.images, image...
  const groups = [json?.data, json?.images, json?.output?.images, json?.output?.image, json?.image, json?.image_url, json?.url, json?.result?.images];
  for (const g of groups) {
    if (!g) continue;
    if (Array.isArray(g)) {
      for (const item of g) {
        if (typeof item === 'string') push(item);
        else if (item && typeof item === 'object') push(item.url || item.b64_json || item.image || item.image_url || item.content);
      }
    } else if (typeof g === 'string') push(g);
    else if (g && typeof g === 'object') push(g.url || g.b64_json || g.image || g.image_url);
  }
  // Fallback: any image URL, or a base64-looking value in an image-ish field, at any depth.
  const maybe = (v, key) => {
    const s = String(v).trim();
    if (!s) return;
    const keyed = /image|img|b64|base64/i.test(key);
    if (/^data:image\//i.test(s) || /^https?:\/\//i.test(s)) return push(s);
    const b64ish = /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length % 4 === 0;
    if (b64ish && ((keyed && s.length > 32) || s.length > 512)) return push(s);
  };
  const walk = (node, key = '') => {
    if (Array.isArray(node)) {
      for (const v of node) {
        if (typeof v === 'string') maybe(v, key);
        else if (v && typeof v === 'object') walk(v, key);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') maybe(v, k);
      else if (v && typeof v === 'object') walk(v, k);
    }
  };
  walk(json);
  return [...new Set(out)];
}

function base64Bytes(src) {
  const clean = src.replace(/^data:image\/[^;]+;base64,/i, '').replace(/\s/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function downloadBytes(url) {
  const res = await httpFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading image`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A bare base64 image (as opposed to an http(s) URL), including short 1x1 PNGs. */
function isBareBase64(src) {
  return !/^https?:\/\//i.test(src) && /^[A-Za-z0-9+/=\s]+$/.test(src) && src.length > 32 && src.length % 4 === 0;
}

async function makeResult(src, i) {
  const name = `ai-image-${Date.now()}-${i + 1}.png`;
  let bytes = null;
  let preview = src;
  if (/^data:image\//i.test(src) || isBareBase64(src)) {
    bytes = base64Bytes(src);
    preview = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  } else {
    try {
      bytes = await downloadBytes(src);
      preview = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    } catch {
      // Keep the remote URL for the preview; importing retries the download.
    }
  }
  return { name, src, preview, bytes };
}

async function importToProject(app, results) {
  const files = [];
  for (const r of results) {
    const bytes = r.bytes ?? (/^data:image\//i.test(r.src) || isBareBase64(r.src) ? base64Bytes(r.src) : await downloadBytes(r.src));
    files.push({ name: r.name, bytes });
  }
  const n = await importPngs(files, selBone(app.sel) ?? 0, app.doc, app.images);
  app.frameRequest = true;
  app.changed?.();
  app.setStatus?.(tr(`Imported ${n} images`));
  return n;
}

function downloadResult(r) {
  const href = r.bytes ? URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' })) : r.src;
  const a = h('a', { href, download: r.name, rel: 'noopener' });
  document.body.append(a);
  a.click();
  a.remove();
  if (r.bytes) setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

// --- Generation history -------------------------------------------------------
// Thumbnails + the prompts are kept in localStorage (bounded), so past generations can be
// browsed and their prompts reused without storing full-size images.
const HISTORY_KEY = 'rigby.ai-image.history';
const HISTORY_LIMIT = 24;

function loadHistory() {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object' && e.preview) : [];
  } catch {
    return [];
  }
}

/** Keeps the newest HISTORY_LIMIT entries, dropping the oldest if storage is full. */
function saveHistory(list) {
  let kept = list.slice(-HISTORY_LIMIT);
  while (kept.length) {
    try {
      globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(kept));
      return kept;
    } catch {
      kept = kept.slice(1);
    }
  }
  try { globalThis.localStorage?.setItem(HISTORY_KEY, '[]'); } catch {}
  return [];
}

function addHistory(entries) {
  return saveHistory([...loadHistory(), ...entries]);
}

/** A compact data URL so history fits in localStorage (the full-size image is not kept). */
async function makeThumb(bytes, max = 512) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/webp', 0.82);
}

/** A labelled form row. */
function field(label, control) {
  return h('label', { class: 'ai-field' }, h('span', null, tr(label)), control);
}

/** Resets the API settings to their documented defaults, keeping the prompts. */
export function resetApiConfig() {
  const cfg = loadConfig();
  for (const k of Object.keys(DEFAULTS)) if (k !== 'prompt' && k !== 'fixedPrompt') cfg[k] = DEFAULTS[k];
  saveConfig(cfg);
}

/**
 * The SenseNova API settings form, shown in Edit ▸ Preferences ▸ AI image generation.
 * Shared from here so the config lives in one module; it reads the saved config on every
 * build and saves on every change, so edits apply without reopening the image panel.
 */
export function buildApiSettings() {
  const cfg = loadConfig();
  const mk = (key, type = 'text', placeholder = '') => {
    const el = h('input', { type, placeholder, spellcheck: false });
    el.value = cfg[key];
    el.addEventListener('input', () => {
      cfg[key] = el.value;
      saveConfig(cfg);
    });
    return el;
  };
  const auth = h('select', null, h('option', { value: 'bearer' }, tr('Bearer token')), h('option', { value: 'none' }, tr('No authorization header')));
  auth.value = cfg.auth;
  auth.addEventListener('change', () => {
    cfg.auth = auth.value;
    saveConfig(cfg);
  });
  const selectField = (label, key, options) => {
    const el = h('select', null, ...options.map(([v, text]) => h('option', { value: v }, text)));
    el.value = cfg[key];
    el.addEventListener('change', () => {
      cfg[key] = el.value;
      saveConfig(cfg);
    });
    return field(label, el);
  };
  const checkField = (label, key) => {
    const el = h('input', { type: 'checkbox' });
    el.checked = !!cfg[key];
    el.addEventListener('change', () => {
      cfg[key] = el.checked;
      saveConfig(cfg);
    });
    return h('label', { class: 'ai-check' }, el, tr(label));
  };
  const extraHeaders = h('textarea', { rows: 2, placeholder: '{"X-Header": "value"}', spellcheck: false });
  extraHeaders.value = cfg.extraHeaders;
  extraHeaders.addEventListener('input', () => {
    cfg.extraHeaders = extraHeaders.value;
    saveConfig(cfg);
  });
  const extraBody = h('textarea', { rows: 2, placeholder: '{"seed": 42}', spellcheck: false });
  extraBody.value = cfg.extraBody;
  extraBody.addEventListener('input', () => {
    cfg.extraBody = extraBody.value;
    saveConfig(cfg);
  });
  const modelInput = mk('model');
  modelInput.setAttribute('list', 'ai-model-list');
  const models = h('datalist', { id: 'ai-model-list' }, h('option', { value: 'sensenova-u1.5-lite' }), h('option', { value: 'sensenova-u1.5-fast' }));

  return h(
    'div',
    { class: 'ai-prefs-settings ai-ui' },
    h('p', { class: 'small weak' }, tr('According to the official docs: token.sensenova.cn/v1, an sk- API key with Bearer auth, and the sensenova-u1.5 models.')),
    h('p', { class: 'small weak' }, tr('Changes apply to the AI image panel immediately.')),
    h(
      'div',
      { class: 'ai-settings-grid' },
      field('Base URL', mk('baseUrl')),
      field('API key', mk('apiKey', 'password')),
      field('Model', modelInput),
      models,
      field('Request path', mk('path')),
      field('Edit path', mk('editPath')),
      field('Authentication', auth),
      field('Image field path', mk('imageField', 'text', 'data.0.url')),
      field('Browser proxy path', mk('proxyPath')),
      selectField('Response format', 'responseFormat', [['b64_json', tr('b64_json (recommended in the browser)')], ['url', tr('url (temporary 24h link)')]]),
      selectField('Output format', 'outputFormat', [['png', 'png'], ['jpeg', 'jpeg'], ['webp', 'webp']]),
      checkField('Add watermark', 'watermark'),
      checkField('Auto-extend the prompt', 'promptExtend'),
    ),
    h('div', { class: 'ai-settings-grid' }, h('label', { class: 'ai-field ai-wide' }, h('span', null, tr('Extra headers (JSON)')), extraHeaders), h('label', { class: 'ai-field ai-wide' }, h('span', null, tr('Extra body (JSON)')), extraBody)),
    h(
      'p',
      { class: 'small weak' },
      tr('In the browser, requests go through the dev-server proxy at /sensenova; the desktop app calls the API directly.'),
      ' ',
      h('button', { class: 'link', onclick: () => openExternal('https://platform.sensenova.cn/docs') }, tr('SenseNova API docs ↗')),
    ),
  );
}

export function openAiImagePanel(app, opts = {}) {
  const cfg = loadConfig();
  const { body, close } = dialog('ai-image-dialog ai-ui', tr('AI Image Generation'), tr('Generate images for your project with a text-to-image model.'), { dismissible: false, onClose: () => preview.remove() });
  // Full-screen panel: mark the backdrop so CSS can fill the viewport. Escape and outside clicks
  // are disabled by dialog({ dismissible: false }) — only the close buttons dismiss it.
  body.closest('.modal-backdrop')?.classList.add('ai-image-backdrop');
  let results = [];
  let busy = false;

  const status = h('div', { class: 'ai-status small weak' }, tr('No images yet.'));
  const setStatus = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };

  const prompt = h('textarea', { class: 'ai-prompt', rows: 3, placeholder: tr('Describe the image you want…'), spellcheck: false });
  prompt.value = cfg.prompt;
  const fixed = h('textarea', { class: 'ai-fixed', rows: 3, spellcheck: false });
  fixed.value = cfg.fixedPrompt;
  fixed.addEventListener('input', () => {
    cfg.fixedPrompt = fixed.value;
    saveConfig(cfg);
  });
  const restoreFixed = h('button', { class: 'link', onclick: () => {
    cfg.fixedPrompt = DEFAULTS.fixedPrompt;
    fixed.value = DEFAULTS.fixedPrompt;
    saveConfig(cfg);
  } }, tr('Restore default'));
  // Sizes recommended by platform.sensenova.cn/docs (2K/4K, multiples of 32).
  const SIZES = ['2048x2048', '2720x1536', '1536x2720', '1664x2496', '2496x1664', '4096x4096', '1024x1024', 'auto'];
  const size = h('select', null, ...SIZES.map((v) => h('option', { value: v }, v)));
  size.value = cfg.size;

  const generate = h('button', { class: 'primary' }, tr('Generate'));
  const grid = h('div', { class: 'ai-grid' });
  const importAll = h('button', { disabled: true }, tr('Import all into project'));
  const clear = h('button', { disabled: true }, tr('Clear results'));

  const renderResults = () => {
    grid.replaceChildren();
    for (const r of results) {
      const card = h(
        'div',
        { class: 'ai-card' },
        h('img', { src: r.preview, alt: r.name, class: 'ai-card-img', title: tr('View image'), onclick: () => showPreview({ preview: r.preview, src: r.src, ...(r.context ?? {}) }), onerror: (e) => (e.target.style.visibility = 'hidden') }),
        h(
          'div',
          { class: 'ai-card-actions' },
          h('button', { onclick: async () => {
            try {
              const n = await importToProject(app, [r]);
              setStatus(tr(`Imported ${n} images`));
            } catch (e) {
              setStatus(`✕ ${e.message}`, true);
            }
          } }, tr('Import')),
          h('button', { onclick: () => downloadResult(r) }, tr('Download')),
        ),
      );
      grid.append(card);
    }
    importAll.disabled = clear.disabled = results.length === 0;
  };

  const doGenerate = async () => {
    if (busy) return;
    // The API settings now live in Preferences: pick up any edits made while this panel is open.
    Object.assign(cfg, loadConfig());
    const text = prompt.value.trim();
    if (!text) return setStatus(tr('Please enter a prompt.'), true);
    if (cfg.auth === 'bearer' && !cfg.apiKey) return setStatus(tr('Please set the API key.'), true);
    Object.assign(cfg, { prompt: text, fixedPrompt: fixed.value, size: size.value });
    saveConfig(cfg);
    busy = true;
    generate.disabled = true;
    generate.textContent = tr('Generating…');
    setStatus(tr('Generating…'));
    try {
      // The fixed prompt is merged with the user prompt for every request (drop a trailing
      // full stop so the two halves do not end up with '。，').
      const fixedText = fixed.value.trim().replace(/[，,；;。.\s]+$/, '');
      const fullPrompt = [fixedText, text].filter(Boolean).join('，');
      const json = await postJson(cfg, requestBody(cfg, fullPrompt));
      const found = imagesFrom(json, cfg.imageField.trim());
      if (!found.length) throw new Error(tr('No image found in the response.') + ' ' + tr('Set the image field path in API settings if the response format differs.'));
      results = await Promise.all(found.map(makeResult));
      for (const r of results) r.context = { prompt: text, fixedPrompt: fixed.value.trim(), fullPrompt };
      renderResults();
      setStatus(tr(`Generated ${results.length} images`));
      // Save each result with its prompts so it can be browsed or reused later.
      const entries = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        let thumb = r.preview;
        if (r.bytes) {
          try { thumb = await makeThumb(r.bytes); } catch { /* keep the blob URL */ }
        }
        entries.push({
          id: `${Date.now()}-${i}`,
          at: new Date().toISOString(),
          prompt: text,
          fixedPrompt: fixed.value.trim(),
          fullPrompt,
          size: cfg.size,
          model: cfg.model,
          src: r.src,
          preview: thumb,
        });
      }
      addHistory(entries);
      renderHistory();
    } catch (e) {
      setStatus(`✕ ${e.message}`, true);
    } finally {
      busy = false;
      generate.disabled = false;
      generate.textContent = tr('Generate');
    }
  };
  generate.addEventListener('click', doGenerate);
  prompt.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doGenerate();
  });

  importAll.addEventListener('click', async () => {
    if (!results.length) return;
    try {
      const n = await importToProject(app, results);
      setStatus(tr(`Imported ${n} images`));
    } catch (e) {
      setStatus(`✕ ${e.message}`, true);
    }
  });
  clear.addEventListener('click', () => {
    results = [];
    renderResults();
    setStatus(tr('No images yet.'));
  });

  // --- History -----------------------------------------------------------------
  const historyGrid = h('div', { class: 'ai-history-grid' });
  const historyEmpty = h('p', { class: 'small weak ai-history-empty' }, tr('No history yet.'));
  const clearHistory = h('button', { onclick: () => { saveHistory([]); renderHistory(); } }, tr('Clear history'));
  // --- Image preview + smart matting -------------------------------------------
  const preview = h('div', { class: 'ai-preview' });
  const matteOriginal = h('img', { class: 'ai-preview-img' });
  const matteResult = h('canvas', { class: 'ai-preview-img ai-matte-canvas' });
  const matteFigure = h('figure', { class: 'ai-preview-figure ai-checker', hidden: true }, matteResult, h('figcaption', null, tr('Result')));
  const matteStatus = h('div', { class: 'small weak ai-matte-status' });
  const setMatteStatus = (s, err = false) => {
    matteStatus.textContent = s;
    matteStatus.classList.toggle('error', err);
  };

  const methodSel = h('select', null,
    h('option', { value: 'black' }, tr('Black background key (best for generated images)')),
    h('option', { value: 'ai' }, tr('Built-in AI matting (offline)')),
    h('option', { value: 'custom' }, tr('Custom color key')),
  );
  const modelNote = h('span', { class: 'small weak ai-matte-note' }, '');
  const connected = h('input', { type: 'checkbox' });
  connected.checked = true;
  const connectedField = h('label', { class: 'ai-matte-field ai-matte-check' }, connected, tr('Only remove background connected to the edges (protects dark subject details)'));
  const num = (value, min, max, step = 1) => h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) });
  const tolerance = num(18, 0, 120);
  const feather = num(16, 1, 60);
  const erode = num(0, 0, 3);
  const despill = h('input', { type: 'checkbox' });
  despill.checked = true;
  const keyColor = h('input', { type: 'color', value: '#000000' });
  const pickCorner = h('button', { class: 'link', onclick: () => {
    if (!matteSource) return;
    const d = matteSource.getContext('2d').getImageData(0, 0, 1, 1).data;
    keyColor.value = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  } }, tr('Pick from corner'));
  const colorField = h('label', { class: 'ai-matte-field' }, h('span', null, tr('Key color')), h('span', { class: 'ai-matte-color' }, keyColor, pickCorner));
  const matteBtn = h('button', { class: 'primary' }, tr('Apply matting'));
  const importMatte = h('button', { disabled: true }, tr('Import'));
  const downloadMatte = h('button', { disabled: true }, tr('Download'));
  const matteActions = h('div', { class: 'ai-matte-actions' }, importMatte, downloadMatte);
  const setMethod = () => {
    const ai = methodSel.value === 'ai';
    modelNote.hidden = !ai;
    colorField.hidden = methodSel.value !== 'custom';
    connectedField.hidden = ai;
  };
  methodSel.addEventListener('change', setMethod);
  setMethod();

  let matteSource = null;
  let matteEntry = null;
  let matteFullPng = null;
  let matteBusy = false;

  matteBtn.addEventListener('click', async () => {
    if (matteBusy || !matteSource) return;
    matteBusy = true;
    matteBtn.disabled = true;
    matteBtn.textContent = tr('Matting…');
    setMatteStatus(tr('Matting…'));
    try {
      const opts = {
        method: methodSel.value,
        tolerance: Number(tolerance.value) || 0,
        feather: Number(feather.value) || 1,
        erode: Number(erode.value) || 0,
        despill: despill.checked,
        keyColor: keyColor.value,
        connected: connected.checked,
      };
      const onProgress = (p) => {
        if (p.kind === 'download') {
          const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
          setMatteStatus(tr('Downloading matting model… ') + pct + '%');
        } else if (p.kind === 'status') setMatteStatus(tr(p.text));
      };
      const out = await runMatte(matteSource, opts, onProgress);
      matteResult.width = out.width;
      matteResult.height = out.height;
      const rctx = matteResult.getContext('2d');
      rctx.clearRect(0, 0, out.width, out.height);
      rctx.drawImage(out, 0, 0);
      matteFigure.hidden = false;
      matteFullPng = out.toDataURL('image/png');
      importMatte.disabled = downloadMatte.disabled = false;
      // Keep the matted result as its own history record, with the original prompts.
      const scale = Math.min(1, 512 / Math.max(out.width, out.height));
      const tc = document.createElement('canvas');
      tc.width = Math.max(1, Math.round(out.width * scale));
      tc.height = Math.max(1, Math.round(out.height * scale));
      tc.getContext('2d').drawImage(out, 0, 0, tc.width, tc.height);
      const thumb = tc.toDataURL('image/webp', 0.82);
      // A subject-less AI mask (e.g. an abstract test image for a portrait model) is not a
      // useful record: warn instead of filling history with a fully transparent picture.
      const px = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
      let opaque = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) opaque++;
      const empty = opaque / (px.length / 4) < 0.01;
      if (!empty) addHistory([{ id: `matte-${Date.now()}`,
        at: new Date().toISOString(),
        kind: 'matte',
        method: opts.method,
        model: opts.method === 'ai' ? 'Xenova/modnet (bundled)' : '',
        prompt: matteEntry?.prompt ?? '',
        fixedPrompt: matteEntry?.fixedPrompt ?? '',
        fullPrompt: matteEntry?.fullPrompt ?? '',
        size: `${out.width}x${out.height}`,
        src: thumb,
        preview: thumb,
      }]);
      if (!empty) renderHistory();
      setMatteStatus(empty ? tr('No subject detected by the AI model; try the black background key.') : tr('Matte saved to history.'));
    } catch (e) {
      const missing = e.message === 'LOCAL_MODEL_MISSING';
      const tip = methodSel.value === 'ai'
        ? ' ' + (missing ? tr('Local model missing. Run npm run fetch:matting once.') : tr('The built-in model failed; run the fetch script or use the black background key.'))
        : '';
      setMatteStatus(`✕ ${missing ? tr('Local AI model not found.') : e.message}${tip}`, true);
    } finally {
      matteBusy = false;
      matteBtn.disabled = false;
      matteBtn.textContent = tr('Apply matting');
    }
  });

  importMatte.addEventListener('click', async () => {
    if (!matteFullPng) return;
    try {
      const n = await importPngs([{ name: `ai-matte-${Date.now()}.png`, bytes: base64Bytes(matteFullPng) }], selBone(app.sel) ?? 0, app.doc, app.images);
      app.frameRequest = true;
      app.changed?.();
      app.setStatus?.(tr(`Imported ${n} images`));
      setMatteStatus(tr(`Imported ${n} images`));
    } catch (e) {
      setMatteStatus(`✕ ${e.message}`, true);
    }
  });
  downloadMatte.addEventListener('click', () => {
    if (!matteFullPng) return;
    const a = h('a', { href: matteFullPng, download: `ai-matte-${Date.now()}.png`, rel: 'noopener' });
    document.body.append(a);
    a.click();
    a.remove();
  });

  const showPreview = async (entry) => {
    matteEntry = entry;
    matteSource = null;
    matteFullPng = null;
    matteFigure.hidden = true;
    importMatte.disabled = downloadMatte.disabled = true;
    setMatteStatus('');
    matteOriginal.src = entry.preview;
    preview.replaceChildren(
      h('div', { class: 'ai-preview-inner' },
        h('div', { class: 'ai-preview-head' }, h('h3', null, tr('Smart matting')), h('button', { onclick: () => preview.classList.remove('open') }, tr('Close preview'))),
        h('div', { class: 'ai-preview-images' },
          h('figure', { class: 'ai-preview-figure ai-checker' }, matteOriginal, h('figcaption', null, tr('Original'))),
          matteFigure,
        ),
        h('div', { class: 'ai-matte-controls' },
          h('label', { class: 'ai-matte-field' }, h('span', null, tr('Method')), methodSel),
          modelNote,
          h('label', { class: 'ai-matte-field' }, h('span', null, tr('Tolerance')), tolerance),
          h('label', { class: 'ai-matte-field' }, h('span', null, tr('Feather')), feather),
          h('label', { class: 'ai-matte-field' }, h('span', null, tr('Shrink edges')), erode),
          h('label', { class: 'ai-matte-field ai-matte-check' }, despill, tr('Remove color spill')),
          colorField,
          connectedField,
          matteBtn,
        ),
        matteStatus,
        matteActions,
        h('p', { class: 'ai-preview-prompt' }, entry.fullPrompt || entry.prompt || ''),
      ),
    );
    if (!preview.isConnected) document.body.append(preview);
    preview.classList.add('open');
    checkLocalModel().then((ok) => {
      modelNote.textContent = ok ? tr('Built-in AI model ready (MODNet, offline)') : tr('Local model missing. Run npm run fetch:matting once.');
    });
    try {
      matteSource = await canvasFromUrl(entry.preview);
    } catch (e) {
      setMatteStatus(`✕ ${e.message}`, true);
    }
  };

  /** Loads a past prompt back into the editors for a second pass. */
  const loadEntry = (entry) => {
    prompt.value = entry.prompt ?? '';
    fixed.value = entry.fixedPrompt ?? '';
    cfg.prompt = prompt.value;
    cfg.fixedPrompt = fixed.value;
    saveConfig(cfg);
    prompt.scrollIntoView({ block: 'center' });
    prompt.focus();
    setStatus(tr('Prompt loaded from history.'));
  };

  const importEntry = async (entry) => {
    try {
      const bytes = /^data:image\//i.test(entry.preview) ? base64Bytes(entry.preview) : await downloadBytes(entry.src);
      const n = await importPngs([{ name: `ai-history-${entry.id}.png`, bytes }], selBone(app.sel) ?? 0, app.doc, app.images);
      app.frameRequest = true;
      app.changed?.();
      app.setStatus?.(tr(`Imported ${n} images`));
      setStatus(tr(`Imported ${n} images`));
    } catch (e) {
      setStatus(`✕ ${e.message}`, true);
    }
  };

  const deleteEntry = (id) => {
    saveHistory(loadHistory().filter((e) => e.id !== id));
    renderHistory();
  };

  const renderHistory = () => {
    const list = loadHistory().slice().reverse();
    historyGrid.replaceChildren();
    historyEmpty.hidden = list.length > 0;
    clearHistory.disabled = list.length === 0;
    for (const e of list) {
      const card = h(
        'div',
        { class: 'ai-history-card' },
        h('button', { class: 'ai-history-thumb', title: tr('View image'), onclick: () => showPreview(e) }, h('img', { src: e.preview, alt: '' })),
        h(
          'div',
          { class: 'ai-history-meta' },
          h('span', { class: 'small weak' }, new Date(e.at).toLocaleString(), e.kind === 'matte' ? h('span', { class: 'ai-history-kind' }, tr('Matte')) : null),
          h('p', { class: 'ai-history-prompt', title: e.fullPrompt || e.prompt || '' }, e.prompt || e.fullPrompt || ''),
        ),
        h(
          'div',
          { class: 'ai-history-actions' },
          h('button', { title: tr('Load prompt'), onclick: () => loadEntry(e) }, tr('Load prompt')),
          h('button', { title: tr('Import'), onclick: () => importEntry(e) }, tr('Import')),
          h('button', { title: tr('Download'), onclick: () => {
            const a = h('a', { href: e.preview, download: `ai-history-${e.id}.webp`, rel: 'noopener' });
            document.body.append(a);
            a.click();
            a.remove();
          } }, tr('Download')),
          h('button', { class: 'ai-history-del', title: tr('Delete'), onclick: () => deleteEntry(e.id) }, '✕'),
        ),
      );
      historyGrid.append(card);
    }
  };

  // API configuration lives in Edit ▸ Preferences; the panel only points there.
  const hint = h('p', { class: 'small weak ai-prefs-hint' }, tr('API settings are in Edit ▸ Preferences ▸ AI image generation.'));
  if (opts.openPrefs) hint.append(' ', h('button', { class: 'link', onclick: () => opts.openPrefs() }, tr('Open Preferences')));

  // --- Skeleton-template driven generation --------------------------------------
  // A template supplies the bone hierarchy, slot/attachment layout and EVERY animation. We
  // generate one part per slot (each on black, matted, and scaled back to the original
  // attachment size), then re-assemble the document so all motion data is reused unchanged.
  let templateList = [];
  let assembled = null;
  let generatedParts = null;
  let activeTpl = null;
  const partAdjust = new Map();
  const templateSel = h('select', null, h('option', { value: '' }, tr('No template selected')));
  const templateInfo = h('span', { class: 'small weak' }, '');
  const styleAnchor = h('input', { type: 'text', placeholder: tr('Character design (shared by all parts)'), spellcheck: false });
  const modeSel = h('select', null,
    h('option', { value: 'skin' }, tr('Keep all geometry (lossless animation)')),
    h('option', { value: 'parts' }, tr('Maximum difference (rebuild parts)')),
  );
  const poseRef = h('input', { type: 'checkbox' });
  // Off by default: the edit endpoint runs content review on the pose wireframe, which some
  // accounts/models reject as a "sensitive image". Text-to-image is the reliable path.
  poseRef.checked = false;
  const genParts = h('button', { class: 'primary' }, tr('Generate parts from template'));
  const exportJson = h('button', { disabled: true }, tr('Export Spine JSON'));
  const exportSkel = h('button', { disabled: true }, tr('Export .skel'));
  const tplStatus = h('div', { class: 'small weak tpl-gen-status' });
  const setTplStatus = (s, err = false) => { tplStatus.textContent = s; tplStatus.classList.toggle('error', err); };
  const adjustArea = h('div', { class: 'ai-adjust' });
  const numField = (label, value, step, onInput) => h('label', { class: 'ai-adjust-field' },
    h('span', null, label),
    h('input', { type: 'number', value: String(value), step: String(step), oninput: (e) => onInput(Number(e.target.value) || 0) }));

  const applyAdjust = () => {
    if (!generatedParts || !activeTpl) return;
    const adjusted = new Map();
    for (const [name, canvas] of generatedParts) {
      const a = partAdjust.get(name) ?? { dx: 0, dy: 0, scale: 1 };
      const out = document.createElement('canvas');
      out.width = canvas.width; out.height = canvas.height;
      const ctx = out.getContext('2d');
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, a.dx, a.dy, canvas.width * a.scale, canvas.height * a.scale);
      adjusted.set(name, out);
    }
    assembled = assembleTemplate(activeTpl, adjusted, modeSel.value);
  };
  const renderAdjust = () => {
    adjustArea.replaceChildren();
    if (!generatedParts?.size) return;
    adjustArea.append(h('div', { class: 'ai-section-title' }, tr('Part alignment (manual)')));
    for (const [name, canvas] of generatedParts) {
      const a = partAdjust.get(name) ?? { dx: 0, dy: 0, scale: 1 };
      const set = (key) => (v) => {
        partAdjust.set(name, { ...(partAdjust.get(name) ?? { dx: 0, dy: 0, scale: 1 }), [key]: v });
        applyAdjust();
      };
      const thumb = h('canvas', { class: 'ai-adjust-thumb', width: 48, height: 48 });
      thumb.getContext('2d').drawImage(canvas, 0, 0, 48, 48);
      adjustArea.append(h('div', { class: 'ai-adjust-row' },
        thumb,
        h('span', { class: 'small weak' }, name),
        numField(tr('Offset X'), a.dx, 1, set('dx')),
        numField(tr('Offset Y'), a.dy, 1, set('dy')),
        numField(tr('Scale'), a.scale, 0.05, set('scale')),
        h('button', { onclick: () => { partAdjust.delete(name); applyAdjust(); renderAdjust(); } }, tr('Reset')),
      ));
    }
  };

  const updateTplInfo = () => {
    const t = templateList.find((x) => x.id === templateSel.value);
    templateInfo.textContent = t ? `${t.meta.bones} ${tr('bones')} · ${t.parts.length} ${tr('parts')} · ${t.meta.animations} ${tr('animations')}` : '';
  };
  const refreshTemplates = async () => {
    try { templateList = await listTemplates(); } catch { templateList = []; }
    const current = localStorage.getItem(TEMPLATE_KEY) || '';
    templateSel.replaceChildren(h('option', { value: '' }, tr('No template selected')), ...templateList.map((t) => h('option', { value: t.id, selected: t.id === current }, t.name)));
    updateTplInfo();
  };
  templateSel.addEventListener('change', () => {
    localStorage.setItem(TEMPLATE_KEY, templateSel.value);
    updateTplInfo();
  });

  genParts.addEventListener('click', async () => {
    if (busy) return;
    const tpl = await getTemplate(templateSel.value).catch(() => null);
    if (!tpl) return setTplStatus(tr('Select a template first.'), true);
    Object.assign(cfg, loadConfig());
    if (cfg.auth === 'bearer' && !cfg.apiKey) return setTplStatus(tr('Please set the API key.'), true);
    const style = styleAnchor.value.trim();
    // The setup-pose wireframe is sent to /v1/images/edits so the generated parts keep the
    // skeleton's proportions and orientation instead of only following a text description.
    const poseUrl = poseRef.checked ? poseReferenceUrl(tpl) : null;
    const partImages = new Map();
    let skippedShadows = 0;
    let poseFallback = false;
    busy = true;
    genParts.disabled = true;
    try {
      for (let i = 0; i < tpl.parts.length; i++) {
        const p = tpl.parts[i];
        if (p.isShadow) { skippedShadows++; continue; } // a black key would erase a dark shadow
        setTplStatus(tr(`Generating part ${i + 1} of ${tpl.parts.length}`));
        const prompt = [fixed.value.trim(), style, `单独绘制角色部位：${p.boneName} / ${p.attachmentName}，纯黑背景，居中，完整不裁切，与整体角色设定保持一致`].filter(Boolean).join('，');
        const body = requestBody(cfg, prompt);
        if (poseUrl) body.images = [{ image_url: poseUrl }];
        let json;
        try {
          json = await postJson(cfg, body, poseUrl ? cfg.editPath : cfg.path);
        } catch (err) {
          if (!poseUrl) throw err;
          // Content review (or any edit-endpoint failure) must not block generation.
          poseFallback = true;
          json = await postJson(cfg, requestBody(cfg, prompt), cfg.path);
        }
        const found = imagesFrom(json, cfg.imageField.trim());
        if (!found.length) throw new Error(tr('No image found in the response.'));
        const r = await makeResult(found[0], i);
        const src = await canvasFromUrl(r.preview);
        const matted = chromaMatte(src, { mode: 'black', tolerance: 18, feather: 8, connected: true, despill: true });
        const scaled = document.createElement('canvas');
        scaled.width = Math.max(1, Math.round(p.width));
        scaled.height = Math.max(1, Math.round(p.height));
        scaled.getContext('2d').drawImage(matted, 0, 0, scaled.width, scaled.height);
        partImages.set(p.imageName, scaled);
      }
      generatedParts = partImages;
      activeTpl = tpl;
      partAdjust.clear();
      assembled = assembleTemplate(tpl, partImages, modeSel.value);
      renderAdjust();
      exportJson.disabled = exportSkel.disabled = false;
      setTplStatus(tr(`Assembled ${assembled.report.replaced} parts with ${assembled.report.animationsKept} animations`) + ' · ' + tr('Parts generated and assembled.') + (skippedShadows ? ' · ' + tr('Shadow parts skipped (black key would erase them)') : '') + (poseFallback ? ' · ' + tr('Pose reference rejected; retried as text-to-image') : ''));
    } catch (e) {
      setTplStatus(`✕ ${e.message}`, true);
    } finally {
      busy = false;
      genParts.disabled = false;
    }
  });

  const doExport = async (format) => {
    if (!assembled) return;
    try {
      await exportAssembled(app, assembled.doc, assembled.images, format);
      setTplStatus(tr('Export result') + ' ✓');
    } catch (e) {
      setTplStatus(`✕ ${e.message}`, true);
    }
  };
  exportJson.addEventListener('click', () => doExport('json'));
  exportSkel.addEventListener('click', () => doExport('binary'));
  refreshTemplates();

  body.append(
    h(
      'div',
      { class: 'ai-form' },
      h('label', { class: 'ai-field' }, h('span', null, tr('Prompt')), prompt),
      h(
        'label',
        { class: 'ai-field' },
        h('span', null, tr('Fixed prompt'), ' ', restoreFixed),
        fixed,
        h('small', { class: 'weak' }, tr('Appended to every prompt (edit or restore the default)')),
      ),
    ),
    h(
      'div',
      { class: 'ai-controls' },
      field('Size', size),
      h('span', { class: 'small weak ai-note' }, tr('One image per request (SenseNova only supports n=1)')),
      generate,
    ),
    hint,
    h(
      'div',
      { class: 'ai-tpl-row' },
      h('div', { class: 'ai-section-title' }, tr('Skeleton template')),
      h(
        'div',
        { class: 'ai-tpl-controls' },
        h('label', { class: 'ai-field' }, h('span', null, tr('Skeleton template')), templateSel),
        h('label', { class: 'ai-field' }, h('span', null, tr('Character design (shared by all parts)')), styleAnchor),
        h('label', { class: 'ai-field' }, h('span', null, tr('Assembly mode')), modeSel),
        h('label', { class: 'ai-matte-check' }, poseRef, tr('Use skeleton pose reference')),
        h('button', { onclick: () => openTemplateLibrary(app, { onSelect: () => refreshTemplates() }) }, tr('Template library')),
        genParts,
        exportJson,
        exportSkel,
      ),
      templateInfo,
      tplStatus,
      adjustArea,
    ),
    h('div', { class: 'ai-section-title' }, tr('Results')),
    status,
    grid,
    h('div', { class: 'ai-section-title ai-history-head' }, tr('History'), clearHistory),
    historyEmpty,
    historyGrid,
    h(
      'div',
      { class: 'dialog-actions ai-actions' },
      clear,
      importAll,
      h('button', { onclick: close }, tr('Close')),
    ),
  );
  renderResults();
  renderHistory();
}
