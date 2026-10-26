// Multi-angle: lines up clips of the same moment by their sound. Switching
// between them is a list of switches the Angles row on the timeline edits
// (see core/multicam.js); the number keys add one at the playhead.

import { store } from '../core/store.js';
import { itemEnd, newTrack, isVisualItem, newClip } from '../core/model.js';
import * as E from '../core/edit.js';
import { getPeaks } from '../media/library.js';
import { toast, startJob } from '../ui/notify.js';
import { clamp } from '../core/util.js';
import { multicamOf, addSwitch, setSoundAngle } from '../core/multicam.js';

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
    pp.multicam = { angles: [ref.id, ...placed], sound: ref.id, switches: [], defType: 'dissolve', defDur: 0.6 };
    setSoundAngle(pp, ref.id);
  });
  return results;
}

/**
 * Lines up the selected clips. With fewer than two selected it takes every
 * video with sound on the timeline, and with fewer than two there it puts
 * every video with sound from the Media panel on the timeline first.
 */
export async function syncSelected(app) {
  const p = store.project;
  const usable = (i) => i.type === 'clip' && p.media[i.mediaId]?.kind === 'video' && p.media[i.mediaId]?.hasAudio;
  let clips = store.selectedItems.filter(usable);
  if (clips.length < 2) clips = Object.values(p.items).filter(usable);
  if (clips.length < 2) {
    const vids = Object.values(p.media).filter((m) => m.kind === 'video' && m.hasAudio && m.status === 'ready' && !m.hidden && !m.sourceId);
    if (vids.length < 2) return toast('Import two or more videos of the same moment, each with its own sound.', { timeout: 3500 });
    const ids = [];
    store.commit('Add the angles', (pp) => {
      const main = E.mainTrack(pp);
      let at = Math.max(0, ...Object.values(pp.items).filter((i) => i.trackId === main.id).map(itemEnd));
      for (const m of vids) {
        const c = newClip(m, main.id, at);
        pp.items[c.id] = c;
        ids.push(c.id);
        at += c.duration;
      }
    });
    clips = ids.map((id) => store.project.items[id]);
    app.fitCanvasTo?.(vids[0]);
  }
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
    app.timeline?.zoomToFit();
    toast(
      weak.length
        ? `Synced, but ${weak.length} angle${weak.length > 1 ? 's' : ''} had little matching sound. Check the lip sync.`
        : `Synced ${res.length + 1} angles. Play it and press ${res.length + 1 > 2 ? '1, 2 or 3' : '1 or 2'} to switch angles, or use the Angles row above the tracks.`,
      { timeout: 7000 },
    );
  } catch (e) {
    job.fail(e);
  }
}

/** Number key n (1-based) while editing angles: switch to that angle at the playhead. */
export function switchAtPlayhead(n) {
  const p = store.project;
  const mc = multicamOf(p);
  if (!mc || n < 1 || n > mc.angles.length) return false;
  store.commit(`Switch to angle ${n}`, (pp) => addSwitch(pp, store.playhead, n - 1));
  return true;
}

export function showAngleSwitcher() {
  if (!multicamOf(store.project)) return toast('Sync two or more angles by sound first.', { timeout: 3000 });
  toast('Play the video and press 1, 2 or 3 to switch angles at that moment. Click a switch in the Angles row above the tracks to change its transition.', { timeout: 7000 });
}

export { isVisualItem, clamp };
