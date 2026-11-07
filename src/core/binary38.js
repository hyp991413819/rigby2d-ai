// SPDX-License-Identifier: MIT OR Apache-2.0
// Reads a Spine 3.8 BINARY skeleton (.skel) and returns the equivalent 3.8 JSON object, ready
// for interop.readSkeletonJson. Layout follows the official spine-runtimes 3.8 SkeletonBinary.
// 4.3 binaries are handled by binary.js; this module exists for older exports that cannot be
// re-exported from the Spine editor.

const INHERIT = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const BLEND = ['normal', 'additive', 'multiply', 'screen'];
const ATTACHMENT_TYPE = ['region', 'boundingbox', 'mesh', 'linkedmesh', 'path', 'point', 'clipping'];
const BONE_TIMELINE = ['rotate', 'translate', 'scale', 'shear'];
const SLOT_TIMELINE = ['attachment', 'color', 'twoColor'];
const CONSTRAINT_IK = 0, CONSTRAINT_TRANSFORM = 1, CONSTRAINT_PATH = 2;

class Reader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
    this.strings = [];
  }
  byte() { return this.view.getInt8(this.p++); }
  ubyte() { return this.view.getUint8(this.p++); }
  short() { const v = this.view.getInt16(this.p); this.p += 2; return v; }
  int32() { const v = this.view.getInt32(this.p); this.p += 4; return v; }
  float() { const v = this.view.getFloat32(this.p); this.p += 4; return v; }
  bool() { return this.byte() !== 0; }
  varint(positive = true) {
    let b = this.byte(), result = b & 0x7f;
    if (b & 0x80) { b = this.byte(); result |= (b & 0x7f) << 7;
      if (b & 0x80) { b = this.byte(); result |= (b & 0x7f) << 14;
        if (b & 0x80) { b = this.byte(); result |= (b & 0x7f) << 21;
          if (b & 0x80) { b = this.byte(); result |= (b & 0x7f) << 28; } } } }
    return positive ? result : ((result >>> 1) ^ -(result & 1));
  }
  string() {
    const n = this.varint();
    if (n === 0) return null;
    if (n === 1) return '';
    const bytes = new Uint8Array(n - 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = this.ubyte();
    return new TextDecoder().decode(bytes);
  }
  stringRef() { const i = this.varint(); return i === 0 ? null : this.strings[i - 1]; }
  color(hex = true, dark = false) {
    const v = this.int32();
    if (!hex) return v;
    if (dark) return (v & 0xffffff).toString(16).padStart(6, '0');
    return (v >>> 0).toString(16).padStart(8, '0');
  }
  floatArray(n) { const a = []; for (let i = 0; i < n; i++) a.push(this.float()); return a; }
  shortArray() { const n = this.varint(), a = []; for (let i = 0; i < n; i++) a.push(this.short()); return a; }
  vertices(count) {
    if (!this.bool()) return this.floatArray(count << 1);
    const out = [];
    for (let i = 0; i < count; i++) {
      const bones = this.varint();
      out.push(bones);
      for (let j = 0; j < bones; j++) {
        out.push(this.varint(), this.float(), this.float(), this.float());
      }
    }
    return out;
  }
  curve() {
    const type = this.byte();
    if (type === 1) return 'stepped';
    if (type === 2) return [this.float(), this.float(), this.float(), this.float()];
    return undefined;
  }
}

function readAttachment(r, nonessential, fallbackName) {
  const name = r.stringRef() ?? fallbackName;
  const type = ATTACHMENT_TYPE[r.byte()] ?? 'region';
  const att = {};
  if (type !== 'region') att.type = type;
  switch (type) {
    case 'region': {
      const path = r.stringRef();
      if (path !== null && path !== name) att.path = path;
      const rotation = r.float(), x = r.float(), y = r.float(), sx = r.float(), sy = r.float();
      const w = r.float(), h = r.float(), color = r.color();
      if (rotation) att.rotation = rotation;
      if (x) att.x = x;
      if (y) att.y = y;
      if (sx !== 1) att.scaleX = sx;
      if (sy !== 1) att.scaleY = sy;
      att.width = w; att.height = h;
      if (color !== 'ffffffff') att.color = color;
      break;
    }
    case 'boundingbox': {
      const count = r.varint();
      att.vertexCount = count;
      att.vertices = r.vertices(count);
      if (nonessential) att.color = r.color();
      break;
    }
    case 'mesh': {
      const path = r.stringRef();
      if (path !== null && path !== name) att.path = path;
      const color = r.color();
      if (color !== 'ffffffff') att.color = color;
      const count = r.varint();
      att.uvs = r.floatArray(count << 1);
      att.triangles = r.shortArray();
      att.vertices = r.vertices(count);
      att.hull = r.varint();
      if (nonessential) { att.edges = r.shortArray(); att.width = r.float(); att.height = r.float(); }
      break;
    }
    case 'linkedmesh': {
      const path = r.stringRef();
      if (path !== null && path !== name) att.path = path;
      const color = r.color();
      if (color !== 'ffffffff') att.color = color;
      att.skin = r.stringRef();
      att.parent = r.stringRef();
      att.inheritDeform = r.bool();
      if (nonessential) { att.width = r.float(); att.height = r.float(); }
      break;
    }
    case 'path': {
      att.closed = r.bool();
      att.constantSpeed = r.bool();
      const count = r.varint();
      att.vertexCount = count;
      att.vertices = r.vertices(count);
      att.lengths = r.floatArray(count / 3);
      if (nonessential) att.color = r.color();
      break;
    }
    case 'point': {
      const rotation = r.float(), x = r.float(), y = r.float();
      if (rotation) att.rotation = rotation;
      if (x) att.x = x;
      if (y) att.y = y;
      if (nonessential) att.color = r.color();
      break;
    }
    case 'clipping': {
      att.end = r.varint();
      const count = r.varint();
      att.vertexCount = count;
      att.vertices = r.vertices(count);
      if (nonessential) att.color = r.color();
      break;
    }
  }
  return { name, att };
}

