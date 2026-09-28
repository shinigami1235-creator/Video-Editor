// Before and after alignment: finds the face in both shots and moves and
// scales the after shot so the faces sit exactly on top of each other.

import { store } from '../core/store.js';
import { sourceTime, itemEnd, isVisualItem } from '../core/model.js';
import { sourceToProject } from '../core/props.js';
import { loadImage } from '../media/library.js';
import { detectFaces } from './faces.js';
import { framesAt } from './frames.js';
import { toast, startJob, modal } from '../ui/notify.js';
import { h, button, toggle } from '../ui/dom.js';
import { clamp } from '../core/util.js';

async function frameOf(it) {
  const p = store.project;
  const m = p.media[it.mediaId];
  if (m.kind === 'image') {
    const bmp = await loadImage(m.display || m.path);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c;
  }
  const t = clamp(store.playhead, it.start, itemEnd(it) - 0.05);
  for await (const f of framesAt(m, [sourceTime(it, t)], { width: 640 })) return f.canvas;
  return null;
}

async function biggestFace(it) {
  const c = await frameOf(it);
  if (!c) return null;
  const faces = await detectFaces(c, 0.6);
  if (!faces.length) return null;
  return faces.reduce((a, b) => ((b.x2 - b.x1) * (b.y2 - b.y1) > (a.x2 - a.x1) * (a.y2 - a.y1) ? b : a));
}

/** Moves and scales `after` so its face matches the face in `before`. */
export function matchFace(p, before, fa, after, fb, t = store.playhead) {
  const ta = clamp(t, before.start, itemEnd(before) - 0.01);
  const tb = clamp(t, after.start, itemEnd(after) - 0.01);
  const a1 = sourceToProject(p, before, fa.x1, fa.y1, ta);
  const a2 = sourceToProject(p, before, fa.x2, fa.y2, ta);
  const b1 = sourceToProject(p, after, fb.x1, fb.y1, tb);
  const b2 = sourceToProject(p, after, fb.x2, fb.y2, tb);
  const wa = Math.hypot(a2.x - a1.x, a2.y - a1.y);
  const wb = Math.hypot(b2.x - b1.x, b2.y - b1.y);
  const k = wa / Math.max(1, wb);
  for (const key of ['x', 'y', 'scale']) delete after.kf[key];
  after.props.scale = +(after.props.scale * k).toFixed(4);
  const bc = sourceToProject(p, after, (fb.x1 + fb.x2) / 2, (fb.y1 + fb.y2) / 2, tb);
  const ac = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
  after.props.x = Math.round(after.props.x + ac.x - bc.x);
  after.props.y = Math.round(after.props.y + ac.y - bc.y);
  return k;
}

export async function alignBeforeAfter(app) {
  const p = store.project;
  const clips = store.selectedItems.filter((i) => i.type === 'clip' && isVisualItem(p, i));
  if (clips.length !== 2) return toast('Select the before and the after shot, two clips or photos.', { timeout: 3000 });
  // the earlier one (or the lower track when they overlap) is the before shot
  const order = (c) => c.start * 1000 - p.tracks.findIndex((t) => t.id === c.trackId);
  const [before, after] = [...clips].sort((a, b) => order(a) - order(b));
  const job = startJob('Align before and after');
  try {
    job.update(null, 'Finding the faces');
    const fa = await biggestFace(before);
    const fb = await biggestFace(after);
    if (!fa || !fb) {
      job.done();
      return toast(`No face was found in the ${!fa ? 'before' : 'after'} shot. Line them up by hand with 50% opacity instead.`, { kind: 'warn', timeout: 5000 });
    }
    let k = 1;
    store.commit('Align before and after', (pp) => (k = matchFace(pp, before, fa, after, fb)));
    job.done();
    checkDialog(app, before, after, k);
  } catch (e) {
    job.fail(e);
  }
}

/** Shows both shots at half opacity so the match can be checked and nudged. */
function checkDialog(app, before, after, k) {
  const origOpacity = after.props.opacity;
  const overlap = Math.abs(before.start - after.start) < 0.01 || (after.start < itemEnd(before) && itemEnd(after) > before.start);
  let ghost = overlap;
  const setGhost = (on) => {
    const a = store.project.items[after.id];
    if (a) store.mutate(() => (a.props.opacity = on ? 0.5 : origOpacity));
  };
  if (ghost) setGhost(true);
  // the 50% view is only for checking, so it is taken off before each change is recorded
  const live = () => store.project.items[after.id];
  const setGhostLive = (on) => live() && store.mutate(() => (live().props.opacity = on ? 0.5 : origOpacity));
  const nudge = (dx, dy, ds = 1) => {
    if (!live()) return;
    setGhostLive(false);
    store.commit('Nudge', () => {
      const a = live();
      a.props.x += dx;
      a.props.y += dy;
      a.props.scale = +(a.props.scale * ds).toFixed(4);
    });
    if (ghost) setGhostLive(true);
  };
  const pad = h(
    'div',
    { class: 'nudge-pad' },
    button('Up', () => nudge(0, -2), { kind: 'link' }),
    button('Down', () => nudge(0, 2), { kind: 'link' }),
    button('Left', () => nudge(-2, 0), { kind: 'link' }),
    button('Right', () => nudge(2, 0), { kind: 'link' }),
    button('Bigger', () => nudge(0, 0, 1.01), { kind: 'link' }),
    button('Smaller', () => nudge(0, 0, 1 / 1.01), { kind: 'link' }),
  );
  modal(
    'Before and after lined up',
    h(
      'div',
      { class: 'stack' },
      h('p', {}, `The after shot is scaled ${Math.round(k * 100)}% and moved so the faces match.`),
      overlap ? toggle('Show both at 50% to check the match', ghost, (v) => setGhost((ghost = v))) : h('p', { class: 'hint' }, 'The two shots do not overlap on the timeline. Stack them with the Before and after template to compare.'),
      pad,
    ),
    { width: 440, onClose: () => setGhost(false), actions: [{ label: 'Done', primary: true, run: (close) => close(true) }] },
  );
}
