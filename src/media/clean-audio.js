// Two things every clip's sound goes through, the same in the preview and the
// export:
// - Click-free cuts: a 6 ms fade at each end of a clip, so a cut in the middle
//   of a sound never pops. A split that still plays straight on into the next
//   piece (same file, next frame) gets no fade, so it stays seamless.
// - Bleeps: words listed on a clip (it.bleeps, in seconds of the source file)
//   go silent, and with the project's bleep sound on, a 1 kHz tone plays over them.

import { itemEnd, sourceSpan, sourceTime } from '../core/model.js';

export const EDGE = 0.006;
export const BLEEP_HZ = 1000;
export const BLEEP_LEVEL = 0.22;
const RAMP = 0.008;

/** Whether the clip plays straight on from the one before it and into the one after it. */
export function seamless(project, it) {
  let before = false;
  let after = false;
  if (it.speedCurve || it.freeze) return { before, after };
  const end = itemEnd(it);
  const srcEnd = it.in + sourceSpan(it);
  for (const o of Object.values(project.items)) {
    if (o === it || o.type !== 'clip' || o.trackId !== it.trackId || o.mediaId !== it.mediaId || o.speedCurve || o.freeze || o.muted) continue;
    if ((o.speed || 1) !== (it.speed || 1)) continue;
    if (Math.abs(o.start - end) < 0.002 && Math.abs(o.in - srcEnd) < 0.003) after = true;
    if (Math.abs(itemEnd(o) - it.start) < 0.002 && Math.abs(o.in + sourceSpan(o) - it.in) < 0.003) before = true;
  }
  return { before, after };
}

/** Gain from the click-free fades at timeline time t (1 away from the ends). */
export function edgeGain(it, t, joins, on = true) {
  if (!on) return 1;
  const local = t - it.start;
  let g = 1;
  if (!joins?.before && local < EDGE) g = Math.min(g, Math.max(0, local / EDGE));
  const left = it.duration - local;
  if (!joins?.after && left < EDGE) g = Math.min(g, Math.max(0, left / EDGE));
  return g;
}

/** 1 where the clip plays normally, 0 inside a bleeped word, with short ramps between. */
export function bleepGain(it, t) {
  const list = it.bleeps;
  if (!list?.length) return 1;
  const s = sourceTime(it, t);
  const sp = Math.max(0.1, Math.abs(it.speed || 1));
  const ramp = RAMP * sp;
  let g = 1;
  for (const b of list) {
    if (s < b.s - ramp || s > b.e + ramp) continue;
    if (s >= b.s && s <= b.e) return 0;
    g = Math.min(g, s < b.s ? (b.s - s) / ramp : (s - b.e) / ramp);
  }
  return Math.max(0, g);
}

export const clickFreeOn = (project) => project.settings.clickFree !== false;
export const bleepTone = (project) => (project.settings.bleepSound || 'beep') === 'beep';

/** Words that count as swearing, for the bleep list. A * at the end matches any ending. */
export const DEFAULT_BLEEP_WORDS = ['fuck*', 'motherfuck*', 'shit*', 'bullshit', 'bitch*', 'asshole*', 'bastard*', 'dick', 'dickhead', 'cunt*', 'puta', 'putang*', 'putangina', 'tangina', 'tang ina', 'gago', 'gaga', 'ulol', 'tarantado', 'pakyu', 'leche', 'bwisit', 'hayop'];

/** Turns a typed list ("shit, fuck*, tang ina") into matchers. */
export function bleepMatchers(text) {
  const list = Array.isArray(text) ? text : String(text || '').split(/[,\n]/);
  return list
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .map((w) => {
      const star = w.endsWith('*');
      const parts = w.replace(/\*$/, '').split(/\s+/).filter(Boolean);
      return { parts, star };
    });
}

const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Indexes of transcript words that match. Multi-word entries ("tang ina") match consecutive words. */
export function matchWords(words, matchers) {
  const hits = new Set();
  const n = words.map((w) => norm(w.t ?? w.text));
  for (let i = 0; i < n.length; i++) {
    for (const m of matchers) {
      const k = m.parts.length;
      if (!k || i + k > n.length) continue;
      let ok = true;
      for (let j = 0; j < k; j++) {
        const last = j === k - 1;
        if (!(n[i + j] === m.parts[j] || (last && m.star && n[i + j].startsWith(m.parts[j])))) {
          ok = false;
          break;
        }
      }
      // a word glued together in the transcript ("tangina") also matches "tang ina"
      if (!ok && k > 1 && n[i] === m.parts.join('')) ok = true;
      if (ok) for (let j = 0; j < (n[i] === m.parts.join('') ? 1 : k); j++) hits.add(i + j);
    }
  }
  return [...hits].sort((a, b) => a - b);
}
