// What Claude can do in the editor. Each tool takes the arguments Claude sent
// (described in mcp/tools.mjs) and returns plain data, or { content } with
// an image. Every change goes through store.commit, so Ctrl+Z undoes it.

import { store } from '../core/store.js';
import * as E from '../core/edit.js';
import { newText, newTrack, itemEnd, isVisualItem, projectDuration, CANVAS_PRESETS, frameShape, defaultTextStyle, ANIMATIONS_IN, ANIMATIONS_OUT, ANIMATIONS_LOOP } from '../core/model.js';
import { multicamOf, addSwitch, setSoundAngle, SWITCH_TYPES } from '../core/multicam.js';
import { clone } from '../core/util.js';
import { importFiles, whenReady } from '../media/library.js';
import { join, paths, basename, mkdir } from '../backend/index.js';
import { TRANSITION_TYPES } from '../render/shaders.js';
import { FILTERS } from '../render/luts.js';
import { applyFilter } from '../ui/inspector.js';

const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

class ToolError extends Error {}
const fail = (msg) => {
  throw new ToolError(msg);
};

// ---------------------------------------------------------------------------
// Reading the project
// ---------------------------------------------------------------------------

function trackLabel(p, id) {
  const tr = p.tracks.find((t) => t.id === id);
  return tr ? tr.name : '?';
}

function itemSummary(p, it) {
  const m = it.mediaId ? p.media[it.mediaId] : null;
  const out = { id: it.id, type: it.type, name: it.name || m?.name || it.type, track: trackLabel(p, it.trackId), track_id: it.trackId, start: r3(it.start), end: r3(itemEnd(it)), duration: r3(it.duration) };
  if (it.type === 'clip') {
    Object.assign(out, { media_id: it.mediaId, media: m?.name, in: r3(it.in), speed: it.speedCurve ? 'ramp' : it.speed || 1 });
    if (it.muted) out.muted = true;
    if (m?.hasAudio) out.volume = r3(it.props.volume ?? 1);
    if (it.derivations?.length) out.processed = it.derivations;
  }
  if (it.type === 'text') out.text = it.text;
  if (isVisualItem(p, it)) {
    const pr = it.props;
    const t = {};
    for (const k of ['x', 'y', 'scale', 'rotation', 'opacity']) if (pr[k] != null && pr[k] !== (k === 'scale' || k === 'opacity' ? 1 : 0)) t[k] = r3(pr[k]);
    if (Object.keys(t).length) out.transform = t;
    const kf = Object.keys(it.kf || {}).filter((k) => it.kf[k]?.length);
    if (kf.length) out.keyframed = kf;
    if (it.fit && it.fit !== 'contain') out.fit = it.fit;
    if (it.blend && it.blend !== 'normal') out.blend = it.blend;
    if (it.matte) out.shape_from_below = it.matte;
    if (it.color?.filter) out.look = it.color.filter;
    const fx = it.effects || {};
    const on = [];
    if (fx.chroma?.enabled) on.push('green screen');
    if (fx.silhouette?.on) on.push(`silhouette ${fx.silhouette.style} ${fx.silhouette.color}`);
    if (fx.backdrop) on.push('blurred background');
    if (fx.depth3d) on.push('moving photo');
    for (const k of ['glow', 'chromatic', 'pixelate', 'letterbox']) if (fx[k]) on.push(`${k} ${r3(fx[k])}`);
    if (fx.mirror) on.push('mirror');
    if (on.length) out.effects = on;
    if (it.anim?.in || it.anim?.out || it.anim?.loop) out.animation = { in: it.anim.in?.type || null, out: it.anim.out?.type || null, loop: it.anim.loop?.type || null };
    if (it.transitionIn?.type) out.transition_in = { type: it.transitionIn.type, duration: it.transitionIn.duration };
  }
  if (it.fadeIn || it.fadeOut) out.audio_fade = { in: it.fadeIn || 0, out: it.fadeOut || 0 };
  return out;
}

function anglesSummary(p) {
  const mc = multicamOf(p);
  if (!mc) return null;
  return {
    angles: mc.angles.map((id, i) => ({ angle: i + 1, item_id: id, name: p.items[id].name || p.media[p.items[id].mediaId]?.name })),
    sound_from_angle: Math.max(0, mc.angles.indexOf(mc.sound)) + 1,
    switches: mc.switches.map((s) => ({ at: r3(s.t), angle: s.a + 1, transition: s.type, duration: s.type === 'cut' ? 0 : s.d })),
    new_switches_use: { transition: mc.defType || 'dissolve', duration: mc.defDur ?? 0.6 },
  };
}

