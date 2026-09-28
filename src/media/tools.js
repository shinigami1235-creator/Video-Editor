// Locates and installs the helper programs and models the editor uses:
// FFmpeg (required), whisper.cpp for captions, Piper for text-to-speech, and
// ONNX models for background removal. Everything downloads into the app's data
// folder the first time it is needed.

import { paths, join, exists, list, mkdir, invoke, on, remove, stat } from '../backend/index.js';
import { newJobId } from '../backend/proc.js';
import { store } from '../core/store.js';
import { saveSettings } from '../core/settings.js';

export const FFMPEG_URLS = [
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];
export const WHISPER_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-bin-x64.zip';
export const WHISPER_GPU_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-cublas-12.4.0-bin-x64.zip';
export const PIPER_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
// Mac: FFmpeg and whisper-cli come inside the app; these are the fallback if they are missing
const MAC_FFMPEG = (arch, name) => `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch === 'aarch64' ? 'arm64' : 'amd64'}/release/${name}.zip`;

export const WHISPER_MODELS = {
  base: { file: 'ggml-base.bin', size: '148 MB', label: 'Base: fastest, fine for clear English' },
  small: { file: 'ggml-small-q5_1.bin', size: '190 MB', label: 'Small: good for English and Filipino' },
  turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', size: '574 MB', label: 'Large turbo: most accurate, slower' },
};
const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

export const PIPER_VOICES = {
  'en_US-lessac-medium': { path: 'en/en_US/lessac/medium/', label: 'Lessac, US English, calm female voice' },
  'en_US-amy-medium': { path: 'en/en_US/amy/medium/', label: 'Amy, US English, bright female voice' },
  'en_US-hfc_female-medium': { path: 'en/en_US/hfc_female/medium/', label: 'HFC, US English, female voice' },
  'en_US-kristin-medium': { path: 'en/en_US/kristin/medium/', label: 'Kristin, US English, warm female voice' },
  'en_US-ryan-high': { path: 'en/en_US/ryan/high/', label: 'Ryan, US English, male voice' },
  'en_US-hfc_male-medium': { path: 'en/en_US/hfc_male/medium/', label: 'HFC, US English, male voice' },
  'en_US-joe-medium': { path: 'en/en_US/joe/medium/', label: 'Joe, US English, deep male voice' },
  'en_GB-cori-high': { path: 'en/en_GB/cori/high/', label: 'Cori, British English, female voice' },
  'en_GB-alan-medium': { path: 'en/en_GB/alan/medium/', label: 'Alan, British English, male voice' },
  'es_ES-davefx-medium': { path: 'es/es_ES/davefx/medium/', label: 'Davefx, Spanish, male voice' },
  'es_MX-claude-high': { path: 'es/es_MX/claude/high/', label: 'Claude, Mexican Spanish, female voice' },
  'zh_CN-huayan-medium': { path: 'zh/zh_CN/huayan/medium/', label: 'Huayan, Mandarin Chinese, female voice' },
  'vi_VN-vais1000-medium': { path: 'vi/vi_VN/vais1000/medium/', label: 'Vais1000, Vietnamese, female voice' },
  'fr_FR-siwis-medium': { path: 'fr/fr_FR/siwis/medium/', label: 'Siwis, French, female voice' },
};
const HF_PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';

