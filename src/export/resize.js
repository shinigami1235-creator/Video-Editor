// Makes a copy of a project in another shape (9:16, 4:5, 1:1, 16:9) so one
// edit can be exported for every platform. Full-frame clips are refitted,
// titles, captions and overlays move and scale with the frame.

import { clone } from '../core/util.js';
import * as E from '../core/edit.js';

export const SHAPES = [
  { id: '9x16', name: '9:16 Reels and TikTok', w: 1080, h: 1920 },
  { id: '4x5', name: '4:5 feed', w: 1080, h: 1350 },
  { id: '1x1', name: '1:1 square', w: 1080, h: 1080 },
  { id: '16x9', name: '16:9 YouTube', w: 1920, h: 1080 },
];

export function shapeOf(project) {
  const r = project.settings.width / project.settings.height;
  return SHAPES.reduce((best, s) => (Math.abs(s.w / s.h - r) < Math.abs(best.w / best.h - r) ? s : best), SHAPES[0]);
}

function scaleKf(it, prop, f) {
  if (it.props?.[prop] != null) it.props[prop] *= f;
  for (const k of it.kf?.[prop] || []) k.v *= f;
}

/** A copy of `project` with a W2 x H2 frame. framing: 'blur' | 'contain' | 'cover'. */
export function adaptProject(project, W2, H2, framing = 'blur') {
  const p = clone(project);
  const W = p.settings.width;
  const H = p.settings.height;
  const kx = W2 / W;
  const ky = H2 / H;
  // text lines are wide, so fitting the width matters most
  const k = Math.min(kx, Math.sqrt(kx * ky));
  p.settings.width = W2;
  p.settings.height = H2;
  const main = E.mainTrack(p);
  for (const it of Object.values(p.items)) {
    const fullFrame = it.type === 'clip' && it.trackId === main?.id;
    scaleKf(it, 'x', kx);
    scaleKf(it, 'y', ky);
    if (fullFrame) {
      const m = p.media[it.mediaId];
      const differs = m?.width && Math.abs(m.width / m.height - W2 / H2) > 0.05;
      it.fit = framing === 'cover' ? 'cover' : 'contain';
      it.effects.backdrop = framing === 'blur' && differs ? 'blur' : it.effects.backdrop === 'blur' && !differs ? null : it.effects.backdrop;
    } else if (it.type === 'blur') {
      // the region size is w x h times its scale, so only one of them changes
      it.w *= k;
      it.h *= k;
    } else if (it.type === 'text' || it.type === 'shape') {
      scaleKf(it, 'scale', k);
    }
    // overlay clips refit to the new frame through their fit, so their scale stays
  }
  if (p.captionStyle) p.captionStyle = { ...p.captionStyle };
  return p;
}
