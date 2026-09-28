// Face detection (Ultra-Light-Fast face detector, MIT licence, bundled) and
// the tools built on it: automatic face blur and auto reframe.

import { store } from '../core/store.js';
import { sourceSpan, sourceTime, itemEnd, newBlurRegion, isVisualItem } from '../core/model.js';
import * as E from '../core/edit.js';
import { framesAt, frameTimes } from './frames.js';
import { session } from './segment.js';
import { sourceToProject } from '../core/props.js';
import { startJob, toast } from '../ui/notify.js';
import { clamp } from '../core/util.js';

const MODEL_URL = new URL('models/ultraface-rfb-320.onnx', document.baseURI).href;
let entry = null;

async function detector() {
  if (entry) return entry;
  const { InferenceSession, Tensor, env } = await import('onnxruntime-web/webgpu');
  env.wasm.wasmPaths = new URL('ort/', document.baseURI).href;
  env.logLevel = 'error';
  const buf = await (await fetch(MODEL_URL)).arrayBuffer();
  let s;
  try {
    s = await InferenceSession.create(buf, { executionProviders: self.__ortProviders || ['webgpu'], logSeverityLevel: 3 });
  } catch {
    s = await InferenceSession.create(buf, { executionProviders: ['wasm'], logSeverityLevel: 3 });
  }
  entry = { s, Tensor };
  return entry;
}
void session;

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Faces in a canvas as normalised boxes { x1, y1, x2, y2, score }. */
export async function detectFaces(canvas, threshold = 0.7) {
  const { s, Tensor } = await detector();
  const W = 320;
  const H = 240;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = (px[i * 4] - 127) / 128;
    input[n + i] = (px[i * 4 + 1] - 127) / 128;
    input[2 * n + i] = (px[i * 4 + 2] - 127) / 128;
  }
  const res = await s.run({ [s.inputNames[0]]: new Tensor('float32', input, [1, 3, H, W]) });
  const names = s.outputNames;
  const scores = res[names.find((x) => /score/i.test(x)) || names[0]].data;
  const boxes = res[names.find((x) => /box/i.test(x)) || names[1]].data;
  const found = [];
  const count = scores.length / 2;
  for (let i = 0; i < count; i++) {
    const sc = scores[i * 2 + 1];
    if (sc < threshold) continue;
    found.push({ x1: boxes[i * 4], y1: boxes[i * 4 + 1], x2: boxes[i * 4 + 2], y2: boxes[i * 4 + 3], score: sc });
  }
  found.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of found) if (!keep.some((k) => iou(k, f) > 0.3)) keep.push(f);
  return keep;
}

/**
 * Samples a clip at `fps` and links detections into tracks.
 * Returns [{ samples: [{ t, u, v, w, h }] }] with t in timeline seconds and
 * u/v/w/h in 0..1 of the source frame.
 */
export async function faceTracksForClip(it, { fps = 6, onProgress, signal } = {}) {
  const p = store.project;
  const m = p.media[it.mediaId];
  const times = frameTimes(it.start, itemEnd(it), fps);
  const srcTimes = times.map((t) => sourceTime(it, t));
  const tracks = [];
  let i = 0;
  for await (const f of framesAt(m, srcTimes, { width: 640 })) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const t = times[i++];
    onProgress?.(i / times.length);
    if (!f.canvas) continue;
    const faces = await detectFaces(f.canvas);
    for (const fc of faces) {
      const box = { u: (fc.x1 + fc.x2) / 2, v: (fc.y1 + fc.y2) / 2, w: fc.x2 - fc.x1, h: fc.y2 - fc.y1 };
      let best = null;
      let bestD = 0.25;
      for (const tr of tracks) {
        const last = tr.samples[tr.samples.length - 1];
        if (t - last.t > 1.5) continue;
        const d = Math.hypot(last.u - box.u, last.v - box.v);
        if (d < bestD && !tr._taken) {
          best = tr;
          bestD = d;
        }
      }
      if (best) {
        best.samples.push({ t, ...box });
        best._taken = true;
      } else tracks.push({ samples: [{ t, ...box }], _taken: true });
    }
    for (const tr of tracks) tr._taken = false;
  }
  return tracks.filter((tr) => tr.samples.length >= 2 || times.length < 3);
}