function projectSummary() {
  const p = store.project;
  const st = p.settings;
  const order = [...p.tracks.filter((t) => t.kind === 'video'), ...p.tracks.filter((t) => t.kind === 'audio')];
  const main = E.spineTrack(p);
  return {
    name: p.name,
    file: store.projectPath || null,
    unsaved_changes: !!store.dirty,
    type: st.audioOnly ? 'audio' : 'video',
    frame: st.audioOnly ? null : { width: st.width, height: st.height, shape: frameShape(st.width, st.height), fps: st.fps, background: st.background, waiting_for_first_video: !!st.matchFirst },
    duration: r3(projectDuration(p)),
    playhead: r3(store.playhead),
    selected: [...store.selection],
    tracks: order.map((t) => ({ id: t.id, name: t.name, kind: t.kind, main: t === main || undefined, hidden: t.hidden || undefined, muted: t.muted || undefined, locked: t.locked || undefined, items: Object.values(p.items).filter((i) => i.trackId === t.id).sort((a, b) => a.start - b.start).map((i) => itemSummary(p, i)) })),
    media: Object.values(p.media)
      .filter((m) => !m.hidden)
      .map((m) => ({ id: m.id, name: m.name, kind: m.kind, path: m.path, duration: r3(m.duration), size: m.width ? `${m.width}x${m.height}` : undefined, fps: m.fps ? r3(m.fps) : undefined, has_audio: m.hasAudio || undefined, status: m.status, error: m.error || undefined, on_timeline: Object.values(p.items).some((i) => i.mediaId === m.id) })),
    markers: (p.markers || []).map((m) => ({ id: m.id, at: r3(m.t), label: m.label || '' })),
    angles: anglesSummary(p),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function item(id) {
  const it = store.project.items[id];
  if (!it) fail(`There is no item with id ${id}. Call get_project for the current ids.`);
  return it;
}

function items(ids) {
  if (!Array.isArray(ids) || !ids.length) fail('Give item_ids, a list of item ids from get_project.');
  return ids.map(item);
}

function resolveTrack(p, track, kind = 'video') {
  if (!track || track === 'main') return E.mainTrack(p)?.id || null;
  if (track === 'new') {
    const tr = newTrack(kind, `${kind === 'video' ? 'Video' : 'Audio'} ${p.tracks.filter((t) => t.kind === kind).length + 1}`);
    if (kind === 'video') p.tracks.unshift(tr);
    else p.tracks.push(tr);
    return tr.id;
  }
  const tr = p.tracks.find((t) => t.id === track || t.name === track);
  if (!tr) fail(`There is no track "${track}". Use "main", "new" or a track id from get_project.`);
  return tr.id;
}

function at(v, fallback = store.playhead) {
  if (v == null || v === 'playhead') return fallback;
  if (v === 'end') return projectDuration(store.project);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`"${v}" is not a time. Give seconds from the start of the timeline.`);
  return n;
}

const FRAME_IDS = Object.fromEntries(CANVAS_PRESETS.map((c) => [c.id, c]));

/** Applies one set of changes to one item. Returns notes about anything skipped. */
function applyChanges(p, it, ch, notes) {
  const visual = isVisualItem(p, it);
  if (ch.track != null) {
    it.trackId = resolveTrack(p, ch.track, visual ? 'video' : 'audio');
  }
  if (ch.start != null) it.start = Math.max(0, Number(ch.start));
  if (ch.speed != null) {
    if (it.type !== 'clip') notes.push(`${it.id}: speed only applies to clips`);
    else E.setSpeed(p, it, Math.max(0.1, Math.min(10, Number(ch.speed))));
  }
  if (ch.in != null && it.type === 'clip') {
    const m = p.media[it.mediaId];
    const max = m?.kind === 'image' ? 0 : Math.max(0, (m?.duration || 0) - it.duration * (it.speed || 1));
    it.in = Math.max(0, Math.min(max, Number(ch.in)));
  }
  if (ch.duration != null) {
    const d = Math.max(0.05, Number(ch.duration));
    if (it.type === 'clip') {
      const m = p.media[it.mediaId];
      const max = m?.kind === 'image' ? Infinity : ((m?.duration || d) - it.in) / (it.speed || 1);
      if (d > max + 0.01) notes.push(`${it.id}: only ${r3(max)} s of the source is left after its in point`);
      it.duration = Math.min(d, max);
    } else it.duration = d;
  }
  const props = { volume: 'volume', opacity: 'opacity', scale: 'scale', scale_x: 'scaleX', scale_y: 'scaleY', x: 'x', y: 'y', rotation: 'rotation', blur: 'blur', crop_left: 'cropL', crop_right: 'cropR', crop_top: 'cropT', crop_bottom: 'cropB' };
  for (const [k, prop] of Object.entries(props)) {
    if (ch[k] == null) continue;
    if (it.kf?.[prop]?.length) {
      delete it.kf[prop];
      notes.push(`${it.id}: removed the ${k} keyframes to set one value`);
    }
    it.props[prop] = Number(ch[k]);
  }
  if (ch.muted != null) it.muted = !!ch.muted;
  if (ch.pan != null) it.pan = Math.max(-1, Math.min(1, Number(ch.pan)));
  if (ch.fade_in != null) it.fadeIn = Math.max(0, Number(ch.fade_in));
  if (ch.fade_out != null) it.fadeOut = Math.max(0, Number(ch.fade_out));
  if (ch.lower_under_voice != null) it.duck = !!ch.lower_under_voice;
  if (ch.name != null) it.name = String(ch.name);
  if (ch.fit != null) it.fit = ch.fit;
  if (ch.blend != null) it.blend = ch.blend;
  if (ch.flip_x != null) it.flipX = !!ch.flip_x;
  if (ch.flip_y != null) it.flipY = !!ch.flip_y;
  if (ch.shape_from_below !== undefined) {
    if (ch.shape_from_below) it.matte = ch.shape_from_below;
    else delete it.matte;
  }
  if (ch.text != null) {
    if (it.type !== 'text') notes.push(`${it.id}: text only applies to text items`);
    else it.text = String(ch.text);
  }
  if (ch.style && it.type === 'text') Object.assign(it.style, ch.style);
  if (ch.look != null) {
    if (!FILTERS[ch.look]) notes.push(`look "${ch.look}" does not exist. Looks: ${Object.keys(FILTERS).join(', ')}`);
    else applyFilter(it, ch.look);
  }
  if (ch.color) it.color = { ...(it.color || {}), ...ch.color };
  if (ch.effects) {
    const fx = (it.effects ||= {});
    for (const [k, v] of Object.entries(ch.effects)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) fx[k] = { ...(fx[k] || {}), ...v };
      else fx[k] = v;
    }
  }
  for (const [k, list] of [['anim_in', ANIMATIONS_IN], ['anim_out', ANIMATIONS_OUT], ['anim_loop', ANIMATIONS_LOOP]]) {
    if (ch[k] === undefined) continue;
    const slot = k.slice(5);
    it.anim ||= { in: null, out: null, loop: null };
    if (!ch[k]) it.anim[slot] = null;
    else {
      const type = typeof ch[k] === 'string' ? ch[k] : ch[k].type;
      if (!list[type]) notes.push(`${k} "${type}" does not exist. Options: ${Object.keys(list).join(', ')}`);
      else it.anim[slot] = { type, duration: Number(ch[k].duration ?? 0.5), ...(slot === 'loop' ? { speed: ch[k].speed ?? 1 } : {}) };
    }
  }
  if (ch.transition_in !== undefined) {
    if (!ch.transition_in || ch.transition_in.type === 'none') it.transitionIn = null;
    else if (!TRANSITION_TYPES[ch.transition_in.type]) notes.push(`transition "${ch.transition_in.type}" does not exist. Options: ${Object.keys(TRANSITION_TYPES).join(', ')}`);
    else it.transitionIn = { type: ch.transition_in.type, duration: Number(ch.transition_in.duration ?? 0.5) };
  }
  if (ch.keyframes) {
    for (const [k, keys] of Object.entries(ch.keyframes)) {
      const prop = props[k] || k;
      if (!Array.isArray(keys) || !keys.length) {
        delete it.kf[prop];
        continue;
      }
      it.kf[prop] = keys.map((kk) => ({ t: Math.max(0, Math.min(it.duration, Number(kk.at) - it.start)), v: Number(kk.value), e: kk.ease || 'easeInOut' })).sort((a, b) => a.t - b.t);
    }
  }
}

