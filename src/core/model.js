// Project data model: factories, time mapping between the timeline and the
// source media, and keyframe evaluation.

import { uid, clamp, lerp, clone } from './util.js';

export const PROJECT_VERSION = 1;

export const CANVAS_PRESETS = [
  { id: 'reels', name: 'Reels / TikTok / Stories 9:16', width: 1080, height: 1920 },
  { id: 'feed45', name: 'Instagram / Facebook feed 4:5', width: 1080, height: 1350 },
  { id: 'square', name: 'Square 1:1', width: 1080, height: 1080 },
  { id: 'yt1080', name: 'YouTube 16:9, 1080p', width: 1920, height: 1080 },
  { id: 'yt4k', name: 'YouTube 16:9, 4K', width: 3840, height: 2160 },
  { id: 'cinema', name: 'Cinematic 2.39:1', width: 1920, height: 804 },
];

export function newProject({ name = 'Untitled project', width = 1080, height = 1920, fps = 30, audioOnly = false } = {}) {
  const v1 = newTrack('video', 'Video 1');
  const a1 = newTrack('audio', 'Audio 1');
  const tracks = [v1, a1];
  if (audioOnly) {
    // an audio project keeps an empty video track so every tool finds one; the timeline hides it
    a1.height = 110;
    const a2 = newTrack('audio', 'Audio 2');
    a2.height = 80;
    tracks.push(a2);
  }
  return {
    version: PROJECT_VERSION,
    id: uid('p'),
    name,
    settings: { width: audioOnly ? 1920 : width, height: audioOnly ? 1080 : height, fps, background: '#000000', sampleRate: 48000, ...(audioOnly ? { audioOnly: true } : {}) },
    media: {},
    tracks,
    items: {},
    markers: [],
    captionStyle: defaultCaptionStyle(),
    created: Date.now(),
    modified: Date.now(),
  };
}

export function newTrack(kind, name) {
  return { id: uid('t'), kind, name, muted: false, hidden: false, locked: false, height: kind === 'audio' ? 56 : 64 };
}

export function baseProps() {
  return {
    x: 0,
    y: 0,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    cropL: 0,
    cropT: 0,
    cropR: 0,
    cropB: 0,
    volume: 1,
    blur: 0,
    maskPos: 0.5,
    maskDX: 0,
    maskDY: 0,
  };
}

export function defaultColor() {
  return {
    exposure: 0,
    contrast: 0,
    saturation: 0,
    vibrance: 0,
    temperature: 0,
    tint: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    fade: 0,
    vignette: 0,
    sharpen: 0,
    grain: 0,
    hue: 0,
    lut: null,
    lutName: null,
    lutIntensity: 1,
    curves: null,
    filter: null,
    filterIntensity: 1,
  };
}

export function defaultEffects() {
  return {
    chroma: { enabled: false, color: '#00ff00', similarity: 0.35, smoothness: 0.08, spill: 0.3 },
    glow: 0,
    chromatic: 0,
    mirror: false,
    letterbox: 0,
    pixelate: 0,
  };
}

export function defaultMask() {
  return { type: 'none', x: 0.5, y: 0.5, w: 0.6, h: 0.6, radius: 0, angle: 0, feather: 0.02, invert: false, line: true, lineColor: '#ffffff', lineWidth: 4 };
}

function common(type, trackId, start, duration) {
  return {
    id: uid('c'),
    type,
    trackId,
    start,
    duration,
    name: '',
    props: baseProps(),
    kf: {},
    color: defaultColor(),
    effects: defaultEffects(),
    mask: defaultMask(),
    blend: 'normal',
    anim: { in: null, out: null, loop: null },
    transitionIn: null,
  };
}

export function newClip(media, trackId, start, { inPoint = 0, duration } = {}) {
  const dur = duration ?? (media.kind === 'image' ? 5 : Math.max(0.1, (media.duration || 5) - inPoint));
  const it = common('clip', trackId, start, dur);
  Object.assign(it, {
    mediaId: media.id,
    name: media.name,
    in: inPoint,
    speed: 1,
    speedCurve: null,
    freeze: false,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    duck: false,
    fit: 'contain',
    origMediaId: null,
    derivations: [],
  });
  return it;
}

export function newText(trackId, start, text = 'Your text', style = {}) {
  const it = common('text', trackId, start, 4);
  Object.assign(it, {
    name: 'Text',
    text,
    style: { ...defaultTextStyle(), ...style },
    reveal: 'none',
    caption: false,
    words: null,
  });
  return it;
}

