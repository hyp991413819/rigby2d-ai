// SPDX-License-Identifier: MIT OR Apache-2.0
// Re-assembly and export for template-driven regeneration. The template's skeleton, slots,
// skins, constraints, events and EVERY animation timeline are kept byte-for-byte; only the
// pixels behind each attachment are replaced by generated parts.

import { Skeleton, makeAttachment } from '../core/model.js';
import { Images } from './images.js';
import { exportSkeletonJson, exportSkeletonBinary } from './io.js';
import { templateToDoc } from './spinetemplate.js';
import * as platform from './platform.js';

export function assembleTemplate(template, partImages, mode = 'skin') {
  const doc = templateToDoc(template);
  const images = new Images();
  const missing = [];
  const replaced = new Set();

  for (const part of template.parts) {
    const canvas = partImages.get(part.imageName) ?? partImages.get(part.attachmentName);
    if (!canvas || !canvas.width || !canvas.height) {
      missing.push(part.attachmentName);
      continue;
    }
    images.insert(part.imageName, canvas);
    doc.images = (doc.images ?? []).filter((i) => i.name !== part.imageName);
    doc.images.push({ name: part.imageName, path: null, width: canvas.width, height: canvas.height });
    replaced.add(part.imageName);
    // Every attachment variant in this slot (expression swaps, alternate weapons, …) shares the
    // generated image so animation attachment keys never show an empty slot.
    for (const att of doc.slots[part.slotIndex]?.attachments ?? []) {
      if (!['region', 'mesh', 'linkedmesh'].includes(att.type)) continue;
      const key = att.image ?? att.name;
      if (key === part.imageName || images.contains(key)) continue;
      images.insert(key, canvas);
      doc.images = doc.images.filter((i) => i.name !== key);
      doc.images.push({ name: key, path: null, width: canvas.width, height: canvas.height });
    }
    if (mode === 'parts') {
      for (const slot of doc.slots) {
        for (let i = 0; i < (slot.attachments ?? []).length; i++) {
          const att = slot.attachments[i];
          if ((att.image ?? att.name) !== part.imageName && att.name !== part.attachmentName) continue;
          const fresh = makeAttachment(att.name, part.imageName, att.offset ?? { x: 0, y: 0, rotation: 0 }, canvas.width, canvas.height);
          slot.attachments[i] = fresh;
          if (slot.attachment === att.name) slot.attachment = fresh.name;
        }
      }
    }
  }

  const dropped = [];
  if (mode === 'parts') {
    for (const anim of doc.animations) {
      if (anim.deform?.length) {
        dropped.push(...anim.deform.map((d) => d.attachment ?? 'deform'));
        anim.deform = [];
      }
    }
  }
  return {
    doc,
    images,
    report: {
      mode,
      replaced: replaced.size,
      missing,
      droppedDeform: [...new Set(dropped)],
      animationsKept: doc.animations.length,
      bonesKept: doc.bones.length,
      slotsKept: doc.slots.length,
    },
  };
}

export async function exportAssembled(app, doc, images, format = 'json') {
  const binary = format === 'binary';
  const ext = binary ? 'skel' : 'json';
  const target = await app.guard(() =>
    platform.pickSaveTarget(`${doc.name || 'character'}.${ext}`, binary ? 'Binary skeleton' : 'Skeleton JSON', ext, { single: true }),
  );
  if (!target) return null;
  const result = binary
    ? await exportSkeletonBinary(target.path, target.fs, doc, images)
    : await exportSkeletonJson(target.path, target.fs, doc, images, '4.3');
  await target.fs.finish();
  return result;
}
