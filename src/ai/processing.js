// Clip processing that makes a new file with FFmpeg: reverse, stabilise,
// smooth slow motion, noise removal and loudness levelling. The clip then
// points at the new file and can be switched back to the original.

import { store } from '../core/store.js';
import { sourceSpan, maxClipDuration } from '../core/model.js';
import { ffmpeg, editVideoArgs, editAudioArgs, TONEMAP } from '../media/ffmpeg.js';
import { addDerivedMedia, derivedDir, runtime } from '../media/library.js';
import { join, exists, mkdir } from '../backend/index.js';
import { runProcess } from '../backend/proc.js';
import { tools } from '../media/tools.js';
import { startJob, toast } from '../ui/notify.js';
import { hashString } from '../core/util.js';

let filterCache = null;
async function hasFilter(name) {
  if (!filterCache) {
    const { lines } = await runProcess(tools.ffmpeg, ['-hide_banner', '-filters'], { keep: 5000 });
    filterCache = lines.join('\n');
  }
  return new RegExp('\\s' + name + '\\s').test(filterCache);
}

/**
 * Runs `build(media, out, dir)` to make a derived file for a clip, registers it
 * and points the clip at it. `segment` means the file covers only the clip's
 * used range, so the clip's in-point becomes 0.
 */
export async function deriveForClip(it, { kind, label, key, build, segment = false, done }) {
  const p = store.project;
  const m = p.media[it.mediaId];
  if (!m || m.status !== 'ready') throw new Error('Wait until the clip has finished preparing.');
  const job = startJob(label);
  try {
    const span = sourceSpan(it);
    const fullKey = `${kind}|${key || ''}|${segment ? it.in.toFixed(3) + '+' + span.toFixed(3) : ''}|${runtime.codec}`;
    const dir = derivedDir(m, fullKey);
    await mkdir(dir);
    const out = join(dir, 'out.mp4');
    if (!(await exists(out))) {
      await build(m, out + '.part.mp4', dir, job, { start: it.in, span });
      const { rename } = await import('../backend/index.js');
      await rename(out + '.part.mp4', out);
    }
    job.update(null, 'Preparing the new clip');
    const d = await addDerivedMedia(m, out, { name: m.name, key: fullKey, editReady: true, keepDuration: !segment });
    store.commit(label, (pp) => {
      // an undo during the job swaps item objects, so write to the live one
      const cur = pp.items[it.id];
      if (!cur) return;
      cur.origMediaId ||= cur.mediaId;
      if (segment) {
        cur.origIn ??= cur.in;
        cur.in = 0;
      }
      cur.mediaId = d.id;
      cur.derivations = [...(cur.derivations || []), kind];
      done?.(cur, d);
      cur.duration = Math.min(cur.duration, maxClipDuration(store.project, cur));
    });
    job.done(`${label} finished.`);
    return d;
  } catch (e) {
    job.fail(e);
    throw e;
  }
}

export function revertMedia(it) {
  if (!it.origMediaId) return;
  store.commit('Back to the original clip', () => {
    it.mediaId = it.origMediaId;
    it.origMediaId = null;
    if (it.origIn != null) it.in = it.origIn;
    it.origIn = null;
    it.derivations = [];
    it.duration = Math.min(it.duration, maxClipDuration(store.project, it));
  });
}

const seg = ({ start, span }) => ['-ss', start.toFixed(3), '-t', span.toFixed(3)];

export function reverseClip(it) {
  if (it.derivations?.includes('reverse')) return revertMedia(it);
  const span = sourceSpan(it);
  if (span > 120) return toast('Reverse works on clips up to 2 minutes long. Split the clip first.', { kind: 'warn' });
  return deriveForClip(it, {
    kind: 'reverse',
    label: 'Reverse clip',
    segment: true,
    build: (m, out, dir, job, r) => {
      const args = [...seg(r), '-i', m.edit, '-vf', 'reverse', ...editVideoArgs(runtime.codec)];
      if (m.hasAudio) args.push('-af', 'areverse', ...editAudioArgs(runtime.codec));
      args.push('-movflags', '+faststart', out);
      return ffmpeg(args, { duration: r.span, signal: job.signal, onProgress: (f) => job.update(f, 'Reversing') });
    },
  });
}

