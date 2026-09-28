// Multi-camera: lines up clips of the same moment by their sound, then lets
// you switch between the angles with the number keys while it plays.

import { store } from '../core/store.js';
import { itemEnd, newTrack, isVisualItem } from '../core/model.js';
import * as E from '../core/edit.js';
import { getPeaks } from '../media/library.js';
import { toast, startJob } from '../ui/notify.js';
import { h, button } from '../ui/dom.js';
import { uid, clone, clamp, formatTime } from '../core/util.js';

// ---------------------------------------------------------------------------
// Sync by sound
// ---------------------------------------------------------------------------

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

/** Onset envelope (rises in loudness) from the 100-per-second peaks, zero mean. */
function onsets(peaks, a, b) {
  const n = Math.max(0, b - a);
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const cur = peaks[a + i] || 0;
    const prev = peaks[a + i - 1] ?? cur;
    out[i] = Math.max(0, cur - prev) + cur * 0.15;
    mean += out[i];
  }
  mean /= n || 1;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

/**
 * Offset between two sounds: returns { lag, score } where lag (seconds) says
 * where x's first sample sits inside y. score is 0..1.
 */
export function soundOffset(x, y) {
  let n = 1;
  while (n < x.length + y.length) n <<= 1;
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  const yr = new Float64Array(n);
  const yi = new Float64Array(n);
  xr.set(x);
  yr.set(y);
  fft(xr, xi);
  fft(yr, yi);
  for (let i = 0; i < n; i++) {
    // conj(X) * Y
    const r = xr[i] * yr[i] + xi[i] * yi[i];
    const im = xr[i] * yi[i] - xi[i] * yr[i];
    xr[i] = r;
    xi[i] = im;
  }
  fft(xr, xi, true);
  let best = -Infinity;
  let bk = 0;
  for (let k = 0; k < n; k++) {
    if (xr[k] > best) {
      best = xr[k];
      bk = k;
    }
  }
  const lag = bk > n / 2 ? bk - n : bk;
  let ex = 0;
  let ey = 0;
  for (const v of x) ex += v * v;
  for (const v of y) ey += v * v;
  return { lag: lag / 100, score: best / Math.sqrt(ex * ey || 1) };
}

/**
 * Lines up `others` with `ref` by their sound. Each other clip moves to its own
 * track above, starting where its sound matches; its own sound is muted.
 */
export async function syncBySound(refIn, others) {
  let ref = refIn;
  const p = store.project;
  const rm = p.media[ref.mediaId];
  const rp = await getPeaks(rm);
  const a = Math.floor(ref.in * 100);
  const x = onsets(rp, a, a + Math.floor(ref.duration * (ref.speed || 1) * 100));
  const results = [];
  for (const o of others) {
    const om = p.media[o.mediaId];
    const op = await getPeaks(om);
    const y = onsets(op, 0, op.length);
    const { lag, score } = soundOffset(x, y);
    // x starts at ref.in, so ref source time s matches other source time s - ref.in + lag
    results.push({ o, lag, score });
  }
  const placed = [];
  store.commit('Sync by sound', (pp) => {
    // write to the live items in case an undo swapped them during the analysis
    ref = pp.items[ref.id];
    for (const r of results) r.o = pp.items[r.o.id];
    if (!ref || results.some((r) => !r.o)) return;
    // move the other angles off the main track first, so the main track settles
    for (const { o } of results) {
      const tr = newTrack('video', 'Angle ' + (placed.length + 2));
      const idx = pp.tracks.findIndex((t) => t.id === ref.trackId);
      pp.tracks.splice(Math.max(0, idx - placed.length), 0, tr);
      o.trackId = tr.id;
      placed.push(o.id);
    }
    E.compactMagnetic(pp);
    for (const { o, lag } of results) {
      const om = pp.media[o.mediaId];
      // the other clip's source time 0 lines up with the ref's source time ref.in - lag
      let start = ref.start - lag;
      let inPt = 0;
      if (start < 0) {
        inPt = -start;
        start = 0;
      }
      o.in = inPt;
      o.start = start;
      o.duration = Math.max(0.2, (om.duration || o.duration) - inPt);
      o.muted = true;
    }
    pp.multicam = { ref: ref.id, angles: [ref.id, ...placed] };
  });
  return results;
}

