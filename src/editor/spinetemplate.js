// SPDX-License-Identifier: MIT OR Apache-2.0
// Spine animation templates. A template is a FULL, LOSSLESS snapshot of a Skeleton (bones,
// slots, skins, attachments, constraints, events and every animation timeline) plus derived
// metadata: the part list with world-space bounds, the animation inventory, and a compatibility
// report. Generation re-skins this skeleton; the animation data itself is never regenerated.

import { Skeleton } from '../core/model.js';
import { Pose } from '../core/pose.js';
import { toAffine } from '../core/math.js';

const DB_NAME = 'rigby.spine-templates';
const STORE = 'templates';
export const TEMPLATE_VERSION = 1;

// ---- storage ------------------------------------------------------------------
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}
export const listTemplates = () => withStore('readonly', (s) => s.getAll());
export const getTemplate = (id) => withStore('readonly', (s) => s.get(id));
export const deleteTemplate = (id) => withStore('readwrite', (s) => s.delete(id));
export async function saveTemplate(tpl) {
  await withStore('readwrite', (s) => s.put(tpl));
  return tpl;
}

// ---- extraction ---------------------------------------------------------------
const round = (v) => Math.round(v * 100) / 100;

/** All textured attachments, with their size and setup-pose world position. */
export function partsFromDoc(doc) {
  const pose = new Pose(doc);
  const out = [];
  for (let s = 0; s < doc.slots.length; s++) {
    const slot = doc.slots[s];
    const all = (slot.attachments ?? []).filter((a) => a && ['region', 'mesh', 'linkedmesh'].includes(a.type));
    if (!all.length) continue;
    // ONE generated image per SLOT. Expression variants / attachment swaps inside a slot are
    // aliases of that image; generating each tiny variant separately destroys style consistency.
    const att = all.find((a) => a.name === slot.attachment) ?? all[0];
    const w = att.width ?? 0, h = att.height ?? 0;
    const boneIndex = slot.bone;
    let cx = 0, cy = 0;
    try {
      const world = pose.world[boneIndex];
      const off = att.offset ? toAffine(att.offset).apply([0, 0]) : [0, 0];
      [cx, cy] = world.apply(off);
    } catch { /* a broken transform should not lose the part */ }
    const name = att.image ?? att.name;
    out.push({
      slotIndex: s,
      slotName: slot.name,
      boneName: doc.bones[boneIndex]?.name ?? '',
      attachmentName: att.name,
      imageName: name,
      type: att.type,
      width: round(w),
      height: round(h),
      worldX: round(cx),
      worldY: round(cy),
      hasWeights: !!att.weights,
      variants: all.length,
      variantNames: all.map((a) => a.image ?? a.name),
      isShadow: /shadow|阴影/i.test(att.name) || /shadow|阴影/i.test(slot.name),
      small: w < 32 || h < 32,
    });
  }
  return out;
}

/** Inventory of every animation and which timeline channels it uses. */
export function animationsFromDoc(doc) {
  return doc.animations.map((a) => {
    const channels = {
      rotate: a.bones?.filter((t) => t.rotate?.length).length ?? 0,
      translate: a.bones?.filter((t) => t.translate?.length || t.translateX?.length || t.translateY?.length).length ?? 0,
      scale: a.bones?.filter((t) => t.scale?.length || t.scaleX?.length || t.scaleY?.length).length ?? 0,
      shear: a.bones?.filter((t) => t.shear?.length || t.shearX?.length || t.shearY?.length).length ?? 0,
      attachment: a.slots?.filter((t) => t.attachment?.length).length ?? 0,
      color: a.slots?.filter((t) => t.color?.length).length ?? 0,
      deform: a.deform?.length ?? 0,
      drawOrder: a.drawOrder?.length ?? 0,
      event: a.events?.length ?? 0,
      ik: a.ik?.length ?? 0,
      path: a.path?.length ?? 0,
      physics: a.physics?.length ?? 0,
    };
    let duration = 0;
    const scan = (arr, key) => {
      for (const t of arr ?? []) for (const k of t[key] ?? []) duration = Math.max(duration, k.time ?? 0);
    };
    for (const t of a.bones ?? []) for (const key of ['rotate', 'translate', 'scale', 'shear']) scan([t], key);
    for (const t of a.slots ?? []) for (const key of ['attachment', 'color']) scan([t], key);
    for (const t of a.deform ?? []) for (const k of t.keys ?? []) duration = Math.max(duration, k.time ?? 0);
    for (const k of a.drawOrder ?? []) duration = Math.max(duration, k.time ?? 0);
    for (const k of a.events ?? []) duration = Math.max(duration, k.time ?? 0);
    return { name: a.name, duration: round(duration), channels };
  });
}

/** What a regenerated skin can and cannot preserve. */
export function compatibilityFromDoc(doc) {
  const atts = [];
  for (const slot of doc.slots) for (const a of slot.attachments ?? []) atts.push(a);
  const features = {
    meshAttachments: atts.filter((a) => a.type === 'mesh' || a.type === 'linkedmesh').length,
    weightedMeshes: atts.filter((a) => a.weights).length,
    skins: doc.skins.length,
    ikConstraints: doc.ik.length,
    transformConstraints: doc.transform?.length ?? 0,
    pathConstraints: doc.path?.length ?? 0,
    physicsConstraints: doc.physics?.length ?? 0,
    events: doc.events.length,
    clips: doc.animations.length,
  };
  const notes = [];
  const shadows = doc.slots.filter((s) => (s.attachments ?? []).some((a) => /shadow|阴影/i.test(a.name ?? ''))).length;
  const small = partsFromDoc(doc).filter((p) => p.small).length;
  if (shadows) features.shadowParts = shadows;
  if (small) features.smallParts = small;
  if (features.weightedMeshes) notes.push('weighted-mesh');
  if (shadows) notes.push('shadow');
  if (small) notes.push('small');
  if (features.ikConstraints) notes.push('ik');
  if (features.pathConstraints) notes.push('path');
  if (features.physicsConstraints) notes.push('physics');
  if (features.skins) notes.push('skins');
  return { features, notes };
}

/** Builds a template from an open Skeleton document. */
export function templateFromDoc(doc, name, { source = 'current project' } = {}) {
  const obj = JSON.parse(doc.toSnapshot());
  const parts = partsFromDoc(doc);
  const animations = animationsFromDoc(doc);
  return {
    id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name || doc.name || 'Untitled template',
    createdAt: new Date().toISOString(),
    source,
    version: TEMPLATE_VERSION,
    docJson: JSON.stringify(obj),
    meta: {
      bones: doc.bones.length,
      slots: doc.slots.length,
      attachments: parts.length,
      animations: animations.length,
      skins: doc.skins.length,
      constraints: doc.ik.length + (doc.transform?.length ?? 0) + (doc.path?.length ?? 0) + (doc.physics?.length ?? 0),
      events: doc.events.length,
    },
    parts,
    animations,
    compatibility: compatibilityFromDoc(doc),
  };
}

/** Restores the exact skeleton the template was made from. */
export function templateToDoc(template) {
  return Skeleton.fromObject(JSON.parse(template.docJson));
}
