// Timeline editing operations. Each works on a project object in place and is
// called inside store.commit(...) so it becomes one undo step.

import { uid, clone, clamp } from './util.js';
import {
  itemEnd,
  sourceTime,
  sourceSpan,
  newClip,
  newTrack,
  trackItems,
  maxClipDuration,
  curveIntegral,
  curveValue,
  shiftKeyframes,
  visualTracks,
  audioTracks,
  propAt,
} from './model.js';

const EPS = 1e-4;

export function mainTrack(project) {
  const v = visualTracks(project);
  return v[v.length - 1] || null;
}

/** The track that ripples: the main video track, or the first audio track in an audio project. */
export function spineTrack(project) {
  if (project.settings.audioOnly) return audioTracks(project)[0] || null;
  return mainTrack(project);
}

export function isMagnetic(project, trackId) {
  const main = spineTrack(project);
  return !!(project.settings.magnetic !== false && main && main.id === trackId);
}

export function addTrack(project, kind, { above = true } = {}) {
  const count = project.tracks.filter((t) => t.kind === kind).length + 1;
  const tr = newTrack(kind, kind === 'video' ? `Video ${count}` : `Audio ${count}`);
  if (kind === 'video') {
    // new visual tracks go on top of the stack (index 0 is the top layer)
    if (above) project.tracks.unshift(tr);
    else {
      const lastVideo = project.tracks.map((t) => t.kind).lastIndexOf('video');
      project.tracks.splice(lastVideo + 1, 0, tr);
    }
  } else {
    project.tracks.push(tr);
  }
  return tr;
}

export function removeTrack(project, trackId) {
  const kind = project.tracks.find((t) => t.id === trackId)?.kind;
  if (project.tracks.filter((t) => t.kind === kind).length <= 1) return false;
  for (const it of Object.values(project.items)) if (it.trackId === trackId) delete project.items[it.id];
  project.tracks = project.tracks.filter((t) => t.id !== trackId);
  return true;
}

/** Removes empty tracks beyond the first of each kind. */
export function pruneEmptyTracks(project) {
  for (const kind of ['video', 'audio']) {
    const tracks = project.tracks.filter((t) => t.kind === kind);
    for (const tr of tracks) {
      if (project.tracks.filter((t) => t.kind === kind).length <= 1) break;
      if (tr === mainTrack(project) || tr === spineTrack(project)) continue;
      if (!Object.values(project.items).some((it) => it.trackId === tr.id)) project.tracks = project.tracks.filter((t) => t !== tr);
    }
  }
}

export function isFree(project, trackId, start, end, ignore = new Set()) {
  return !Object.values(project.items).some(
    (it) => it.trackId === trackId && !ignore.has(it.id) && it.start < end - EPS && itemEnd(it) > start + EPS,
  );
}

/** Finds a track of `kind` with free space in [start, end), creating one if needed. */
export function findFreeTrack(project, kind, start, end, { prefer, skipMain = false } = {}) {
  const tracks = project.tracks.filter((t) => t.kind === kind && !t.locked);
  if (prefer && tracks.some((t) => t.id === prefer) && isFree(project, prefer, start, end)) return prefer;
  const main = mainTrack(project);
  // for visual tracks search from the bottom up so overlays stack upward
  const order = kind === 'video' ? [...tracks].reverse() : tracks;
  for (const t of order) {
    if (skipMain && t === main) continue;
    if (isFree(project, t.id, start, end)) return t.id;
  }
  return addTrack(project, kind).id;
}

/** Cuts a curve's [u0,u1] segment into a new curve over 0..1. */
export function subCurve(curve, u0, u1) {
  if (!curve) return null;
  const pts = [{ x: 0, y: curveValue(curve, u0) }];
  for (const p of curve) if (p.x > u0 + EPS && p.x < u1 - EPS) pts.push({ x: (p.x - u0) / (u1 - u0), y: p.y });
  pts.push({ x: 1, y: curveValue(curve, u1) });
  return pts;
}

