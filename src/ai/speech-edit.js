// Speech clean-up edits (cut silences, remove filler words) and music beats.

import { store } from '../core/store.js';
import { itemEnd, sourceTime, sourceSpan, isVisualItem, trackItems, maxClipDuration } from '../core/model.js';
import * as E from '../core/edit.js';
import { getPeaks, readPcmMono } from '../media/pcm.js';
import { transcribeClip, timelineTimeFor } from './captions.js';
import { startJob, toast, modal } from '../ui/notify.js';
import { h, slider, button } from '../ui/dom.js';
import { uid, clamp, clone } from '../core/util.js';

/**
 * Replaces a clip with the pieces of it given by `keep` (source-time ranges),
 * closing the gaps on its track. Linked separated audio follows along.
 */
export function keepRanges(p, it, keep) {
  const pieces = [];
  let t = it.start;
  const removedTotal = it.duration - keep.reduce((a, r) => a + (r[1] - r[0]) / (it.speed || 1), 0);
  for (const [a, b] of keep) {
    const c = clone(it);
    c.id = uid('c');
    c.in = a;
    c.duration = (b - a) / (it.speed || 1);
    c.start = t;
    c.kf = {};
    c.transitionIn = null;
    c.fadeIn = c.fadeOut = 0;
    c.speedCurve = null;
    t += c.duration;
    p.items[c.id] = c;
    pieces.push(c);
  }
  if (pieces.length) {
    pieces[0].transitionIn = it.transitionIn;
    pieces[0].fadeIn = it.fadeIn;
    pieces[pieces.length - 1].fadeOut = it.fadeOut;
  }
  const oldEnd = itemEnd(it);
  delete p.items[it.id];
  if (!E.isMagnetic(p, it.trackId)) E.rippleShift(p, it.trackId, oldEnd - 1e-4, -removedTotal);
  E.compactMagnetic(p);
  return pieces;
}

function mergeRanges(ranges, minGap = 0.05) {
  const r = ranges.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + minGap) last[1] = Math.max(last[1], x[1]);
    else out.push([...x]);
  }
  return out;
}

/** Silent source ranges in a clip from its waveform peaks. */
export async function findSilences(it, { threshold = null, minSilence = 0.5, pad = 0.12 } = {}) {
  const m = store.project.media[it.mediaId];
  const peaks = await getPeaks(m);
  if (!peaks) throw new Error('This clip has no waveform yet.');
  const a = Math.floor(it.in * 100);
  const b = Math.min(peaks.length, Math.ceil((it.in + sourceSpan(it)) * 100));
  const seg = peaks.slice(a, b);
  const sorted = [...seg].sort((x, y) => x - y);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1;
  const thr = threshold ?? Math.max(18, loud * 0.28);
  const silent = [];
  let run = -1;
  for (let i = 0; i <= seg.length; i++) {
    const quiet = i < seg.length && seg[i] < thr;
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) {
      const s = (a + run) / 100;
      const e = (a + i) / 100;
      if (e - s >= minSilence) silent.push([s + pad, e - pad]);
      run = -1;
    }
  }
  return { silent: silent.filter((r) => r[1] - r[0] > 0.05), thr, loud };
}

export function complement(start, end, cut) {
  const keep = [];
  let t = start;
  for (const [a, b] of mergeRanges(cut)) {
    if (a > t) keep.push([t, Math.min(a, end)]);
    t = Math.max(t, b);
  }
  if (t < end) keep.push([t, end]);
  return keep.filter((r) => r[1] - r[0] > 0.04);
}