export function defaultTextStyle() {
  return {
    font: 'Montserrat',
    size: 96,
    weight: 800,
    italic: false,
    color: '#ffffff',
    align: 'center',
    lineHeight: 1.15,
    letterSpacing: 0,
    uppercase: false,
    maxWidth: 0.86,
    outlineWidth: 0,
    outlineColor: '#000000',
    shadowBlur: 12,
    shadowX: 0,
    shadowY: 4,
    shadowColor: 'rgba(0,0,0,0.55)',
    boxEnabled: false,
    boxColor: 'rgba(0,0,0,0.6)',
    boxPadding: 24,
    boxRadius: 16,
    highlightColor: '#f5c542',
    highlightMode: 'color',
  };
}

export function defaultCaptionStyle() {
  return {
    preset: 'bold-highlight',
    font: 'Montserrat',
    size: 72,
    weight: 800,
    color: '#ffffff',
    uppercase: false,
    outlineWidth: 6,
    outlineColor: '#000000',
    shadowBlur: 8,
    shadowColor: 'rgba(0,0,0,0.6)',
    boxEnabled: false,
    boxColor: 'rgba(0,0,0,0.65)',
    highlightColor: '#f5c542',
    highlightMode: 'color',
    reveal: 'karaoke',
    y: 0.72,
    maxWords: 4,
    maxChars: 26,
  };
}

export function newShape(trackId, start, shape = 'rect', opts = {}) {
  const it = common('shape', trackId, start, 4);
  Object.assign(it, {
    name: shapeName(shape),
    shape,
    w: 400,
    h: shape === 'line' || shape === 'arrow' ? 24 : 260,
    fill: shape === 'line' || shape === 'arrow' ? '#ffffff' : 'rgba(255,255,255,0.0)',
    stroke: '#ffffff',
    strokeWidth: 10,
    radius: 24,
    ...opts,
  });
  return it;
}

function shapeName(s) {
  return { rect: 'Box', ellipse: 'Circle', arrow: 'Arrow', line: 'Line', callout: 'Label' }[s] || 'Shape';
}

export function newBlurRegion(trackId, start, duration, { x = 0, y = 0, w = 360, h = 360 } = {}) {
  const it = common('blur', trackId, start, duration);
  Object.assign(it, {
    name: 'Blur',
    mode: 'blur',
    shape: 'ellipse',
    amount: 0.6,
    feather: 0.25,
    fillColor: '#000000',
  });
  Object.assign(it.props, { x, y });
  it.w = w;
  it.h = h;
  return it;
}

export function newAdjustment(trackId, start, duration = 5) {
  const it = common('adjust', trackId, start, duration);
  it.name = 'Adjustment';
  return it;
}

export function newSolid(trackId, start, duration = 5, color = '#101010') {
  const it = common('solid', trackId, start, duration);
  Object.assign(it, { name: 'Colour', fillColor: color, gradient: null });
  return it;
}

/** Procedural overlays: dust, sparkles, bokeh, falling flakes, light leaks, flares. */
export const FX_PRESETS = {
  dust: { name: 'Floating dust', kind: 'dust', color: '#fff2dc', density: 0.55, size: 6, speed: 0.25, angle: -90, blend: 'screen' },
  sparkle: { name: 'Gold sparkles', kind: 'sparkle', color: '#ffd27a', density: 0.35, size: 22, speed: 0.12, angle: -90, blend: 'screen' },
  bokeh: { name: 'Bokeh lights', kind: 'bokeh', color: '#ffc890', density: 0.55, size: 42, speed: 0.12, angle: -80, variety: 0.25, blend: 'screen' },
  cocoa: { name: 'Falling cocoa', kind: 'dust', color: '#4a2a18', density: 0.6, size: 7, speed: 0.9, angle: 96, blend: 'normal' },
  snow: { name: 'Snow', kind: 'dust', color: '#ffffff', density: 0.6, size: 9, speed: 1.1, angle: 100, blend: 'screen' },
  leak: { name: 'Light leak', kind: 'leak', color: '#ff9a4a', density: 0.8, size: 100, speed: 1, angle: 0, blend: 'screen' },
  flare: { name: 'Lens flare', kind: 'flare', color: '#ffd9a0', density: 0.7, size: 100, speed: 0.5, angle: 0, blend: 'screen', pos: [-0.22, -0.3] },
};