/** Splits one item at timeline time t. Returns the new right-hand item or null. */
export function splitItem(project, it, t) {
  if (t <= it.start + 0.02 || t >= itemEnd(it) - 0.02) return null;
  const right = clone(it);
  right.id = uid('c');
  const leftDur = t - it.start;
  const rightDur = itemEnd(it) - t;
  if (it.type === 'clip') {
    right.in = sourceTime(it, t);
    if (it.speedCurve) {
      const u = leftDur / it.duration;
      right.speedCurve = subCurve(it.speedCurve, u, 1);
      it.speedCurve = subCurve(it.speedCurve, 0, u);
    }
    right.fadeIn = 0;
    it.fadeOut = 0;
  }
  if (it.words) {
    it.words = it.words.filter((w) => w.start < leftDur);
    right.words = (right.words || []).filter((w) => w.end > leftDur).map((w) => ({ ...w, start: w.start - leftDur, end: w.end - leftDur }));
  }
  right.start = t;
  right.duration = rightDur;
  it.duration = leftDur;
  // keyframes: keep the ones on each side and pin the value at the cut
  const leftKf = {};
  const rightKf = {};
  for (const [prop, list] of Object.entries(it.kf || {})) {
    const l = list.filter((k) => k.t <= leftDur + EPS);
    const r = list.filter((k) => k.t >= leftDur - EPS).map((k) => ({ ...k, t: k.t - leftDur }));
    if (l.length) leftKf[prop] = l;
    if (r.length) rightKf[prop] = r;
  }
  it.kf = leftKf;
  right.kf = rightKf;
  right.transitionIn = null;
  if (it.anim) {
    right.anim = { ...clone(it.anim), in: null };
    it.anim.out = null;
  }
  project.items[right.id] = right;
  return right;
}

export function splitAt(project, items, t) {
  const created = [];
  for (const it of items) {
    const r = splitItem(project, it, t);
    if (r) created.push(r);
  }
  return created;
}

/** Clears [start, end) on a track by trimming, splitting or deleting items. */
export function overwrite(project, trackId, start, end, ignore = new Set()) {
  for (const it of Object.values(project.items)) {
    if (it.trackId !== trackId || ignore.has(it.id)) continue;
    const s = it.start;
    const e = itemEnd(it);
    if (e <= start + EPS || s >= end - EPS) continue;
    if (s >= start - EPS && e <= end + EPS) {
      delete project.items[it.id];
    } else if (s < start && e > end) {
      const right = splitItem(project, it, end);
      it.duration = start - s;
      if (right) trimHeadTo(project, right, end);
    } else if (s < start) {
      it.duration = start - s;
    } else {
      trimHeadTo(project, it, end);
    }
  }
}

/** Moves an item's start to newStart keeping its end (head trim). */
export function trimHeadTo(project, it, newStart) {
  const end = itemEnd(it);
  newStart = Math.min(newStart, end - 0.05);
  if (it.type === 'clip' && !it.freeze) {
    const media = project.media[it.mediaId];
    if (media && media.kind !== 'image') {
      if (it.speedCurve) {
        // keep it simple: head trims flatten the curve section proportionally
        const u = (newStart - it.start) / it.duration;
        if (u >= 0) {
          it.in = sourceTime(it, newStart);
          it.speedCurve = subCurve(it.speedCurve, clamp(u, 0, 1), 1);
        } else {
          const extra = -u * it.duration * curveValue(it.speedCurve, 0);
          if (it.in - extra < 0) newStart = it.start - it.in / Math.max(0.01, curveValue(it.speedCurve, 0));
          it.in = Math.max(0, it.in - extra);
        }
      } else {
        const speed = it.speed || 1;
        const minStart = it.start - it.in / speed;
        newStart = Math.max(newStart, minStart);
        it.in = Math.max(0, it.in + (newStart - it.start) * speed);
      }
    }
  }
  const delta = newStart - it.start;
  it.start = newStart;
  it.duration = end - newStart;
  shiftKeyframes(it, delta);
  if (it.words) it.words = it.words.map((w) => ({ ...w, start: w.start - delta, end: w.end - delta })).filter((w) => w.end > 0);
}

/** Moves an item's end to newEnd (tail trim), clamped to the media. */
export function trimTailTo(project, it, newEnd) {
  let dur = Math.max(0.05, newEnd - it.start);
  if (it.type === 'clip') dur = Math.min(dur, maxClipDuration(project, it));
  it.duration = dur;
  for (const [prop, list] of Object.entries(it.kf || {})) {
    it.kf[prop] = list.filter((k) => k.t <= dur + EPS);
    if (!it.kf[prop].length) delete it.kf[prop];
  }
}

export function deleteItems(project, ids, { ripple = false } = {}) {
  const items = ids.map((id) => project.items[id]).filter(Boolean);
  // ripple per track, from the latest item backwards
  items.sort((a, b) => b.start - a.start);
  for (const it of items) {
    delete project.items[it.id];
    if (ripple || isMagnetic(project, it.trackId)) rippleShift(project, it.trackId, itemEnd(it), -it.duration);
  }
  compactMagnetic(project);
}

