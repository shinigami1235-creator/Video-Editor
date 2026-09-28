// Edit by text: every clip with speech gets a transcript, shown as a document.
// Selecting words and pressing Delete cuts them out of the video.

import { store } from '../core/store.js';
import { sourceSpan, trackItems, isVisualItem } from '../core/model.js';
import * as E from '../core/edit.js';
import { transcribeClip, timelineTimeFor } from './captions.js';
import { keepRanges, cutLinked, complement } from './speech-edit.js';
import { startJob, toast } from '../ui/notify.js';
import { h, button, select, icon } from '../ui/dom.js';
import { formatTime } from '../core/util.js';

const FILLERS = /^(um+|uh+|uhm+|erm+|er|ah+|hmm+|mm+|mhm|eh+)[.,!?]*$/i;

/** Transcribes a whole media file once; words are kept on the media in source seconds. */
export async function transcribeMedia(m, job) {
  if (m.transcript?.words) return m.transcript;
  const whole = { mediaId: m.id, in: 0, start: 0, duration: m.duration, speed: 1, name: m.name };
  const words = await transcribeClip(whole, { language: store.settings.whisperLanguage, model: store.settings.whisperModel, job });
  m.transcript = { words: words.map((w) => ({ t: w.text, s: +w.start.toFixed(3), e: +w.end.toFixed(3) })), language: store.settings.whisperLanguage || 'auto' };
  store.dirty = true;
  store.emit('media', m);
  return m.transcript;
}

/** Clips the transcript follows, in timeline order. */
export function transcriptClips(p = store.project, scope = 'main') {
  let clips;
  if (scope === 'selected') clips = store.selectedItems.filter((i) => i.type === 'clip');
  else if (scope === 'all') clips = Object.values(p.items).filter((i) => i.type === 'clip' && !i.muted);
  else {
    const main = E.spineTrack(p);
    clips = main ? trackItems(p, main.id) : [];
    // a main clip whose sound was separated reads its words from the separated copy
    clips = clips.map((c) => (c.muted ? Object.values(p.items).find((o) => o.linkedTo === c.id) || c : c));
  }
  return clips.filter((c) => p.media[c.mediaId]?.hasAudio && !c.freeze).sort((a, b) => a.start - b.start);
}

/** Words of a clip that are still in it, with their timeline times. */
export function clipWords(it) {
  const m = store.project.media[it.mediaId];
  const words = m?.transcript?.words;
  if (!words) return null;
  const a = it.in;
  const b = it.in + sourceSpan(it);
  const out = [];
  words.forEach((w, i) => {
    const mid = (w.s + w.e) / 2;
    if (mid >= a && mid < b) out.push({ ...w, i, ts: timelineTimeFor(it, Math.max(a, w.s)), te: timelineTimeFor(it, Math.min(b, w.e)) });
  });
  return out;
}

/**
 * Cuts the given words (per clip: word indexes into the media transcript).
 * Each run of words is cut from the middle of the pause before it to the
 * middle of the pause after it, so the cut lands in silence.
 */
export function cutWords(p, selection) {
  let removed = 0;
  const newIds = [];
  for (const [clipId, idxs] of selection) {
    const it = p.items[clipId];
    if (!it || it.speedCurve || !idxs.length) continue;
    const m = p.media[it.mediaId];
    const words = m.transcript.words;
    const a = it.in;
    const b = it.in + sourceSpan(it);
    const inClip = clipWords(it).map((w) => w.i);
    const sel = new Set(idxs);
    const cuts = [];
    let k = 0;
    while (k < inClip.length) {
      if (!sel.has(inClip[k])) {
        k++;
        continue;
      }
      let j = k;
      while (j + 1 < inClip.length && sel.has(inClip[j + 1])) j++;
      const first = words[inClip[k]];
      const last = words[inClip[j]];
      const prev = k > 0 ? words[inClip[k - 1]] : null;
      const next = j + 1 < inClip.length ? words[inClip[j + 1]] : null;
      const from = prev ? Math.max(prev.e, (prev.e + first.s) / 2) : a;
      const to = next ? Math.min(next.s, (last.e + next.s) / 2) : b;
      cuts.push([Math.max(a, from), Math.min(b, to)]);
      removed += j - k + 1;
      k = j + 1;
    }
    if (!cuts.length) continue;
    const keep = complement(a, b, cuts);
    const linkedFrom = it.linkedTo ? p.items[it.linkedTo] : null;
    if (linkedFrom) {
      // words came from separated audio: cut the video it belongs to the same way
      const pieces = keepRanges(p, linkedFrom, keep);
      cutLinked(p, linkedFrom, keep, pieces);
      newIds.push(...pieces.map((c) => c.id));
    } else if (!keep.length) {
      delete p.items[it.id];
      E.compactMagnetic(p);
    } else {
      const pieces = keepRanges(p, it, keep);
      cutLinked(p, it, keep, pieces);
      newIds.push(...pieces.map((c) => c.id));
    }
  }
  return { removed, newIds };
}