export async function stabilizeClip(it) {
  const vidstab = await hasFilter('vidstabdetect');
  return deriveForClip(it, {
    kind: 'stab',
    label: 'Stabilise',
    key: vidstab ? 'vidstab' : 'deshake',
    build: async (m, out, dir, job) => {
      const dur = m.duration;
      if (vidstab) {
        await runFfmpegIn(dir, ['-i', m.edit, '-vf', 'vidstabdetect=shakiness=6:accuracy=15:result=transforms.trf', '-f', 'null', '-'], dur, (f) => job.update(f * 0.5, 'Measuring the shake'), job.signal);
        const args = ['-i', m.edit, '-vf', 'vidstabtransform=input=transforms.trf:smoothing=24:optzoom=1:zoomspeed=0.2,unsharp=5:5:0.5:3:3:0.2', ...editVideoArgs(runtime.codec)];
        if (m.hasAudio) args.push('-c:a', 'copy');
        args.push('-movflags', '+faststart', out);
        await runFfmpegIn(dir, args, dur, (f) => job.update(0.5 + f * 0.5, 'Smoothing the camera'), job.signal);
      } else {
        const args = ['-i', m.edit, '-vf', 'deshake=rx=32:ry=32', ...editVideoArgs(runtime.codec)];
        if (m.hasAudio) args.push('-c:a', 'copy');
        args.push('-movflags', '+faststart', out);
        await ffmpeg(args, { duration: dur, signal: job.signal, onProgress: (f) => job.update(f, 'Smoothing the camera') });
      }
    },
  });
}

function runFfmpegIn(cwd, args, duration, onProgress, signal) {
  return runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
    cwd,
    signal,
    onLine(line, stream) {
      if (stream !== 'stdout') return;
      const mm = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (mm && duration) onProgress(Math.min(1, Number(mm[1]) / 1e6 / duration));
    },
  });
}

export function smoothSlowmo(it) {
  const speed = it.speedCurve ? Math.min(...it.speedCurve.map((p) => p.y)) : it.speed || 1;
  const m = store.project.media[it.mediaId];
  if (speed >= 0.95) return toast('Slow the clip down first (Speed tab), then make it smooth.', { kind: 'warn', timeout: 4000 });
  const srcFps = m.fps || 30;
  const target = Math.min(240, Math.round(srcFps / Math.max(0.1, speed)));
  const span = sourceSpan(it);
  if (span > 60) return toast('Smooth slow motion works on up to 60 seconds of footage. Split the clip first.', { kind: 'warn' });
  return deriveForClip(it, {
    kind: 'smooth',
    label: 'Smooth slow motion',
    key: String(target),
    segment: true,
    build: (mm, out, dir, job, r) => {
      const args = [...seg(r), '-i', mm.edit, '-vf', `minterpolate=fps=${target}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`, ...editVideoArgs(runtime.codec, { crf: runtime.codec === 'h264' ? 17 : 28 })];
      if (mm.hasAudio) args.push(...editAudioArgs(runtime.codec));
      args.push('-movflags', '+faststart', out);
      return ffmpeg(args, { duration: r.span, signal: job.signal, onProgress: (f) => job.update(f, `Creating in-between frames (${target} fps)`) });
    },
  });
}

function audioDerive(it, kind, label, filter) {
  return deriveForClip(it, {
    kind,
    label,
    key: hashString(filter),
    build: (m, out, dir, job) => {
      const args = ['-i', m.edit];
      if (m.kind === 'video') args.push('-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy');
      else args.push('-vn');
      args.push('-af', filter, ...editAudioArgs(runtime.codec), '-movflags', '+faststart', out);
      return ffmpeg(args, { duration: m.duration, signal: job.signal, onProgress: (f) => job.update(f, label) });
    },
  });
}

export function denoiseClip(it) {
  return audioDerive(it, 'denoise', 'Remove background noise', 'highpass=f=70,afftdn=nr=18:nf=-30:tn=1,lowpass=f=15000');
}

export function normalizeClip(it) {
  return audioDerive(it, 'norm', 'Even out loudness', 'loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95');
}

/** Evens out a voice: quiet words come up, loud ones come down, like a radio presenter. */
export function compressClip(it) {
  return audioDerive(it, 'comp', 'Level out the voice', 'highpass=f=70,acompressor=threshold=0.1:ratio=3:attack=8:release=220:makeup=2,alimiter=limit=0.95');
}

