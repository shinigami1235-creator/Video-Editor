// Reading the float PCM audio each media file keeps next to its edit copy.

import { readBytes } from '../backend/index.js';
export { getPeaks } from './library.js';

const SR = 48000;

/** Mono samples of [start, end) seconds, resampled down to `rate` by averaging. */
export async function readPcmMono(m, start, end, rate = 11025) {
  if (!m?.pcm) throw new Error('This clip has no sound data.');
  const f0 = Math.max(0, Math.floor(start * SR));
  const f1 = Math.max(f0, Math.floor(end * SR));
  const ratio = SR / rate;
  const out = new Float32Array(Math.floor((f1 - f0) / ratio));
  const chunk = SR * 20;
  let oi = 0;
  let acc = 0;
  let n = 0;
  let next = ratio;
  let pos = 0;
  for (let f = f0; f < f1; f += chunk) {
    const frames = Math.min(chunk, f1 - f);
    const bytes = await readBytes(m.pcm, f * 8, frames * 8);
    const s = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    for (let i = 0; i + 1 < s.length; i += 2) {
      acc += (s[i] + s[i + 1]) * 0.5;
      n++;
      pos++;
      if (pos >= next) {
        if (oi < out.length) out[oi++] = acc / n;
        acc = 0;
        n = 0;
        next += ratio;
      }
    }
  }
  return out.subarray(0, oi);
}