/** Shifts every item on a track that starts at or after `from` by delta seconds. */
export function rippleShift(project, trackId, from, delta) {
  for (const it of Object.values(project.items)) {
    if (it.trackId === trackId && it.start >= from - EPS) it.start = Math.max(0, it.start + delta);
  }
}

/** Keeps the magnetic main track contiguous from 0 with no gaps. */
export function compactMagnetic(project) {
  const main = spineTrack(project);
  if (!main || project.settings.magnetic === false) return;
  let t = 0;
  for (const it of trackItems(project, main.id)) {
    it.start = t;
    t += it.duration;
  }
}

/**
 * Inserts items into the magnetic main track at the boundary nearest `time`.
 * The inserted items keep their order.
 */
export function insertIntoMain(project, items, time) {
  const main = spineTrack(project);
  const existing = trackItems(project, main.id).filter((it) => !items.includes(it));
  let insertAt = existing.length;
  for (let i = 0; i < existing.length; i++) {
    const mid = existing[i].start + existing[i].duration / 2;
    if (time < mid) {
      insertAt = i;
      break;
    }
  }
  const order = [...existing.slice(0, insertAt), ...items, ...existing.slice(insertAt)];
  let t = 0;
  for (const it of order) {
    it.trackId = main.id;
    it.start = t;
    t += it.duration;
  }
}

/**
 * Adds media to the timeline. Video and images go to the main track (inserted
 * at the playhead when magnetic), audio-only files to an audio track.
 */
export function addMediaToTimeline(project, mediaList, time, { trackId = null } = {}) {
  if (project.settings.audioOnly) return addSoundToTimeline(project, mediaList, time, { trackId });
  const added = [];
  const visual = [];
  let audioTime = time;
  for (const m of mediaList) {
    if (m.kind === 'audio') {
      const probe = newClip(m, null, audioTime);
      probe.trackId = findFreeTrack(project, 'audio', audioTime, audioTime + probe.duration, { prefer: trackId });
      project.items[probe.id] = probe;
      added.push(probe);
      audioTime += probe.duration;
    } else {
      const c = newClip(m, null, 0);
      project.items[c.id] = c;
      visual.push(c);
      added.push(c);
    }
  }
  if (visual.length) {
    const target = trackId && project.tracks.find((t) => t.id === trackId && t.kind === 'video');
    if (!target || isMagnetic(project, target.id)) {
      insertIntoMain(project, visual, time);
    } else {
      let t = time;
      for (const c of visual) {
        c.trackId = target.id;
        overwrite(project, target.id, t, t + c.duration, new Set([c.id]));
        c.start = t;
        t += c.duration;
      }
    }
  }
  return added;
}

/**
 * Audio projects: every file with sound goes onto an audio track, a video
 * brings only its sound, and photos are left out. The first audio track is
 * the magnetic one.
 */
function addSoundToTimeline(project, mediaList, time, { trackId = null } = {}) {
  const clips = [];
  for (const m of mediaList) {
    if (m.kind === 'image' || (m.kind === 'video' && m.hasAudio === false)) continue;
    const c = newClip(m, null, 0);
    project.items[c.id] = c;
    clips.push(c);
  }
  if (!clips.length) return clips;
  const spine = spineTrack(project);
  const target = (trackId && project.tracks.find((t) => t.id === trackId && t.kind === 'audio')) || spine;
  if (target && isMagnetic(project, target.id)) {
    insertIntoMain(project, clips, time);
    return clips;
  }
  let t = time;
  for (const c of clips) {
    c.trackId = target && isFree(project, target.id, t, t + c.duration, new Set([c.id])) ? target.id : findFreeTrack(project, 'audio', t, t + c.duration, { prefer: target?.id });
    c.start = t;
    t += c.duration;
  }
  return clips;
}

/** Places an overlay item (text, shape, blur...) on a free visual track above the main one. */
export function placeOverlay(project, item, { trackId = null } = {}) {
  item.trackId = findFreeTrack(project, 'video', item.start, itemEnd(item), { prefer: trackId, skipMain: true });
  project.items[item.id] = item;
  return item;
}

