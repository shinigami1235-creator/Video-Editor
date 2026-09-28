// Long video to shorts: Claude reads the transcript of a lecture and picks the
// moments that stand on their own. Each one becomes a vertical project with
// captions and a title, saved and exported to Documents\Video Editor Shorts.

import { store } from '../core/store.js';
import { newProject, newClip, newText, sourceSpan, defaultTextStyle } from '../core/model.js';
import * as E from '../core/edit.js';
import { clone, formatTime, clamp } from '../core/util.js';
import { h, button, select, toggle } from '../ui/dom.js';
import { modal, toast, startJob } from '../ui/notify.js';
import { join, paths, mkdir, writeText, invoke } from '../backend/index.js';
import { transcribeMedia, transcriptClips } from './transcript.js';
import { chunkWords, addCaptionItems } from './captions.js';
import { askClaudeJson, hasClaude, sentences } from './llm.js';
import { exportVideo } from '../export/export.js';

const LENGTHS = { short: [15, 30], mid: [30, 60], long: [60, 90] };

/** The clip to cut shorts from: the selected one, else the longest video with sound, else the longest voice clip. */
function sourceClip() {
  const p = store.project;
  const sel = store.selectedItems.find((i) => i.type === 'clip' && p.media[i.mediaId]?.hasAudio);
  if (sel) return sel;
  const all = transcriptClips(p, 'all').filter((c) => !c.duck);
  const longest = (list) => [...list].sort((a, b) => b.duration - a.duration)[0] || null;
  return longest(all.filter((c) => p.media[c.mediaId]?.kind === 'video')) || longest(all);
}

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Short';
}

/** Asks Claude for moments. Returns [{ title, hook, start, end }] in source seconds. */
export async function findMoments(it, { count = 5, length = 'mid', signal } = {}) {
  const m = store.project.media[it.mediaId];
  const a = it.in;
  const b = it.in + sourceSpan(it);
  const words = m.transcript.words.filter((w) => w.s >= a && w.e <= b);
  const sents = sentences(words);
  if (sents.length < 3) throw new Error('There is not enough speech in this clip to find moments.');
  const [lo, hi] = LENGTHS[length];
  const lines = sents.map((s) => `[${s.s.toFixed(1)}-${s.e.toFixed(1)}] ${s.text}`).join('\n');
  const prompt = `Below is the transcript of a video, one sentence per line with its start and end time in seconds.

Pick up to ${count} moments that work as short vertical videos for Instagram Reels and TikTok. Each moment must:
- make sense to someone who has not seen the rest of the video
- start at the start of a sentence and end at the end of a sentence
- run between ${lo} and ${hi} seconds
- not overlap another moment

For each moment give a title of at most 6 words for the top of the screen, and a one-line reason it works.

Answer with only a JSON array like [{"start": 12.3, "end": 48.9, "title": "...", "why": "..."}], best moment first.

Transcript:
${lines}`;
  const raw = await askClaudeJson(prompt, { maxTokens: 3000, signal, system: 'You edit short-form video. You answer with JSON only.' });
  const starts = sents.map((s) => s.s);
  const ends = sents.map((s) => s.e);
  const snap = (t, list) => list.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), list[0]);
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    let s = snap(Number(r.start), starts);
    let e = snap(Number(r.end), ends);
    if (!(e > s)) continue;
    if (e - s > hi + 15) e = snap(s + hi, ends);
    if (out.some((o) => s < o.end && e > o.start)) continue;
    out.push({ start: clamp(s - 0.15, a, b), end: clamp(e + 0.3, a, b), title: String(r.title || 'Short').trim(), why: String(r.why || '').trim(), on: true });
  }
  return out.slice(0, count);
}

/** A new vertical project holding one moment. */
export function buildShortProject(srcProject, it, moment, { framing = 'blur', captions = true, title = true, width = 1080, height = 1920 } = {}) {
  const m = srcProject.media[it.mediaId];
  const p = newProject({ name: moment.title, width, height, fps: srcProject.settings.fps || 30 });
  p.settings.magnetic = true;
  p.captionStyle = clone(srcProject.captionStyle);
  p.media[m.id] = clone(m);
  const main = E.mainTrack(p);
  const c = newClip(p.media[m.id], main.id, 0, { inPoint: moment.start, duration: moment.end - moment.start });
  c.fit = framing === 'cover' ? 'cover' : 'contain';
  c.effects.backdrop = framing === 'blur' ? 'blur' : null;
  c.color = clone(it.color);
  c.fadeOut = 0.3;
  p.items[c.id] = c;
  if (captions && m.transcript) {
    const words = m.transcript.words.filter((w) => w.s >= moment.start - 0.05 && w.e <= moment.end + 0.05).map((w) => ({ text: w.t, start: Math.max(0, w.s - moment.start), end: Math.max(0.05, w.e - moment.start) }));
    if (words.length) addCaptionItems(p, chunkWords(words, { maxWords: 3, maxChars: 22 }));
  }
  if (title && moment.title) {
    const tx = newText(null, 0, moment.title, { ...defaultTextStyle(), font: 'Montserrat', size: 78, weight: 800, color: '#ffffff', boxEnabled: true, boxColor: 'rgba(0,0,0,0.55)', boxPadding: 22, boxRadius: 14, maxWidth: 0.86, align: 'center' });
    tx.duration = Math.min(3.5, c.duration);
    tx.props.y = -height * 0.3;
    tx.anim = { in: { type: 'pop', duration: 0.4 }, out: { type: 'fade', duration: 0.3 }, loop: null };
    tx.name = 'Title';
    E.placeOverlay(p, tx);
  }
  return p;
}

