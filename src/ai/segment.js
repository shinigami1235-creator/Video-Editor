// Background removal with an ONNX segmentation model (U2-Net human or ISNet)
// running on the GPU through WebGPU, falling back to the CPU.
// Video results are stored as "packed alpha" clips: the picture on top, the
// cut-out mask below, so the preview and export read both from one file.

import { store } from '../core/store.js';
import { sourceSpan, maxClipDuration } from '../core/model.js';
import { ensureSegModel, SEG_MODELS } from '../media/tools.js';
import { addDerivedMedia, derivedDir, runtime } from '../media/library.js';
import { fileUrl, join, mkdir, exists, writeBytes } from '../backend/index.js';
import { framesAt, frameTimes } from './frames.js';
import { startJob, modal, toast } from '../ui/notify.js';
import { h, button } from '../ui/dom.js';
import { Output, Mp4OutputFormat, StreamTarget, CanvasSource } from 'mediabunny';
import { revertMedia } from './processing.js';

let ortPromise = null;
async function ort() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web/webgpu').then((mod) => {
      mod.env.wasm.wasmPaths = new URL('ort/', document.baseURI).href;
      mod.env.logLevel = 'error';
      mod.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      return mod;
    });
  }
  return ortPromise;
}

const sessions = new Map();
export async function session(modelPath) {
  if (sessions.has(modelPath)) return sessions.get(modelPath);
  const o = await ort();
  const buf = await (await fetch(fileUrl(modelPath))).arrayBuffer();
  let s;
  try {
    s = await o.InferenceSession.create(buf, { executionProviders: self.__ortProviders || ['webgpu'], logSeverityLevel: 3 });
  } catch (e) {
    console.warn('WebGPU unavailable for the model, using the CPU', e);
    s = await o.InferenceSession.create(buf, { executionProviders: ['wasm'], logSeverityLevel: 3 });
  }
  const entry = { s, o };
  sessions.set(modelPath, entry);
  return entry;
}

/** Returns a Float32 mask (size x size, 0..1) for a canvas. */
export async function maskFor(entry, canvas, size, key) {
  const { s, o } = entry;
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const n = size * size;
  const input = new Float32Array(3 * n);
  const isnet = key === 'object';
  const mean = isnet ? [0.5, 0.5, 0.5] : [0.485, 0.456, 0.406];
  const std = isnet ? [1, 1, 1] : [0.229, 0.224, 0.225];
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  const scale = 1 / Math.max(1, mx);
  for (let i = 0; i < n; i++) {
    input[i] = (px[i * 4] * scale - mean[0]) / std[0];
    input[n + i] = (px[i * 4 + 1] * scale - mean[1]) / std[1];
    input[2 * n + i] = (px[i * 4 + 2] * scale - mean[2]) / std[2];
  }
  const feeds = { [s.inputNames[0]]: new o.Tensor('float32', input, [1, 3, size, size]) };
  const res = await s.run(feeds);
  const out = res[s.outputNames[0]].data;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }
  const mask = new Float32Array(n);
  const r = hi - lo || 1;
  for (let i = 0; i < n; i++) mask[i] = (out[i] - lo) / r;
  for (const t of Object.values(res)) t.dispose?.();
  return mask;
}

