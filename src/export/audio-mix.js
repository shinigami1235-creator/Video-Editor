// Mixes every audible clip into one 48 kHz stereo float WAV for export.
// Reads only the needed ranges of each clip's PCM file, so long projects stay
// light on memory.

import { readBytes, writeBytes, exists, join } from '../backend/index.js';
import { itemEnd, sourceTime, propAt, trackItems } from '../core/model.js';
import { clamp } from '../core/util.js';
import { peaksSync, getPeaks, mediaDir } from '../media/library.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { audioFx, ensurePitched, EqChain } from '../media/audio-fx.js';

const SR = 48000;

export function audibleItems(project, t0 = 0, t1 = Infinity) {
  const out = [];
  for (const tr of project.tracks) {
    if (tr.muted) continue;
    for (const it of trackItems(project, tr.id)) {
      if (it.type !== 'clip' || it.muted || it.freeze) continue;
      const m = project.media[it.mediaId];
      if (!m?.hasAudio || !m.pcm) continue;
      if (itemEnd(it) <= t0 || it.start >= t1) continue;
      out.push(it);
    }
  }
  return out;
}

/** True when a non-music clip has speech or sound near time t (used for ducking). */
export function voiceActive(project, t, items) {
  for (const it of items) {
    if (it.duck) continue;
    if (t < it.start || t >= itemEnd(it)) continue;
    const m = project.media[it.mediaId];
    const peaks = peaksSync(m);
    if (!peaks) return true;
    const i = Math.floor(sourceTime(it, t) * 100);
    for (let k = Math.max(0, i - 15); k < Math.min(peaks.length, i + 15); k++) if (peaks[k] > 50) return true;
  }
  return false;
}

export function trackVolume(project, it) {
  const tr = project.tracks.find((x) => x.id === it.trackId);
  return tr?.volume ?? 1;
}

function baseGain(project, it, t) {
  let g = propAt(it, 'volume', t) * trackVolume(project, it);
  const local = t - it.start;
  if (it.fadeIn > 0 && local < it.fadeIn) g *= clamp(local / it.fadeIn, 0, 1);
  if (it.fadeOut > 0 && local > it.duration - it.fadeOut) g *= clamp((it.duration - local) / it.fadeOut, 0, 1);
  return Math.max(0, g);
}

function atempoChain(speed) {
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
  parts.push('atempo=' + s.toFixed(5));
  return parts.join(',');
}

/** PCM file for a clip at constant speed (pitch kept), made once and cached. */
async function pcmForSpeed(m, speed, base = m.pcm, tag = '') {
  if (Math.abs(speed - 1) < 1e-3) return base;
  const out = join(mediaDir(m), `audio${tag}_s${speed.toFixed(3)}.f32`);
  if (!(await exists(out))) {
    await ffmpeg(['-f', 'f32le', '-ac', '2', '-ar', String(SR), '-i', base, '-af', atempoChain(speed), '-f', 'f32le', '-ac', '2', '-ar', String(SR), out]);
  }
  return out;
}

function wavHeader(dataBytes) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, 2, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 8, true);
  v.setUint16(32, 8, true);
  v.setUint16(34, 32, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(b);
}

async function readPcm(path, startFrame, frames) {
  if (frames <= 0) return new Float32Array(0);
  const s = Math.max(0, startFrame);
  const pad = s - startFrame;
  const bytes = await readBytes(path, s * 8, (frames - pad) * 8);
  const out = new Float32Array(frames * 2);
  const n = Math.floor(bytes.byteLength / 4);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, n);
  out.set(f.subarray(0, Math.min(f.length, out.length - pad * 2)), pad * 2);
  return out;
}

/**
 * Writes the mix of [t0, t1) to outPath. Returns true when anything audible
 * was found (a silent WAV is still written otherwise).
 */
