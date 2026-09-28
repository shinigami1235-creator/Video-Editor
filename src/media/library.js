// Media library: importing files, making edit copies, audio data, thumbnails
// and waveforms, and keeping track of derived clips (background removed,
// stabilised, reversed and so on).

import { paths, join, exists, stat, mkdir, readBytes, writeBytes, basename, extname, stripExt, fileUrl, remove } from '../backend/index.js';
import { store } from '../core/store.js';
import { uid, hashString, limiter, clamp } from '../core/util.js';
import { probe, ffmpeg, editVideoArgs, editAudioArgs, scaleFilter, fpsFor, TONEMAP } from './ffmpeg.js';
import { canDecodeVideo } from 'mediabunny';

export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'ts'];
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma', 'aiff', 'aif'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'svg'];
const BROWSER_IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'svg'];

export const runtime = {
  codec: 'h264',
  peaks: new Map(), // mediaId -> Uint8Array (100 per second)
  images: new Map(), // path -> Promise<ImageBitmap>
};

const heavy = limiter(2);

export async function detectEditCodec() {
  const v = document.createElement('video');
  const h264 = v.canPlayType('video/mp4; codecs="avc1.640028"') !== '' && (await canDecodeVideo('avc').catch(() => false));
  runtime.codec = h264 ? 'h264' : 'vp9';
  return runtime.codec;
}

export function cacheRoot() {
  return join(paths.cache, 'media');
}

export function mediaDir(m) {
  return join(cacheRoot(), m.cacheKey);
}