export function newFx(trackId, start, duration, presetKey, project) {
  const pr = FX_PRESETS[presetKey] || FX_PRESETS.dust;
  const it = common('fx', trackId, start, duration);
  const { name, blend, pos, ...fx } = pr;
  Object.assign(it, { name, fx: { ...fx, seed: Math.round(Math.random() * 1000) / 10, preset: presetKey }, blend });
  if (pos && project) {
    it.props.x = Math.round(pos[0] * project.settings.width);
    it.props.y = Math.round(pos[1] * project.settings.height);
  }
  return it;
}

// ---------------------------------------------------------------------------
// Time mapping
// ---------------------------------------------------------------------------

export const itemEnd = (it) => it.start + it.duration;

/** Integral of a piecewise-linear speed curve from 0 to u (0..1). */
export function curveIntegral(curve, u) {
  if (!curve || curve.length < 2) return u;
  let acc = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (u <= a.x) break;
    const x1 = Math.min(u, b.x);
    const w = x1 - a.x;
    if (w <= 0) continue;
    const ya = a.y;
    const yb = lerp(a.y, b.y, (x1 - a.x) / Math.max(1e-9, b.x - a.x));
    acc += (w * (ya + yb)) / 2;
  }
  return acc;
}

export function curveValue(curve, u) {
  if (!curve || !curve.length) return 1;
  if (u <= curve[0].x) return curve[0].y;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (u <= b.x) return lerp(a.y, b.y, (u - a.x) / Math.max(1e-9, b.x - a.x));
  }
  return curve[curve.length - 1].y;
}

/** Seconds of source media an item consumes. */
export function sourceSpan(it) {
  if (it.type !== 'clip') return it.duration;
  if (it.freeze) return 0;
  if (it.speedCurve) return it.duration * curveIntegral(it.speedCurve, 1);
  return it.duration * (it.speed || 1);
}

/** Source media time for timeline time t (clamped to the item). */
export function sourceTime(it, t) {
  const local = clamp(t - it.start, 0, it.duration);
  if (it.freeze) return it.in;
  if (it.speedCurve) return it.in + it.duration * curveIntegral(it.speedCurve, local / it.duration);
  return it.in + local * (it.speed || 1);
}

/** Same as sourceTime but allows local time outside the item (used by transitions). */
export function sourceTimeUnclamped(it, t) {
  const local = t - it.start;
  if (it.freeze) return it.in;
  if (it.speedCurve) {
    if (local < 0) return it.in + local * curveValue(it.speedCurve, 0);
    if (local > it.duration) return it.in + sourceSpan(it) + (local - it.duration) * curveValue(it.speedCurve, 1);
    return it.in + it.duration * curveIntegral(it.speedCurve, local / it.duration);
  }
  return it.in + local * (it.speed || 1);
}

export function instantSpeed(it, t) {
  if (it.freeze) return 0;
  if (it.speedCurve) return curveValue(it.speedCurve, clamp((t - it.start) / it.duration, 0, 1));
  return it.speed || 1;
}

