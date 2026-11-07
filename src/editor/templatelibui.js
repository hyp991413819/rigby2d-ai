// SPDX-License-Identifier: MIT OR Apache-2.0
// Template library: browse Spine animation templates, inspect the skeleton and every animation,
// and pick one to drive skeleton-conditioned image generation.

import { dialog } from './helpui.js';
import { h } from './widgets.js';
import { translateUiText as tr } from './i18n.js';
import { Pose } from '../core/pose.js';
import { listTemplates, saveTemplate, deleteTemplate, templateFromDoc, templateToDoc } from './spinetemplate.js';
import { isSkeletonJson, readSkeletonJson } from '../core/interop.js';
import { readSkeletonBinary } from '../core/binary.js';
import { readSkeletonBinary38 } from '../core/binary38.js';
import * as platform from './platform.js';

export const TEMPLATE_KEY = 'rigby.ai-image.templateId';

export function drawSkeleton(canvas, doc, parts, w, h) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = w ?? canvas.clientWidth ?? 520;
  const H = canvas.height = h ?? 340;
  ctx.clearRect(0, 0, W, H);
  const pose = new Pose(doc);
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x, y) => {
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
  };
  const bones = doc.bones.map((b, i) => {
    const m = pose.world[i];
    const a = m.apply([0, 0]), z = m.apply([b.length || 12, 0]);
    add(a[0], a[1]); add(z[0], z[1]);
    return { a, z };
  });
  for (const p of parts) {
    add(p.worldX - p.width / 2, p.worldY - p.height / 2);
    add(p.worldX + p.width / 2, p.worldY + p.height / 2);
  }
  const spanX = Math.max(1, box.maxX - box.minX), spanY = Math.max(1, box.maxY - box.minY);
  const scale = Math.min((W - 40) / spanX, (H - 40) / spanY);
  const ox = (W - spanX * scale) / 2 - box.minX * scale;
  const oy = (H - spanY * scale) / 2 - box.minY * scale;
  const X = (x) => x * scale + ox, Y = (y) => H - (y * scale + oy);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (const p of parts) ctx.strokeRect(X(p.worldX - p.width / 2), Y(p.worldY + p.height / 2), p.width * scale, p.height * scale);
  ctx.strokeStyle = '#7ba7c7';
  ctx.lineWidth = 2;
  for (const b of bones) {
    ctx.beginPath(); ctx.moveTo(X(b.a[0]), Y(b.a[1])); ctx.lineTo(X(b.z[0]), Y(b.z[1])); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(b.a[0]), Y(b.a[1]), 3, 0, Math.PI * 2); ctx.fillStyle = '#e8b04a'; ctx.fill();
  }
}

/** A clean pose/part wireframe used as a structural reference for image editing. */
export function poseReferenceUrl(template, size = 768) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f4f2';
  ctx.fillRect(0, 0, size, size);
  drawSkeleton(canvas, templateToDoc(template), template.parts, size, size);
  // Recolour for a light, high-contrast line drawing the model can read as structure.
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  return canvas.toDataURL('image/png');
}

