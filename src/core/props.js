// Property edits that respect keyframes: once a property has keyframes,
// changing it at the playhead adds or updates a keyframe there.

import { store } from './store.js';
import { setKeyframe, propAt, hasKeyframes, removeKeyframe } from './model.js';
import { rasterText, rasterShape } from '../render/text.js';
import { clamp } from './util.js';

export function localTime(it) {
  return clamp(store.playhead - it.start, 0, it.duration);
}

export function setProp(it, prop, value) {
  if (hasKeyframes(it, prop)) setKeyframe(it, prop, localTime(it), value);
  else it.props[prop] = value;
}

export function getProp(it, prop, t = store.playhead) {
  return propAt(it, prop, clamp(t, it.start, it.start + it.duration));
}

/** Toggles a keyframe for one property at the playhead. */
export function toggleKeyframe(it, prop) {
  const lt = localTime(it);
  const list = it.kf?.[prop];
  const hit = list?.find((k) => Math.abs(k.t - lt) < 1 / 60);
  if (hit) removeKeyframe(it, prop, lt);
  else setKeyframe(it, prop, lt, getProp(it, prop));
}

export function keyframeAtPlayhead(it, prop) {
  const lt = localTime(it);
  return !!it.kf?.[prop]?.some((k) => Math.abs(k.t - lt) < 1 / 60);
}

/** Size in project pixels of an item's content before scaling. */
export function contentSize(project, it) {
  const W = project.settings.width;
  const H = project.settings.height;
  if (it.type === 'clip') {
    const m = project.media[it.mediaId];
    const mw = m?.width || W;
    const mh = m?.height || H;
    if (it.fit === 'stretch') return { w: W, h: H };
    const f = it.fit === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
    return { w: mw * f, h: mh * f };
  }
  if (it.type === 'text') {
    const r = rasterText(it, store.playhead - it.start, W, 0.25);
    return { w: r.w, h: r.h };
  }
  if (it.type === 'shape') {
    const r = rasterShape(it, 0.25);
    return { w: r.w, h: r.h };
  }
  if (it.type === 'blur') return { w: it.w, h: it.h };
  return { w: W, h: H };
}

/** On-screen box of an item at the playhead, in project pixels. */
export function itemBox(project, it, t = store.playhead) {
  const W = project.settings.width;
  const H = project.settings.height;
  const { w, h } = contentSize(project, it);
  const s = getProp(it, 'scale', t);
  const sx = s * (it.props.scaleX ?? 1);
  const sy = s * (it.props.scaleY ?? 1);
  const cl = getProp(it, 'cropL', t);
  const ct = getProp(it, 'cropT', t);
  const cr = getProp(it, 'cropR', t);
  const cb = getProp(it, 'cropB', t);
  const rot = getProp(it, 'rotation', t);
  const cx0 = W / 2 + getProp(it, 'x', t);
  const cy0 = H / 2 + getProp(it, 'y', t);
  // the visible (cropped) box centre moves with the crop
  const offX = ((cl - cr) / 2) * w * sx;
  const offY = ((ct - cb) / 2) * h * sy;
  const a = (rot * Math.PI) / 180;
  return {
    cx: cx0 + offX * Math.cos(a) - offY * Math.sin(a),
    cy: cy0 + offX * Math.sin(a) + offY * Math.cos(a),
    w: w * sx * (1 - cl - cr),
    h: h * sy * (1 - ct - cb),
    fullW: w * sx,
    fullH: h * sy,
    fullCx: cx0,
    fullCy: cy0,
    rot,
    crop: { l: cl, t: ct, r: cr, b: cb },
  };
}

/** Maps a point in a clip's source frame (u, v in 0..1) to project pixels at time t. */
export function sourceToProject(project, it, u, v, t) {
  const b = itemBox(project, it, t);
  const a = (b.rot * Math.PI) / 180;
  let du = u;
  if (it.flipX) du = 1 - du;
  let dv = v;
  if (it.flipY) dv = 1 - dv;
  const lx = (du - 0.5) * b.fullW;
  const ly = (dv - 0.5) * b.fullH;
  return { x: b.fullCx + lx * Math.cos(a) - ly * Math.sin(a), y: b.fullCy + lx * Math.sin(a) + ly * Math.cos(a), scale: b.fullW };
}

/** Inverse of sourceToProject. */
export function projectToSource(project, it, x, y, t) {
  const b = itemBox(project, it, t);
  const a = (-b.rot * Math.PI) / 180;
  const dx = x - b.fullCx;
  const dy = y - b.fullCy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  let u = lx / b.fullW + 0.5;
  let v = ly / b.fullH + 0.5;
  if (it.flipX) u = 1 - u;
  if (it.flipY) v = 1 - v;
  return { u, v, pxPerU: b.fullW, pxPerV: b.fullH };
}