function readSkin(r, bones, slots, ikNames, defaultSkin, nonessential) {
  const skin = { attachments: {} };
  let slotCount;
  if (defaultSkin) {
    slotCount = r.varint();
    skin.name = 'default';
  } else {
    skin.name = r.stringRef() ?? 'skin';
    skin.bones = [];
    for (let i = 0, n = r.varint(); i < n; i++) skin.bones.push(bones[r.varint()].name);
    skin.ik = [];
    for (let i = 0, n = r.varint(); i < n; i++) skin.ik.push(ikNames[r.varint()]);
    for (const key of ['transform', 'path']) {
      skin[key] = [];
      for (let i = 0, n = r.varint(); i < n; i++) skin[key].push(r.varint());
    }
    slotCount = r.varint();
  }
  for (let i = 0; i < slotCount; i++) {
    const slotIndex = r.varint();
    if (!slots[slotIndex]) throw new Error(`[38] bad slot index ${slotIndex} at p=${r.p}, slotCount=${slotCount}, slots=${slots.length}`);
    const slotName = slots[slotIndex].name;
    const atts = skin.attachments[slotName] ?? (skin.attachments[slotName] = {});
    for (let j = 0, n = r.varint(); j < n; j++) {
      const outerName = r.stringRef(); // skin's attachment key (official reads this twice)
      const { name, att } = readAttachment(r, nonessential, outerName);
      atts[name ?? outerName ?? 'unnamed'] = att;
    }
  }
  return skin;
}

function readTimelineKeys(r, count, valueFn, withCurve = true) {
  const keys = [];
  for (let i = 0; i < count; i++) {
    const time = r.float();
    const k = { time, ...valueFn() };
    if (withCurve && i < count - 1) {
      const c = r.curve();
      if (c !== undefined) k.curve = c;
    }
    keys.push(k);
  }
  return keys;
}