export async function faceBlur(it) {
  const p = store.project;
  const m = p.media[it.mediaId];
  if (!m || m.kind !== 'video' || m.status !== 'ready') return toast('Select a video clip that has finished preparing.', { kind: 'warn' });
  const job = startJob('Blur faces');
  try {
    job.update(0, 'Loading the face finder');
    const tracks = await faceTracksForClip(it, { onProgress: (f) => job.update(f, 'Looking for faces'), signal: job.signal });
    if (!tracks.length) {
      job.done();
      return toast('No faces were found in this clip.', { kind: 'warn' });
    }
    const ids = [];
    store.commit('Blur faces', (pp) => {
      for (const tr of tracks) {
        const s0 = tr.samples[0];
        const s1 = tr.samples[tr.samples.length - 1];
        const start = Math.max(it.start, s0.t - 0.2);
        const end = Math.min(itemEnd(it), s1.t + 0.4);
        const blur = newBlurRegion(null, start, Math.max(0.3, end - start));
        const maxW = Math.max(...tr.samples.map((s) => s.w));
        const maxH = Math.max(...tr.samples.map((s) => s.h));
        const mid = sourceToProject(pp, it, 0.5, 0.5, s0.t);
        blur.w = Math.max(40, maxW * mid.scale * 1.35);
        blur.h = Math.max(40, maxH * mid.scale * 1.5);
        blur.name = 'Face blur';
        blur.amount = 0.8;
        blur.kf.x = [];
        blur.kf.y = [];
        for (const s of tr.samples) {
          const pt = sourceToProject(pp, it, s.u, s.v, s.t);
          const lt = clamp(s.t - start, 0, blur.duration);
          blur.kf.x.push({ t: lt, v: pt.x - pp.settings.width / 2, e: 'linear' });
          blur.kf.y.push({ t: lt, v: pt.y - pp.settings.height / 2, e: 'linear' });
        }
        E.placeOverlay(pp, blur);
        ids.push(blur.id);
      }
    });
    store.select(ids);
    job.done(`Blurred ${tracks.length} face${tracks.length > 1 ? 's' : ''}. Check the whole clip, since a face turned away can be missed.`);
  } catch (e) {
    job.fail(e);
  }
}

export async function autoReframe(it) {
  const p = store.project;
  const m = p.media[it.mediaId];
  if (!m || m.kind !== 'video') return toast('Select a video clip.', { kind: 'warn' });
  const W = p.settings.width;
  const H = p.settings.height;
  const clipAspect = (m.width || 16) / (m.height || 9);
  if (Math.abs(clipAspect - W / H) < 0.05) return toast('This clip already has the same shape as the project.', { timeout: 3000 });
  const job = startJob('Auto reframe');
  try {
    const tracks = await faceTracksForClip(it, { fps: 4, onProgress: (f) => job.update(f, 'Following the subject'), signal: job.signal });
    // follow the biggest, longest-lived face
    const main = tracks.sort((a, b) => b.samples.length * avgW(b) - a.samples.length * avgW(a))[0];
    store.commit('Auto reframe', (pp) => {
      it.fit = 'cover';
      it.props.scale = 1;
      delete it.kf.x;
      delete it.kf.y;
      if (!main) {
        it.props.x = 0;
        it.props.y = 0;
        return;
      }
      const f = Math.max(W / m.width, H / m.height);
      const fullW = m.width * f;
      const fullH = m.height * f;
      const maxX = Math.max(0, (fullW - W) / 2);
      const maxY = Math.max(0, (fullH - H) / 2);
      // smooth the path with a moving average so the camera glides
      const raw = main.samples.map((s) => ({ t: s.t, x: clamp((0.5 - s.u) * fullW, -maxX, maxX), y: clamp((0.5 - s.v) * fullH * 0.6, -maxY, maxY) }));
      const sm = raw.map((r, i) => {
        const win = raw.slice(Math.max(0, i - 3), i + 4);
        return { t: r.t, x: win.reduce((a, b) => a + b.x, 0) / win.length, y: win.reduce((a, b) => a + b.y, 0) / win.length };
      });
      it.kf.x = [];
      it.kf.y = [];
      let lastT = -1;
      for (const s of sm) {
        if (s.t - lastT < 0.5) continue;
        lastT = s.t;
        it.kf.x.push({ t: clamp(s.t - it.start, 0, it.duration), v: Math.round(s.x), e: 'smooth' });
        it.kf.y.push({ t: clamp(s.t - it.start, 0, it.duration), v: Math.round(s.y), e: 'smooth' });
      }
      void pp;
    });
    job.done(main ? 'The frame now follows the subject.' : null);
    if (!main) toast('No face was found, so the clip fills the frame from the centre. Drag it on the preview to choose the framing.', { timeout: 5000 });
  } catch (e) {
    job.fail(e);
  }
}

function avgW(tr) {
  return tr.samples.reduce((a, s) => a + s.w, 0) / tr.samples.length;
}

export { isVisualItem, sourceSpan };
