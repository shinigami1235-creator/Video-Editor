// Auto captions with whisper.cpp: word timings, chunking into caption items,
// styles, SRT import and editing.

import { store } from '../core/store.js';
import { itemEnd, sourceTime, sourceSpan, newText, newTrack, defaultTextStyle, isVisualItem, trackItems } from '../core/model.js';
import * as E from '../core/edit.js';
import { ensureWhisper } from '../media/tools.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { runProcess } from '../backend/proc.js';
import { join, paths, mkdir, readText, remove, openDialog, saveDialog } from '../backend/index.js';
import { startJob, toast, modal } from '../ui/notify.js';
import { h, button } from '../ui/dom.js';
import { uid, clamp, formatTime, hashString, clone } from '../core/util.js';
import { CAPTION_PRESETS } from '../ui/presets.js';
import { exportCaptions } from '../export/export.js';

/** Timeline time for a source time inside a clip (inverse of sourceTime). */
export function timelineTimeFor(it, src) {
  if (!it.speedCurve && !it.freeze) return it.start + (src - it.in) / (it.speed || 1);
  // numeric inverse for ramps
  let lo = it.start;
  let hi = itemEnd(it);
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (sourceTime(it, mid) < src) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function parseTs(s) {
  const m = String(s).match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

/** Runs whisper on a clip's used range. Returns words with timeline times. */
export async function transcribeClip(it, { language = 'auto', model = 'small', translate = false, job } = {}) {
  const p = store.project;
  const m = p.media[it.mediaId];
  if (!m?.hasAudio) throw new Error(`${it.name || 'This clip'} has no sound.`);
  const w = await ensureWhisper(model, (pr) => job?.download(pr), job?.signal);
  const dir = join(paths.temp, 've-whisper');
  await mkdir(dir);
  const span = sourceSpan(it);
  const base = join(dir, hashString(m.path + it.in + span + language + model + translate));
  const wav = base + '.wav';
  job?.update(0, 'Preparing the sound');
  await ffmpeg(['-ss', it.in.toFixed(3), '-t', span.toFixed(3), '-i', m.pcm ? m.edit : m.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const threads = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const args = ['-m', w.model, '-f', wav, '-l', language || 'auto', '-oj', '-of', base, '-t', String(threads), '-pp', '-ml', '1', '-sow'];
  if (translate) args.push('-tr');
  await runProcess(w.bin, args, {
    signal: job?.signal,
    onLine(line) {
      const mm = line.match(/progress\s*=\s*(\d+)%/);
      if (mm) job?.update(Number(mm[1]) / 100, 'Listening');
    },
  });
  const json = JSON.parse(await readText(base + '.json'));
  await remove(wav).catch(() => {});
  await remove(base + '.json').catch(() => {});
  const words = [];
  for (const seg of json.transcription || []) {
    const text = (seg.text || '').trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue;
    const from = seg.offsets ? seg.offsets.from / 1000 : parseTs(seg.timestamps?.from);
    const to = seg.offsets ? seg.offsets.to / 1000 : parseTs(seg.timestamps?.to);
    const src0 = it.in + from;
    const src1 = it.in + Math.max(from + 0.05, to);
    words.push({ text, start: timelineTimeFor(it, src0), end: timelineTimeFor(it, src1) });
  }
  // whisper sometimes splits one word into pieces without a leading space; join them back
  const merged = [];
  for (const wd of words) {
    const prev = merged[merged.length - 1];
    if (prev && /^[^A-Za-z0-9À-ÿ"'(]/.test(wd.text) && wd.text.length <= 3) {
      prev.text += wd.text;
      prev.end = wd.end;
    } else merged.push({ ...wd });
  }
  return merged.filter((wd) => wd.start < itemEnd(it) && wd.end > it.start);
}

/** Splits timed words into caption chunks. */
export function chunkWords(words, { maxWords = 4, maxChars = 26 } = {}) {
  const chunks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const wd = words[i];
    const prev = cur[cur.length - 1];
    if (prev && wd.start - prev.end > 0.6) flush();
    const chars = cur.reduce((a, x) => a + x.text.length + 1, 0) + wd.text.length;
    if (cur.length >= maxWords || (cur.length && chars > maxChars)) flush();
    cur.push(wd);
    if (/[.!?]$/.test(wd.text) || (/[,;:]$/.test(wd.text) && cur.length >= Math.max(2, maxWords - 1))) flush();
  }
  flush();
  return chunks;
}

export function captionTrack(p) {
  let tr = p.tracks.find((t) => t.kind === 'video' && t.captions);
  if (!tr) {
    tr = newTrack('video', 'Captions');
    tr.captions = true;
    p.tracks.unshift(tr);
  }
  return tr;
}

function styleFromCaption(cs) {
  return {
    ...defaultTextStyle(),
    font: cs.font,
    size: cs.size,
    weight: cs.weight,
    color: cs.color,
    uppercase: cs.uppercase,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    shadowBlur: cs.shadowBlur,
    shadowColor: cs.shadowColor,
    shadowY: cs.shadowBlur ? 3 : 0,
    boxEnabled: cs.boxEnabled,
    boxColor: cs.boxColor || 'rgba(0,0,0,0.6)',
    boxPadding: 18,
    boxRadius: 12,
    highlightColor: cs.highlightColor,
    highlightMode: cs.highlightMode,
    maxWidth: 0.84,
    lineHeight: 1.12,
  };
}

/** Builds caption items from chunks of timed words (timeline seconds). */
export function addCaptionItems(p, chunks) {
  const cs = p.captionStyle;
  const tr = captionTrack(p);
  const made = [];
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const start = ch[0].start;
    const nextStart = chunks[i + 1]?.[0].start ?? Infinity;
    const end = Math.min(nextStart, Math.max(ch[ch.length - 1].end + 0.25, start + 0.4));
    const it = newText(tr.id, start, ch.map((w) => w.text).join(' '), styleFromCaption(cs));
    it.duration = Math.max(0.2, end - start);
    it.caption = true;
    it.name = 'Caption';
    it.words = ch.map((w) => ({ text: w.text, start: Math.max(0, w.start - start), end: Math.max(0.05, w.end - start) }));
    it.reveal = cs.reveal || 'none';
    it.props.y = ((cs.y ?? 0.72) - 0.5) * p.settings.height;
    it.anim = { in: null, out: null, loop: null };
    // keep caption items from overlapping on the caption track
    if (!E.isFree(p, tr.id, it.start, it.start + it.duration)) it.trackId = E.findFreeTrack(p, 'video', it.start, it.start + it.duration, { skipMain: true });
    p.items[it.id] = it;
    made.push(it);
  }
  return made;
}

export async function autoCaptions(app, target) {
  const p = store.project;
  let clips;
  if (target) clips = [target];
  else {
    const sel = store.selectedItems.filter((i) => i.type === 'clip' && p.media[i.mediaId]?.hasAudio);
    clips = sel.length ? sel : Object.values(p.items).filter((i) => i.type === 'clip' && p.media[i.mediaId]?.hasAudio && !i.muted && !p.tracks.find((t) => t.id === i.trackId)?.muted);
  }
  // a detached audio clip and its video would be transcribed twice; keep the audible one
  clips = clips.filter((c) => !(isVisualItem(p, c) && c.muted));
  if (!clips.length) return toast('There is no clip with sound to caption.', { kind: 'warn' });
  // skip music marked to duck: it is not speech
  const speech = clips.filter((c) => !c.duck);
  if (!speech.length) return toast('The only sound is music marked "Lower under voice". Captions need speech.', { kind: 'warn' });
  const job = startJob('Auto captions');
  try {
    let all = [];
    for (let i = 0; i < speech.length; i++) {
      const c = speech[i];
      const words = await transcribeClip(c, {
        language: store.settings.whisperLanguage,
        model: store.settings.whisperModel,
        translate: !!store.settings.whisperTranslate,
        job: { ...job, update: (f, l) => job.update((i + (f || 0)) / speech.length, speech.length > 1 ? `${l} (clip ${i + 1} of ${speech.length})` : l) },
      });
      all.push(...words);
    }
    all.sort((a, b) => a.start - b.start);
    if (!all.length) {
      job.done();
      return toast('No speech was found.', { kind: 'warn' });
    }
    const cs = p.captionStyle;
    const chunks = chunkWords(all, { maxWords: cs.maxWords || 4, maxChars: cs.maxChars || 26 });
    let made = [];
    store.commit('Auto captions', (pp) => {
      // replace captions in the same time range
      const lo = all[0].start;
      const hi = all[all.length - 1].end;
      for (const it of Object.values(pp.items)) if (it.caption && it.start < hi && itemEnd(it) > lo) delete pp.items[it.id];
      made = addCaptionItems(pp, chunks);
    });
    app.openPanel('captions');
    job.done(`Made ${made.length} captions. Check the spelling of names and medical terms.`);
  } catch (e) {
    job.fail(e);
  }
}

export function allCaptions(p = store.project) {
  return Object.values(p.items)
    .filter((i) => i.type === 'text' && i.caption)
    .sort((a, b) => a.start - b.start);
}

function captionWordsAbsolute(c) {
  if (c.words?.length) return c.words.map((w) => ({ text: w.text, start: c.start + w.start, end: c.start + w.end }));
  return spreadWords(c.text, c.start, itemEnd(c));
}

export function spreadWords(text, start, end) {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((a, w) => a + w.length + 1, 0) || 1;
  let t = start;
  const span = Math.max(0.1, end - start);
  return parts.map((w) => {
    const d = ((w.length + 1) / total) * span;
    const out = { text: w, start: t, end: t + d * 0.95 };
    t += d;
    return out;
  });
}

export function applyCaptionPreset(id) {
  const pr = CAPTION_PRESETS.find((x) => x.id === id);
  if (!pr) return;
  store.commit('Caption style', (p) => {
    Object.assign(p.captionStyle, pr.style, { preset: id, reveal: pr.reveal });
    if (pr.y != null) p.captionStyle.y = pr.y;
    if (pr.maxWords) p.captionStyle.maxWords = pr.maxWords;
    for (const c of allCaptions(p)) {
      c.style = styleFromCaption(p.captionStyle);
      c.reveal = c.words ? pr.reveal : 'none';
      c.props.y = ((p.captionStyle.y ?? 0.72) - 0.5) * p.settings.height;
    }
  });
}

export function setCaptionY(v, commit) {
  const fn = (p) => {
    p.captionStyle.y = v;
    for (const c of allCaptions(p)) c.props.y = (v - 0.5) * p.settings.height;
  };
  if (commit) store.commit('Caption height', fn);
  else store.mutate(fn);
}

export function rechunkCaptions(maxWords) {
  store.commit('Words per caption', (p) => {
    p.captionStyle.maxWords = maxWords;
    const caps = allCaptions(p);
    if (!caps.length) return;
    const words = caps.flatMap(captionWordsAbsolute);
    const style = clone(caps[0].style);
    for (const c of caps) delete p.items[c.id];
    const made = addCaptionItems(p, chunkWords(words, { maxWords, maxChars: Math.max(p.captionStyle.maxChars || 26, maxWords * 7) }));
    for (const m of made) m.style = clone(style);
  });
}

export function captionStyleFrom(it) {
  store.commit('Caption style from this caption', (p) => {
    for (const c of allCaptions(p)) {
      c.style = clone(it.style);
      c.reveal = c.words ? it.reveal : 'none';
    }
    Object.assign(p.captionStyle, { font: it.style.font, size: it.style.size, weight: it.style.weight, color: it.style.color, uppercase: it.style.uppercase, outlineWidth: it.style.outlineWidth, outlineColor: it.style.outlineColor, boxEnabled: it.style.boxEnabled, boxColor: it.style.boxColor, highlightColor: it.style.highlightColor, highlightMode: it.style.highlightMode, reveal: it.reveal });
  });
  toast('Every caption now uses this style.');
}

export function editCaptions(app) {
  const caps = allCaptions();
  if (!caps.length) return toast('There are no captions yet.', { kind: 'warn' });
  const rows = caps.map((c) => {
    const inp = h('input', { type: 'text', value: c.text });
    const time = h('button', { class: 'btn btn-link cap-time', type: 'button', title: 'Go to this caption', onclick: () => app.seek(c.start + 0.01) }, formatTime(c.start));
    return { c, inp, el: h('div', { class: 'cap-row' }, time, inp) };
  });
  modal('Edit captions', h('div', { class: 'cap-list' }, h('p', { class: 'hint' }, 'Fix words here. Timing is kept, and a changed caption spreads its words evenly over the same time.'), ...rows.map((r) => r.el)), {
    width: 640,
    actions: [
      { label: 'Cancel', run: (close) => close(null) },
      {
        label: 'Save',
        primary: true,
        run: (close) => {
          store.commit('Edit captions', () => {
            for (const r of rows) {
              const v = r.inp.value.trim();
              if (v === r.c.text) continue;
              if (!v) {
                delete store.project.items[r.c.id];
                continue;
              }
              r.c.text = v;
              r.c.words = spreadWords(v, 0, r.c.duration);
            }
          });
          close(true);
        },
      },
    ],
  });
}

export function parseSrt(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->').map((s) => parseTs(s.trim()));
    const txt = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (txt) out.push({ start: a, end: z, text: txt });
  }
  return out;
}

export async function importSrt() {
  const path = await openDialog({ title: 'Import captions', filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] });
  if (!path) return;
  const cues = parseSrt(await readText(path));
  if (!cues.length) return toast('No captions were found in that file.', { kind: 'warn' });
  store.commit('Import captions', (p) => {
    const chunks = cues.map((c) => spreadWords(c.text, c.start, c.end));
    const made = addCaptionItems(p, chunks);
    // keep the file's exact timing
    made.forEach((m, i) => {
      m.start = cues[i].start;
      m.duration = Math.max(0.2, cues[i].end - cues[i].start);
      m.reveal = 'none';
    });
  });
  toast(`Imported ${cues.length} captions.`);
}

export async function exportSrt() {
  const out = await saveDialog({ title: 'Save captions', defaultPath: join(store.settings.exportFolder || paths.documents, (store.project.name || 'captions') + '.srt'), filters: [{ name: 'SRT', extensions: ['srt'] }, { name: 'WebVTT', extensions: ['vtt'] }] });
  if (!out) return;
  await exportCaptions(store.project, out);
  toast('Captions saved.');
}

export function deleteCaptions() {
  store.commit('Delete captions', (p) => {
    for (const c of allCaptions(p)) delete p.items[c.id];
    E.pruneEmptyTracks(p);
  });
}

export { uid, clamp, trackItems };