function readAnimation(r, name, bones, slots, ikNames, transformNames, pathNames, eventList, skinNames) {
  const anim = { bones: {}, slots: {}, deform: {}, ik: {}, transform: {}, path: {} };
  // Slot timelines.
  for (let i = 0, n = r.varint(); i < n; i++) {
    const slotName = slots[r.varint()].name;
    const target = anim.slots[slotName] ?? (anim.slots[slotName] = {});
    for (let j = 0, m = r.varint(); j < m; j++) {
      const type = SLOT_TIMELINE[r.byte()] ?? 'attachment';
      const count = r.varint();
      if (type === 'attachment') {
        target.attachment = [];
        for (let k = 0; k < count; k++) target.attachment.push({ time: r.float(), name: r.stringRef() });
      } else if (type === 'color') {
        target.color = readTimelineKeys(r, count, () => ({ color: r.color() }));
      } else {
        target.twoColor = readTimelineKeys(r, count, () => ({ light: r.color(), dark: r.color(false, true) }));
      }
    }
  }
  // Bone timelines.
  for (let i = 0, n = r.varint(); i < n; i++) {
    const boneName = bones[r.varint()].name;
    const target = anim.bones[boneName] ?? (anim.bones[boneName] = {});
    for (let j = 0, m = r.varint(); j < m; j++) {
      const kind = BONE_TIMELINE[r.byte()] ?? 'rotate';
      const count = r.varint();
      if (kind === 'rotate') target.rotate = readTimelineKeys(r, count, () => ({ angle: r.float() }));
      else target[kind] = readTimelineKeys(r, count, () => ({ x: r.float(), y: r.float() }));
    }
  }
  // IK constraint timelines.
  for (let i = 0, n = r.varint(); i < n; i++) {
    const ikName = ikNames[r.varint()] ?? ('ik' + i);
    const count = r.varint();
    anim.ik[ikName] = readTimelineKeys(r, count, () => ({
      mix: r.float(), softness: r.float(), bendPositive: r.byte() > 0, compress: r.bool(), stretch: r.bool(),
    }));
  }
  // Transform constraint timelines.
  for (let i = 0, n = r.varint(); i < n; i++) {
    const cname = transformNames[r.varint()] ?? ('transform' + i);
    const count = r.varint();
    anim.transform[cname] = readTimelineKeys(r, count, () => ({ rotateMix: r.float(), translateMix: r.float(), scaleMix: r.float(), shearMix: r.float() }));
  }
  // Path constraint timelines.
  for (let i = 0, n = r.varint(); i < n; i++) {
    const cname = pathNames[r.varint()] ?? ('path' + i);
    for (let j = 0, m = r.varint(); j < m; j++) {
      const kind = ['position', 'spacing', 'mix'][r.byte()] ?? 'position';
      const count = r.varint();
      anim.path[cname] ??= {};
      anim.path[cname][kind] = readTimelineKeys(r, count, kind === 'mix' ? () => ({ rotateMix: r.float(), translateMix: r.float() }) : () => ({ value: r.float() }));
    }
  }
  // Deform timelines.
  for (let i = 0, n = r.varint(); i < n; i++) {
    const skinName = skinNames[r.varint()] ?? 'default';
    const skin = anim.deform[skinName] ?? (anim.deform[skinName] = {});
    for (let j = 0, m = r.varint(); j < m; j++) {
      const slotName = slots[r.varint()].name;
      const slotMap = skin[slotName] ?? (skin[slotName] = {});
      for (let k = 0, q = r.varint(); k < q; k++) {
        const attName = r.stringRef() ?? 'unnamed';
        const count = r.varint();
        const keys = [];
        for (let f = 0; f < count; f++) {
          const time = r.float();
          const end = r.varint();
          let offset = 0, vertices = [];
          if (end !== 0) {
            const start = r.varint();
            offset = start;
            const len = end;
            vertices = r.floatArray(len);
          }
          const key = { time, offset, vertices };
          if (f < count - 1) { const c = r.curve(); if (c !== undefined) key.curve = c; }
          keys.push(key);
        }
        slotMap[attName] = keys;
      }
    }
  }
  // Draw order.
  const drawOrderCount = r.varint();
  if (drawOrderCount > 0) {
    anim.drawOrder = [];
    for (let i = 0; i < drawOrderCount; i++) {
      const time = r.float();
      const offsets = [];
      for (let j = 0, m = r.varint(); j < m; j++) {
        const slotIndex = r.varint();
        const amount = r.varint();
        offsets.push({ slot: slots[slotIndex]?.name ?? ('slot' + slotIndex), offset: amount });
      }
      anim.drawOrder.push({ time, offsets });
    }
  }
  // Events.
  const eventCount = r.varint();
  if (eventCount > 0) {
    anim.events = [];
    for (let i = 0; i < eventCount; i++) {
      const time = r.float();
      const e = { time, name: eventList[r.varint()]?.name ?? 'event', int: r.varint(false), float: r.float() };
      if (r.bool()) e.string = r.string();
      const ev = eventList.find((x) => x.name === e.name);
      if (ev?.audio != null) { e.volume = r.float(); e.balance = r.float(); }
      anim.events.push(e);
    }
  }
  for (const key of ['bones', 'slots', 'deform', 'ik', 'transform', 'path']) {
    if (Object.keys(anim[key]).length === 0) delete anim[key];
  }
  return anim;
}