export function duplicateItems(project, ids) {
  const out = [];
  for (const id of ids) {
    const it = project.items[id];
    if (!it) continue;
    const c = clone(it);
    c.id = uid('c');
    c.start = itemEnd(it);
    if (isMagnetic(project, it.trackId)) {
      project.items[c.id] = c;
      insertIntoMain(project, [c], itemEnd(it) - 0.001 + c.duration / 2);
    } else {
      c.trackId = findFreeTrack(project, project.tracks.find((t) => t.id === it.trackId)?.kind || 'video', c.start, itemEnd(c), { prefer: it.trackId });
      project.items[c.id] = c;
    }
    out.push(c);
  }
  return out;
}

/** Sets a constant speed, keeping the start and adjusting the duration. */
export function setSpeed(project, it, speed) {
  const span = sourceSpan(it);
  it.speedCurve = null;
  it.speed = clamp(speed, 0.05, 20);
  const dur = span / it.speed;
  it.duration = Math.max(0.05, Math.min(dur, maxClipDuration(project, it)));
  compactMagnetic(project);
}

/** Applies a speed ramp preset. The item keeps its duration where the media allows. */
export function setSpeedCurve(project, it, curve) {
  if (!curve) {
    it.speedCurve = null;
    return;
  }
  const span = sourceSpan(it);
  it.speedCurve = clone(curve);
  it.speed = 1;
  // keep the same amount of source consumed
  const avg = curveIntegral(it.speedCurve, 1);
  it.duration = Math.max(0.1, Math.min(span / avg, maxClipDuration(project, it)));
  compactMagnetic(project);
}

/** Inserts a freeze frame of `seconds` at time t inside a clip. */
export function freezeFrame(project, it, t, seconds = 2) {
  if (it.type !== 'clip') return null;
  const src = sourceTime(it, t);
  const right = t > it.start + 0.02 && t < itemEnd(it) - 0.02 ? splitItem(project, it, t) : null;
  const at = right ? t : itemEnd(it);
  rippleShift(project, it.trackId, at, seconds);
  const fr = clone(it);
  fr.id = uid('c');
  fr.start = at;
  fr.duration = seconds;
  fr.in = src;
  fr.freeze = true;
  fr.speed = 1;
  fr.speedCurve = null;
  fr.kf = {};
  fr.transitionIn = null;
  fr.anim = { in: null, out: null, loop: null };
  fr.name = (it.name || 'Clip') + ' (freeze)';
  fr.muted = true;
  project.items[fr.id] = fr;
  compactMagnetic(project);
  return fr;
}

/** Moves a video clip's sound to its own audio clip and mutes the original. */
export function detachAudio(project, it) {
  const media = project.media[it.mediaId];
  if (!media?.hasAudio) return null;
  const a = clone(it);
  a.id = uid('c');
  a.kf = it.kf?.volume ? { volume: clone(it.kf.volume) } : {};
  a.anim = { in: null, out: null, loop: null };
  a.transitionIn = null;
  a.trackId = findFreeTrack(project, 'audio', it.start, itemEnd(it));
  a.muted = false;
  a.linkedTo = it.id;
  project.items[a.id] = a;
  it.muted = true;
  return a;
}

/**
 * Moves items by dt seconds and optionally onto another track. Items that land on
 * occupied space overwrite what was there, except on the magnetic main track,
 * where they are inserted.
 */
export function moveItems(project, ids, dt, trackDelta = 0, { dropTime = null } = {}) {
  const items = ids.map((id) => project.items[id]).filter(Boolean);
  if (!items.length) return;
  const moving = new Set(items.map((i) => i.id));
  const kindOf = (id) => project.tracks.find((t) => t.id === id)?.kind;
  for (const it of items) {
    const kind = kindOf(it.trackId);
    const sameKind = project.tracks.filter((t) => t.kind === kind);
    const idx = sameKind.findIndex((t) => t.id === it.trackId);
    const nidx = clamp(idx + trackDelta, 0, sameKind.length - 1);
    it._fromTrack = it.trackId;
    it.trackId = sameKind[nidx].id;
    it.start = Math.max(0, it.start + dt);
  }
  const main = mainTrack(project);
  const toMain = items.filter((it) => isMagnetic(project, it.trackId));
  const others = items.filter((it) => !isMagnetic(project, it.trackId));
  for (const it of others) overwrite(project, it.trackId, it.start, itemEnd(it), moving);
  if (toMain.length) {
    toMain.sort((a, b) => a.start - b.start);
    insertIntoMain(project, toMain, dropTime ?? toMain[0].start);
  }
  for (const it of items) delete it._fromTrack;
  compactMagnetic(project);
  void main;
}

export function replaceClipMedia(project, it, media) {
  it.mediaId = media.id;
  it.name = media.name;
  if (media.kind !== 'image') {
    it.in = 0;
    it.duration = Math.min(it.duration, maxClipDuration(project, it));
  }
}