// ---------------------------------------------------------------------------
// Smart tools: name -> how to run it
// ---------------------------------------------------------------------------

const RUN = {
  captions: { cmd: 'captions', item: 'optional' },
  remove_background: { cmd: 'removeBackground', item: 'visual', model: true, guard: (it) => it.derivations?.includes('bg') && 'This clip is already cut out. Use run_tool revert to put the background back.' },
  make_silhouette: { cmd: 'silhouette', item: 'visual', model: true },
  silhouette_shadow: { cmd: 'silhouetteShadow', item: 'visual', model: true },
  fill_silhouette: { cmd: 'fillSilhouette', item: 'visual', model: true },
  fill_subject_below: { cmd: 'fillSubjectBelow', item: 'visual', model: true },
  blur_faces: { cmd: 'faceBlur', item: 'visual' },
  auto_reframe: { cmd: 'autoReframe', item: 'visual' },
  stabilize: { cmd: 'stabilize', item: 'visual' },
  reverse: { cmd: 'reverse', item: 'clip' },
  smooth_slowmo: { cmd: 'smoothSlowmo', item: 'visual' },
  upscale: { cmd: 'upscale', item: 'visual' },
  revert: { cmd: 'revertMedia', item: 'clip' },
  clear_voice: { cmd: 'clearVoice', item: 'sound' },
  remove_noise: { cmd: 'denoise', item: 'sound' },
  level_voice: { cmd: 'compressClip', item: 'sound' },
  even_loudness: { cmd: 'normalizeClip', item: 'sound' },
  voice_effect: { cmd: 'voiceEffect', item: 'sound', extra: (o) => [o.kind || 'deeper'] },
  cut_silences: { cmd: 'silenceCut', item: 'sound', answer: (o) => ({ 'Cut out silences': { minSilence: o.min_pause ?? 0.5, pad: o.keep_around_speech ?? 0.12, sens: o.sensitivity ?? 0.28 } }) },
  remove_fillers: { cmd: 'fillerCut', item: 'sound' },
  mark_beats: { cmd: 'beats', item: 'sound' },
  sync_to_beat: { cmd: 'beatSync', item: 'select' },
  separate_audio: { cmd: 'detachAudio', item: 'select' },
  lower_others: { cmd: 'duckOthers', item: 'sound' },
  freeze_frame: { cmd: 'freeze', item: 'select', playhead: true },
  picture_in_picture: { cmd: 'pip', item: 'select', extra: (o) => [o.corner || 'tr'] },
  split_screen: { cmd: 'splitScreen', item: 'select' },
  blurred_background: { cmd: 'blurBackdrop', item: 'select' },
  line_up_faces: { cmd: 'alignFaces', item: 'select' },
  match_frame: { cmd: 'matchCanvas', item: 'none' },
  moving_photo: { item: 'visual', run: async (it, o) => (await import('./depth.js')).makeDepthShot(it, { motion: o.motion || 'push', amount: o.amount ?? 1, focus: o.focus || 'middle' }) },
};

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const TOOLS = {
  async get_project() {
    return projectSummary();
  },

  async get_frame(a) {
    const t = at(a.time);
    const w = Math.max(160, Math.min(1280, Number(a.width) || 640));
    if (store.project.settings.audioOnly) fail('This is an audio project, so it has no picture.');
    const { renderFrameCanvas } = await import('../export/export.js');
    const c = await renderFrameCanvas(store.project, t, w);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { content: [{ type: 'text', text: `Frame at ${r3(t)} s, ${c.width} x ${c.height}.` }, { type: 'image', data: btoa(bin), mimeType: 'image/jpeg' }] };
  },

  async list_options() {
    const { EXPORT_PRESETS } = await import('../export/export.js');
    const { TEXT_PRESETS, CAPTION_PRESETS } = await import('../ui/presets.js');
    const { VOICE_EFFECTS } = await import('./processing.js');
    return {
      frames: CANVAS_PRESETS.map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height })),
      export_presets: EXPORT_PRESETS.map((x) => ({ id: x.id, name: x.name, width: x.w, height: x.h, fps: x.fps, mbps: x.bitrate })),
      text_presets: TEXT_PRESETS.map((x) => x.name),
      caption_styles: CAPTION_PRESETS.map((x) => x.id),
      transitions: Object.keys(TRANSITION_TYPES),
      angle_transitions: SWITCH_TYPES.map(([k]) => k),
      looks: Object.keys(FILTERS),
      animations: { in: Object.keys(ANIMATIONS_IN), out: Object.keys(ANIMATIONS_OUT), loop: Object.keys(ANIMATIONS_LOOP) },
      blend_modes: ['normal', 'multiply', 'screen', 'overlay', 'softlight', 'add', 'darken', 'lighten'],
      fits: ['contain', 'cover', 'stretch'],
      run_tools: Object.keys(RUN),
      voice_effects: Object.keys(VOICE_EFFECTS),
      background_models: ['person', 'object', 'fast'],
      text_style_keys: Object.keys(defaultTextStyle()),
    };
  },

  async new_project(a, ctx) {
    if (store.dirty && Object.keys(store.project.items).length && !a.discard_unsaved) fail(`${store.project.name} has unsaved changes. Save it with save_project first, or pass discard_unsaved: true.`);
    const { createProject } = await import('../project-io.js');
    const audio = a.type === 'audio';
    const fr = a.frame && a.frame !== 'match' ? FRAME_IDS[a.frame] : null;
    if (a.frame && a.frame !== 'match' && !fr) fail(`Frame "${a.frame}" does not exist. Frames: match, ${Object.keys(FRAME_IDS).join(', ')}`);
    createProject({ name: a.name || 'Untitled project', audioOnly: audio, ...(fr ? { width: fr.width, height: fr.height } : {}), fps: a.fps || 30 });
    ctx.app.applyMode?.();
    return projectSummary();
  },

  async open_project(a) {
    if (!a.path) fail('Give the path of a .vproj file.');
    if (store.dirty && Object.keys(store.project.items).length && !a.discard_unsaved) fail(`${store.project.name} has unsaved changes. Save it with save_project first, or pass discard_unsaved: true.`);
    const { openProjectPath } = await import('../project-io.js');
    if (!(await openProjectPath(a.path))) fail(`Could not open ${a.path}.`);
    return projectSummary();
  },

  async save_project(a) {
    const { saveProject } = await import('../project-io.js');
    if (a.path) {
      let path = a.path;
      if (!/\.vproj$/i.test(path)) path += '.vproj';
      store.projectPath = path;
      store.project.name = basename(path).replace(/\.vproj$/i, '');
    }
    if (!store.projectPath) {
      const dir = join(paths.documents, 'Video Editor Projects');
      await mkdir(dir).catch(() => {});
      store.projectPath = join(dir, (store.project.name || 'Untitled project') + '.vproj');
    }
    if (!(await saveProject())) fail('Saving failed.');
    return { saved: store.projectPath };
  },

  async set_frame(a, ctx) {
    const p = store.project;
    if (p.settings.audioOnly) fail('This is an audio project, so it has no frame.');
    if (a.frame === 'match') {
      const vid = a.media_id ? p.media[a.media_id] : null;
      await ctx.app.cmd('matchCanvas', vid);
    } else {
      const fr = a.frame ? FRAME_IDS[a.frame] : null;
      if (a.frame && !fr) fail(`Frame "${a.frame}" does not exist. Frames: match, ${Object.keys(FRAME_IDS).join(', ')}`);
      store.commit('Frame', (pp) => {
        if (fr) Object.assign(pp.settings, { width: fr.width, height: fr.height });
        if (a.width && a.height) Object.assign(pp.settings, { width: Math.round(a.width / 2) * 2, height: Math.round(a.height / 2) * 2 });
        if (a.fps) pp.settings.fps = Number(a.fps);
        if (a.background) pp.settings.background = a.background;
        if (fr || (a.width && a.height)) delete pp.settings.matchFirst;
      });
    }
    return projectSummary().frame;
  },

  async import_media(a, ctx) {
    if (!Array.isArray(a.paths) || !a.paths.length) fail('Give paths, a list of full file paths on this computer.');
    const list = await importFiles(a.paths);
    if (!list.length) fail('None of those files is a video, audio, photo or PDF the editor opens, or the paths are wrong.');
    ctx.app.openPanel?.('media');
    await Promise.all(list.map((m) => whenReady(m).catch(() => null)));
    return list.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: r3(m.duration), size: m.width ? `${m.width}x${m.height}` : undefined, has_audio: m.hasAudio, status: m.status, error: m.error || undefined }));
  },

  async add_clips(a, ctx) {
    const p = store.project;
    const media = (a.media_ids || []).map((id) => p.media[id] || fail(`There is no media with id ${id}. Import it first with import_media.`));
    if (!media.length) fail('Give media_ids from import_media or get_project.');
    const t = at(a.at, a.at == null ? projectDuration(p) : store.playhead);
    const before = new Set(Object.keys(p.items));
    if (a.track && a.track !== 'main') {
      let trackId = null;
      store.commit('Add to timeline', (pp) => {
        trackId = resolveTrack(pp, a.track, media[0].kind === 'audio' ? 'audio' : 'video');
      });
      ctx.app.addMedia(media, t, trackId);
    } else ctx.app.addMedia(media, t);
    await new Promise((r) => setTimeout(r, 30));
    return Object.values(store.project.items)
      .filter((i) => !before.has(i.id))
      .map((i) => itemSummary(store.project, i));
  },

  async edit_items(a) {
    const its = items(a.item_ids);
    if (!a.changes || typeof a.changes !== 'object') fail('Give changes, for example { "volume": 0.5 }.');
    const notes = [];
    store.commit(a.label || 'Claude edit', (p) => {
      for (const it of its) applyChanges(p, p.items[it.id], a.changes, notes);
      E.compactMagnetic(p);
    });
    await new Promise((r) => setTimeout(r, 20));
    return { items: its.map((i) => store.project.items[i.id] && itemSummary(store.project, store.project.items[i.id])).filter(Boolean), notes };
  },

  async split_at(a) {
    const t = at(a.time);
    const p = store.project;
    const targets = (a.item_ids?.length ? items(a.item_ids) : Object.values(p.items)).filter((it) => it.start < t - 0.02 && itemEnd(it) > t + 0.02);
    if (!targets.length) fail(`Nothing ${a.item_ids?.length ? 'of those items ' : ''}spans ${t} s.`);
    let created = [];
    store.commit('Split', (pp) => (created = E.splitAt(pp, targets.map((x) => pp.items[x.id]), t)));
    return { split: targets.map((x) => x.id), new_items: created.map((c) => itemSummary(store.project, c)) };
  },

  async delete_items(a) {
    const its = items(a.item_ids);
    store.commit(a.ripple ? 'Delete and close gap' : 'Delete', (p) => {
      for (const it of its) for (const o of Object.values(p.items)) if (o.linkedTo === it.id) o.linkedTo = null;
      E.deleteItems(
        p,
        its.map((i) => i.id),
        { ripple: !!a.ripple },
      );
      if (!a.ripple) E.pruneEmptyTracks(p);
    });
    store.clearSelection();
    return { deleted: its.map((i) => i.id) };
  },

  async duplicate_items(a) {
    const its = items(a.item_ids);
    let out = [];
    store.commit('Duplicate', (p) => (out = E.duplicateItems(p, its.map((i) => i.id))));
    return out.map((i) => itemSummary(store.project, i));
  },

  async add_text(a) {
    if (store.project.settings.audioOnly) fail('This is an audio project, so it has no picture for text.');
    const t = at(a.at);
    const { TEXT_PRESETS } = await import('../ui/presets.js');
    const pr = a.preset ? TEXT_PRESETS.find((x) => x.name.toLowerCase() === String(a.preset).toLowerCase()) : null;
    if (a.preset && !pr) fail(`Text preset "${a.preset}" does not exist. Presets: ${TEXT_PRESETS.map((x) => x.name).join(', ')}`);
    const made = [];
    store.commit('Add text', (p) => {
      const parts = pr?.parts || [pr || {}];
      const lines = Array.isArray(a.text) ? a.text : [a.text];
      parts.forEach((part, i) => {
        const it = newText(null, t, lines[i] ?? part.text ?? pr?.text ?? 'Your text', { ...defaultTextStyle(), ...(part.style || pr?.style || {}), ...(a.style || {}) });
        it.duration = Number(a.duration) || pr?.duration || 4;
        const pp = part.props || pr?.props || {};
        if (pp.yFrac != null) it.props.y = pp.yFrac * p.settings.height;
        if (pp.xFrac != null) it.props.x = pp.xFrac * p.settings.width;
        it.anim = clone(part.anim || pr?.anim) || { in: null, out: null, loop: null };
        it.reveal = a.reveal || part.reveal || pr?.reveal || 'none';
        it.name = part.name || pr?.name || 'Text';
        if (a.x != null) it.props.x = Number(a.x);
        if (a.y != null) it.props.y = Number(a.y) + (i ? i * (it.style.size * 1.4) : 0);
        E.placeOverlay(p, it);
        made.push(it);
      });
      const notes = [];
      for (const it of made) if (a.anim_in !== undefined || a.anim_out !== undefined) applyChanges(p, it, { anim_in: a.anim_in, anim_out: a.anim_out }, notes);
    });
    store.select(made.map((i) => i.id));
    return made.map((i) => itemSummary(store.project, i));
  },

  async run_tool(a, ctx) {
    const spec = RUN[a.tool];
    if (!spec) fail(`There is no tool "${a.tool}". Tools: ${Object.keys(RUN).join(', ')}`);
    const o = a.options || {};
    const p = store.project;
    const its = a.item_ids?.length ? items(a.item_ids) : a.item_id ? [item(a.item_id)] : [];
    const it = its[0] || null;
    if (spec.item === 'visual' && (!it || !isVisualItem(p, it))) fail(`${a.tool} needs item_id of a video or photo clip.`);
    if (spec.item === 'clip' && it?.type !== 'clip') fail(`${a.tool} needs item_id of a clip.`);
    if (spec.item === 'sound' && (!it || it.type !== 'clip' || !p.media[it.mediaId]?.hasAudio)) fail(`${a.tool} needs item_id of a clip with sound.`);
    const why = spec.guard?.(it);
    if (why) fail(why);
    if (its.length) store.select(its.map((i) => i.id));
    if (o.at != null || spec.playhead) ctx.app.seek(at(o.at));
    ctx.answers = { ...(spec.model ? { 'Remove background': o.model || 'person' } : {}), ...(spec.answer?.(o) || {}) };
    if (spec.run) await spec.run(it, o);
    else await ctx.app.cmd(spec.cmd, ...(spec.item === 'select' || spec.item === 'none' ? [] : [it]), ...(spec.extra?.(o) || []));
    if (a.tool === 'make_silhouette' && (o.color || o.style)) {
      store.commit('Silhouette look', (pp) => {
        const s = pp.items[it.id]?.effects?.silhouette;
        if (s) Object.assign(s, o.color ? { color: o.color } : {}, o.style ? { style: o.style } : {}, o.width ? { width: o.width } : {});
      });
    }
    return { done: a.tool, project: { duration: r3(projectDuration(store.project)), selected: [...store.selection] }, items: its.map((x) => store.project.items[x.id] && itemSummary(store.project, store.project.items[x.id])).filter(Boolean) };
  },

  async angles(a, ctx) {
    const p = store.project;
    const act = a.action;
    if (act === 'sync') {
      if (a.item_ids?.length) store.select(items(a.item_ids).map((i) => i.id));
      else store.clearSelection();
      await ctx.app.cmd('syncAngles');
      if (!multicamOf(store.project)) fail('The angles were not synced. They need two or more videos with sound.');
      return anglesSummary(store.project);
    }
    const mc = multicamOf(p);
    if (!mc) fail('Sync the angles first with angles action "sync".');
    const n = (v) => {
      const k = Number(v) - 1;
      if (!(k >= 0 && k < mc.angles.length)) fail(`Angle ${v} does not exist. There are ${mc.angles.length} angles, numbered from 1.`);
      return k;
    };
    const typeOk = (t) => {
      if (t && !SWITCH_TYPES.some(([k]) => k === t)) fail(`Transition "${t}" does not exist. Options: ${SWITCH_TYPES.map(([k]) => k).join(', ')}`);
      return t;
    };
    if (act === 'switch') {
      const t = at(a.at);
      const k = n(a.angle);
      typeOk(a.transition);
      store.commit(`Switch to angle ${k + 1}`, (pp) => {
        const s = addSwitch(pp, t, k);
        if (a.transition) s.type = a.transition;
        if (a.duration != null) s.d = Number(a.duration);
      });
    } else if (act === 'set_switches') {
      if (!Array.isArray(a.switches)) fail('Give switches, a list of { at, angle, transition, duration }.');
      const list = a.switches.map((s) => ({ t: at(s.at), a: n(s.angle), type: typeOk(s.transition) || mc.defType || 'dissolve', d: Number(s.duration ?? mc.defDur ?? 0.6) }));
      store.commit('Angle switches', (pp) => {
        pp.multicam.switches = list.sort((x, y) => x.t - y.t).map((s, i) => ({ id: 'sw' + Date.now().toString(36) + i, ...s }));
      });
    } else if (act === 'remove_switch') {
      const t = at(a.at);
      const s = mc.switches.reduce((best, x) => (Math.abs(x.t - t) < Math.abs((best?.t ?? Infinity) - t) ? x : best), null);
      if (!s || Math.abs(s.t - t) > 0.3) fail(`There is no switch near ${t} s.`);
      store.commit('Remove angle switch', (pp) => (pp.multicam.switches = pp.multicam.switches.filter((x) => x.id !== s.id)));
    } else if (act === 'sound') {
      const k = n(a.angle);
      store.commit(`Sound from angle ${k + 1}`, (pp) => setSoundAngle(pp, mc.angles[k]));
    } else if (act === 'defaults') {
      typeOk(a.transition);
      store.commit('Default angle transition', (pp) => {
        if (a.transition) pp.multicam.defType = a.transition;
        if (a.duration != null) pp.multicam.defDur = Number(a.duration);
      });
    } else if (act === 'stop') {
      await ctx.app.cmd('stopAngles');
      return { stopped: true };
    } else fail('action must be sync, switch, set_switches, remove_switch, sound, defaults or stop.');
    return anglesSummary(store.project);
  },

  async add_marker(a) {
    const t = at(a.time);
    let mk = null;
    store.commit('Add marker', (p) => {
      mk = { id: 'mk' + Date.now().toString(36), t, label: a.label || '', color: a.color || '#e0b84a' };
      (p.markers ||= []).push(mk);
      p.markers.sort((x, y) => x.t - y.t);
    });
    return { id: mk.id, at: r3(t), label: mk.label };
  },

  async playback(a, ctx) {
    if (a.action === 'play') {
      if (a.time != null) ctx.app.seek(at(a.time));
      ctx.app.preview.play();
    } else if (a.action === 'pause') ctx.app.preview.pause();
    else if (a.action === 'seek') ctx.app.seek(at(a.time));
    else fail('action must be play, pause or seek.');
    return { playhead: r3(store.playhead) };
  },

  async select_items(a) {
    if (!a.item_ids?.length) store.clearSelection();
    else store.select(items(a.item_ids).map((i) => i.id));
    return { selected: [...store.selection] };
  },

  async history(a, ctx) {
    const n = Math.max(1, Math.min(50, Number(a.steps) || 1));
    for (let i = 0; i < n; i++) await ctx.app.cmd(a.action === 'redo' ? 'redo' : 'undo');
    return { last_steps: store.undoStack.slice(-5).map((e) => e.label) };
  },

  async export(a, ctx) {
    const p = store.project;
    const X = await import('../export/export.js');
    const kind = a.kind || (p.settings.audioOnly ? 'audio' : 'video');
    const ext = { video: 'mp4', audio: a.format || 'mp3', frame: a.format || 'png', gif: 'gif', captions: a.format || 'srt' }[kind];
    if (!ext) fail('kind must be video, audio, frame, gif or captions.');
    let out = a.path;
    if (!out) {
      const dir = join(paths.documents, 'Video Editor Exports');
      await mkdir(dir).catch(() => {});
      out = join(dir, X.defaultExportName(p, ext).split(/[\\/]/).pop());
    }
    const t0 = a.start != null ? Number(a.start) : 0;
    const t1 = a.end != null ? Number(a.end) : projectDuration(p);
    if (!(t1 > t0)) fail('There is nothing on the timeline to export.');
    const job = (ctx.job = { title: 'Export', fraction: 0, label: 'Starting' });
    const onProgress = (pr) => {
      job.fraction = pr.fraction;
      job.label = pr.stage;
    };
    if (kind === 'video') {
      let w = a.width;
      let h = a.height;
      let fps = a.fps || p.settings.fps;
      let mbps = a.quality_mbps || 12;
      let proj = p;
      if (a.preset) {
        const pr = X.EXPORT_PRESETS.find((x) => x.id === a.preset) || fail(`Export preset "${a.preset}" does not exist. Presets: ${X.EXPORT_PRESETS.map((x) => x.id).join(', ')}`);
        w = pr.w;
        h = pr.h;
        fps = a.fps || pr.fps;
        mbps = a.quality_mbps || pr.bitrate;
      }
      if (!w || !h) {
        const short = Math.min(p.settings.width, p.settings.height);
        const k = Math.min(1080, short) / short;
        w = Math.round((p.settings.width * k) / 2) * 2;
        h = Math.round((p.settings.height * k) / 2) * 2;
      }
      // a different shape refits the clips the same way the export dialog's extra shapes do
      if (Math.abs(w / h - p.settings.width / p.settings.height) > 0.02) {
        const { adaptProject } = await import('../export/resize.js');
        proj = adaptProject(p, w, h, a.framing || 'blur');
      }
      await X.exportVideo(proj, { out, width: w, height: h, fps, bitrateMbps: mbps, t0, t1, loudnorm: !!a.social_loudness, onProgress });
    } else if (kind === 'audio') await X.exportAudio(p, { out, t0, t1, format: ext, loudnorm: !!a.podcast_loudness, onProgress });
    else if (kind === 'frame') await X.exportFrame(p, at(a.time), out, { width: a.width });
    else if (kind === 'gif') await X.exportGif(p, { out, width: a.width || 540, fps: a.fps || 15, t0, t1, onProgress });
    else await X.exportCaptions(p, out);
    return { saved: out, kind };
  },
};

export { ToolError, projectSummary };