/** Converts Spine 3.8 binary bytes into the 3.8 JSON object accepted by readSkeletonJson. */
export function readSkeletonBinary38(bytes) {
  const r = new Reader(bytes);
  const hash = r.string();
  const version = r.string();
  if (!/^3\.8/.test(version ?? '')) throw new Error(`Not a Spine 3.8 binary skeleton (${version ?? 'unknown version'})`);
  const x = r.float(), y = r.float(), width = r.float(), height = r.float();
  const nonessential = r.bool();
  const skeleton = { hash: hash ?? '', spine: version, x, y, width, height };
  if (nonessential) {
    skeleton.fps = r.float();
    skeleton.images = r.string() ?? '';
    skeleton.audio = r.string() ?? '';
  }
  for (let i = 0, n = r.varint(); i < n; i++) r.strings.push(r.string());

  const bones = [];
  for (let i = 0, n = r.varint(); i < n; i++) {
    const b = { name: r.string() };
    if (i > 0) b.parent = bones[r.varint()].name;
    const rotation = r.float(), bx = r.float(), by = r.float(), sx = r.float(), sy = r.float(), shx = r.float(), shy = r.float(), len = r.float();
    const inherit = INHERIT[r.varint()] ?? 'normal';
    const skin = r.bool();
    if (nonessential) b.color = r.color();
    if (bx || by || rotation) { b.x = bx; b.y = by; b.rotation = rotation; }
    if (sx !== 1) b.scaleX = sx;
    if (sy !== 1) b.scaleY = sy;
    if (shx) b.shearX = shx;
    if (shy) b.shearY = shy;
    if (len) b.length = len;
    if (inherit !== 'normal') b.inherit = inherit;
    if (skin) b.skin = true;
    bones.push(b);
  }

  const slots = [];
  for (let i = 0, n = r.varint(); i < n; i++) {
    const s = { name: r.string(), bone: bones[r.varint()].name, color: r.color() };
    const dark = r.int32();
    if (dark !== -1) s.dark = (dark & 0xffffff).toString(16).padStart(6, '0');
    const attachment = r.stringRef();
    if (attachment !== null) s.attachment = attachment;
    const blend = BLEND[r.varint()] ?? 'normal';
    if (blend !== 'normal') s.blend = blend;
    slots.push(s);
  }

  const ik = [];
  const ikNames = [];
  for (let i = 0, n = r.varint(); i < n; i++) {
    const c = { name: r.string(), order: r.varint(), skin: r.bool(), bones: [] };
    for (let j = 0, m = r.varint(); j < m; j++) c.bones.push(bones[r.varint()].name);
    c.target = bones[r.varint()].name;
    c.mix = r.float(); c.softness = r.float(); c.bendPositive = r.byte() > 0;
    c.compress = r.bool(); c.stretch = r.bool(); c.uniform = r.bool();
    ik.push(c); ikNames.push(c.name);
  }
  const transform = [], transformNames = [];
  for (let i = 0, n = r.varint(); i < n; i++) {
    const c = { name: r.string(), order: r.varint(), skin: r.bool(), bones: [] };
    for (let j = 0, m = r.varint(); j < m; j++) c.bones.push(bones[r.varint()].name);
    c.target = bones[r.varint()].name;
    c.local = r.bool(); c.relative = r.bool();
    c.rotation = r.float(); c.x = r.float(); c.y = r.float(); c.scaleX = r.float(); c.scaleY = r.float(); c.shearY = r.float();
    c.rotateMix = r.float(); c.translateMix = r.float(); c.scaleMix = r.float(); c.shearMix = r.float();
    transform.push(c); transformNames.push(c.name);
  }
  const path = [], pathNames = [];
  for (let i = 0, n = r.varint(); i < n; i++) {
    const c = { name: r.string(), order: r.varint(), skin: r.bool(), bones: [] };
    for (let j = 0, m = r.varint(); j < m; j++) c.bones.push(bones[r.varint()].name);
    c.target = slots[r.varint()].name;
    c.positionMode = ['fixed', 'percent'][r.varint()] ?? 'percent';
    c.spacingMode = ['length', 'fixed', 'percent', 'proportional'][r.varint()] ?? 'length';
    c.rotateMode = ['tangent', 'chain', 'chainScale'][r.varint()] ?? 'tangent';
    c.rotation = r.float(); c.position = r.float(); c.spacing = r.float();
    c.rotateMix = r.float(); c.translateMix = r.float();
    path.push(c); pathNames.push(c.name);
  }

  const skins = {};
  const defaultSkin = readSkin(r, bones, slots, ikNames, true, nonessential);
  skins.default = defaultSkin.attachments;
  for (let i = 0, n = r.varint(); i < n; i++) {
    const sk = readSkin(r, bones, slots, ikNames, false, nonessential);
    const entry = { ...sk.attachments };
    if (sk.bones?.length) entry.bones = sk.bones;
    if (sk.ik?.length) entry.ik = sk.ik;
    skins[sk.name] = entry;
  }

  const events = {};
  const eventList = [];
  for (let i = 0, n = r.varint(); i < n; i++) {
    const name = r.stringRef() ?? ('event' + i);
    const e = { name, int: r.varint(false), float: r.float(), string: r.string(), audio: r.string() };
    if (e.audio !== null) { e.volume = r.float(); e.balance = r.float(); }
    const { name: _, ...rest } = e;
    events[name] = rest;
    eventList.push(e);
  }

  const skinNames = Object.keys(skins);
  const animations = {};
  for (let i = 0, n = r.varint(); i < n; i++) {
    const name = r.string() ?? ('animation' + i);
    animations[name] = readAnimation(r, name, bones, slots, ikNames, transformNames, pathNames, eventList, skinNames);
  }

  const out = { skeleton, bones, slots, skins, events, animations };
  if (ik.length) out.ik = ik;
  if (transform.length) out.transform = transform;
  if (path.length) out.path = path;
  return out;
}