export function ensureAudioTrack(project) {
  return audioTracks(project)[0] || addTrack(project, 'audio');
}

export function selectAllOnTrack(project, trackId) {
  return trackItems(project, trackId).map((i) => i.id);
}

export function closeGaps(project, trackId) {
  let t = 0;
  for (const it of trackItems(project, trackId)) {
    it.start = t;
    t += it.duration;
  }
}

/** Cuts [start,end) out of every unlocked track and closes the gap (ripple). */
export function rippleCutRange(project, start, end, trackIds = null) {
  const len = end - start;
  if (len <= 0) return;
  const tracks = project.tracks.filter((t) => !t.locked && (!trackIds || trackIds.includes(t.id)));
  for (const tr of tracks) {
    overwrite(project, tr.id, start, end);
    rippleShift(project, tr.id, end - EPS, -len);
  }
}

/**
 * Dips the volume of every other sound while `it` plays and brings it back
 * afterwards, with short ramps. Dips are kept as regions on each clip and the
 * volume points are rebuilt from the clip's own points, so pressing it twice or
 * overlapping two voiceovers never dips twice.
 */
export function duckOthers(project, it, level = 0.2, ramp = 0.3) {
  const a = it.start;
  const b = itemEnd(it);
  const changed = [];
  for (const o of Object.values(project.items)) {
    if (o.id === it.id || o.type !== 'clip' || o.muted || o.freeze) continue;
    const m = project.media[o.mediaId];
    if (!m?.hasAudio) continue;
    if (itemEnd(o) <= a || o.start >= b) continue;
    // points edited by hand since the last dip become the new base
    const rendered = JSON.stringify(o.kf?.volume || []);
    if (!o.duck2 || o.duck2.rendered !== rendered) o.duck2 = { base: JSON.parse(rendered), regions: [] };
    o.duck2.regions = o.duck2.regions.filter((r) => r.by !== it.id);
    o.duck2.regions.push({ a, b, level, by: it.id });
    renderDucks(o, ramp);
    changed.push(o.id);
  }
  return changed;
}

/** Rebuilds a clip's volume points from its base points and its dip regions (project seconds). */
export function renderDucks(o, ramp = 0.3) {
  const base = o.duck2.base;
  const baseItem = { kf: { volume: base }, props: o.props, start: o.start };
  const at = (t) => propAt(baseItem, 'volume', t);
  // merge dips that overlap or sit closer than two ramps
  const regs = o.duck2.regions.map((r) => ({ ...r })).sort((x, y) => x.a - y.a);
  const merged = [];
  for (const r of regs) {
    const last = merged[merged.length - 1];
    if (last && r.a <= last.b + ramp * 2) {
      last.b = Math.max(last.b, r.b);
      last.level = Math.min(last.level, r.level);
    } else merged.push(r);
  }
  const pts = [];
  const inside = (lt) => merged.some((r) => lt > r.a - o.start - ramp - 1e-3 && lt < r.b - o.start + ramp + 1e-3);
  for (const k of base) if (!inside(k.t)) pts.push({ ...k });
  for (const r of merged) {
    const la = r.a - o.start;
    const lb = r.b - o.start;
    if (la - ramp > 0) pts.push({ t: la - ramp, v: at(r.a - ramp), e: 'linear' });
    pts.push({ t: Math.max(0, la), v: at(Math.max(r.a, o.start)) * r.level, e: 'linear' });
    for (const k of base) if (k.t > la + 1e-3 && k.t < lb - 1e-3) pts.push({ ...k, v: k.v * r.level, e: 'linear' });
    pts.push({ t: Math.min(o.duration, lb), v: at(Math.min(r.b, itemEnd(o))) * r.level, e: 'linear' });
    if (lb + ramp < o.duration) pts.push({ t: lb + ramp, v: at(r.b + ramp), e: 'linear' });
  }
  pts.sort((x, y) => x.t - y.t);
  const out = [];
  for (const k of pts) {
    const q = { t: Math.round(k.t * 1000) / 1000, v: Math.round(k.v * 1000) / 1000, e: k.e || 'linear' };
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - q.t) < 1 / 120) prev.v = Math.min(prev.v, q.v);
    else out.push(q);
  }
  o.kf ||= {};
  if (out.length) o.kf.volume = out;
  else delete o.kf.volume;
  o.duck2.rendered = JSON.stringify(o.kf.volume || []);
}
