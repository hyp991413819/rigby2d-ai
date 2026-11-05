// SPDX-License-Identifier: MIT OR Apache-2.0
// Interface translations. Text is written in English in the code and wrapped in t('…'); each
// language maps the English text to its translation (i18n/<code>.js). Missing entries show the
// English text, so a partly translated language still works. `{name}` placeholders are filled
// from t(text, { name }). No DOM here: tests run it under Node.

import ja from './i18n/ja.js';
import zh from './i18n/zh-CN.js';
import ko from './i18n/ko.js';
import es from './i18n/es.js';
import pt from './i18n/pt-BR.js';
import zhExtra from './i18n/zh-CN-extra.js';

/** [code, name in its own language]. */
export const LANGUAGES = [
  ['en', 'English'],
  ['ja', '日本語'],
  ['zh-CN', '简体中文'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['pt-BR', 'Português (Brasil)'],
];

export const TABLES = { ja, 'zh-CN': zh, ko, es, 'pt-BR': pt };

let current = 'en';
let table = null;
// Extra Simplified Chinese coverage for UI text that predates t() and is still hard-coded.
let extra = null;

/** The language matching a browser language list (navigator.languages), or English. */
export function languageFor(preferred = []) {
  for (const tag of preferred) {
    const lower = String(tag).toLowerCase();
    const exact = LANGUAGES.find(([code]) => code.toLowerCase() === lower);
    if (exact) return exact[0];
    const base = LANGUAGES.find(([code]) => code.split('-')[0] === lower.split('-')[0]);
    if (base) return base[0];
  }
  return 'en';
}

export function setLanguage(code) {
  current = TABLES[code] ? code : 'en';
  table = TABLES[current] ?? null;
  extra = current === 'zh-CN' ? zhExtra : null;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = current;
    if (extra) ensureDomTranslations();
    else if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  }
}

export function language() {
  return current;
}

/** `text` in the interface language, with `{name}` placeholders filled from `vars`. */
export function t(text, vars) {
  const s = table?.[text] ?? extra?.phrases?.[text] ?? text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

// --- DOM fallback translation -------------------------------------------------
// Older panels write English straight into the DOM instead of calling t(). When a
// translation with extra coverage is active, translate those text nodes and the
// common tooltip attributes as they appear (including content added later).

let domObserver = null;
const ATTRS = ['title', 'placeholder', 'aria-label'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

function lookup(core) {
  const dict = extra?.phrases;
  if (!dict) return null;
  const direct = table?.[core] ?? dict[core];
  if (direct != null) return direct;
  // Buttons often carry a leading icon: "✋ Pose" -> "✋ 姿势".
  const icon = /^([^\p{L}\p{N}\s]+)\s+(.+)$/u.exec(core);
  if (icon) {
    const inner = lookup(icon[2]);
    if (inner != null) return icon[1] + ' ' + inner;
  }
  // Or a trailing shortcut: "Key (K)" -> "关键帧 (K)".
  const key = /^(.+?)\s+(\([^)]*\))$/.exec(core);
  if (key) {
    const inner = lookup(key[1]);
    if (inner != null) return inner + ' ' + key[2];
  }
  return null;
}

function translated(text) {
  const core = text.trim();
  // Already translated (or user data in Chinese): leave it alone.
  if (!core || /[\u3400-\u9fff]/.test(core)) return null;
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  const found = lookup(core);
  if (found != null) return lead + found + trail;
  for (const [re, rep] of extra?.patterns ?? []) {
    if (re.test(core)) return lead + core.replace(re, rep) + trail;
  }
  return null;
}

function translateTextNode(node) {
  const out = translated(node.nodeValue ?? '');
  if (out != null && out !== node.nodeValue) node.nodeValue = out;
}

function translateAttrs(el) {
  for (const name of ATTRS) {
    const v = el.getAttribute(name);
    if (!v) continue;
    const out = translated(v);
    if (out != null && out !== v) el.setAttribute(name, out.trim());
  }
}

function translateTree(root) {
  if (root.nodeType === 3) { translateTextNode(root); return; }
  if (root.nodeType !== 1) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === 3) {
        const p = n.parentElement;
        return p && SKIP_TAGS.has(p.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) translateTextNode(n);
    else translateAttrs(n);
  }
}

function onDomChange(mutations) {
  for (const m of mutations) {
    if (m.type === 'childList') {
      for (const n of m.addedNodes) translateTree(n);
    } else if (m.type === 'characterData') {
      translateTree(m.target);
    } else if (m.type === 'attributes') {
      translateAttrs(m.target);
    }
  }
}

function ensureDomTranslations() {
  if (typeof document === 'undefined' || domObserver || !extra) return;
  translateTree(document.documentElement);
  domObserver = new MutationObserver(onDomChange);
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
}

/** Install the fallback layer explicitly (setLanguage already does this). */
export function installDomTranslations() {
  ensureDomTranslations();
}

/** Translate a plain UI string outside the DOM (canvas-drawn labels t() never sees). */
export function translateUiText(text) {
  return extra ? (translated(text) ?? text) : text;
}