export const VOICE_EFFECTS = {
  deeper: 'asetrate=48000*0.84,aresample=48000,atempo=1.190476',
  higher: 'asetrate=48000*1.25,aresample=48000,atempo=0.8',
  echo: 'aecho=0.8:0.7:60|140:0.35|0.22',
  radio: 'highpass=f=320,lowpass=f=3300,acompressor=threshold=0.08:ratio=6:attack=5:release=80,volume=1.8',
  robot: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
};

export async function voiceEffect(it, kind) {
  const filter = VOICE_EFFECTS[kind];
  if (!filter) return;
  // effects replace each other rather than stacking
  if (it.derivations?.some((d) => d.startsWith('fx-'))) revertMedia(it);
  return audioDerive(it, 'fx-' + kind, 'Voice effect', filter);
}

/**
 * Sharper, bigger copy of a video: Lanczos upscale to twice the size (up to 4K
 * on the short side) with light sharpening. Made from the original file.
 */
export function upscaleClip(it) {
  if (it.derivations?.includes('upscale')) return revertMedia(it);
  const m = store.project.media[it.mediaId];
  const short = Math.min(m.width || 1080, m.height || 1920);
  const target = Math.min(2160, short * 2);
  if (target <= short) return toast('This clip is already 4K or larger.', { timeout: 2500 });
  const span = sourceSpan(it);
  if (span > 300) return toast('Upscale works on clips up to 5 minutes. Split the clip first.', { kind: 'warn' });
  return deriveForClip(it, {
    kind: 'upscale',
    label: 'Upscale',
    key: String(target),
    segment: true,
    build: (mm, out, dir, job, r) => {
      const scale = (mm.width || 1) < (mm.height || 1) ? `scale=${target}:-2:flags=lanczos` : `scale=-2:${target}:flags=lanczos`;
      const tone = mm.hdr ? TONEMAP + ',' : '';
      const args = [...seg(r), '-i', mm.path, '-vf', `${tone}${scale},unsharp=5:5:0.7:5:5:0.0,format=yuv420p`, ...editVideoArgs(runtime.codec)];
      if (mm.hasAudio) args.push(...editAudioArgs(runtime.codec));
      args.push('-movflags', '+faststart', out);
      return ffmpeg(args, { duration: r.span, signal: job.signal, onProgress: (f) => job.update(f, `Upscaling to ${target}p`) });
    },
  });
}

/** AI upscale of a photo through Replicate (Real-ESRGAN), billed to the user's token. */
export async function aiUpscalePhoto(it) {
  const { run, imageDataUri } = await import('./generate.js');
  const { downloadTo } = await import('../media/tools.js');
  const { importFiles, whenReady } = await import('../media/library.js');
  const { paths } = await import('../backend/index.js');
  const p = store.project;
  const m = p.media[it.mediaId];
  if (m?.kind !== 'image') return toast('Select a photo first.', { timeout: 2000 });
  if (!store.settings.replicateToken) return toast('Add your Replicate token in Settings first.', { kind: 'warn' });
  const job = startJob('AI upscale');
  try {
    const model = store.settings.replicateUpscaleModel || 'nightmareai/real-esrgan';
    job.update(null, 'Sending the photo');
    const urls = await run(model, { image: await imageDataUri(m), scale: 4, face_enhance: false }, job);
    const u = urls.find((x) => typeof x === 'string');
    if (!u) throw new Error('Replicate sent back no picture.');
    const dir = join(paths.documents, 'Video Editor Generated');
    await mkdir(dir);
    const file = join(dir, `${m.name.replace(/\.[^.]+$/, '')} 4x ${hashString(u).slice(0, 6)}.png`);
    await downloadTo(u, file, (r, t) => job.update(t ? r / t : null, 'Downloading the result'));
    const [nm] = await importFiles([file]);
    await whenReady(nm);
    store.commit('AI upscale', (pp) => {
      const cur = pp.items[it.id];
      if (!cur) return;
      cur.origMediaId ||= cur.mediaId;
      cur.mediaId = nm.id;
      cur.derivations = [...(cur.derivations || []), 'upscale'];
    });
    job.done('The photo is now 4 times bigger.');
  } catch (e) {
    job.fail(e);
  }
}
