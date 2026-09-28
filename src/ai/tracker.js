// Follows an area through a clip with template matching (normalised
// cross-correlation), for blurs that stick to a tattoo, a name tag or a screen.

import { store } from '../core/store.js';
import { itemEnd, sourceTime, activeVisualItems, newBlurRegion } from '../core/model.js';
import * as E from '../core/edit.js';
import { framesAt, grayscale } from './frames.js';
import { projectToSource, sourceToProject, itemBox } from '../core/props.js';
import { startJob, toast } from '../ui/notify.js';
import { clamp } from '../core/util.js';

function patch(img, cx, cy, w, h) {
  const out = new Float32Array(w * h);
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);
  for (let y = 0; y < h; y++) {
    const yy = clamp(y0 + y, 0, img.height - 1);
    for (let x = 0; x < w; x++) out[y * w + x] = img.g[yy * img.width + clamp(x0 + x, 0, img.width - 1)];
  }
  return out;
}

function stats(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  const mean = s / a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - mean) ** 2;
  return { mean, sd: Math.sqrt(v / a.length) || 1 };
}

/** Best match of template T (w x h) near (cx, cy) within radius r. */
function search(img, T, tst, w, h, cx, cy, r) {
  let best = { score: -2, x: cx, y: cy };
  const step = r > 24 ? 2 : 1;
  const tryAt = (px, py) => {
    const x0 = Math.round(px - w / 2);
    const y0 = Math.round(py - h / 2);
    if (x0 < 0 || y0 < 0 || x0 + w > img.width || y0 + h > img.height) return;
    let s = 0;
    let s2 = 0;
    let st = 0;
    for (let y = 0; y < h; y++) {
      const row = (y0 + y) * img.width + x0;
      const trow = y * w;
      for (let x = 0; x < w; x++) {
        const v = img.g[row + x];
        s += v;
        s2 += v * v;
        st += v * (T[trow + x] - tst.mean);
      }
    }
    const n = w * h;
    const mean = s / n;
    const sd = Math.sqrt(Math.max(1e-6, s2 / n - mean * mean));
    const score = st / (n * sd * tst.sd);
    if (score > best.score) best = { score, x: px, y: py };
  };
  for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) tryAt(cx + dx, cy + dy);
  if (step > 1) {
    const c = { ...best };
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tryAt(c.x + dx, c.y + dy);
  }
  return best;
}

async function trackRun(m, times, box, frameW, signal, onStep) {
  const out = [];
  let T = null;
  let tst = null;
  let cx = 0;
  let cy = 0;
  let tw = 0;
  let th = 0;
  let lost = 0;
  let i = 0;
  for await (const f of framesAt(m, times, { width: frameW })) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    i++;
    if (!f.canvas) continue;
    const img = grayscale(f.canvas);
    if (!T) {
      tw = Math.max(8, Math.round(box.w * img.width));
      th = Math.max(8, Math.round(box.h * img.height));
      cx = box.u * img.width;
      cy = box.v * img.height;
      T = patch(img, cx, cy, tw, th);
      tst = stats(T);
      out.push({ time: f.time, u: box.u, v: box.v, score: 1 });
      continue;
    }
    const r = Math.max(10, Math.round(Math.max(tw, th) * 0.7));
    const b = search(img, T, tst, tw, th, cx, cy, r);
    if (b.score > 0.35) {
      cx = b.x;
      cy = b.y;
      lost = 0;
      if (b.score > 0.75) {
        const np = patch(img, cx, cy, tw, th);
        for (let k = 0; k < T.length; k++) T[k] = T[k] * 0.9 + np[k] * 0.1;
        tst = stats(T);
      }
    } else lost++;
    out.push({ time: f.time, u: cx / img.width, v: cy / img.height, score: b.score });
    onStep?.(i);
    if (lost > 12) break;
  }
  return out;
}

/** Tracks what is under a blur region through the clip below it. */
export async function trackRegion(region) {
  const p = store.project;
  const t = store.playhead;
  if (t < region.start || t >= itemEnd(region)) return toast('Put the playhead inside the selected item first.', { kind: 'warn' });
  const under = activeVisualItems(p, t)
    .filter((i) => i.type === 'clip' && p.media[i.mediaId]?.kind === 'video' && i.id !== region.id)
    .pop();
  if (!under) return toast('There is no video under it at the playhead.', { kind: 'warn' });
  const m = p.media[under.mediaId];
  const rb = itemBox(p, region, t);
  const c = projectToSource(p, under, rb.cx, rb.cy, t);
  const box = { u: c.u, v: c.v, w: rb.w / c.pxPerU, h: rb.h / c.pxPerV };
  if (box.u < 0 || box.u > 1 || box.v < 0 || box.v > 1) return toast('Move it over the video first.', { kind: 'warn' });
  const job = startJob('Track area');
  try {
    const fps = Math.min(15, m.fps || 30);
    const end = Math.min(itemEnd(region), itemEnd(under));
    const start = Math.max(region.start, under.start);
    const fwd = [];
    for (let x = t; x < end; x += 1 / fps) fwd.push(x);
    const back = [];
    for (let x = t; x >= start; x -= 1 / fps) back.push(x);
    const frameW = clamp(Math.round(48 / Math.max(0.02, box.w)), 200, 720);
    const total = fwd.length + back.length;
    const a = await trackRun(m, fwd.map((x) => sourceTime(under, x)), box, frameW, job.signal, (i) => job.update(i / total, 'Following forward'));
    const b = back.length > 1 ? await trackRun(m, back.map((x) => sourceTime(under, x)), box, frameW, job.signal, (i) => job.update((fwd.length + i) / total, 'Following backward')) : [];
    const pts = [...b.slice(1).reverse().map((s, k) => ({ ...s, tl: back[b.length - 1 - k] })), ...a.map((s, k) => ({ ...s, tl: fwd[k] }))].filter((s) => s.tl != null);
    store.commit('Track area', (pp) => {
      region = pp.items[region.id];
      if (!region) return;
      region.kf.x = [];
      region.kf.y = [];
      for (const s of pts) {
        const pt = sourceToProject(pp, under, s.u, s.v, s.tl);
        const lt = clamp(s.tl - region.start, 0, region.duration);
        region.kf.x.push({ t: lt, v: Math.round(pt.x - pp.settings.width / 2), e: 'linear' });
        region.kf.y.push({ t: lt, v: Math.round(pt.y - pp.settings.height / 2), e: 'linear' });
      }
      region.kf.x.sort((q, r) => q.t - r.t);
      region.kf.y.sort((q, r) => q.t - r.t);
    });
    const lostAt = [...a, ...b].some((s) => s.score < 0.35);
    job.done(lostAt ? 'Tracked, but it lost the area in places. Check the clip and fix any keyframes that drift.' : 'It now follows that area of the video.');
  } catch (e) {
    job.fail(e);
  }
}