export async function showShorts(app) {
  const it = sourceClip();
  if (!it) return toast('Put a clip with speech on the timeline first.', { timeout: 2500 });
  const m = store.project.media[it.mediaId];
  const opts = { count: 5, length: 'mid', framing: 'blur', captions: true, title: true, exportNow: true };
  let moments = [];
  const results = h('div', { class: 'shorts-list' });
  const notice = hasClaude() ? null : h('p', { class: 'notice' }, 'Add your Claude API key in Settings to use this. Claude reads the transcript and picks the moments.');
  const findBtn = button('Find moments', () => find(), { kind: 'primary', icon: 'sparkles', disabled: !hasClaude() });
  const drawResults = () => {
    results.replaceChildren(
      ...moments.map((mo) => {
        const cb = h('input', { type: 'checkbox', checked: mo.on, onchange: () => (mo.on = cb.checked) });
        const name = h('input', { type: 'text', value: mo.title, class: 'short-title', onchange: () => (mo.title = name.value) });
        return h(
          'div',
          { class: 'short-row' },
          cb,
          h('div', { class: 'short-main' }, name, h('div', { class: 'hint' }, `${formatTime(mo.start - it.in + it.start)} to ${formatTime(mo.end - it.in + it.start)}, ${Math.round(mo.end - mo.start)}s. ${mo.why}`)),
          button('Play', () => {
            app.seek(it.start + (mo.start - it.in) / (it.speed || 1));
            app.preview?.play();
          }, { kind: 'link', icon: 'play' }),
        );
      }),
    );
  };
  const body = h(
    'div',
    { class: 'stack' },
    h('p', {}, `Claude reads the transcript of ${it.name || m.name} and picks the parts that stand on their own. Each becomes a 9:16 video with captions and a title.`),
    notice,
    select('How many', [3, 5, 8, 10].map((n) => [n, `Up to ${n}`]), opts.count, (v) => (opts.count = Number(v))),
    select('Length', [['short', '15 to 30 seconds'], ['mid', '30 to 60 seconds'], ['long', '60 to 90 seconds']], opts.length, (v) => (opts.length = v)),
    select('Framing', [['blur', 'Fit, blurred copy behind'], ['cover', 'Fill the frame, crop the sides']], opts.framing, (v) => (opts.framing = v)),
    toggle('Captions', opts.captions, (v) => (opts.captions = v)),
    toggle('Title at the top', opts.title, (v) => (opts.title = v)),
    toggle('Export each one as an MP4 now', opts.exportNow, (v) => (opts.exportNow = v)),
    findBtn,
    results,
  );
  const dlg = modal('Make shorts', body, {
    width: 640,
    actions: [
      { label: 'Close', run: (close) => close() },
      { label: 'Make the shorts', primary: true, run: () => make() },
    ],
  });

  async function find() {
    const job = startJob('Finding moments');
    try {
      if (!m.transcript) {
        job.update(0, 'Making the transcript');
        await transcribeMedia(m, job);
      }
      job.update(null, 'Claude is reading the transcript');
      moments = await findMoments(it, { count: opts.count, length: opts.length, signal: job.signal });
      drawResults();
      job.done(moments.length ? null : 'No moments were found.');
    } catch (e) {
      job.fail(e);
    }
  }

  async function make() {
    const chosen = moments.filter((mo) => mo.on);
    if (!chosen.length) return toast('Find moments first, then tick the ones to make.', { timeout: 2500 });
    dlg.close();
    const dir = join(paths.documents, 'Video Editor Shorts');
    await mkdir(dir);
    const job = startJob('Making shorts');
    try {
      let n = 0;
      for (const mo of chosen) {
        const base = join(dir, safeName(`${store.project.name} - ${mo.title}`));
        const p = buildShortProject(store.project, it, mo, opts);
        await writeText(base + '.vproj', JSON.stringify(p));
        if (opts.exportNow) {
          await exportVideo(p, {
            out: base + '.mp4',
            width: 1080,
            height: 1920,
            fps: p.settings.fps,
            bitrateMbps: 10,
            signal: job.signal,
            onProgress: (pr) => job.update((n + pr.fraction) / chosen.length, `${mo.title} (${n + 1} of ${chosen.length})`),
          });
        }
        n++;
      }
      job.done();
      toast(`Made ${n} shorts in Documents\\Video Editor Shorts.`, { timeout: 8000, action: { label: 'Show folder', run: () => invoke('open_path', { path: dir }) } });
    } catch (e) {
      job.fail(e);
    }
  }
}