export function kindForPath(p) {
  const e = extname(p);
  if (VIDEO_EXT.includes(e)) return 'video';
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (IMAGE_EXT.includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  return null;
}

// media still being prepared, so their progress lands even if the project is swapped meanwhile
const inflight = new Map();

function setMedia(id, patch) {
  const m = store.project.media[id] || inflight.get(id);
  if (!m) return;
  Object.assign(m, patch);
  store.emit('media', m);
  store.touch();
}

/** Adds files to the project library and starts processing them. Returns the media entries. */
export async function importFiles(filePaths, { onEach } = {}) {
  const out = [];
  for (const p of filePaths) {
    const kind = kindForPath(p);
    if (!kind) continue;
    if (kind === 'pdf') {
      const { importPdf } = await import('./pdf.js');
      const pages = await importPdf(p);
      out.push(...pages);
      continue;
    }
    const existing = Object.values(store.project.media).find((m) => m.path === p && !m.sourceId);
    if (existing) {
      out.push(existing);
      continue;
    }
    const st = await stat(p);
    if (!st) continue;
    const m = {
      id: uid('m'),
      path: p,
      name: basename(p),
      kind,
      duration: 0,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: false,
      size: st.size,
      cacheKey: hashString(p + '|' + st.size + '|' + Math.round(st.mtimeMs)) + '-' + runtime.codec,
      status: 'processing',
      progress: 0,
      imported: Date.now(),
    };
    store.project.media[m.id] = m;
    store.emit('media', m);
    out.push(m);
    onEach?.(m);
    processMedia(m).catch((e) => console.error(e));
  }
  store.touch();
  return out;
}

/** Waits until a media entry has finished processing. */
export function whenReady(m) {
  if (m.status === 'ready') return Promise.resolve(m);
  if (m.status === 'error') return Promise.reject(new Error(m.error));
  return new Promise((resolve, reject) => {
    const off = store.on('media', (x) => {
      if (x.id !== m.id) return;
      if (x.status === 'ready') {
        off();
        resolve(x);
      } else if (x.status === 'error') {
        off();
        reject(new Error(x.error));
      }
    });
  });
}

export async function processMedia(m) {
  const id = m.id;
  const dir = mediaDir(m);
  inflight.set(id, m);
  try {
    await mkdir(dir);
    let info = await probe(m.path);
    if (!(info.duration > 0) && (info.hasAudio || (info.hasVideo && ['webm', 'mkv'].includes(extname(m.path))))) {
      // browser recordings (MediaRecorder) carry no duration; a copy-remux writes one
      const fixed = join(dir, 'remux.mkv');
      if (!(await exists(fixed))) {
        await ffmpeg(['-i', m.path, '-map', '0', '-c', 'copy', fixed + '.part.mkv']);
        const { rename } = await import('../backend/index.js');
        await rename(fixed + '.part.mkv', fixed);
      }
      const again = await probe(fixed);
      info = { ...again, src: fixed, isStill: again.hasVideo && !(again.duration > 0.1) };
    }
    let kind = m.kind;
    if (info.hasVideo && !info.isStill && info.duration > 0.1) kind = 'video';
    else if (info.hasVideo && info.isStill) kind = 'image';
    else if (info.hasAudio) kind = 'audio';
    setMedia(id, {
      kind,
      duration: kind === 'image' ? 0 : info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio && kind !== 'image',
      rotation: info.rotation,
      hdr: info.hdr,
      alpha: info.alpha,
    });
    if (kind === 'image') await prepareImage(m, info, dir);
    else await heavy(() => prepareAv(m, info, dir));
    setMedia(id, { status: 'ready', progress: 1, error: null });
  } catch (e) {
    console.error('import failed', m.path, e);
    setMedia(id, { status: 'error', error: String(e.message || e) });
  } finally {
    inflight.delete(id);
  }
}

async function prepareImage(m, info, dir) {
  const e = extname(m.path);
  if (BROWSER_IMAGES.includes(e)) {
    setMedia(m.id, { display: m.path });
    return;
  }
  const out = join(dir, 'image.png');
  if (!(await exists(out))) await ffmpeg(['-i', m.path, '-frames:v', '1', out]);
  setMedia(m.id, { display: out });
}

async function prepareAv(m, info, dir) {
  const id = m.id;
  const codec = runtime.codec;
  const edit = m.editReady ? m.path : join(dir, 'edit.mp4');
  const pcm = join(dir, 'audio.f32');
  const thumbs = join(dir, 'thumbs.jpg');
  const peaksPath = join(dir, 'peaks.u8');
  const dur = info.duration || 1;
  const prog = (a, b) => (f) => setMedia(id, { progress: clamp(a + (b - a) * f, 0, 1) });

  if (!(await exists(edit))) {
    const args = ['-i', info.src || m.path, '-map', '0:v:0?', '-map', '0:a:0?'];
    if (m.kind === 'video') {
      const filters = [];
      if (info.hdr) filters.push(TONEMAP);
      filters.push(scaleFilter(info, store.settings.editCopyHeight || 1080));
      filters.push('format=yuv420p');
      args.push('-vf', filters.join(','), '-r', fpsFor(info), '-fps_mode', 'cfr', ...editVideoArgs(codec));
    } else {
      args.push('-vn');
    }
    if (info.hasAudio) args.push(...editAudioArgs(codec));
    args.push('-movflags', '+faststart', edit + '.part.mp4');
    await ffmpeg(args, { duration: dur, onProgress: prog(0, 0.75) });
    const { rename } = await import('../backend/index.js');
    await rename(edit + '.part.mp4', edit);
  }
  const editInfo = m.kind === 'video' ? await probe(edit) : null;
  setMedia(id, {
    edit,
    editWidth: editInfo?.width || 0,
    editHeight: editInfo?.height || 0,
    fps: editInfo?.fps || m.fps,
    duration: editInfo?.duration && m.kind === 'video' ? Math.min(info.duration || editInfo.duration, editInfo.duration) : m.duration,
  });

  if (info.hasAudio) {
    if (!(await exists(pcm))) {
      await ffmpeg(['-i', info.src || m.path, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', pcm + '.part'], { duration: dur, onProgress: prog(0.75, 0.88) });
      const { rename } = await import('../backend/index.js');
      await rename(pcm + '.part', pcm);
    }
    setMedia(id, { pcm });
    if (!(await exists(peaksPath))) await computePeaks(pcm, peaksPath);
    setMedia(id, { peaks: peaksPath });
  }

  if (m.kind === 'video') {
    const count = Math.max(1, Math.min(240, Math.ceil(dur / 0.5)));
    const interval = dur / count;
    const th = 90;
    const w = Math.max(2, Math.round((th * (info.width || 16)) / (info.height || 9) / 2) * 2);
    const cols = Math.min(count, 20);
    const rows = Math.ceil(count / cols);
    if (!(await exists(thumbs))) {
      await ffmpeg(['-i', edit, '-vf', `fps=${1 / interval},scale=${w}:${th},tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', thumbs], {
        duration: dur,
        onProgress: prog(0.88, 1),
      });
    }
    setMedia(id, { thumbs: { path: thumbs, cols, rows, count, interval, w, h: th } });
  }
}

/** Reads a float32 stereo PCM file and writes max-abs peaks at 100 per second. */
export async function computePeaks(pcmPath, outPath) {
  const st = await stat(pcmPath);
  const frameBytes = 8;
  const block = 480; // frames per peak
  const chunkFrames = block * 1024;
  const peaks = new Uint8Array(Math.ceil(st.size / frameBytes / block));
  let pi = 0;
  for (let off = 0; off < st.size; off += chunkFrames * frameBytes) {
    const bytes = await readBytes(pcmPath, off, chunkFrames * frameBytes);
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    for (let i = 0; i < f.length; i += block * 2) {
      let mx = 0;
      const end = Math.min(f.length, i + block * 2);
      for (let j = i; j < end; j++) {
        const v = f[j] < 0 ? -f[j] : f[j];
        if (v > mx) mx = v;
      }
      peaks[pi++] = Math.min(255, Math.round(Math.sqrt(mx) * 255));
    }
  }
  await writeBytes(outPath, peaks.subarray(0, pi), { offset: 0, truncate: true });
  return peaks.subarray(0, pi);
}

export async function getPeaks(m) {
  if (!m?.peaks) return null;
  if (runtime.peaks.has(m.id)) return runtime.peaks.get(m.id);
  const p = readBytes(m.peaks).catch(() => null);
  runtime.peaks.set(m.id, p);
  const v = await p;
  runtime.peaks.set(m.id, v);
  return v;
}

export function peaksSync(m) {
  const v = runtime.peaks.get(m?.id);
  return v instanceof Uint8Array ? v : null;
}

export function mediaUrl(m) {
  if (!m) return null;
  if (m.kind === 'image') return fileUrl(m.display || m.path);
  return m.edit ? fileUrl(m.edit) : null;
}

export function thumbUrl(m) {
  if (m?.kind === 'image') return fileUrl(m.display || m.path);
  return m?.thumbs ? fileUrl(m.thumbs.path) : null;
}

/** Loads an image as an ImageBitmap (cached by path), downscaled to fit 4096. */
export function loadImage(path) {
  if (runtime.images.has(path)) return runtime.images.get(path);
  const p = (async () => {
    const res = await fetch(fileUrl(path));
    const blob = await res.blob();
    let bmp = await createImageBitmap(blob);
    const max = 4096;
    if (bmp.width > max || bmp.height > max) {
      const s = max / Math.max(bmp.width, bmp.height);
      const b2 = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * s), resizeHeight: Math.round(bmp.height * s), resizeQuality: 'high' });
      bmp.close();
      bmp = b2;
    }
    return bmp;
  })();
  runtime.images.set(path, p);
  p.catch(() => runtime.images.delete(path));
  return p;
}

/**
 * Registers a derived media entry (a new file made from an existing one) and
 * processes it like an import. `file` is the finished file on disk.
 */
export async function addDerivedMedia(source, file, { name, key, alphaPacked = null, keepDuration = true, editReady = false } = {}) {
  const st = await stat(file);
  const m = {
    id: uid('m'),
    path: file,
    name: name || source.name,
    kind: source.kind === 'image' ? 'video' : source.kind,
    duration: 0,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: false,
    size: st?.size || 0,
    cacheKey: hashString(file + '|' + (st?.size || 0) + '|' + Math.round(st?.mtimeMs || 0)) + '-' + runtime.codec,
    status: 'processing',
    progress: 0,
    sourceId: source.id,
    derivedKey: key,
    hidden: true,
    alphaPacked,
    editReady,
    imported: Date.now(),
  };
  const projectId = store.project.id;
  store.project.media[m.id] = m;
  store.emit('media', m);
  await processMedia(m);
  if (store.project.id !== projectId) throw new Error('The project was closed before this finished.');
  store.project.media[m.id] ||= m;
  if (store.project.media[m.id]?.status === 'error') throw new Error(store.project.media[m.id].error);
  if (alphaPacked) {
    // packed-alpha clips show the colour half only
    const mm = store.project.media[m.id];
    if (alphaPacked === 'v') Object.assign(mm, { height: mm.height / 2, editHeight: mm.editHeight / 2 });
    else Object.assign(mm, { width: mm.width / 2, editWidth: mm.editWidth / 2 });
  }
  if (keepDuration && source.duration) store.project.media[m.id].duration = Math.min(store.project.media[m.id].duration || source.duration, source.duration);
  store.touch();
  return store.project.media[m.id];
}

export function derivedDir(source, key) {
  return join(mediaDir(source), 'derived-' + hashString(key));
}

/** Re-checks every media file after a project opens and rebuilds missing caches. */
export async function verifyMedia() {
  for (const m of Object.values(store.project.media)) {
    const srcOk = await exists(m.path);
    const cacheOk = m.kind === 'image' ? await exists(m.display || m.path) : m.edit ? await exists(m.edit) : false;
    if (cacheOk) {
      m.status = 'ready';
      if (m.peaks) getPeaks(m);
      continue;
    }
    if (!srcOk) {
      m.status = 'missing';
      m.error = 'File not found: ' + m.path;
      continue;
    }
    m.status = 'processing';
    m.progress = 0;
    processMedia(m);
  }
  store.touch();
}

export async function removeMedia(id) {
  const used = Object.values(store.project.items).some((it) => it.mediaId === id || it.origMediaId === id);
  if (used) return false;
  delete store.project.media[id];
  store.touch();
  return true;
}

export function mediaName(p) {
  return stripExt(basename(p));
}

export async function clearCache() {
  await remove(cacheRoot());
}

/** Codec support details (shown in tests and Settings). */
export async function codecCaps() {
  const v = document.createElement('video');
  return {
    play: v.canPlayType('video/mp4; codecs="avc1.640028"'),
    dec: await canDecodeVideo('avc').catch(() => false),
    codec: runtime.codec,
  };
}
