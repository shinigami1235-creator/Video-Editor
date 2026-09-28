// Pitch, tone (EQ) and speed settings for a clip's sound. The preview uses the
// same numbers through WebAudio filters and a pitched copy of the sound, and
// the export applies them in audio-mix.js, so both sound the same.

import { join, exists, rename, remove } from '../backend/index.js';
import { runProcess } from '../backend/proc.js';
import { tools } from './tools.js';
import { ffmpeg } from './ffmpeg.js';
import { mediaDir } from './library.js';

const SR = 48000;

export const EQ_BANDS = [
  { key: 'low', label: 'Bass', type: 'lowshelf', f: 150, q: 0.707 },
  { key: 'mid', label: 'Middle', type: 'peaking', f: 1500, q: 0.8 },
  { key: 'high', label: 'Treble', type: 'highshelf', f: 5000, q: 0.707 },
];

export const TONE_PRESETS = {
  none: { name: 'Flat', eq: { low: 0, mid: 0, high: 0 } },
  clear: { name: 'Clear voice', eq: { low: -4, mid: 2, high: 4 } },
  warm: { name: 'Warm', eq: { low: 4, mid: 0, high: -2 } },
  bass: { name: 'More bass', eq: { low: 7, mid: 0, high: 0 } },
  bright: { name: 'Bright', eq: { low: -1, mid: 1, high: 6 } },
  phone: { name: 'Phone call', eq: { low: -18, mid: 6, high: -14 } },
  muffled: { name: 'Next room', eq: { low: 2, mid: -6, high: -18 } },
};

export function audioFx(it) {
  const a = it?.audioFx || {};
  return {
    pitch: Number(a.pitch) || 0,
    keepPitch: a.keepPitch !== false,
    eq: { low: a.eq?.low || 0, mid: a.eq?.mid || 0, high: a.eq?.high || 0 },
    tone: a.tone || 'none',
  };
}

export const hasEq = (it) => {
  const e = audioFx(it).eq;
  return !!(e.low || e.mid || e.high);
};

export const pitchKey = (semis) => 'p' + (Math.round(semis * 10) / 10).toFixed(1).replace('-', 'm').replace('.', '_');

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

let rubberband = null;
async function hasRubberband() {
  if (rubberband != null) return rubberband;
  try {
    const { lines } = await runProcess(tools.ffmpeg, ['-hide_banner', '-filters'], { keep: 5000 });
    rubberband = lines.some((l) => /\srubberband\s/.test(l));
  } catch {
    rubberband = false;
  }
  return rubberband;
}

function atempo(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  while (s > 2) {
    parts.push('atempo=2.0');
    s /= 2;
  }
  parts.push('atempo=' + s.toFixed(6));
  return parts;
}

async function pitchFilter(semis) {
  const r = Math.pow(2, semis / 12);
  if (await hasRubberband()) return `rubberband=pitch=${r.toFixed(6)}:pitchq=quality:transients=smooth`;
  return [`asetrate=${Math.round(SR * r)}`, `aresample=${SR}`, ...atempo(1 / r)].join(',');
}

const pending = new Map();
const verified = new Map(); // media id + key -> { pcm, play } checked on disk this session
const failed = new Set(); // keys that failed, so the preview does not retry every frame

/**
 * Makes the pitched copies of a media file's sound: raw PCM for the export and
 * an AAC file the preview can play. Cached next to the edit copy. Each file is
 * written under a temporary name first, so a cancelled job leaves nothing half made.
 */