export const SPEED_RAMPS = {
  montage: [
    { x: 0, y: 1 },
    { x: 0.35, y: 1 },
    { x: 0.5, y: 0.25 },
    { x: 0.65, y: 1 },
    { x: 1, y: 1 },
  ],
  hero: [
    { x: 0, y: 2 },
    { x: 0.3, y: 2 },
    { x: 0.45, y: 0.3 },
    { x: 0.6, y: 0.3 },
    { x: 0.75, y: 2 },
    { x: 1, y: 2 },
  ],
  bullet: [
    { x: 0, y: 3 },
    { x: 0.4, y: 0.2 },
    { x: 0.7, y: 0.2 },
    { x: 1, y: 3 },
  ],
  flashIn: [
    { x: 0, y: 4 },
    { x: 0.3, y: 1 },
    { x: 1, y: 1 },
  ],
  flashOut: [
    { x: 0, y: 1 },
    { x: 0.7, y: 1 },
    { x: 1, y: 4 },
  ],
  jumpCut: [
    { x: 0, y: 1 },
    { x: 0.45, y: 1 },
    { x: 0.5, y: 5 },
    { x: 0.55, y: 1 },
    { x: 1, y: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

export const EASINGS = {
  linear: (t) => t,
  easeIn: (t) => t * t * t,
  easeOut: (t) => 1 - (1 - t) ** 3,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  smooth: (t) => t * t * (3 - 2 * t),
  hold: () => 0,
};

/** Value of a property at timeline time t, honouring keyframes. */
export function propAt(it, prop, t) {
  const list = it.kf?.[prop];
  if (!list || !list.length) return it.props?.[prop] ?? baseProps()[prop] ?? 0;
  const local = t - it.start;
  if (local <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (local >= last.t) return last.v;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    if (local >= a.t && local <= b.t) {
      const e = EASINGS[a.e || 'easeInOut'] || EASINGS.linear;
      return lerp(a.v, b.v, e((local - a.t) / Math.max(1e-9, b.t - a.t)));
    }
  }
  return last.v;
}

export function hasKeyframes(it, prop) {
  return !!it.kf?.[prop]?.length;
}

/** Adds or replaces a keyframe at local time `local`. */
export function setKeyframe(it, prop, local, value, ease = 'easeInOut') {
  it.kf ||= {};
  const list = (it.kf[prop] ||= []);
  const tol = 1 / 120;
  const hit = list.find((k) => Math.abs(k.t - local) < tol);
  if (hit) {
    hit.v = value;
  } else {
    list.push({ t: local, v: value, e: ease });
    list.sort((a, b) => a.t - b.t);
  }
}

export function removeKeyframe(it, prop, local) {
  const list = it.kf?.[prop];
  if (!list) return;
  const i = list.findIndex((k) => Math.abs(k.t - local) < 1 / 60);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) delete it.kf[prop];
}

/** All keyframe times of an item, local seconds, deduplicated. */
export function keyframeTimes(it) {
  const set = new Set();
  for (const list of Object.values(it.kf || {})) for (const k of list) set.add(Math.round(k.t * 1000) / 1000);
  return [...set].sort((a, b) => a - b);
}

/** Shifts keyframes when the item's head is trimmed by `delta` seconds. */
export function shiftKeyframes(it, delta) {
  for (const [prop, list] of Object.entries(it.kf || {})) {
    for (const k of list) k.t -= delta;
    it.kf[prop] = list.filter((k) => k.t >= -1e-6 && k.t <= it.duration + 1e-6);
    if (!it.kf[prop].length) delete it.kf[prop];
  }
}

// ---------------------------------------------------------------------------
// In and out animations
// ---------------------------------------------------------------------------

export const ANIMATIONS_IN = {
  fade: 'Fade in',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  slideUp: 'Slide up',
  slideDown: 'Slide down',
  slideLeft: 'Slide left',
  slideRight: 'Slide right',
  pop: 'Pop',
  blurIn: 'Blur in',
  spin: 'Spin in',
  wipe: 'Wipe in',
};
export const ANIMATIONS_OUT = {
  fade: 'Fade out',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  slideUp: 'Slide up',
  slideDown: 'Slide down',
  slideLeft: 'Slide left',
  slideRight: 'Slide right',
  pop: 'Pop',
  blurOut: 'Blur out',
  spin: 'Spin out',
  wipe: 'Wipe out',
};
export const ANIMATIONS_LOOP = {
  pulse: 'Pulse',
  float: 'Float',
  shake: 'Shake',
  kenBurns: 'Slow zoom',
  rotate: 'Rotate',
};

/**
 * Returns transform modifiers for in/out/loop animations at timeline time t:
 * { dx, dy, scale, rotation, opacity, blur, wipe } where dx/dy are fractions of
 * the canvas size and wipe is 0..1 revealed width (1 = fully shown).
 */
export function animState(it, t) {
  const s = { dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, wipe: 1 };
  const local = t - it.start;
  const a = it.anim || {};
  const apply = (type, p, dir) => {
    // p runs 0 -> 1 as the element becomes fully visible
    const e = EASINGS.easeOut(clamp(p, 0, 1));
    const q = 1 - e;
    switch (type) {
      case 'fade':
        s.opacity *= e;
        break;
      case 'zoomIn':
        s.scale *= 1 - 0.35 * q * (dir === 'in' ? 1 : -1);
        s.opacity *= dir === 'in' ? Math.min(1, e * 1.6) : Math.min(1, e * 1.6);
        break;
      case 'zoomOut':
        s.scale *= 1 + 0.35 * q * (dir === 'in' ? 1 : -1);
        s.opacity *= Math.min(1, e * 1.6);
        break;
      case 'slideUp':
        s.dy += 0.25 * q * (dir === 'in' ? 1 : -1);
        s.opacity *= Math.min(1, e * 1.4);
        break;
      case 'slideDown':
        s.dy -= 0.25 * q * (dir === 'in' ? 1 : -1);
        s.opacity *= Math.min(1, e * 1.4);
        break;
      case 'slideLeft':
        s.dx += 0.35 * q * (dir === 'in' ? 1 : -1);
        s.opacity *= Math.min(1, e * 1.4);
        break;
      case 'slideRight':
        s.dx -= 0.35 * q * (dir === 'in' ? 1 : -1);
        s.opacity *= Math.min(1, e * 1.4);
        break;
      case 'pop': {
        const b = EASINGS.easeOut(clamp(p, 0, 1));
        const over = Math.sin(clamp(p, 0, 1) * Math.PI) * 0.12;
        s.scale *= 0.4 + 0.6 * b + over;
        s.opacity *= Math.min(1, p * 3);
        break;
      }
      case 'blurIn':
      case 'blurOut':
        s.blur = Math.max(s.blur, q * 30);
        s.opacity *= Math.min(1, e * 1.3);
        break;
      case 'spin':
        s.rotation += q * 180 * (dir === 'in' ? -1 : 1);
        s.scale *= 0.5 + 0.5 * e;
        s.opacity *= e;
        break;
      case 'wipe':
        s.wipe = Math.min(s.wipe, e);
        break;
    }
  };
  if (a.in?.type && local < a.in.duration) apply(a.in.type, local / Math.max(0.01, a.in.duration), 'in');
  if (a.out?.type && local > it.duration - a.out.duration) apply(a.out.type, (it.duration - local) / Math.max(0.01, a.out.duration), 'out');
  if (a.loop?.type) {
    const period = a.loop.period || 2;
    const ph = (local / period) * Math.PI * 2;
    const amt = a.loop.amount ?? 1;
    switch (a.loop.type) {
      case 'pulse':
        s.scale *= 1 + 0.05 * amt * Math.sin(ph);
        break;
      case 'float':
        s.dy += 0.012 * amt * Math.sin(ph);
        break;
      case 'shake':
        s.dx += 0.006 * amt * Math.sin(ph * 7.3);
        s.dy += 0.006 * amt * Math.sin(ph * 5.1 + 1);
        break;
      case 'kenBurns':
        s.scale *= 1 + 0.12 * amt * clamp(local / Math.max(0.1, it.duration), 0, 1);
        break;
      case 'rotate':
        s.rotation += (local / period) * 360 * amt;
        break;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function projectDuration(project) {
  let end = 0;
  for (const it of Object.values(project.items)) end = Math.max(end, itemEnd(it));
  return end;
}

export function trackItems(project, trackId) {
  return Object.values(project.items)
    .filter((it) => it.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

export function trackIndex(project, trackId) {
  return project.tracks.findIndex((t) => t.id === trackId);
}

export function visualTracks(project) {
  return project.tracks.filter((t) => t.kind === 'video');
}

export function audioTracks(project) {
  return project.tracks.filter((t) => t.kind === 'audio');
}

/** Items that are visible (drawn) at time t, bottom layer first. */
export function activeVisualItems(project, t) {
  const out = [];
  const tracks = visualTracks(project);
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i];
    if (tr.hidden) continue;
    for (const it of trackItems(project, tr.id)) {
      if (t >= it.start - 1e-6 && t < itemEnd(it) - 1e-6) out.push(it);
    }
  }
  return out;
}

export function isVisualItem(project, it) {
  const tr = project.tracks.find((t) => t.id === it.trackId);
  return tr?.kind === 'video';
}

/** The item directly before `it` on the same track if it touches it. */
export function previousAdjacent(project, it, tol = 0.02) {
  let best = null;
  for (const o of Object.values(project.items)) {
    if (o.trackId !== it.trackId || o.id === it.id) continue;
    if (Math.abs(itemEnd(o) - it.start) <= tol) best = o;
  }
  return best;
}

export function nextAdjacent(project, it, tol = 0.02) {
  for (const o of Object.values(project.items)) {
    if (o.trackId !== it.trackId || o.id === it.id) continue;
    if (Math.abs(o.start - itemEnd(it)) <= tol) return o;
  }
  return null;
}

export function mediaOf(project, it) {
  return it.mediaId ? project.media[it.mediaId] : null;
}

export function cloneItem(it) {
  const c = clone(it);
  c.id = uid('c');
  return c;
}

/** Max timeline duration a clip may have given its media and speed. */
export function maxClipDuration(project, it) {
  const m = mediaOf(project, it);
  if (!m || m.kind === 'image' || it.freeze) return Infinity;
  const remaining = Math.max(0, (m.duration || 0) - it.in);
  if (it.speedCurve) return remaining / Math.max(0.01, curveIntegral(it.speedCurve, 1));
  return remaining / Math.max(0.01, it.speed || 1);
}
