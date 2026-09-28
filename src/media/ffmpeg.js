// FFmpeg and FFprobe wrappers.

import { runProcess } from '../backend/proc.js';
import { tools } from './tools.js';

export async function probe(path) {
  const { lines } = await runProcess(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { keep: 100000 });
  const json = JSON.parse(lines.filter((l) => !l.startsWith('[')).join('\n').replace(/^[^{]*/, '') || '{}');
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = json.format || {};
  const rate = (r) => {
    if (!r || r === '0/0') return 0;
    const [n, d] = r.split('/').map(Number);
    return d ? n / d : n;
  };
  let rotation = 0;
  if (v) {
    const dm = (v.side_data_list || []).find((sd) => sd.rotation != null);
    if (dm) rotation = Number(dm.rotation) || 0;
    else if (v.tags?.rotate) rotation = -Number(v.tags.rotate) || 0;
  }
  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const duration = parseFloat(fmt.duration || v?.duration || a?.duration || 0) || 0;
  const imageCodecs = ['png', 'mjpeg', 'webp', 'bmp', 'tiff', 'gif', 'heic', 'hevc_image'];
  const isStill = v && (!duration || duration < 0.05 || (imageCodecs.includes(v.codec_name) && (v.nb_frames === '1' || !v.nb_frames)));
  return {
    duration,
    width,
    height,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30 : 0,
    videoCodec: v?.codec_name || null,
    audioCodec: a?.codec_name || null,
    hasVideo: !!v,
    hasAudio: !!a,
    isStill: !!isStill,
    rotation,
    hdr: !!v && ['arib-std-b67', 'smpte2084'].includes(v.color_transfer),
    pixFmt: v?.pix_fmt || null,
    sampleRate: a ? Number(a.sample_rate) : 0,
    channels: a ? Number(a.channels) : 0,
    size: Number(fmt.size || 0),
    formatName: fmt.format_name,
    alpha: !!v && /a$|rgba|argb|yuva/.test(v.pix_fmt || ''),
  };
}

/**
 * Runs ffmpeg with progress reporting. `duration` (seconds of output) turns
 * the out_time lines into a 0..1 fraction for onProgress.
 */
export function ffmpeg(args, { duration = 0, onProgress, signal, onLine } = {}) {
  const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
  return runProcess(tools.ffmpeg, full, {
    signal,
    onLine(line, stream) {
      onLine?.(line, stream);
      if (stream === 'stdout' && duration > 0 && onProgress) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    },
  });
}

/** Same as ffmpeg() but reads frames from stdin (used by piped jobs). */
export function ffmpegPiped(args, opts = {}) {
  return ffmpeg(args, opts);
}

export const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** Video encoder arguments for edit copies and derived clips. */
export function editVideoArgs(codec, { crf } = {}) {
  if (codec === 'h264')
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf ?? 18), '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  return ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', String(crf ?? 30), '-g', '15', '-pix_fmt', 'yuv420p'];
}

export function editAudioArgs(codec) {
  if (codec === 'h264') return ['-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000'];
  return ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
}

export function scaleFilter(info, maxShort) {
  const short = Math.min(info.width, info.height);
  if (!maxShort || short <= maxShort) return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  if (info.width <= info.height) return `scale=${maxShort}:-2`;
  return `scale=-2:${maxShort}`;
}

export function fpsFor(info) {
  const f = info.fps || 30;
  if (f > 61) return 60;
  if (Math.abs(f - 29.97) < 0.02) return '30000/1001';
  if (Math.abs(f - 59.94) < 0.02) return '60000/1001';
  if (Math.abs(f - 23.976) < 0.02) return '24000/1001';
  return String(Math.round(f));
}
