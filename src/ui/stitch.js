// Stitch videos: pick several clips, put them in order, and join them end to
// end on the main track with the same transition and framing for each.

import { h, iconButton, button, select, slider, toggle, clear } from './dom.js';
import { modal, toast } from './notify.js';
import { store } from '../core/store.js';
import * as E from '../core/edit.js';
import { itemEnd, trackItems, CANVAS_PRESETS, canvasForMedia } from '../core/model.js';
import { importFiles, thumbUrl, whenReady, VIDEO_EXT, IMAGE_EXT, AUDIO_EXT } from '../media/library.js';
import { openDialog, stat } from '../backend/index.js';
import { TRANSITION_TYPES } from '../render/shaders.js';
import { formatDuration } from '../core/util.js';
import { createProject } from '../project-io.js';

/** Canvas size for a new project that matches the first video. */
function canvasFor(m) {
  if (!m?.width || !m?.height) return CANVAS_PRESETS[0];
  const r = m.width / m.height;
  let best = CANVAS_PRESETS[0];
  for (const c of CANVAS_PRESETS) if (Math.abs(c.width / c.height - r) < Math.abs(best.width / best.height - r)) best = c;
  return best;
}

/** Joins media end to end at the end of the main track. Returns the new clips. */
export function stitchMedia(project, mediaList, { transition = null, duration = 0.5, framing = 'contain', at = null, soft = false } = {}) {
  if (project.settings.audioOnly) {
    // audio projects join the recordings on the first audio track, with a short fade at each join if asked
    const spine = E.spineTrack(project);
    const end = at ?? Math.max(0, ...trackItems(project, spine.id).map(itemEnd));
    const added = E.addMediaToTimeline(project, mediaList, end, { trackId: spine.id }).sort((a, b) => a.start - b.start);
    if (soft) for (const c of added) c.fadeIn = c.fadeOut = Math.min(0.15, c.duration / 4);
    return added;
  }
  const main = E.mainTrack(project);
  const end = at ?? Math.max(0, ...trackItems(project, main.id).map(itemEnd));
  const added = E.addMediaToTimeline(project, mediaList, end, { trackId: main.id }).filter((c) => c.trackId === main.id);
  added.sort((a, b) => a.start - b.start);
  added.forEach((c, i) => {
    c.fit = framing === 'cover' ? 'cover' : 'contain';
    c.effects.backdrop = framing === 'blur' ? 'blur' : null;
    const prev = i > 0 || trackItems(project, main.id).some((o) => o.id !== c.id && Math.abs(itemEnd(o) - c.start) < 0.02);
    if (transition && prev) c.transitionIn = { type: transition, duration: Math.min(duration, c.duration / 3) };
  });
  return added;
}