export async function mixAudio(project, t0, t1, outPath, { onProgress, signal } = {}) {
  const items = audibleItems(project, t0, t1);
  for (const it of items) await getPeaks(project.media[it.mediaId]);
  const prepared = [];
  for (const it of items) {
    const m = project.media[it.mediaId];
    const fx = audioFx(it);
    let base = m.pcm;
    let tag = '';
    if (fx.pitch) {
      const pf = await ensurePitched(m, fx.pitch, { signal });
      base = pf.pcm;
      tag = '_' + fx.pitch.toFixed(1).replace('.', '_');
    }
    // with "keep pitch" off, constant speed is resampled so the pitch follows the speed
    const constant = !it.speedCurve && fx.keepPitch;
    const pcm = constant ? await pcmForSpeed(m, it.speed || 1, base, tag) : base;
    const eq = new EqChain(fx.eq);
    prepared.push({ it, m, pcm, constant, speed: it.speed || 1, eq: eq.active ? eq : null });
  }
  const totalFrames = Math.max(1, Math.round((t1 - t0) * SR));
  await writeBytes(outPath, wavHeader(totalFrames * 8), { offset: 0, truncate: true });
  const chunk = SR * 5;
  const duckLevel = project.settings.duckLevel ?? 0.25;
  let duck = 1;
  const ducking = items.some((i) => i.duck);
  for (let f0 = 0; f0 < totalFrames; f0 += chunk) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const frames = Math.min(chunk, totalFrames - f0);
    const mix = new Float32Array(frames * 2);
    const ct0 = t0 + f0 / SR;
    const ct1 = ct0 + frames / SR;
    // duck envelope at 10 ms steps with attack/release smoothing
    const steps = Math.ceil(frames / 480) + 1;
    const duckEnv = new Float32Array(steps);
    for (let s = 0; s < steps; s++) {
      const t = ct0 + (s * 480) / SR;
      const target = ducking && voiceActive(project, t, items) ? duckLevel : 1;
      duck += (target - duck) * (target < duck ? 0.25 : 0.06);
      duckEnv[s] = duck;
    }
    for (const p of prepared) {
      const { it } = p;
      const a = Math.max(ct0, it.start);
      const b = Math.min(ct1, itemEnd(it));
      if (b <= a) continue;
      const outStart = Math.round((a - ct0) * SR);
      const n = Math.min(frames - outStart, Math.round((b - a) * SR));
      if (n <= 0) continue;
      let src;
      if (p.constant) {
        const srcStartSec = it.in / p.speed + (a - it.start);
        src = await readPcm(p.pcm, Math.round(srcStartSec * SR), n);
      } else {
        // variable speed: resample from the original PCM (pitch follows speed)
        const s0 = sourceTime(it, a);
        const s1 = sourceTime(it, b);
        const lo = Math.floor(Math.min(s0, s1) * SR) - 2;
        const hi = Math.ceil(Math.max(s0, s1) * SR) + 2;
        const raw = await readPcm(p.pcm, lo, hi - lo);
        src = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          const st = sourceTime(it, a + i / SR);
          const x = st * SR - lo;
          const i0 = Math.floor(x);
          const fr = x - i0;
          const j = clamp(i0, 0, hi - lo - 2);
          src[i * 2] = raw[j * 2] * (1 - fr) + raw[j * 2 + 2] * fr;
          src[i * 2 + 1] = raw[j * 2 + 1] * (1 - fr) + raw[j * 2 + 3] * fr;
        }
      }
      if (p.eq) p.eq.process(src);
      // gain envelope at 10 ms steps, interpolated per sample
      // left / right placement, the same constant-power law as the preview's StereoPannerNode
      const pan = Math.max(-1, Math.min(1, it.pan || 0));
      let lL = 1;
      let rL = 0;
      let lR = 0;
      let rR = 1;
      if (pan < 0) {
        const x = ((pan + 1) * Math.PI) / 2;
        rL = Math.cos(x);
        rR = Math.sin(x);
      } else if (pan > 0) {
        const x = (pan * Math.PI) / 2;
        lL = Math.cos(x);
        lR = Math.sin(x);
      }
      const gsteps = Math.ceil(n / 480) + 1;
      const genv = new Float32Array(gsteps);
      for (let s = 0; s < gsteps; s++) genv[s] = baseGain(project, it, a + (s * 480) / SR);
      for (let i = 0; i < n; i++) {
        const gi = i / 480;
        const g0 = Math.floor(gi);
        const g = genv[g0] + (genv[Math.min(gsteps - 1, g0 + 1)] - genv[g0]) * (gi - g0);
        let d = 1;
        if (it.duck) {
          const di = (outStart + i) / 480;
          const d0 = Math.floor(di);
          d = duckEnv[d0] + (duckEnv[Math.min(steps - 1, d0 + 1)] - duckEnv[d0]) * (di - d0);
        }
        const o = (outStart + i) * 2;
        const L = src[i * 2] * g * d;
        const R = src[i * 2 + 1] * g * d;
        mix[o] += L * lL + R * rL;
        mix[o + 1] += L * lR + R * rR;
      }
    }
    // soft limit peaks above 0.9 so loud mixes do not clip hard
    for (let i = 0; i < mix.length; i++) {
      const v = mix[i];
      const av = Math.abs(v);
      if (av > 0.9) mix[i] = Math.sign(v) * (0.9 + 0.1 * Math.tanh((av - 0.9) / 0.1));
    }
    await writeBytes(outPath, new Uint8Array(mix.buffer), { offset: 44 + f0 * 8 });
    onProgress?.(Math.min(1, (f0 + frames) / totalFrames));
  }
  return items.length > 0;
}