export const SEG_MODELS = {
  person: { file: 'u2net_human_seg.onnx', size: 320, url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx', mb: 168, label: 'People' },
  object: { file: 'isnet-general-use.onnx', size: 1024, url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx', mb: 171, label: 'Products and objects' },
  fast: { file: 'u2netp.onnx', size: 320, url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx', mb: 4.4, label: 'Fast preview quality' },
};

export const tools = { ffmpeg: null, ffprobe: null, whisper: null, piper: null };

const isWin = () => paths.platform === 'windows';
const isMac = () => paths.platform === 'macos';
/** A program shipped inside the Mac app, next to the editor itself (Contents/MacOS). */
async function macBundled(name) {
  if (!isMac() || !paths.resource) return null;
  const p = join(paths.resource, '..', 'MacOS', name);
  return (await exists(p)) ? p : null;
}
const exe = (n) => (isWin() ? n + '.exe' : n);
// Large downloads live in the local (non-roaming) app folder.
export const toolsDir = (...p) => join(paths.cache, 'tools', ...p);

/** Recursively searches a folder (depth-limited) for a file name. */
export async function findFile(dir, name, depth = 4) {
  if (!(await exists(dir))) return null;
  let entries = [];
  try {
    entries = await list(dir);
  } catch {
    return null;
  }
  for (const e of entries) if (!e.isDir && e.name.toLowerCase() === name.toLowerCase()) return join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDir) {
      const r = await findFile(join(dir, e.name), name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

async function usable(p) {
  if (!p) return false;
  if (!/[\\/]/.test(p)) return true; // program on PATH
  return exists(p);
}

export async function locateTools() {
  const s = store.settings;
  tools.ffmpeg = (await usable(s.ffmpegPath)) ? s.ffmpegPath : (await macBundled('ffmpeg')) || (await findFile(toolsDir('ffmpeg'), exe('ffmpeg')));
  tools.ffprobe = (await usable(s.ffprobePath)) ? s.ffprobePath : (await macBundled('ffprobe')) || (await findFile(toolsDir('ffmpeg'), exe('ffprobe')));
  if (!tools.ffmpeg && !isWin() && !isMac()) tools.ffmpeg = 'ffmpeg';
  if (!tools.ffprobe && !isWin() && !isMac()) tools.ffprobe = 'ffprobe';
  tools.whisper = (await usable(s.whisperPath)) ? s.whisperPath : (await macBundled('whisper-cli')) || (await findFile(toolsDir(whisperFolder()), exe('whisper-cli')));
  tools.piper = (await usable(s.piperPath)) ? s.piperPath : await findFile(toolsDir('piper'), exe('piper'));
  return tools;
}

/** Downloads url to dest with progress callbacks (received, total). */
export function downloadTo(url, dest, onProgress, signal) {
  const jobId = newJobId('dl');
  const off = on('download-progress', (p) => {
    if (p.jobId === jobId) onProgress?.(p.received, p.total);
  });
  const abort = () => invoke('download_cancel', { jobId }).catch(() => {});
  signal?.addEventListener('abort', abort);
  return invoke('download', { jobId, url, dest }).finally(() => {
    off();
    signal?.removeEventListener('abort', abort);
  });
}

async function downloadAndUnzip(urls, folder, label, onProgress, signal) {
  const dir = toolsDir(folder);
  await mkdir(dir);
  const zip = join(dir, 'download.zip');
  let lastErr = null;
  for (const url of [].concat(urls)) {
    try {
      await downloadTo(url, zip, (r, t) => onProgress?.({ label: `Downloading ${label}`, received: r, total: t }), signal);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    }
  }
  if (lastErr) throw lastErr;
  onProgress?.({ label: `Unpacking ${label}` });
  await invoke('unzip', { zipPath: zip, destDir: dir });
  await remove(zip);
}

export async function ensureFfmpeg(onProgress) {
  await locateTools();
  if (tools.ffmpeg && tools.ffprobe) return tools;
  if (isMac()) {
    await downloadAndUnzip(MAC_FFMPEG(paths.arch, 'ffmpeg'), 'ffmpeg', 'FFmpeg (about 80 MB)', onProgress);
    await downloadAndUnzip(MAC_FFMPEG(paths.arch, 'ffprobe'), 'ffmpeg', 'FFprobe (about 80 MB)', onProgress);
    await locateTools();
    if (!tools.ffmpeg || !tools.ffprobe) throw new Error('FFmpeg downloaded but ffmpeg was not found in it.');
    return tools;
  }
  if (!isWin()) throw new Error('FFmpeg was not found. Set its location in Settings.');
  await downloadAndUnzip(FFMPEG_URLS, 'ffmpeg', 'FFmpeg (about 190 MB)', onProgress);
  await locateTools();
  if (!tools.ffmpeg) throw new Error('FFmpeg downloaded but ffmpeg.exe was not found in it.');
  return tools;
}

// the GPU build lives in its own folder so switching the setting fetches the right one
const whisperFolder = () => (store.settings.whisperGpu && !isMac() ? 'whisper-cuda' : 'whisper');

export async function ensureWhisper(modelKey, onProgress, signal) {
  await locateTools();
  if (!tools.whisper) {
    if (isMac()) throw new Error('whisper-cli is missing from the app. Download the Mac version of the editor again.');
    if (!isWin()) throw new Error('whisper-cli was not found. Set its location in Settings.');
    await downloadAndUnzip(store.settings.whisperGpu && isWin() ? WHISPER_GPU_URL : WHISPER_URL, whisperFolder(), 'whisper.cpp', onProgress, signal);
    await locateTools();
    if (!tools.whisper) throw new Error('whisper.cpp downloaded but whisper-cli.exe was not found in it.');
  }
  const m = WHISPER_MODELS[modelKey] || WHISPER_MODELS.small;
  const modelPath = toolsDir('whisper', 'models', m.file);
  if (!(await exists(modelPath))) {
    await mkdir(toolsDir('whisper', 'models'));
    await downloadTo(HF_WHISPER + m.file, modelPath, (r, t) => onProgress?.({ label: `Downloading the ${modelKey} speech model (${m.size})`, received: r, total: t }), signal);
  }
  return { bin: tools.whisper, model: modelPath };
}

export async function ensurePiper(voiceKey, onProgress, signal) {
  await locateTools();
  if (!tools.piper) {
    if (!isWin()) throw new Error('Piper was not found. Set its location in Settings.');
    await downloadAndUnzip(PIPER_URL, 'piper', 'Piper voice engine', onProgress, signal);
    await locateTools();
    if (!tools.piper) throw new Error('Piper downloaded but piper.exe was not found in it.');
  }
  const v = PIPER_VOICES[voiceKey] || PIPER_VOICES['en_US-lessac-medium'];
  const voiceDir = toolsDir('piper-voices');
  const model = join(voiceDir, voiceKey + '.onnx');
  const config = model + '.json';
  if (!(await exists(model)) || !(await exists(config))) {
    await mkdir(voiceDir);
    await downloadTo(HF_PIPER + v.path + voiceKey + '.onnx.json', config, null, signal);
    await downloadTo(HF_PIPER + v.path + voiceKey + '.onnx', model, (r, t) => onProgress?.({ label: `Downloading the ${voiceKey} voice`, received: r, total: t }), signal);
  }
  return { bin: tools.piper, model };
}

export async function ensureSegModel(key, onProgress, signal) {
  const m = SEG_MODELS[key] || SEG_MODELS.person;
  const p = toolsDir('models', m.file);
  const st = await stat(p);
  if (!st || st.size < 1000) {
    await mkdir(toolsDir('models'));
    await downloadTo(m.url, p, (r, t) => onProgress?.({ label: `Downloading the ${m.label.toLowerCase()} model (${m.mb} MB)`, received: r, total: t }), signal);
  }
  return { path: p, size: m.size };
}

export const DEPTH_MODEL = { file: 'depth_anything_v2_vits.onnx', size: 518, url: 'https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx', mb: 99 };

export async function ensureDepthModel(onProgress, signal) {
  const m = DEPTH_MODEL;
  const p = toolsDir('models', m.file);
  const st = await stat(p);
  if (!st || st.size < 1000) {
    await mkdir(toolsDir('models'));
    await downloadTo(m.url, p, (r, t) => onProgress?.({ label: `Downloading the depth model (${m.mb} MB)`, received: r, total: t }), signal);
  }
  return { path: p, size: m.size };
}

export function rememberToolPath(key, value) {
  saveSettings({ [key]: value });
}