export async function syncSelected(app) {
  const p = store.project;
  const clips = store.selectedItems.filter((i) => i.type === 'clip' && p.media[i.mediaId]?.kind === 'video' && p.media[i.mediaId]?.hasAudio);
  if (clips.length < 2) return toast('Select two or more video clips of the same moment, each with its own sound.', { timeout: 3500 });
  if (clips.some((c) => c.speedCurve || (c.speed || 1) !== 1)) return toast('Set every angle back to normal speed first.', { kind: 'warn' });
  const main = E.mainTrack(p);
  const ref = clips.find((c) => c.trackId === main?.id) || clips[0];
  const job = startJob('Sync by sound');
  try {
    job.update(null, 'Comparing the sound');
    const res = await syncBySound(
      ref,
      clips.filter((c) => c !== ref),
    );
    const weak = res.filter((r) => r.score < 0.15);
    job.done();
    toast(weak.length ? `Synced, but ${weak.length} angle${weak.length > 1 ? 's' : ''} had little matching sound. Check the lip sync.` : `Synced ${res.length + 1} angles. Press "Switch angles" to cut between them.`, { timeout: 5000, action: { label: 'Switch angles', run: () => showAngleSwitcher(app) } });
  } catch (e) {
    job.fail(e);
  }
}

// ---------------------------------------------------------------------------
// Switching angles live
// ---------------------------------------------------------------------------

/** Keeps only the given timeline ranges of a clip, leaving each piece where it is. */
export function keepTimeRanges(p, it, ranges) {
  const out = [];
  for (const [a0, b0] of ranges) {
    const a = Math.max(a0, it.start);
    const b = Math.min(b0, itemEnd(it));
    if (b - a < 0.04) continue;
    const c = clone(it);
    c.id = uid('c');
    c.in = it.in + (a - it.start) * (it.speed || 1);
    c.start = a;
    c.duration = b - a;
    c.kf = {};
    c.transitionIn = null;
    p.items[c.id] = c;
    out.push(c);
  }
  delete p.items[it.id];
  return out;
}

/** Turns a list of [time, angle] switches into cut clips. */
export function applySwitches(p, angles, switches, end) {
  const sw = [...switches].sort((a, b) => a[0] - b[0]);
  for (let ai = 1; ai < angles.length; ai++) {
    const it = p.items[angles[ai]];
    if (!it) continue;
    const ranges = [];
    for (let k = 0; k < sw.length; k++) if (sw[k][1] === ai) ranges.push([sw[k][0], sw[k + 1]?.[0] ?? end]);
    keepTimeRanges(p, it, ranges);
  }
  delete p.multicam;
}

export function showAngleSwitcher(app) {
  const p = store.project;
  const mc = p.multicam;
  const angles = (mc?.angles || []).filter((id) => p.items[id]);
  if (angles.length < 2) return toast('Sync two or more angles by sound first.', { timeout: 3000 });
  const tracks = angles.map((id) => p.tracks.find((t) => t.id === p.items[id].trackId));
  const names = angles.map((id, i) => `${i + 1}  ${p.items[id].name || p.media[p.items[id].mediaId]?.name || 'Angle'}`);
  const start = Math.min(...angles.map((id) => p.items[id].start));
  const end = Math.max(...angles.map((id) => itemEnd(p.items[id])));
  const hiddenBefore = tracks.map((t) => t.hidden);
  let active = 0;
  let switches = [];
  let recording = false;
  const show = (i) => {
    active = i;
    store.mutate(() => tracks.forEach((t, k) => k > 0 && (t.hidden = k !== i)));
    btns.forEach((b, k) => b.classList.toggle('active', k === i));
  };
  const btns = names.map((n, i) => button(n, () => pick(i), { cls: 'angle-btn' }));
  const recBtn = button('Record the cuts', () => (recording ? stop(true) : startRec()), { kind: 'primary', icon: 'record' });
  const bar = h('div', { class: 'angle-bar' }, h('span', { class: 'dim' }, 'Angles'), ...btns, recBtn, button('Close', () => stop(false), { kind: 'link' }));
  app.viewerEl.append(bar);
  const pick = (i) => {
    if (i < 0 || i >= angles.length) return;
    show(i);
    if (recording) switches.push([store.playhead, i]);
  };
  const onKey = (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= angles.length && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      e.stopPropagation();
      pick(n - 1);
    }
  };
  document.addEventListener('keydown', onKey, true);
  function startRec() {
    recording = true;
    switches = [[start, active]];
    app.seek(start);
    app.preview.play();
    recBtn.querySelector('span').textContent = 'Stop and cut';
    recBtn.classList.add('recording');
  }
  function stop(apply) {
    document.removeEventListener('keydown', onKey, true);
    app.preview.pause();
    bar.remove();
    store.mutate(() => tracks.forEach((t, k) => (t.hidden = hiddenBefore[k])));
    if (apply && switches.length) {
      const cutEnd = Math.max(store.playhead, switches[switches.length - 1][0]);
      // after the last recorded moment the current angle carries on to the end
      store.commit('Switch angles', (pp) => applySwitches(pp, angles, switches, end));
      toast(`Cut between ${angles.length} angles with ${switches.length - 1} switches up to ${formatTime(cutEnd)}.`);
    }
  }
  show(0);
  toast('Press 1, 2 or 3 to switch angles. "Record the cuts" plays it and keeps every switch you press.', { timeout: 5000 });
}

export { isVisualItem, clamp };