export function openTemplateLibrary(app, opts = {}) {
  const { body, close } = dialog('template-library ai-ui', tr('Spine animation templates'), tr('Reuse the skeleton and every animation with a completely new look.'), { dismissible: false });
  body.closest('.modal-backdrop')?.classList.add('ai-image-backdrop');
  let templates = [];
  let selected = null;

  const list = h('div', { class: 'tpl-list' });
  const detail = h('div', { class: 'tpl-detail' });
  const status = h('div', { class: 'small weak tpl-status' });
  const setStatus = (s, err = false) => { status.textContent = s; status.classList.toggle('error', err); };

  const renderList = () => {
    list.replaceChildren();
    if (!templates.length) {
      list.append(h('p', { class: 'small weak' }, tr('No templates yet. Create one from an open Spine project or a JSON file.')));
      return;
    }
    for (const t of templates.slice().reverse()) {
      list.append(h('button', { class: 'tpl-item' + (selected?.id === t.id ? ' active' : ''), onclick: () => { selected = t; renderList(); renderDetail(); } },
        h('strong', null, t.name),
        h('span', { class: 'small weak' }, `${t.meta.bones} ${tr('bones')} · ${t.meta.animations} ${tr('animations')} · ${t.meta.attachments} ${tr('parts')}`),
      ));
    }
  };

  const renderDetail = () => {
    detail.replaceChildren();
    if (!selected) {
      detail.append(h('p', { class: 'small weak' }, tr('Select a template to inspect its skeleton and animations.')));
      return;
    }
    const t = selected;
    const canvas = h('canvas', { class: 'tpl-skeleton' });
    const animRows = t.animations.map((a) => {
      const ch = Object.entries(a.channels).filter(([, n]) => n > 0).map(([k]) => k).join(', ') || '-';
      return h('tr', null, h('td', null, a.name), h('td', null, a.duration + ' s'), h('td', { class: 'small weak' }, ch));
    });
    const partRows = t.parts.map((p) => h('tr', null,
      h('td', null, p.attachmentName), h('td', null, p.boneName), h('td', null, `${p.width}×${p.height}`), h('td', null, p.hasWeights ? tr('weighted') : p.type)));
    const notes = t.compatibility.notes.length
      ? t.compatibility.notes.map((n) => tr('compat-' + n)).join('、')
      : tr('No special constraints: all animation data can be reused as-is.');
    detail.append(
      h('div', { class: 'tpl-summary' },
        `${t.meta.bones} ${tr('bones')} · ${t.meta.slots} ${tr('slots')} · ${t.meta.attachments} ${tr('parts')} · ${t.meta.animations} ${tr('animations')} · ${t.meta.constraints} ${tr('constraints')} · ${t.meta.skins} ${tr('skins')} · ${t.meta.events} ${tr('events')}`),
      h('div', { class: 'tpl-section-title' }, tr('Skeleton (setup pose)')),
      canvas,
      h('div', { class: 'tpl-section-title' }, tr('Animations (all channels kept)')),
      h('table', { class: 'tpl-table' }, h('thead', null, h('tr', null, h('th', null, tr('Name')), h('th', null, tr('Duration')), h('th', null, tr('Channels')))), h('tbody', null, ...animRows)),
      h('div', { class: 'tpl-section-title' }, tr('Parts to regenerate')),
      h('table', { class: 'tpl-table' }, h('thead', null, h('tr', null, h('th', null, tr('Attachment')), h('th', null, tr('Bone')), h('th', null, tr('Size')), h('th', null, tr('Type')))), h('tbody', null, ...partRows)),
      h('div', { class: 'tpl-section-title' }, tr('Compatibility')),
      h('p', { class: 'small weak' }, notes),
      h('div', { class: 'tpl-actions' },
        h('button', { class: 'primary', onclick: () => {
          localStorage.setItem(TEMPLATE_KEY, t.id);
          setStatus(tr('Template selected for image generation.'));
          opts.onSelect?.(t);
        } }, tr('Use for generation')),
        h('button', { onclick: async () => { await deleteTemplate(t.id); templates = templates.filter((x) => x.id !== t.id); selected = null; renderList(); renderDetail(); setStatus(tr('Template deleted.')); } }, tr('Delete template')),
      ),
    );
    try { drawSkeleton(canvas, templateToDoc(t), t.parts); } catch { /* preview is best-effort */ }
  };

  const refresh = async () => {
    try { templates = await listTemplates(); } catch (e) { setStatus('✕ ' + e.message, true); templates = []; }
    if (selected) selected = templates.find((t) => t.id === selected.id) ?? null;
    if (!selected && templates.length) {
      const wanted = localStorage.getItem(TEMPLATE_KEY);
      selected = templates.find((t) => t.id === wanted) ?? templates[templates.length - 1];
    }
    renderList(); renderDetail();
  };

  const createFromProject = async () => {
    if (!app.doc || (app.doc.bones.length <= 1 && !app.doc.slots.length)) return setStatus(tr('Open a Spine project first, then create a template from it.'), true);
    const name = app.doc.name && app.doc.name !== 'untitled' ? app.doc.name : tr('Untitled template');
    await saveTemplate(templateFromDoc(app.doc, name, { source: 'current project' }));
    await refresh();
    setStatus(tr('Template created from the open project.'));
  };

  const importSpine = async () => {
    const files = await platform.pickImportFiles('Spine skeleton', ['json', 'skel'], false);
    if (!files?.length) return;
    try {
      const file = files[0];
      let obj;
      if (/\.skel$/i.test(file.name)) {
        // 4.3 and 3.8 binaries have different layouts; try both.
        try { obj = readSkeletonBinary(file.bytes); }
        catch { obj = readSkeletonBinary38(file.bytes); }
      } else {
        obj = JSON.parse(new TextDecoder().decode(file.bytes));
      }
      if (!isSkeletonJson(obj)) throw new Error(tr('Not a Spine skeleton JSON file.'));
      const parsed = readSkeletonJson(obj, file.name);
      await saveTemplate(templateFromDoc(parsed.skeleton, file.name.replace(/\.(json|skel)$/i, ''), { source: file.name }));
      await refresh();
      setStatus(tr('Template imported.') + (parsed.warnings?.length ? ' (' + parsed.warnings.length + ' warnings)' : ''));
    } catch (e) {
      setStatus('✕ ' + (tr('Unsupported Spine binary. Import a 3.8/4.3 .skel or a JSON export.') + ' ' + e.message), true);
    }
  };

  body.append(
    h('div', { class: 'tpl-layout' },
      h('div', { class: 'tpl-side' },
        h('div', { class: 'tpl-buttons' },
          h('button', { onclick: createFromProject }, tr('From open project')),
          h('button', { onclick: importSpine }, tr('Import Spine JSON / .skel')),
        ),
        list,
      ),
      detail,
    ),
    status,
  );
  refresh();
  return { close };
}
