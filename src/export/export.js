// Frame-accurate export. Every frame is decoded with WebCodecs, drawn by the
// same compositor as the preview, encoded, then FFmpeg adds the audio mix.

import { Output, Mp4OutputFormat, StreamTarget, CanvasSource, Input, UrlSource, ALL_FORMATS, VideoSampleSink, canEncodeVideo } from 'mediabunny';
import { Compositor, framePlan, planSources } from '../render/compositor.js';
import { fileUrl, writeBytes, remove, join, paths, mkdir, dirname, stripExt, basename, writeText } from '../backend/index.js';
import { loadImage } from '../media/library.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { mixAudio } from './audio-mix.js';
import { srtTime, uid, clamp } from '../core/util.js';
import { itemEnd, projectDuration } from '../core/model.js';

export const EXPORT_PRESETS = [
  { id: 'reels', name: 'Instagram Reels, TikTok, Stories', w: 1080, h: 1920, fps: 30, bitrate: 12, aspect: 9 / 16 },
  { id: 'feed45', name: 'Instagram and Facebook feed 4:5', w: 1080, h: 1350, fps: 30, bitrate: 10, aspect: 4 / 5 },
  { id: 'square', name: 'Square post 1:1', w: 1080, h: 1080, fps: 30, bitrate: 10, aspect: 1 },
  { id: 'yt1080', name: 'YouTube and Facebook 1080p', w: 1920, h: 1080, fps: 30, bitrate: 14, aspect: 16 / 9 },
  { id: 'yt4k', name: 'YouTube 4K', w: 3840, h: 2160, fps: 30, bitrate: 45, aspect: 16 / 9 },
  { id: 'lecture', name: 'Lecture 1080p, small file', w: 1920, h: 1080, fps: 30, bitrate: 6, aspect: 16 / 9 },
];

/** Output sizes offered for a project, keeping its aspect ratio. */
export function sizeOptions(project) {
  const { width: W, height: H } = project.settings;
  const short = Math.min(W, H);
  const out = [];
  for (const s of [480, 720, 1080, 1440, 2160]) {
    const k = s / short;
    const w = Math.round((W * k) / 2) * 2;
    const h = Math.round((H * k) / 2) * 2;
    out.push({ label: `${s}p (${w} x ${h})`, w, h, short: s });
  }
  return out;
}

class ExportSources {
  constructor(project) {
    this.project = project;
    this.state = new Map(); // item id -> { input, sink, iter, cur, next, frame }
    this.bitmaps = new Map();
    this.frames = new Map();
  }

