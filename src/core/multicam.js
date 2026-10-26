// Multi-angle editing: clips of the same moment, lined up by their sound, each
// on its own track. Only one angle shows at a time. A list of switches says
// when the picture moves to another angle and with which transition, while one
// angle's sound plays the whole way through.
//
// project.multicam = {
//   angles: [itemId, ...],      angle 1 first; it shows until the first switch
//   sound: itemId,              the angle whose sound is used
//   switches: [{ id, t, a, type, d }],  at time t, move to angle a with transition type over d seconds
//   defType, defDur,            the transition new switches get
// }

import { itemEnd } from './model.js';
import { uid } from './util.js';

export const SWITCH_TYPES = [
  ['cut', 'Cut'],
  ['dissolve', 'Fade'],
  ['dipBlack', 'Dip to black'],
  ['dipWhite', 'Dip to white'],
  ['blur', 'Blur'],
  ['zoomIn', 'Zoom in'],
  ['zoomOut', 'Zoom out'],
  ['wipeLeft', 'Wipe left'],
  ['wipeRight', 'Wipe right'],
  ['pushLeft', 'Push left'],
  ['pushRight', 'Push right'],
  ['slideOver', 'Slide over'],
  ['circle', 'Circle reveal'],
  ['whip', 'Whip pan'],
  ['glitch', 'Glitch'],
];

export const ANGLE_COLORS = ['#e0b84a', '#5aa9e6', '#e66a8a', '#6cc27a', '#a78bfa', '#f08a4b', '#4fd1c5', '#d4d4d4'];

/** The multi-angle setup with its angles still on the timeline, or null. */
export function multicamOf(p) {
  const mc = p?.multicam;
  if (!mc?.angles) return null;
  const angles = mc.angles.filter((id) => p.items[id]);
  if (angles.length < 2) return null;
  return { ...mc, angles, switches: [...(mc.switches || [])].filter((s) => s.a < mc.angles.length).sort((a, b) => a.t - b.t) };
}

const dur = (s) => (s.type === 'cut' ? 0 : Math.max(0, s.d ?? 0.6));

/**
 * Which angle shows at time t: { a } or, inside a transition, { a, b, p, type }
 * where a and b are angle numbers (0-based) and p runs 0..1.
 */
export function angleAt(mc, t) {
  let cur = 0;
  for (const s of mc.switches) {
    const d = dur(s);
    const w0 = s.t - d / 2;
    if (t < w0) break;
    if (d > 0 && t < s.t + d / 2 && s.a !== cur) return { a: cur, b: s.a, p: (t - w0) / d, type: s.type };
    cur = s.a;
  }
  return { a: cur };
}

const covers = (p, it, t) => it && t >= it.start - 1e-6 && t < itemEnd(it) - 1e-6 && !p.tracks.find((tr) => tr.id === it.trackId)?.hidden;

/** The angle item to show for angle number a at t, falling back to one that has picture there. */
function pick(p, mc, a, t) {
  const want = p.items[mc.angles[a]];
  if (covers(p, want, t)) return want;
  for (const id of mc.angles) if (covers(p, p.items[id], t)) return p.items[id];
  return null;
}

/**
 * The render step for the angles at time t: a layer or transition op, or null
 * when no angle has picture there. Hidden tracks drop out of the choice.
 */
export function angleOp(p, mc, t) {
  const st = angleAt(mc, t);
  const A = pick(p, mc, st.a, t);
  if (st.b == null) return A ? { kind: 'layer', item: A } : null;
  const B = pick(p, mc, st.b, t);
  if (!A && !B) return null;
  if (!A || !B || A === B) return { kind: 'layer', item: A || B };
  return { kind: 'transition', a: A, b: B, p: st.p, type: st.type, angles: true };
}

/** Angle items about to come into view within `horizon` seconds after t, so the preview can start them early. */
export function upcomingAngles(p, mc, t, horizon) {
  const out = [];
  for (const s of mc.switches) {
    const w0 = s.t - dur(s) / 2;
    if (w0 < t - 0.05 || w0 - t > horizon) continue;
    const it = p.items[mc.angles[s.a]];
    if (it && !out.includes(it)) out.push(it);
  }
  return out;
}

/** Adds a switch to angle a at t, or changes the angle of a switch already there. Call inside a commit. */
export function addSwitch(p, t, a) {
  const mc = p.multicam;
  mc.switches ||= [];
  const near = mc.switches.find((s) => Math.abs(s.t - t) < 0.12);
  if (near) {
    near.a = a;
    return near;
  }
  const s = { id: uid('sw'), t: Math.max(0, t), a, type: mc.defType || 'dissolve', d: mc.defDur ?? 0.6 };
  mc.switches.push(s);
  mc.switches.sort((x, y) => x.t - y.t);
  return s;
}

/** Plays only the chosen angle's sound. Call inside a commit. */
export function setSoundAngle(p, id) {
  const mc = p.multicam;
  mc.sound = id;
  for (const aid of mc.angles) if (p.items[aid]) p.items[aid].muted = aid !== id;
}

/** Timeline stretches [t0, t1, angle] where each angle is on screen, for drawing. */
export function angleSpans(p, mc, end) {
  const out = [];
  const start = Math.min(...mc.angles.map((id) => p.items[id]?.start ?? Infinity));
  let t = Math.max(0, start);
  let cur = 0;
  for (const s of mc.switches) {
    if (s.t > t) out.push([t, s.t, cur]);
    t = Math.max(t, s.t);
    cur = s.a;
  }
  if (end > t) out.push([t, end, cur]);
  return out;
}
