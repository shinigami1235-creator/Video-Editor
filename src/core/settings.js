import { paths, join, readJson, writeJson } from '../backend/index.js';
import { store } from './store.js';
import { debounce } from './util.js';

export const DEFAULT_SETTINGS = {
  ffmpegPath: '',
  ffprobePath: '',
  whisperPath: '',
  whisperModel: 'small',
  whisperLanguage: 'auto',
  whisperGpu: false,
  piperPath: '',
  piperVoice: 'en_US-lessac-medium',
  editCopyHeight: 1080,
  previewQuality: 'half',
  autosaveSeconds: 30,
  replicateToken: '',
  replicateImageModel: 'black-forest-labs/flux-schnell',
  replicateVideoModel: 'minimax/video-01',
  replicateMusicModel: 'meta/musicgen',
  replicateUpscaleModel: 'nightmareai/real-esrgan',
  replicateVoiceModel: 'lucataco/xtts-v2',
  replicateAvatarModel: 'cjwbw/sadtalker',
  recentProjects: [],
  exportFolder: '',
  lastPreset: 'reels',
  brandKits: [],
  userLuts: [],
  userTemplates: [],
  snapping: true,
  magneticDefault: true,
  paidServices: false,
};

/** Claude and Replicate cost money per use, so they stay off until switched on in Settings. */
export function paidOn() {
  return !!store.settings?.paidServices || !!globalThis.__claudeMock;
}

export const PAID_OFF_MESSAGE = 'Paid services are switched off. Turn them on in Settings, under Paid services.';

let settingsPath = null;

export async function loadSettings() {
  settingsPath = join(paths.appData, 'settings.json');
  const s = await readJson(settingsPath, {});
  store.settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  return store.settings;
}

const saveNow = () => writeJson(settingsPath, store.settings).catch((e) => console.warn('settings save failed', e));
const saveSoon = debounce(saveNow, 400);

export function saveSettings(patch = {}, { immediate = false } = {}) {
  Object.assign(store.settings, patch);
  store.emit('settings');
  if (immediate) return saveNow();
  saveSoon();
}

export function addRecent(path, name) {
  const list = (store.settings.recentProjects || []).filter((r) => r.path !== path);
  list.unshift({ path, name, opened: Date.now() });
  saveSettings({ recentProjects: list.slice(0, 12) });
}