export function ensurePitched(m, semis, { signal, retry = false } = {}) {
  if (!semis || !m?.pcm) return Promise.resolve(null);
  const key = pitchKey(semis);
  const id = m.id + key;
  if (verified.has(id)) return Promise.resolve(verified.get(id));
  if (retry) failed.delete(id);
  if (failed.has(id)) return Promise.reject(new Error('Changing the pitch failed for this clip.'));
  if (pending.has(id)) return pending.get(id);
  const job = (async () => {
    const dir = mediaDir(m);
    const pcm = join(dir, `audio_${key}.f32`);
    const play = join(dir, `audio_${key}.m4a`);
    if (!(await exists(pcm))) {
      const af = await pitchFilter(semis);
      await ffmpeg(['-f', 'f32le', '-ac', '2', '-ar', String(SR), '-i', m.pcm, '-af', af, '-f', 'f32le', '-ac', '2', '-ar', String(SR), pcm + '.part'], { duration: m.duration, signal });
      await rename(pcm + '.part', pcm);
    }
    if (!(await exists(play))) {
      await ffmpeg(['-f', 'f32le', '-ac', '2', '-ar', String(SR), '-i', pcm, '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', play + '.part'], { duration: m.duration, signal });
      await rename(play + '.part', play);
    }
    m.fx ||= {};
    m.fx[key] = { pcm, play };
    verified.set(id, m.fx[key]);
    return m.fx[key];
  })();
  pending.set(id, job);
  job.catch((e) => {
    if (e?.name !== 'AbortError') failed.add(id);
    remove(join(mediaDir(m), `audio_${key}.f32.part`)).catch(() => {});
    remove(join(mediaDir(m), `audio_${key}.m4a.part`)).catch(() => {});
  });
  job.finally(() => pending.delete(id));
  return job;
}

/** The pitched files if they were made or checked this session, else null. */
export function pitchedSync(m, semis) {
  if (!semis || !m) return null;
  return verified.get(m.id + pitchKey(semis)) || null;
}

export function pitchFailed(m, semis) {
  return !!m && failed.has(m.id + pitchKey(semis));
}

// ---------------------------------------------------------------------------
// Tone (EQ). Same formulas as the WebAudio BiquadFilterNode so the preview
// and the export match.
// ---------------------------------------------------------------------------

export function biquad(type, f, gainDb, q, sr = SR) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sr;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peaking') {
    const alpha = sn / (2 * q);
    b0 = 1 + alpha * A;
    b1 = -2 * cs;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cs;
    a2 = 1 - alpha / A;
  } else {
    const alpha = (sn / 2) * Math.SQRT2;
    const s = 2 * Math.sqrt(A) * alpha;
    if (type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cs + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cs);
      b2 = A * (A + 1 - (A - 1) * cs - s);
      a0 = A + 1 + (A - 1) * cs + s;
      a1 = -2 * (A - 1 + (A + 1) * cs);
      a2 = A + 1 + (A - 1) * cs - s;
    } else {
      b0 = A * (A + 1 + (A - 1) * cs + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cs);
      b2 = A * (A + 1 + (A - 1) * cs - s);
      a0 = A + 1 - (A - 1) * cs + s;
      a1 = 2 * (A - 1 - (A + 1) * cs);
      a2 = A + 1 - (A - 1) * cs - s;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Runs the three EQ bands over interleaved stereo samples, keeping state between calls. */
export class EqChain {
  constructor(eq) {
    this.stages = EQ_BANDS.filter((b) => eq[b.key]).map((b) => ({ c: biquad(b.type, b.f, eq[b.key], b.q), s: [0, 0, 0, 0, 0, 0, 0, 0] }));
  }
  get active() {
    return this.stages.length > 0;
  }
  process(buf) {
    for (const st of this.stages) {
      const [b0, b1, b2, a1, a2] = st.c;
      const s = st.s;
      for (let ch = 0; ch < 2; ch++) {
        let x1 = s[ch * 4], x2 = s[ch * 4 + 1], y1 = s[ch * 4 + 2], y2 = s[ch * 4 + 3];
        for (let i = ch; i < buf.length; i += 2) {
          const x = buf[i];
          const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
          buf[i] = y;
        }
        s[ch * 4] = x1;
        s[ch * 4 + 1] = x2;
        s[ch * 4 + 2] = y1;
        s[ch * 4 + 3] = y2;
      }
    }
    return buf;
  }
}

/** Frequency response in dB at f, for drawing the tone curve. */
export function eqResponse(eq, f, sr = SR) {
  let db = 0;
  for (const b of EQ_BANDS) {
    if (!eq[b.key]) continue;
    const [b0, b1, b2, a1, a2] = biquad(b.type, b.f, eq[b.key], b.q, sr);
    const w = (2 * Math.PI * f) / sr;
    const re = (c0, c1, c2) => c0 + c1 * Math.cos(-w) + c2 * Math.cos(-2 * w);
    const im = (c1, c2) => c1 * Math.sin(-w) + c2 * Math.sin(-2 * w);
    const nr = re(b0, b1, b2), ni = im(b1, b2);
    const dr = re(1, a1, a2), di = im(a1, a2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}