function maskCanvas(mask, size) {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(Math.min(1, Math.max(0, (mask[i] - 0.05) / 0.9)) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function askModel() {
  return new Promise((resolve) => {
    const m = modal(
      'Remove background',
      h(
        'div',
        { class: 'stack' },
        h('p', {}, 'What should stay in the picture?'),
        ...Object.entries(SEG_MODELS).map(([k, v]) => button(`${v.label} (${v.mb} MB model)`, () => m.close(k), { kind: k === 'person' ? 'primary' : '' })),
        h('p', { class: 'hint' }, 'The model downloads once, then runs on this computer.'),
      ),
      { width: 440, onClose: (v) => resolve(v) },
    );
  });
}

export async function removeBackground(it) {
  if (it.derivations?.includes('bg')) return revertMedia(it);
  const p = store.project;
  const m = p.media[it.mediaId];
  if (!m || m.status !== 'ready') return toast('Wait until the clip has finished preparing.', { kind: 'warn' });
  const key = await askModel();
  if (!key) return;
  const job = startJob('Remove background');
  try {
    const model = await ensureSegModel(key, (pr) => job.download(pr), job.signal);
    job.update(null, 'Loading the model');
    const entry = await session(model.path);
    if (m.kind === 'image') await removeFromImage(it, m, entry, model, key, job);
    else await removeFromVideo(it, m, entry, model, key, job);
    job.done('Background removed.');
  } catch (e) {
    job.fail(e);
  }
}

async function removeFromImage(it, m, entry, model, key, job) {
  const { loadImage } = await import('../media/library.js');
  const bmp = await loadImage(m.display || m.path);
  job.update(0.3, 'Finding the subject');
  const mask = await maskFor(entry, bmp, model.size, key);
  const mc = maskCanvas(mask, model.size);
  const out = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(mc, 0, 0, bmp.width, bmp.height);
  // use the mask's brightness as alpha
  const md = ctx.getImageData(0, 0, bmp.width, bmp.height);
  ctx.clearRect(0, 0, bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  const cd = ctx.getImageData(0, 0, bmp.width, bmp.height);
  for (let i = 0; i < cd.data.length; i += 4) cd.data[i + 3] = md.data[i];
  ctx.putImageData(cd, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  const dir = derivedDir(m, 'bg|' + key);
  await mkdir(dir);
  const file = join(dir, 'cutout.png');
  await writeBytes(file, new Uint8Array(await blob.arrayBuffer()), { offset: 0, truncate: true });
  const { uid, hashString } = await import('../core/util.js');
  const d = {
    id: uid('m'),
    path: file,
    display: file,
    name: m.name + ' (cut out)',
    kind: 'image',
    width: bmp.width,
    height: bmp.height,
    duration: 0,
    fps: 0,
    hasAudio: false,
    cacheKey: hashString(file),
    status: 'ready',
    progress: 1,
    hidden: true,
    sourceId: m.id,
    imported: Date.now(),
  };
  store.project.media[d.id] = d;
  store.commit('Remove background', () => {
    it.origMediaId ||= it.mediaId;
    it.mediaId = d.id;
    it.derivations = [...(it.derivations || []), 'bg'];
  });
}

async function removeFromVideo(it, m, entry, model, key, job) {
  const span = sourceSpan(it);
  if (span > 180) throw new Error('Background removal works on up to 3 minutes of footage at a time. Split the clip first.');
  const fps = m.fps || 30;
  const start = it.in;
  const times = frameTimes(start, start + span, fps);
  const fullKey = `bg|${key}|${start.toFixed(3)}+${span.toFixed(3)}|${runtime.codec}`;
  const dir = derivedDir(m, fullKey);
  await mkdir(dir);
  const out = join(dir, 'packed.mp4');
  const W = m.editWidth || m.width;
  const H = m.editHeight || m.height;
  const vertical = W >= H; // stack vertically for wide clips, side by side for tall ones
  const pw = vertical ? W : W * 2;
  const ph = vertical ? H * 2 : H;
  if (!(await exists(out))) {
    const vOnly = m.hasAudio ? join(dir, 'packed-video.mp4') : out;
    await encodePacked(vOnly);
    if (m.hasAudio) {
      job.update(null, 'Adding the sound back');
      const { ffmpeg } = await import('../media/ffmpeg.js');
      await ffmpeg(['-i', vOnly, '-ss', start.toFixed(3), '-t', span.toFixed(3), '-i', m.edit, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', out]);
      const { remove } = await import('../backend/index.js');
      await remove(vOnly).catch(() => {});
    }
  }
  async function encodePacked(out) {
    const canvas = new OffscreenCanvas(pw, ph);
    const ctx = canvas.getContext('2d');
    await writeBytes(out, new Uint8Array(0), { offset: 0, truncate: true });
    const writable = new WritableStream({ write: (c) => writeBytes(out, c.data, { offset: c.position }) });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true }) });
    const codec = runtime.codec === 'h264' ? 'avc' : 'vp9';
    const src = new CanvasSource(canvas, { codec, bitrate: Math.round(W * H * fps * 0.25), keyFrameInterval: 0.5 });
    output.addVideoTrack(src, { frameRate: fps });
    await output.start();
    let prev = null;
    let i = 0;
    const t0 = performance.now();
    try {
      for await (const f of framesAt(m, times, { width: W })) {
        if (job.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (!f.canvas) {
          i++;
          continue;
        }
        let mask = await maskFor(entry, f.canvas, model.size, key);
        if (prev) for (let k = 0; k < mask.length; k++) mask[k] = mask[k] * 0.65 + prev[k] * 0.35;
        prev = mask;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, pw, ph);
        ctx.drawImage(f.canvas, 0, 0, W, H);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(maskCanvas(mask, model.size), vertical ? 0 : W, vertical ? H : 0, W, H);
        await src.add(i / fps, 1 / fps);
        i++;
        const el = (performance.now() - t0) / 1000;
        job.update(i / times.length, `Frame ${i} of ${times.length}${i > 5 ? `, about ${Math.round((el / i) * (times.length - i))}s left` : ''}`);
      }
      await output.finalize();
    } catch (e) {
      await output.cancel().catch(() => {});
      const { remove } = await import('../backend/index.js');
      await remove(out).catch(() => {});
      throw e;
    }
  }
  job.update(null, 'Preparing the cut-out clip');
  const d = await addDerivedMedia(m, out, { name: m.name + ' (cut out)', key: fullKey, alphaPacked: vertical ? 'v' : 'h', editReady: true, keepDuration: false });
  store.commit('Remove background', () => {
    it.origMediaId ||= it.mediaId;
    it.origIn ??= it.in;
    it.in = 0;
    it.mediaId = d.id;
    it.derivations = [...(it.derivations || []), 'bg'];
    it.duration = Math.min(it.duration, maxClipDuration(store.project, it));
  });
}