/** Makes a freehand mask follow what it outlines through its own clip. */
export async function trackMask(it) {
  const p = store.project;
  const m = p.media[it.mediaId];
  const pts = it.mask?.points;
  if (!pts || pts.length < 3) return toast('Draw the mask first.', { kind: 'warn' });
  if (m?.kind !== 'video') return toast('Following works on video clips.', { kind: 'warn' });
  const t = clamp(store.playhead, it.start, itemEnd(it) - 0.01);
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const dx0 = propAtSafe(it, 'maskDX', t);
  const dy0 = propAtSafe(it, 'maskDY', t);
  const box = { u: (Math.min(...xs) + Math.max(...xs)) / 2 + dx0, v: (Math.min(...ys) + Math.max(...ys)) / 2 + dy0, w: clamp(Math.max(...xs) - Math.min(...xs), 0.04, 0.6), h: clamp(Math.max(...ys) - Math.min(...ys), 0.04, 0.6) };
  const job = startJob('Follow the mask');
  try {
    const fps = Math.min(15, m.fps || 30);
    const fwd = [];
    for (let x = t; x < itemEnd(it); x += 1 / fps) fwd.push(x);
    const back = [];
    for (let x = t; x >= it.start; x -= 1 / fps) back.push(x);
    const frameW = clamp(Math.round(48 / box.w), 200, 720);
    const total = fwd.length + back.length;
    const a = await trackRun(m, fwd.map((x) => sourceTime(it, x)), box, frameW, job.signal, (i) => job.update(i / total, 'Following forward'));
    const b = back.length > 1 ? await trackRun(m, back.map((x) => sourceTime(it, x)), box, frameW, job.signal, (i) => job.update((fwd.length + i) / total, 'Following backward')) : [];
    const steps = [...b.slice(1).reverse().map((s, k) => ({ ...s, tl: back[b.length - 1 - k] })), ...a.map((s, k) => ({ ...s, tl: fwd[k] }))].filter((s) => s.tl != null);
    const baseU = box.u - dx0;
    const baseV = box.v - dy0;
    store.commit('Follow the mask', (pp) => {
      // an undo during the job swaps item objects, so write to the live one
      const cur = pp.items[it.id];
      if (!cur) return;
      cur.kf.maskDX = steps.map((s) => ({ t: clamp(s.tl - it.start, 0, it.duration), v: +(s.u - baseU).toFixed(4), e: 'linear' })).sort((q, r) => q.t - r.t);
      cur.kf.maskDY = steps.map((s) => ({ t: clamp(s.tl - it.start, 0, it.duration), v: +(s.v - baseV).toFixed(4), e: 'linear' })).sort((q, r) => q.t - r.t);
    });
    job.done([...a, ...b].some((s) => s.score < 0.35) ? 'The mask follows, but it lost the area in places.' : 'The mask now follows that area.');
  } catch (e) {
    job.fail(e);
  }
}

function propAtSafe(it, k, t) {
  const list = it.kf?.[k];
  if (!list?.length) return it.props?.[k] || 0;
  const local = t - it.start;
  if (local <= list[0].t) return list[0].v;
  for (let i = 0; i < list.length - 1; i++) if (local <= list[i + 1].t) return list[i].v + ((list[i + 1].v - list[i].v) * (local - list[i].t)) / Math.max(1e-9, list[i + 1].t - list[i].t);
  return list[list.length - 1].v;
}

/** Adds a blur region over a clip and asks the user to place it. */
export function startTrackBlur(it) {
  const p = store.project;
  const t = Math.max(store.playhead, it.start);
  let region = null;
  store.commit('Add tracked blur', (pp) => {
    region = newBlurRegion(null, t, Math.max(0.3, itemEnd(it) - t), { x: 0, y: 0, w: 260, h: 260 });
    region.name = 'Tracked blur';
    E.placeOverlay(pp, region);
  });
  store.select(region.id);
  toast('Drag the blur over the area to hide, then press "Track what is under this region" in the Region tab.', { timeout: 6000 });
  void p;
}
