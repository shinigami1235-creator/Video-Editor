// Commands for the smart tools. App.cmd() falls back to this table.

import { store } from '../core/store.js';
import { itemEnd, isVisualItem } from '../core/model.js';
import { getProp } from '../core/props.js';
import { toast } from '../ui/notify.js';
import { clamp } from '../core/util.js';

const clipOrSelected = (it) => it || store.primary;

export const COMMANDS = {
  // captions
  captions: async (app, it) => (await import('./captions.js')).autoCaptions(app, it),
  captionPreset: async (app, id) => {
    (await import('./captions.js')).applyCaptionPreset(id);
    app.renderPanel();
  },
  captionY: async (app, v, commit) => (await import('./captions.js')).setCaptionY(v, commit),
  captionWords: async (app, n) => (await import('./captions.js')).rechunkCaptions(n),
  captionStyleFrom: async (app, it) => (await import('./captions.js')).captionStyleFrom(it),
  editCaptions: async (app) => (await import('./captions.js')).editCaptions(app),
  importSrt: async () => (await import('./captions.js')).importSrt(),
  exportSrt: async () => (await import('./captions.js')).exportSrt(),
  deleteCaptions: async (app) => {
    (await import('./captions.js')).deleteCaptions();
    app.renderPanel();
  },

  // speech and music
  silenceCut: async (app, it) => (await import('./speech-edit.js')).silenceCut(clipOrSelected(it)),
  fillerCut: async (app, it) => (await import('./speech-edit.js')).fillerCut(clipOrSelected(it)),
  beats: async (app, it) => (await import('./speech-edit.js')).markBeats(clipOrSelected(it)),
  beatSync: async (app) => (await import('./speech-edit.js')).beatSync(app),
  scriptToVideo: async (app) => (await import('./script.js')).scriptToVideo(app),
  generate: async (app) => (await import('./generate.js')).generateDialog(app),

  // processing
  removeBackground: async (app, it) => (await import('./segment.js')).removeBackground(clipOrSelected(it)),
  revertMedia: async (app, it) => (await import('./processing.js')).revertMedia(clipOrSelected(it)),
  reverse: async (app, it) => (await import('./processing.js')).reverseClip(clipOrSelected(it)),
  stabilize: async (app, it) => (await import('./processing.js')).stabilizeClip(clipOrSelected(it)),
  smoothSlowmo: async (app, it) => (await import('./processing.js')).smoothSlowmo(clipOrSelected(it)),
  denoise: async (app, it) => (await import('./processing.js')).denoiseClip(clipOrSelected(it)),
  normalizeClip: async (app, it) => (await import('./processing.js')).normalizeClip(clipOrSelected(it)),
  compressClip: async (app, it) => (await import('./processing.js')).compressClip(clipOrSelected(it)),
  voiceEffect: async (app, it, kind) => (await import('./processing.js')).voiceEffect(clipOrSelected(it), kind),
  faceBlur: async (app, it) => (await import('./faces.js')).faceBlur(clipOrSelected(it)),
  autoReframe: async (app, it) => (await import('./faces.js')).autoReframe(clipOrSelected(it)),
  trackBlur: async (app, it) => (await import('./tracker.js')).startTrackBlur(clipOrSelected(it)),
  trackRegion: async (app, it) => (await import('./tracker.js')).trackRegion(clipOrSelected(it)),

  // brand
  applyBrandColor: async (app, c) => (await import('./brand.js')).applyBrandColor(c),
  addLogo: async (app, path) => (await import('./brand.js')).addLogo(app, path),
  brandWatermark: async (app, kit) => (await import('./brand.js')).brandWatermark(app, kit),
  brandEndCard: async (app, kit) => (await import('./brand.js')).brandEndCard(app, kit),
  brandFonts: async (app, kit) => (await import('./brand.js')).brandFonts(kit),
  editBrandKit: async (app, kit) => (await import('./brand.js')).editBrandKit(app, kit),
  importPhotoEditorKits: async (app) => (await import('./brand.js')).importPhotoEditorKits(app),

  /** Zooms toward the next point clicked on the preview, holds, then zooms back. */
  zoomToSpot: async (app, it) => {
    it = clipOrSelected(it);
    if (!it || !isVisualItem(store.project, it)) return toast('Select a video or photo clip first.', { timeout: 1500 });
    if (store.playhead < it.start || store.playhead >= itemEnd(it)) app.seek(it.start + 0.01);
    toast('Click the spot on the preview to zoom toward.', { timeout: 3000 });
    const overlay = app.viewer.overlay;
    overlay.classList.add('picking');
    const pt = await new Promise((resolve) => {
      const fn = (e) => {
        e.stopPropagation();
        e.preventDefault();
        overlay.removeEventListener('pointerdown', fn, true);
        overlay.classList.remove('picking');
        resolve(app.viewer.toProject(e));
      };
      overlay.addEventListener('pointerdown', fn, true);
    });
    const p = store.project;
    const W = p.settings.width;
    const H = p.settings.height;
    const lt = clamp(store.playhead - it.start, 0, it.duration);
    const s0 = getProp(it, 'scale');
    const x0 = getProp(it, 'x');
    const y0 = getProp(it, 'y');
    const s1 = s0 * 1.9;
    // the content point under the click, relative to the item centre before scaling
    const cx = (pt.x - (W / 2 + x0)) / s0;
    const cy = (pt.y - (H / 2 + y0)) / s0;
    const x1 = -s1 * cx;
    const y1 = -s1 * cy;
    const tIn = Math.min(it.duration, lt + 0.7);
    const tHold = Math.min(it.duration, tIn + 2);
    const tOut = Math.min(it.duration, tHold + 0.7);
    store.commit('Zoom to a spot', () => {
      const set = (prop, list) => {
        it.kf[prop] = (it.kf[prop] || []).filter((k) => k.t < lt - 0.01 || k.t > tOut + 0.01);
        it.kf[prop].push(...list);
        it.kf[prop].sort((a, b) => a.t - b.t);
      };
      set('scale', [
        { t: lt, v: s0, e: 'easeInOut' },
        { t: tIn, v: s1, e: 'easeInOut' },
        { t: tHold, v: s1, e: 'easeInOut' },
        { t: tOut, v: s0, e: 'easeInOut' },
      ]);
      set('x', [
        { t: lt, v: x0, e: 'easeInOut' },
        { t: tIn, v: x1, e: 'easeInOut' },
        { t: tHold, v: x1, e: 'easeInOut' },
        { t: tOut, v: x0, e: 'easeInOut' },
      ]);
      set('y', [
        { t: lt, v: y0, e: 'easeInOut' },
        { t: tIn, v: y1, e: 'easeInOut' },
        { t: tHold, v: y1, e: 'easeInOut' },
        { t: tOut, v: y0, e: 'easeInOut' },
      ]);
    });
    toast('Zoom added. Drag the keyframes on the clip to change the timing.', { timeout: 3000 });
  },

  /** Fills the empty frame around a clip with a blurred copy of itself. */
  blurBackdrop: async (app) => {
    const clips = store.selectedItems.filter((i) => i.type === 'clip' && isVisualItem(store.project, i));
    if (!clips.length) return toast('Select a clip first.', { timeout: 1500 });
    const on = !clips[0].effects.backdrop;
    store.commit(on ? 'Blurred background' : 'Remove blurred background', () => clips.forEach((c) => (c.effects.backdrop = on ? 'blur' : null)));
  },

  noop: () => true,
};