  async _open(it, m) {
    let s = this.state.get(it.id);
    if (s) return s;
    const input = new Input({ source: new UrlSource(fileUrl(m.edit)), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${m.name} has no video track in its edit copy.`);
    s = { input, sink: new VideoSampleSink(track), iter: null, cur: null, next: null, frame: null, lastTime: -1 };
    this.state.set(it.id, s);
    return s;
  }

  async _sampleAt(s, time) {
    const eps = 1e-4;
    const restart = !s.iter || time < s.lastTime - eps || time - s.lastTime > 3;
    if (restart) {
      await s.iter?.return?.();
      s.cur?.close();
      s.next?.close();
      s.cur = null;
      s.next = null;
      s.iter = s.sink.samples(Math.max(0, time - 0.001));
      const first = await s.iter.next();
      s.cur = first.done ? null : first.value;
      const second = s.cur ? await s.iter.next() : { done: true };
      s.next = second.done ? null : second.value;
    }
    while (s.next && s.next.timestamp <= time + eps) {
      s.cur?.close();
      s.cur = s.next;
      const n = await s.iter.next();
      s.next = n.done ? null : n.value;
    }
    s.lastTime = time;
    return s.cur;
  }

  /** Loads every frame needed at time t. */
  async prepare(plan, t) {
    const needed = planSources(this.project, plan, t);
    this.frames.clear();
    for (const n of needed) {
      if (n.media.kind === 'image') {
        const path = n.media.display || n.media.path;
        if (!this.bitmaps.has(path)) this.bitmaps.set(path, await loadImage(path));
        const b = this.bitmaps.get(path);
        this.frames.set(n.item.id, { image: b, w: b.width, h: b.height });
        continue;
      }
      const s = await this._open(n.item, n.media);
      const sample = await this._sampleAt(s, n.time);
      if (!sample) continue;
      if (s.frameOf !== sample) {
        s.frame?.close();
        s.frame = sample.toVideoFrame();
        s.frameOf = sample;
      }
      this.frames.set(n.item.id, { image: s.frame, w: s.frame.displayWidth, h: s.frame.displayHeight });
    }
    // close decoders for clips that are finished
    for (const [id, s] of this.state) {
      const it = this.project.items[id];
      if (it && itemEnd(it) + 2 < t) {
        await this._close(id, s);
      }
    }
  }

  frame(it) {
    return this.frames.get(it.id) || null;
  }

  async _close(id, s) {
    try {
      await s.iter?.return?.();
    } catch {}
    s.cur?.close();
    s.next?.close();
    s.frame?.close();
    s.input?.dispose?.();
    this.state.delete(id);
  }

  async dispose() {
    for (const [id, s] of [...this.state]) await this._close(id, s);
  }
}

export async function pickVideoCodec(w, h, bitrate) {
  for (const codec of ['avc', 'vp9', 'av1', 'vp8']) {
    try {
      if (await canEncodeVideo(codec, { width: w, height: h, bitrate })) return codec;
    } catch {}
  }
  throw new Error(paths.platform === 'macos' ? 'This Mac cannot encode video in the app. Update macOS to 13.3 or newer, then try again.' : 'This computer cannot encode video in the app. Update Windows and the WebView2 runtime, then try again.');
}

/**
 * Renders [t0, t1) of the project to an MP4.
 * opts: { out, width, height, fps, bitrateMbps, t0, t1, loudnorm, onProgress, signal, format }
 */
export async function exportVideo(project, opts) {
  const { out, fps = 30, bitrateMbps = 12, loudnorm = false, onProgress, signal } = opts;
  // encoders need even frame sizes
  const width = Math.max(2, Math.round(opts.width / 2) * 2);
  const height = Math.max(2, Math.round((opts.height || (opts.width * project.settings.height) / project.settings.width) / 2) * 2);
  const t0 = opts.t0 ?? 0;
  const t1 = opts.t1 ?? projectDuration(project);
  const duration = Math.max(1 / fps, t1 - t0);
  const frames = Math.max(1, Math.round(duration * fps));
  const bitrate = Math.round(bitrateMbps * 1e6);
  const codec = await pickVideoCodec(width, height, bitrate);
  const tmpDir = join(paths.temp, 've-export-' + uid(''));
  await mkdir(tmpDir);
  const videoTmp = join(tmpDir, 'video.mp4');
  const audioTmp = join(tmpDir, 'audio.wav');
  const report = (stage, f) => onProgress?.({ stage, fraction: clamp(f, 0, 1) });

  const canvas = new OffscreenCanvas(width, height);
  const comp = new Compositor(canvas);
  await comp.preload(project);
  const sources = new ExportSources(project);
  const scale = width / project.settings.width;
  let output = null;
  try {
    await writeBytes(videoTmp, new Uint8Array(0), { offset: 0, truncate: true });
    const writable = new WritableStream({
      async write(chunk) {
        await writeBytes(videoTmp, chunk.data, { offset: chunk.position });
      },
    });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
    const src = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2, latencyMode: 'quality' });
    output.addVideoTrack(src, { frameRate: fps });
    await output.start();
    const started = performance.now();
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const t = t0 + i / fps;
      const plan = framePlan(project, t);
      await sources.prepare(plan, t);
      comp.render(project, t, sources, { scale, plan, size: [width, height] });
      await src.add(i / fps, 1 / fps);
      if (i % 3 === 0) {
        const el = (performance.now() - started) / 1000;
        const eta = i > 5 ? (el / (i + 1)) * (frames - i - 1) : null;
        onProgress?.({ stage: 'Rendering frames', fraction: (i + 1) / frames, frame: i + 1, frames, eta });
      }
    }
    await output.finalize();
    output = null;
  } finally {
    if (output) await output.cancel().catch(() => {});
    await sources.dispose();
    comp.dispose();
  }

  report('Mixing audio', 0);
  await mixAudio(project, t0, t1, audioTmp, { signal, onProgress: (f) => report('Mixing audio', f) });

  report('Finishing the file', 0);
  const args = ['-i', videoTmp, '-i', audioTmp, '-map', '0:v:0', '-map', '1:a:0'];
  if (codec === 'avc') args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'medium', '-b:v', `${bitrateMbps}M`, '-pix_fmt', 'yuv420p');
  if (loudnorm) args.push('-af', 'loudnorm=I=-14:TP=-1.5:LRA=11');
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', duration.toFixed(3), out);
  await ffmpeg(args, { duration, signal, onProgress: (f) => report('Finishing the file', f) });
  await remove(tmpDir).catch(() => {});
  report('Done', 1);
  return { out, codec, frames };
}

export async function exportGif(project, opts) {
  const { out, width, fps = 15 } = opts;
  const tmp = join(paths.temp, 've-gif-' + uid('') + '.mp4');
  await exportVideo(project, { ...opts, out: tmp, fps: Math.max(fps, 15), onProgress: (p) => opts.onProgress?.({ ...p, fraction: p.fraction * 0.8 }) });
  const w = Math.round(width / 2) * 2;
  await ffmpeg(['-i', tmp, '-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', out]);
  await remove(tmp).catch(() => {});
  opts.onProgress?.({ stage: 'Done', fraction: 1 });
  return { out };
}

export async function exportAudio(project, { out, t0 = 0, t1, format = 'mp3', loudnorm = false, onProgress, signal }) {
  t1 ??= projectDuration(project);
  const wav = join(paths.temp, 've-audio-' + uid('') + '.wav');
  await mixAudio(project, t0, t1, wav, { signal, onProgress: (f) => onProgress?.({ stage: 'Mixing audio', fraction: f * 0.9 }) });
  const args = ['-i', wav];
  // loudnorm resamples to 192 kHz internally, so set the rate back to 48 kHz
  if (loudnorm) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000');
  if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
  else if (format === 'm4a') args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-c:a', 'pcm_s16le');
  args.push(out);
  await ffmpeg(args, { signal });
  await remove(wav).catch(() => {});
  onProgress?.({ stage: 'Done', fraction: 1 });
  return { out };
}

/** Renders one frame at full size and saves it as PNG or JPG. */
export async function exportFrame(project, t, out, { width } = {}) {
  width ||= project.settings.width;
  const height = Math.round((project.settings.height * width) / project.settings.width);
  const canvas = new OffscreenCanvas(width, height);
  const comp = new Compositor(canvas);
  await comp.preload(project);
  const sources = new ExportSources(project);
  try {
    const plan = framePlan(project, t);
    await sources.prepare(plan, t);
    comp.render(project, t, sources, { scale: width / project.settings.width, plan });
    const type = out.toLowerCase().endsWith('.jpg') || out.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    const blob = await canvas.convertToBlob({ type, quality: 0.95 });
    await writeBytes(out, new Uint8Array(await blob.arrayBuffer()), { offset: 0, truncate: true });
  } finally {
    await sources.dispose();
    comp.dispose();
  }
  return out;
}

/** Renders a frame to an ImageBitmap-compatible canvas (used by AI tools). */
export async function renderFrameCanvas(project, t, width) {
  const height = Math.round((project.settings.height * width) / project.settings.width);
  const canvas = new OffscreenCanvas(width, height);
  const comp = new Compositor(canvas);
  await comp.preload(project);
  const sources = new ExportSources(project);
  try {
    const plan = framePlan(project, t);
    await sources.prepare(plan, t);
    comp.render(project, t, sources, { scale: width / project.settings.width, plan });
    // copy into a 2D canvas right away, before the WebGL buffer is cleared
    const out = new OffscreenCanvas(width, height);
    out.getContext('2d').drawImage(canvas, 0, 0);
    return out;
  } finally {
    await sources.dispose();
    comp.dispose();
  }
}

export function captionsToSrt(project, { vtt = false } = {}) {
  const caps = Object.values(project.items)
    .filter((it) => it.type === 'text' && it.caption && !it.translation)
    .sort((a, b) => a.start - b.start);
  const lines = vtt ? ['WEBVTT', ''] : [];
  caps.forEach((c, i) => {
    if (!vtt) lines.push(String(i + 1));
    lines.push(`${srtTime(c.start, vtt ? '.' : ',')} --> ${srtTime(itemEnd(c), vtt ? '.' : ',')}`);
    lines.push(c.text);
    lines.push('');
  });
  return lines.join('\n');
}

export async function exportCaptions(project, out) {
  const vtt = out.toLowerCase().endsWith('.vtt');
  await writeText(out, captionsToSrt(project, { vtt }));
  return out;
}

export function defaultExportName(project, ext) {
  const safe = (project.name || 'Video').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Video';
  return `${safe}.${ext}`;
}

export { dirname, stripExt, basename };