/** The transcript of the project as timed lines: [{ start, end, text }] in timeline seconds. */
export function transcriptLines(p = store.project) {
  const lines = [];
  for (const c of transcriptClips(p, 'all')) {
    const words = clipWords(c);
    if (!words?.length) continue;
    let cur = null;
    for (const w of words) {
      const t = w.t.trim();
      if (!t) continue;
      // a new line after a pause, after a sentence ends, or when it gets long
      if (!cur || w.ts - cur.end > 0.9 || /[.!?]$/.test(cur.text) || cur.text.length > 80) {
        cur = { start: w.ts, end: w.te, text: t };
        lines.push(cur);
      } else {
        cur.text += ' ' + t;
        cur.end = w.te;
      }
    }
  }
  return lines.sort((a, b) => a.start - b.start);
}

/** Writes the transcript as plain text with times, or as SRT subtitles. */
export async function exportTranscript(p, out) {
  const lines = transcriptLines(p);
  if (!lines.length) throw new Error('There is no transcript yet. Open the Transcript panel and press "Make the transcript" first.');
  const { writeText } = await import('../backend/index.js');
  const srtTime = (t) => {
    const ms = Math.round(t * 1000);
    const pad = (n, k = 2) => String(n).padStart(k, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  const text = out.toLowerCase().endsWith('.srt')
    ? lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(Math.max(l.end, l.start + 0.3))}\n${l.text}\n`).join('\n')
    : lines.map((l) => `[${formatTime(l.start)}] ${l.text}`).join('\n') + '\n';
  await writeText(out, text);
  return out;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let scope = 'main';
let query = '';
let seekOff = null;

export function transcriptPanel(app) {
  const body = h('div', { class: 'panel-body transcript-panel' });
  const p = store.project;
  const clips = transcriptClips(p, scope);
  const missing = [...new Set(clips.map((c) => p.media[c.mediaId]).filter((m) => !m.transcript))];
  const scopeSel = select('Show', [['main', p.settings.audioOnly ? 'First audio track' : 'Main track'], ['all', 'Every clip with sound'], ['selected', 'Selected clips']], scope, (v) => {
    scope = v;
    app.renderPanel();
  });
  const search = h('input', { type: 'search', placeholder: 'Find a word', value: query, class: 'tr-search' });
  body.append(scopeSel, search);
  if (!clips.length) {
    body.append(h('p', { class: 'hint' }, p.settings.audioOnly ? 'Put a recording with speech on the first audio track and its words show up here. Deleting words cuts that part of the recording.' : 'Put a clip with speech on the timeline and its words show up here. Deleting words deletes that part of the video.'));
    return body;
  }
  if (missing.length) {
    body.append(
      h('div', { class: 'notice col' }, h('p', {}, `${missing.length} ${missing.length === 1 ? 'clip needs' : 'clips need'} a transcript first. Whisper runs on this computer and takes about a quarter of the clip length.`), button('Make the transcript', () => transcribeAll(app, missing), { kind: 'primary', icon: 'doc' })),
    );
  }
  const doc = h('div', { class: 'tr-doc', tabindex: '0' });
  let count = 0;
  for (const c of clips) {
    const words = clipWords(c);
    if (!words) continue;
    const para = h('div', { class: 'tr-clip' }, h('div', { class: 'tr-clip-head' }, icon(p.media[c.mediaId].kind === 'audio' || !isVisualItem(p, c) ? 'music' : 'film', 12), h('span', {}, c.name || p.media[c.mediaId].name), h('span', { class: 'dim' }, formatTime(c.start))));
    let line = h('p', {});
    let prevEnd = null;
    for (const w of words) {
      if (prevEnd != null && w.s - prevEnd > 1.2 && line.childNodes.length) {
        para.append(line);
        line = h('p', {});
      }
      const span = h('span', { class: 'tw' + (FILLERS.test(w.t.trim()) ? ' filler' : '') + (query && w.t.toLowerCase().includes(query.toLowerCase()) ? ' hit' : '') }, w.t + ' ');
      span.dataset.clip = c.id;
      span.dataset.i = w.i;
      span.dataset.t = w.ts;
      line.append(span);
      prevEnd = w.e;
      count++;
    }
    if (line.childNodes.length) para.append(line);
    doc.append(para);
  }
  const selectedWords = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    return [...doc.querySelectorAll('.tw')].filter((el) => r.intersectsNode(el) && !(el === r.endContainer.parentNode && r.endOffset === 0));
  };
  const doCut = (els) => {
    if (!els.length) return toast('Select some words first by dragging across them.', { timeout: 2200 });
    const byClip = new Map();
    for (const el of els) {
      if (!byClip.has(el.dataset.clip)) byClip.set(el.dataset.clip, []);
      byClip.get(el.dataset.clip).push(Number(el.dataset.i));
    }
    let res = null;
    store.commit('Cut words', (pp) => (res = cutWords(pp, byClip)));
    window.getSelection()?.removeAllRanges();
    toast(`Cut ${res.removed} word${res.removed === 1 ? '' : 's'}.`, { timeout: 2500 });
  };
  doc.addEventListener('click', (e) => {
    const w = e.target.closest('.tw');
    if (!w || !window.getSelection()?.isCollapsed) return;
    app.seek(Number(w.dataset.t) + 0.01);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      doCut(selectedWords());
    } else if (e.key === ' ' && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      app.preview?.toggle();
    }
  });
  doc.addEventListener('mouseup', () => doc.focus({ preventScroll: true }));
  search.addEventListener('input', () => {
    query = search.value;
    doc.querySelectorAll('.tw').forEach((el) => el.classList.toggle('hit', !!query && el.textContent.toLowerCase().includes(query.toLowerCase())));
  });
  const tools = h(
    'div',
    { class: 'btn-row wrap' },
    button('Cut selected words', () => doCut(selectedWords()), { icon: 'split' }),
    button('Cut filler words', () => doCut([...doc.querySelectorAll('.tw.filler')]), { kind: 'link' }),
    button('Cut found words', () => doCut([...doc.querySelectorAll('.tw.hit')]), { kind: 'link' }),
    button('Copy text', () => navigator.clipboard?.writeText([...doc.querySelectorAll('.tr-clip p')].map((x) => x.textContent.trim()).join('\n\n')).then(() => toast('Copied.')), { kind: 'link' }),
  );
  body.append(tools, h('div', { class: 'hint' }, count ? 'Drag across words and press Delete to cut them from the video. Click a word to jump there. Filler words are underlined.' : ''), doc);
  // highlight the word under the playhead
  seekOff?.();
  const mark = () => {
    if (!doc.isConnected) return seekOff?.();
    const t = store.playhead;
    let cur = null;
    for (const el of doc.querySelectorAll('.tw')) {
      if (Number(el.dataset.t) <= t) cur = el;
      else break;
    }
    doc.querySelector('.tw.now')?.classList.remove('now');
    if (cur) {
      cur.classList.add('now');
      if (store.playing) cur.scrollIntoView({ block: 'nearest' });
    }
  };
  seekOff = store.on('seek', mark);
  setTimeout(mark, 0);
  return body;
}

async function transcribeAll(app, list) {
  const job = startJob('Transcript');
  try {
    for (let i = 0; i < list.length; i++) {
      job.update(i / list.length, `${list[i].name} (${i + 1} of ${list.length})`);
      await transcribeMedia(list[i], job);
    }
    job.done('Transcript ready.');
    app.renderPanel();
  } catch (e) {
    job.fail(e);
  }
}