export async function silenceCut(it) {
  if (it.speedCurve || it.freeze) return toast('Remove the speed ramp first.', { kind: 'warn' });
  const settings = await new Promise((resolve) => {
    let minSilence = 0.5;
    let pad = 0.12;
    let sens = 0.28;
    modal(
      'Cut out silences',
      h(
        'div',
        { class: 'stack' },
        h('p', {}, 'Pauses longer than the minimum are cut and the rest of the clip moves up.'),
        slider('Minimum pause', { value: 0.5, min: 0.2, max: 3, step: 0.05, format: (v) => Number(v).toFixed(2) + 's', onInput: (v) => (minSilence = v) }),
        slider('Keep around speech', { value: 0.12, min: 0, max: 0.5, step: 0.01, format: (v) => Number(v).toFixed(2) + 's', onInput: (v) => (pad = v) }),
        slider('Sensitivity', { value: 0.28, min: 0.1, max: 0.6, step: 0.01, format: (v) => Math.round(v * 100) + '%', onInput: (v) => (sens = v) }),
        h('p', { class: 'hint' }, 'Raise the sensitivity if breaths and room noise are kept. Lower it if quiet words are cut.'),
      ),
      {
        width: 460,
        onClose: (v) => resolve(v),
        actions: [
          { label: 'Cancel', run: (c) => c(null) },
          { label: 'Cut silences', primary: true, run: (c) => c({ minSilence, pad, sens }) },
        ],
      },
    );
  });
  if (!settings) return;
  const m = store.project.media[it.mediaId];
  const peaks = await getPeaks(m);
  const a = Math.floor(it.in * 100);
  const seg = peaks.slice(a, Math.ceil((it.in + sourceSpan(it)) * 100));
  const loud = [...seg].sort((x, y) => x - y)[Math.floor(seg.length * 0.9)] || 1;
  const { silent } = await findSilences(it, { minSilence: settings.minSilence, pad: settings.pad, threshold: Math.max(12, loud * settings.sens) });
  if (!silent.length) return toast('No pauses that long were found.', { timeout: 3000 });
  const keep = complement(it.in, it.in + sourceSpan(it), silent);
  const before = it.duration;
  let pieces = [];
  store.commit('Cut out silences', (p) => {
    pieces = keepRanges(p, it, keep);
    cutLinked(p, it, keep, pieces);
  });
  const after = pieces.reduce((s, c) => s + c.duration, 0);
  store.select(pieces.map((c) => c.id));
  toast(`Cut ${silent.length} pauses, ${Math.round(before - after)} seconds shorter.`);
}

/** Applies the same cut to audio that was separated from the clip. */
export function cutLinked(p, it, keep, pieces) {
  for (const o of Object.values(p.items)) {
    if (o.linkedTo !== it.id) continue;
    const parts = keepRanges(p, o, keep);
    parts.forEach((c, i) => {
      c.linkedTo = pieces[i]?.id || null;
      c.start = pieces[i]?.start ?? c.start;
    });
  }
}

const FILLERS = /^(um+|uh+|uhm+|erm+|er|ah+|hmm+|mm+|mhm|eh+|uh-huh)[.,!?]*$/i;

export async function fillerCut(it) {
  if (it.speedCurve || it.freeze) return toast('Remove the speed ramp first.', { kind: 'warn' });
  const job = startJob('Remove filler words');
  try {
    const words = await transcribeClip(it, { language: store.settings.whisperLanguage, model: store.settings.whisperModel, job });
    const fillers = words.filter((w) => FILLERS.test(w.text.trim()));
    if (!fillers.length) {
      job.done();
      return toast('No filler words were found.', { timeout: 3000 });
    }
    const cut = fillers.map((w) => [sourceTime(it, w.start) - 0.04, sourceTime(it, w.end) + 0.04]);
    const keep = complement(it.in, it.in + sourceSpan(it), cut);
    let pieces = [];
    store.commit('Remove filler words', (p) => {
      pieces = keepRanges(p, it, keep);
      cutLinked(p, it, keep, pieces);
    });
    store.select(pieces.map((c) => c.id));
    job.done(`Removed ${fillers.length} filler word${fillers.length > 1 ? 's' : ''}.`);
  } catch (e) {
    job.fail(e);
  }
}

// ---------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------

