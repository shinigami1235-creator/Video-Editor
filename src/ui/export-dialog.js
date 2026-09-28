// Export dialog: video, GIF, audio, a still frame or captions.

import { h, button, select, toggle, slider, clear, icon } from './dom.js';
import { modal, toast, errorToast } from './notify.js';
import { store } from '../core/store.js';
import { projectDuration, itemEnd } from '../core/model.js';
import { EXPORT_PRESETS, sizeOptions, exportVideo, exportGif, exportAudio, exportFrame, exportCaptions, defaultExportName } from '../export/export.js';
import { saveDialog, join, paths, invoke, dirname } from '../backend/index.js';
import { saveSettings } from '../core/settings.js';
import { SHAPES, shapeOf, adaptProject } from '../export/resize.js';
import { formatTime, formatDuration } from '../core/util.js';

export function showExport(app) {
  const p = store.project;
  const dur = projectDuration(p);
  if (dur <= 0) return toast('Add something to the timeline first.', { kind: 'warn' });
  if (Object.values(p.media).some((m) => m.status === 'processing')) toast('Some clips are still being prepared. Export waits for them.', { kind: 'warn' });
  const audioProject = !!p.settings.audioOnly;
  let format = audioProject ? 'audio' : 'mp4';
  let trFmt = 'txt';
  const sizes = sizeOptions(p);
  const short = Math.min(p.settings.width, p.settings.height);
  let size = sizes.find((s) => s.short === Math.min(1080, short)) || sizes[2];
  let fps = p.settings.fps;
  let mbps = 12;
  let range = store.inPoint != null || store.outPoint != null ? 'inout' : 'all';
  let loud = false;
  let audioFmt = 'mp3';
  let frameFmt = 'png';
  let capFmt = 'srt';
  let gifW = 540;
  const extraShapes = new Set(store.settings.exportExtraShapes || []);
  let extraFraming = store.settings.exportExtraFraming || 'blur';
  const ownShape = shapeOf(p);

  const body = h('div', { class: 'export' });
  const opts = h('div', { class: 'export-opts' });
  const progress = h('div', { class: 'export-progress', style: { display: 'none' } });
  body.append(opts, progress);
  const aspect = p.settings.width / p.settings.height;
  const matching = EXPORT_PRESETS.filter((x) => Math.abs(x.aspect - aspect) < 0.02);

  function draw() {
    clear(opts);
    const fmts = h('div', { class: 'seg wide' });
    for (const [k, l] of audioProject
      ? [
          ['audio', 'Audio'],
          ['transcript', 'Transcript'],
        ]
      : [
          ['mp4', 'Video'],
          ['gif', 'GIF'],
          ['audio', 'Audio only'],
          ['frame', 'Still frame'],
          ['captions', 'Captions'],
        ])
      fmts.append(h('button', { class: 'seg-btn' + (format === k ? ' active' : ''), type: 'button', onclick: () => {
        format = k;
        draw();
      } }, l));
    opts.append(fmts);
    if (format === 'mp4') {
      if (matching.length) {
        const cards = h('div', { class: 'chips' });
        for (const pr of matching)
          cards.append(h('button', { class: 'chip', type: 'button', onclick: () => {
            size = sizes.find((s) => s.w === pr.w && s.h === pr.h) || size;
            fps = pr.fps;
            mbps = pr.bitrate;
            draw();
          } }, pr.name));
        opts.append(h('div', { class: 'row col' }, h('label', {}, 'Presets'), cards));
      }
      opts.append(
        select('Size', sizes.map((s, i) => [i, s.label]), sizes.indexOf(size), (v) => (size = sizes[Number(v)])),
        select('Frame rate', [24, 25, 30, 50, 60].map((f) => [f, f + ' fps']), fps, (v) => (fps = Number(v))),
        slider('Quality', { value: mbps, min: 2, max: 60, step: 1, format: (v) => `${v} Mbps`, onInput: (v) => {
          mbps = v;
          est.textContent = estimate();
        } }),
        toggle('Even out loudness for social media (-14 LUFS)', loud, (v) => (loud = v)),
      );
      const others = SHAPES.filter((sh) => sh.id !== ownShape.id);
      const boxes = h('div', { class: 'chips' });
      for (const sh of others)
        boxes.append(h('button', { class: 'chip' + (extraShapes.has(sh.id) ? ' active' : ''), type: 'button', onclick: () => {
          extraShapes.has(sh.id) ? extraShapes.delete(sh.id) : extraShapes.add(sh.id);
          draw();
        } }, sh.name));
      opts.append(h('div', { class: 'row col' }, h('label', {}, 'Also export in these shapes'), boxes));
      if (extraShapes.size) opts.append(select('Clips that do not fit', [['blur', 'Fit, blurred copy behind'], ['contain', 'Fit, black bars'], ['cover', 'Fill the frame, crop the edges']], extraFraming, (v) => (extraFraming = v)));
    }
    if (format === 'gif') opts.append(select('Width', [[320, '320 px'], [480, '480 px'], [540, '540 px'], [720, '720 px']], gifW, (v) => (gifW = Number(v))), select('Frame rate', [[10, '10 fps'], [15, '15 fps'], [20, '20 fps']], 15, (v) => (fps = Number(v))));
    if (format === 'audio')
      opts.append(
        select('Format', [['mp3', 'MP3 (podcasts, sharing)'], ['m4a', 'M4A / AAC (Apple, smaller)'], ['wav', 'WAV (full quality, large)']], audioFmt, (v) => {
          audioFmt = v;
          est.textContent = estimate();
        }),
        toggle('Even out loudness to podcast level (-16 LUFS)', loud, (v) => (loud = v)),
      );
    if (format === 'transcript') opts.append(select('Format', [['txt', 'Text with times'], ['srt', 'SRT subtitles']], trFmt, (v) => (trFmt = v)), h('p', { class: 'hint' }, 'Uses the transcript from the Transcript panel. Make it there first if it is empty.'));
    if (format === 'frame') opts.append(h('p', { class: 'hint' }, `Saves the frame at the playhead (${formatTime(store.playhead)}) at full size.`), select('Format', [['png', 'PNG'], ['jpg', 'JPG']], frameFmt, (v) => (frameFmt = v)));
    if (format === 'captions') opts.append(select('Format', [['srt', 'SRT'], ['vtt', 'WebVTT']], capFmt, (v) => (capFmt = v)), h('p', { class: 'hint' }, 'Upload the file next to the video on YouTube or Facebook for closed captions.'));
    if (['mp4', 'gif', 'audio'].includes(format)) {
      const sel = store.selectedItems;
      const opt = [['all', `Whole project (${formatDuration(dur)})`]];
      if (store.inPoint != null || store.outPoint != null) opt.push(['inout', `In to out (${formatDuration((store.outPoint ?? dur) - (store.inPoint ?? 0))})`]);
      if (sel.length) opt.push(['sel', 'Selected clips']);
      opts.append(select('Range', opt, range, (v) => {
        range = v;
        est.textContent = estimate();
      }));
    }
    const est = h('div', { class: 'hint' }, estimate());
    opts.append(est);
  }

  function rangeTimes() {
    if (range === 'inout') return [store.inPoint ?? 0, store.outPoint ?? dur];
    if (range === 'sel' && store.selectedItems.length) return [Math.min(...store.selectedItems.map((i) => i.start)), Math.max(...store.selectedItems.map(itemEnd))];
    return [0, dur];
  }

  function estimate() {
    const [a, b] = rangeTimes();
    if (format === 'audio') {
      const mb = ((audioFmt === 'wav' ? 1536 : audioFmt === 'm4a' ? 192 : 190) * (b - a)) / 8 / 1000;
      return `About ${mb < 1 ? '1' : Math.round(mb)} MB for ${formatDuration(b - a)}.`;
    }
    if (format !== 'mp4') return '';
    const mb = ((mbps + 0.2) * (b - a)) / 8;
    return `About ${mb < 1000 ? Math.round(mb) + ' MB' : (mb / 1000).toFixed(1) + ' GB'} for ${formatDuration(b - a)}.`;
  }

  draw();
  let running = null;
  const m = modal('Export', body, {
    width: 560,
    onClose: () => running?.abort(),
    actions: [
      { label: 'Cancel', run: (close) => close(null) },
      { label: 'Export', primary: true, run: () => start() },
    ],
  });

  async function start() {
    if (running) return;
    const ext = format === 'mp4' ? 'mp4' : format === 'gif' ? 'gif' : format === 'audio' ? audioFmt : format === 'frame' ? frameFmt : format === 'transcript' ? trFmt : capFmt;
    const folder = store.settings.exportFolder || paths.videos || paths.documents;
    const out = await saveDialog({ title: 'Export', defaultPath: join(folder, defaultExportName(p, ext)), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!out) return;
    saveSettings({ exportFolder: dirname(out) });
    const [t0, t1] = rangeTimes();
    const ctrl = new AbortController();
    running = ctrl;
    opts.style.display = 'none';
    progress.style.display = 'block';
    m.box.querySelector('.modal-foot').style.display = 'none';
    const bar = h('div', { class: 'job-bar big' }, h('div', { class: 'job-fill' }));
    const label = h('div', { class: 'job-label' }, 'Starting');
    const cancel = button('Cancel', () => ctrl.abort());
    clear(progress);
    progress.append(h('div', { class: 'export-file' }, icon('download', 16), h('span', {}, out)), bar, label, cancel);
    const fill = bar.firstChild;
    const onProgress = (pr) => {
      fill.style.width = Math.round(pr.fraction * 100) + '%';
      let txt = pr.stage;
      if (pr.frame) txt += ` ${pr.frame} of ${pr.frames}`;
      if (pr.eta != null) txt += `, about ${formatDuration(pr.eta)} left`;
      label.textContent = txt;
    };
    try {
      await waitForMedia(ctrl.signal, label);
      if (app.preview.playing) app.preview.pause();
      await loadProjectLuts(app);
      const extras = [];
      if (format === 'mp4') {
        const shapes = SHAPES.filter((sh) => extraShapes.has(sh.id) && sh.id !== ownShape.id);
        saveSettings({ exportExtraShapes: [...extraShapes], exportExtraFraming: extraFraming });
        const total = shapes.length + 1;
        const part = (i, name) => (pr) => onProgress({ ...pr, stage: total > 1 ? `${name}: ${pr.stage}` : pr.stage, fraction: (i + pr.fraction) / total });
        await exportVideo(p, { out, width: size.w, height: size.h, fps, bitrateMbps: mbps, t0, t1, loudnorm: loud, onProgress: part(0, ownShape.id.replace('x', ':')), signal: ctrl.signal });
        for (let i = 0; i < shapes.length; i++) {
          const sh = shapes[i];
          const k = Math.min(size.w, size.h) / 1080;
          const w = Math.round((sh.w * k) / 2) * 2;
          const hh = Math.round((sh.h * k) / 2) * 2;
          const o2 = out.replace(/(\.mp4)?$/i, ` (${sh.id}).mp4`);
          await exportVideo(adaptProject(p, sh.w, sh.h, extraFraming), { out: o2, width: w, height: hh, fps, bitrateMbps: mbps, t0, t1, loudnorm: loud, onProgress: part(i + 1, sh.id.replace('x', ':')), signal: ctrl.signal });
          extras.push(o2);
        }
      }
      else if (format === 'gif') await exportGif(p, { out, width: gifW, height: Math.round((gifW / p.settings.width) * p.settings.height), fps, bitrateMbps: 8, t0, t1, onProgress, signal: ctrl.signal });
      else if (format === 'audio') await exportAudio(p, { out, t0, t1, format: audioFmt, loudnorm: loud, onProgress, signal: ctrl.signal });
      else if (format === 'frame') await exportFrame(p, store.playhead, out);
      else if (format === 'transcript') await (await import('../ai/transcript.js')).exportTranscript(p, out);
      else await exportCaptions(p, out);
      clear(progress);
      progress.append(
        h('div', { class: 'export-done' }, icon('check', 22), h('span', {}, 'Exported')),
        h('div', { class: 'export-file' }, h('span', {}, out)),
        ...extras.map((x) => h('div', { class: 'export-file' }, h('span', {}, x))),
        h('div', { class: 'btn-row' }, button('Show in folder', () => invoke('reveal_path', { path: out }), { icon: 'folder' }), button('Open', () => invoke('open_path', { path: out }), { icon: 'play' }), button('Close', () => m.close(true), { kind: 'primary' })),
      );
      running = null;
    } catch (e) {
      running = null;
      if (e?.name === 'AbortError') {
        toast('Export cancelled.');
        m.close(null);
        return;
      }
      errorToast(e, 'Export failed.');
      clear(progress);
      progress.append(h('p', { class: 'err' }, String(e.message || e)), button('Back', () => {
        progress.style.display = 'none';
        opts.style.display = 'block';
        m.box.querySelector('.modal-foot').style.display = '';
      }));
    }
  }
}

async function waitForMedia(signal, label) {
  const busy = () => Object.values(store.project.media).filter((m) => m.status === 'processing');
  while (busy().length) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    label.textContent = `Waiting for ${busy().length} clip${busy().length > 1 ? 's' : ''} to finish preparing`;
    await new Promise((r) => setTimeout(r, 500));
  }
  const bad = Object.values(store.project.items).filter((it) => it.mediaId && ['error', 'missing'].includes(store.project.media[it.mediaId]?.status));
  if (bad.length) throw new Error(`${bad.length} clip${bad.length > 1 ? 's use files that are' : ' uses a file that is'} missing or failed to prepare: ${store.project.media[bad[0].mediaId].name}.`);
}

export async function loadProjectLuts(app) {
  const keys = new Set(Object.values(store.project.items).map((it) => it.color?.lut).filter((k) => k?.startsWith('file:')));
  for (const k of keys) await app.ensureLut(k).catch(() => {});
}