export async function showStitch(app, { mediaIds = null, fresh = false, audio = store.project.settings.audioOnly } = {}) {
  audio = !!audio;
  const filters = audio ? [{ name: 'Audio, or video to take the sound from', extensions: [...AUDIO_EXT, ...VIDEO_EXT] }] : [{ name: 'Videos and photos', extensions: [...VIDEO_EXT, ...IMAGE_EXT] }];
  let list = (mediaIds || []).map((id) => store.project.media[id]).filter(Boolean);
  if (!list.length) {
    const paths = await openDialog({ multiple: true, title: audio ? 'Choose the recordings to join' : 'Choose the videos to stitch', filters });
    if (!paths?.length) return;
    // keep the order the files were picked in, sorted by name as Explorer shows them
    paths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    list = await importFiles(paths);
    if (!list.length) return toast(audio ? 'None of those files can be joined.' : 'None of those files can be stitched.', { kind: 'error' });
  }
  const opts = { transition: store.settings.stitchTransition ?? 'dissolve', duration: store.settings.stitchDuration ?? 0.5, framing: store.settings.stitchFraming ?? 'blur', loudness: false, soft: true };
  const rows = h('div', { class: 'stitch-list' });
  const total = h('div', { class: 'hint' });
  const draw = () => {
    clear(rows);
    list.forEach((m, i) => {
      const th = thumbUrl(m);
      rows.append(
        h(
          'div',
          { class: 'stitch-row' },
          h('span', { class: 'stitch-n' }, String(i + 1)),
          h('div', { class: 'stitch-thumb', style: th ? { backgroundImage: `url("${th}")` } : {} }),
          h('span', { class: 'stitch-name', title: m.path }, m.name),
          h('span', { class: 'dim' }, m.duration ? formatDuration(m.duration) : m.kind === 'image' ? 'photo' : ''),
          iconButton('prev', () => move(i, -1), 'Earlier', { size: 14, disabled: i === 0 }),
          iconButton('next', () => move(i, 1), 'Later', { size: 14, disabled: i === list.length - 1 }),
          iconButton('x', () => {
            list.splice(i, 1);
            draw();
          }, 'Take out', { size: 14 }),
        ),
      );
    });
    const secs = list.reduce((a, m) => a + (m.kind === 'image' ? 3 : m.duration || 0), 0);
    total.textContent = `${list.length} ${audio ? 'files' : 'clips'}, about ${formatDuration(secs)} long.`;
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    draw();
  };
  const sortBy = async (how) => {
    if (how === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else {
      const times = new Map();
      for (const m of list) times.set(m.id, (await stat(m.path).catch(() => null))?.mtimeMs || 0);
      list.sort((a, b) => times.get(a.id) - times.get(b.id));
    }
    draw();
  };
  draw();
  const trans = select('Between clips', [['', 'Straight cut'], ...Object.entries(TRANSITION_TYPES).map(([k, t]) => [k, t.name])], opts.transition || '', (v) => (opts.transition = v || null));
  const dur = slider('Transition length', { value: opts.duration, min: 0.1, max: 2, step: 0.05, format: (v) => Number(v).toFixed(2) + 's', onInput: (v) => (opts.duration = v) });
  const framing = select('Different shapes', [['blur', 'Fit, blurred copy behind'], ['contain', 'Fit, black bars'], ['cover', 'Fill the frame, crop the edges']], opts.framing, (v) => (opts.framing = v));
  const loud = toggle('Even out the loudness of every clip', false, (v) => (opts.loudness = v), { title: 'Runs loudness levelling on each clip after stitching' });
  const soft = toggle('Soft joins (a short fade at each join)', opts.soft, (v) => (opts.soft = v));
  const body = h(
    'div',
    { class: 'stitch' },
    h('p', {}, audio ? (fresh ? 'The recordings join end to end in a new audio project.' : 'The recordings join end to end after the last clip on the first audio track.') : fresh ? 'The clips join end to end in a new project sized to the first video.' : 'The clips join end to end after the last clip on the main track.'),
    h('div', { class: 'btn-row' }, button('Sort by name', () => sortBy('name'), { kind: 'link' }), button('Sort by date', () => sortBy('date'), { kind: 'link' }), button('Add more', async () => {
      const paths = await openDialog({ multiple: true, title: audio ? 'Add recordings' : 'Add videos', filters });
      if (!paths?.length) return;
      list.push(...(await importFiles(paths)));
      draw();
    }, { kind: 'link', icon: 'plus' })),
    rows,
    total,
    ...(audio ? [soft] : [trans, dur, framing]),
    loud,
  );
  modal(audio ? 'Join audio files' : 'Stitch videos', body, {
    width: 620,
    actions: [
      { label: 'Cancel', run: (close) => close() },
      {
        label: audio ? 'Join' : 'Stitch',
        primary: true,
        run: async (close) => {
          if (!list.length) return;
          close();
          app.saveSetting('stitchTransition', opts.transition);
          app.saveSetting('stitchDuration', opts.duration);
          app.saveSetting('stitchFraming', opts.framing);
          if (fresh && audio) {
            createProject({ name: 'Joined ' + new Date().toLocaleDateString(), audioOnly: true });
            for (const m of list) if (!store.project.media[m.id]) store.project.media[m.id] = m;
            store.emit('media');
          } else if (fresh) {
            const first = list.find((m) => m.kind === 'video') || list[0];
            await whenReady(first).catch(() => {});
            const c = first.kind === 'video' && first.width ? canvasForMedia(first) : canvasFor(first);
            createProject({ name: 'Stitched ' + new Date().toLocaleDateString(), width: c.width, height: c.height, fps: c.fps || (Math.round(first.fps) === 60 ? 60 : 30) });
            for (const m of list) if (!store.project.media[m.id]) store.project.media[m.id] = m;
            store.emit('media');
          }
          // clips need their real length before they are joined
          await Promise.all(list.map((m) => whenReady(m).catch(() => null)));
          const ok = list.filter((m) => m.status === 'ready');
          let added = [];
          store.commit(audio ? 'Join audio' : 'Stitch videos', (p) => (added = stitchMedia(p, ok, opts)));
          store.select(added.map((c) => c.id));
          app.timeline?.zoomToFit();
          if (opts.loudness) for (const c of added) if (store.project.media[c.mediaId]?.hasAudio) await app.cmd('normalizeClip', store.project.items[c.id]);
          toast(audio ? `Joined ${added.length} files.` : `Stitched ${added.length} clips.`);
        },
      },
    ],
  });
}