/** Beat times (source seconds) in [start, end) of a media file. */
export async function detectBeats(m, start, end) {
  const rate = 200; // onset envelope samples per second
  const mono = await readPcmMono(m, start, end, 11025);
  const hop = Math.round(11025 / rate);
  const env = new Float32Array(Math.floor(mono.length / hop));
  let prev = 0;
  for (let i = 0; i < env.length; i++) {
    let e = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) e += mono[k] * mono[k];
    e = Math.log(1 + e * 1000);
    env[i] = Math.max(0, e - prev);
    prev = e;
  }
  // tempo by autocorrelation between 70 and 180 BPM
  let bestLag = 0;
  let bestVal = -1;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * rate;
    let s = 0;
    for (let i = Math.ceil(lag); i < env.length; i++) s += env[i] * (env[Math.round(i - lag)] || 0);
    // gently prefer tempos near 110 so half and double tempo lose ties
    s *= 1 - Math.abs(bpm - 110) / 600;
    if (s > bestVal) {
      bestVal = s;
      bestLag = lag;
    }
  }
  // phase: the offset whose beat grid collects the most onset energy
  let bestPhase = 0;
  let bestSum = -1;
  for (let ph = 0; ph < bestLag; ph++) {
    let s = 0;
    for (let x = ph; x < env.length; x += bestLag) s += env[Math.round(x)] || 0;
    if (s > bestSum) {
      bestSum = s;
      bestPhase = ph;
    }
  }
  const beats = [];
  for (let x = bestPhase; x < env.length; x += bestLag) beats.push(start + x / rate);
  return { beats, bpm: (60 * rate) / bestLag };
}

export async function markBeats(it) {
  const m = store.project.media[it.mediaId];
  const job = startJob('Find beats');
  try {
    job.update(null, 'Listening for the beat');
    const { beats, bpm } = await detectBeats(m, it.in, it.in + sourceSpan(it));
    store.commit('Beat markers', (p) => {
      p.markers = p.markers.filter((mk) => !mk.beat || mk.t < it.start || mk.t > itemEnd(it));
      for (const b of beats) {
        const t = timelineTimeFor(it, b);
        if (t >= it.start && t <= itemEnd(it)) p.markers.push({ id: uid('k'), t, label: '', color: '#6fb6ff', beat: true });
      }
    });
    job.done(`About ${Math.round(bpm)} beats per minute. ${beats.length} markers added.`);
  } catch (e) {
    job.fail(e);
  }
}

export async function beatSync(app) {
  const p = store.project;
  let clips = store.selectedItems.filter((i) => i.type === 'clip' && isVisualItem(p, i)).sort((a, b) => a.start - b.start);
  if (clips.length < 2) return toast('Select two or more clips on one track to cut to the beat.', { kind: 'warn' });
  let beats = p.markers.filter((m) => m.beat).map((m) => m.t).sort((a, b) => a - b);
  if (beats.length < 2) {
    const music = Object.values(p.items).find((i) => i.type === 'clip' && !isVisualItem(p, i) && p.media[i.mediaId]?.hasAudio && (i.duck || p.media[i.mediaId].kind === 'audio'));
    if (!music) return toast('Add a music clip, or mark its beats first.', { kind: 'warn' });
    await markBeats(music);
    beats = store.project.markers.filter((m) => m.beat).map((m) => m.t).sort((a, b) => a - b);
  }
  const trackId = clips[0].trackId;
  clips = clips.filter((c) => c.trackId === trackId);
  store.commit('Cut to the beat', (pp) => {
    let t = clips[0].start;
    const beatLen = beats.length > 1 ? beats[1] - beats[0] : 0.5;
    for (const c of clips) {
      c.start = t;
      // end on the first beat at least one beat (and 0.4 s) after the start that the clip can reach
      const maxEnd = t + maxClipDuration(pp, c);
      const target = beats.find((b) => b >= t + Math.max(0.4, beatLen * 0.9) && b <= Math.min(maxEnd, t + c.duration + beatLen * 4)) ?? t + Math.min(c.duration, maxEnd - t);
      c.duration = Math.max(0.2, target - t);
      t = target;
    }
    E.compactMagnetic(pp);
  });
  toast('Cuts now land on the beat.');
}

export { trackItems, clamp };
