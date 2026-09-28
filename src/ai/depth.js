// Moving photo: estimates depth in a still photo (Depth Anything V2 small,
// running on this computer) and moves a virtual camera through it, so the
// front of a product moves more than the background.

import { store } from '../core/store.js';
import { ensureDepthModel } from '../media/tools.js';
import { loadImage, mediaDir } from '../media/library.js';
import { join, exists, writeBytes, mkdir } from '../backend/index.js';
import { session } from './segment.js';
import { startJob, modal, toast } from '../ui/notify.js';
import { h, select, slider } from '../ui/dom.js';
import { isVisualItem } from '../core/model.js';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Makes (or reuses) the depth map of a photo. Returns the PNG path. White is near. */
export async function depthMapFor(m, job) {
  const out = join(mediaDir(m), 'depth.png');
  if (await exists(out)) return out;
  const model = await ensureDepthModel((pr) => job?.download(pr), job?.signal);
  job?.update(null, 'Working out the depth');
  const entry = await session(model.path);
  const { s, o } = entry;
  const N = model.size;
  const bmp = await loadImage(m.display || m.path);
  const c = new OffscreenCanvas(N, N);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, N, N);
  const px = g.getImageData(0, 0, N, N).data;
  const n = N * N;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) input[k * n + i] = (px[i * 4 + k] / 255 - MEAN[k]) / STD[k];
  const res = await s.run({ [s.inputNames[0]]: new o.Tensor('float32', input, [1, 3, N, N]) });
  const d = res[s.outputNames[0]].data;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < d.length; i++) {
    lo = Math.min(lo, d[i]);
    hi = Math.max(hi, d[i]);
  }
  const dc = new OffscreenCanvas(N, N);
  const dg = dc.getContext('2d');
  const img = dg.createImageData(N, N);
  for (let i = 0; i < n; i++) {
    const v = Math.round(((d[i] - lo) / Math.max(1e-6, hi - lo)) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  dg.putImageData(img, 0, 0);
  // back to the photo's shape, softened so edges do not tear when the camera moves
  const W = Math.min(1024, bmp.width);
  const H = Math.round((W * bmp.height) / bmp.width);
  const fc = new OffscreenCanvas(W, H);
  const fg = fc.getContext('2d');
  fg.filter = `blur(${Math.max(1, W / 400).toFixed(1)}px)`;
  fg.drawImage(dc, 0, 0, W, H);
  const blob = await fc.convertToBlob({ type: 'image/png' });
  await mkdir(mediaDir(m));
  await writeBytes(out, new Uint8Array(await blob.arrayBuffer()), { offset: 0, truncate: true });
  return out;
}

export const DEPTH_MOTIONS = [
  ['push', 'Push in'],
  ['pull', 'Pull out'],
  ['orbit', 'Slide around'],
  ['orbitPush', 'Slide and push'],
  ['rise', 'Rise up'],
];

export async function makeDepthShot(it, opts) {
  const p = store.project;
  const m = p.media[it.mediaId];
  const job = startJob('Moving photo');
  try {
    const map = await depthMapFor(m, job);
    store.commit('Moving photo', (pp) => {
      const cur = pp.items[it.id];
      if (cur) cur.effects.depth3d = { map, motion: opts.motion, amount: opts.amount, focus: opts.focus };
    });
    job.done('The photo now moves.');
  } catch (e) {
    job.fail(e);
  }
}

export function depthShotDialog(app, it) {
  const p = store.project;
  if (!it || it.type !== 'clip' || !isVisualItem(p, it) || p.media[it.mediaId]?.kind !== 'image') return toast('Select a photo on the timeline first.', { timeout: 2500 });
  const cur = it.effects.depth3d || {};
  const opts = { motion: cur.motion || 'push', amount: cur.amount ?? 1, focus: cur.focus || 'middle' };
  const body = h(
    'div',
    { class: 'stack' },
    h('p', {}, 'The editor works out how far each part of the photo is from the camera, then moves the camera through it over the length of the clip. The first time downloads the depth model (99 MB).'),
    select('Camera move', DEPTH_MOTIONS, opts.motion, (v) => (opts.motion = v)),
    slider('Strength', { value: opts.amount, min: 0.2, max: 2.5, step: 0.05, format: (v) => Math.round(v * 100) + '%', onInput: (v) => (opts.amount = v) }),
    select('Stays still', [['front', 'The front (the product)'], ['middle', 'The middle'], ['back', 'The background']], opts.focus, (v) => (opts.focus = v)),
  );
  modal('Moving photo', body, {
    width: 480,
    actions: [
      cur.map ? { label: 'Remove', kind: 'danger', run: (close) => { close(); store.commit('Remove moving photo', () => delete it.effects.depth3d); } } : null,
      { label: 'Cancel', run: (close) => close() },
      { label: cur.map ? 'Update' : 'Make it move', primary: true, run: (close) => { close(); makeDepthShot(it, opts); } },
    ].filter(Boolean),
  });
}
