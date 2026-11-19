// Footage search: finds what was said across every imported video and
// recording, on the timeline or not, and puts the moment on the timeline.
// Transcripts are made on this computer with Whisper and kept on the media.

import { store } from '../core/store.js';
import { newClip, sourceSpan } from '../core/model.js';
import * as E from '../core/edit.js';
import { timelineTimeFor } from './captions.js';
import { transcribeMedia } from './transcript.js';
import { h, button, icon } from '../ui/dom.js';
import { startJob, toast } from '../ui/notify.js';
import { formatTime } from '../core/util.js';

const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Imported files with sound, not the copies the smart tools make. */
export function footage(p = store.project) {
  return Object.values(p.media).filter((m) => !m.hidden && (m.kind === 'video' || m.kind === 'audio') && m.hasAudio && m.status === 'ready');
}

/** Where a moment of a file already sits on the timeline. */
function placesOf(p, mediaId, s) {
  const out = [];
  for (const it of Object.values(p.items)) {
    if (it.type !== 'clip' || it.mediaId !== mediaId || it.freeze) continue;
    if (s >= it.in && s < it.in + sourceSpan(it)) out.push({ itemId: it.id, t: timelineTimeFor(it, s) });
  }
  return out;
}

/**
 * Finds a word or a phrase. Each word of the query has to start a word of the
 * transcript, in order, so "inject" finds "injection" and "lip filler" finds
 * "lip fillers". Returns [{ mediaId, name, s, e, text, places }].
 */
export function searchFootage(p, query, { limit = 60, context = 8 } = {}) {
  const q = String(query || '').split(/\s+/).map(norm).filter(Boolean);
  if (!q.length) return [];
  const hits = [];
  for (const m of footage(p)) {
    const words = m.transcript?.words;
    if (!words?.length) continue;
    const n = words.map((w) => norm(w.t));
    for (let i = 0; i + q.length <= n.length; i++) {
      let ok = true;
      for (let j = 0; j < q.length; j++) {
        if (!n[i + j].startsWith(q[j])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const last = i + q.length - 1;
      const before = words.slice(Math.max(0, i - context), i).map((w) => w.t.trim()).join(' ');
      const match = words.slice(i, last + 1).map((w) => w.t.trim()).join(' ');
      const after = words.slice(last + 1, last + 1 + context).map((w) => w.t.trim()).join(' ');
      hits.push({ mediaId: m.id, name: m.name, s: words[i].s, e: words[last].e, before, match, after, text: `${before} ${match} ${after}`.trim(), places: placesOf(p, m.id, words[i].s) });
      i = last;
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** The sentence around a moment, so an added clip starts and ends on a pause. */
export function sentenceAround(m, s, e, { max = 20 } = {}) {
  const words = m.transcript?.words || [];
  let i = words.findIndex((w) => w.e > s);
  if (i < 0) return { s: Math.max(0, s - 1), e: Math.min(m.duration, e + 1.5) };
  let j = i;
  while (j + 1 < words.length && words[j + 1].s < e) j++;
  const gap = 0.6;
  while (i > 0 && words[i].s - words[i - 1].e < gap && !/[.!?]$/.test(words[i - 1].t.trim()) && e - words[i - 1].s < max) i--;
  while (j + 1 < words.length && words[j + 1].s - words[j].e < gap && !/[.!?]$/.test(words[j].t.trim()) && words[j + 1].e - s < max) j++;
  return { s: Math.max(0, words[i].s - 0.25), e: Math.min(m.duration, words[j].e + 0.35) };
}

/**
 * Puts parts of files on the timeline at time t: [{ mediaId, s, e }] in seconds
 * of each file. Video goes on the main track (pushing later clips along when
 * it is magnetic), sound alone goes on an audio track. Returns the new clips.
 */
export function addRanges(p, ranges, t, { trackId = null } = {}) {
  const added = [];
  const visual = [];
  let at = t;
  for (const r of ranges) {
    const m = p.media[r.mediaId];
    if (!m) continue;
    const s = Math.max(0, Number(r.s) || 0);
    const e = Math.min(m.duration || Infinity, Number(r.e));
    if (!(e > s + 0.05)) continue;
    const c = newClip(m, null, 0, { inPoint: s, duration: e - s });
    p.items[c.id] = c;
    added.push(c);
    if (p.settings.audioOnly || m.kind === 'audio') {
      if (p.settings.audioOnly) visual.push(c);
      else {
        c.start = at;
        c.trackId = E.findFreeTrack(p, 'audio', at, at + c.duration, { prefer: trackId });
        at += c.duration;
      }
    } else visual.push(c);
  }
  if (visual.length) {
    const target = trackId && p.tracks.find((x) => x.id === trackId);
    if (!target || E.isMagnetic(p, target.id)) E.insertIntoMain(p, visual, t);
    else {
      let x = t;
      for (const c of visual) {
        c.trackId = target.id;
        E.overwrite(p, target.id, x, x + c.duration, new Set([c.id]));
        c.start = x;
        x += c.duration;
      }
    }
  }
  return added;
}

/** Makes the transcripts that are missing, one file after another. */
export async function transcribeFootage(list, job) {
  for (let i = 0; i < list.length; i++) {
    job?.update(i / list.length, `${list[i].name} (${i + 1} of ${list.length})`);
    await transcribeMedia(list[i], job);
  }
}

// ---------------------------------------------------------------------------
// The view inside the Transcript panel
// ---------------------------------------------------------------------------

let lastQuery = '';

export function footageView(app, body) {
  const p = store.project;
  const files = footage(p);
  const missing = files.filter((m) => !m.transcript);
  const search = h('input', { type: 'search', placeholder: 'Search what was said, like "lip filler"', value: lastQuery, class: 'tr-search' });
  const results = h('div', { class: 'fs-results' });
  body.append(search);
  if (!files.length) {
    body.append(h('p', { class: 'hint' }, 'Import videos or recordings with speech, and this searches all of them by what was said, whether they are on the timeline or not.'));
    return;
  }
  if (missing.length) {
    body.append(
      h(
        'div',
        { class: 'notice col' },
        h('p', {}, `${missing.length} of ${files.length} ${files.length === 1 ? 'file has' : 'files have'} no transcript yet, so ${missing.length === 1 ? 'it is' : 'they are'} left out of the search. Whisper makes them on this computer in about a quarter of their length.`),
        button('Make the transcripts', async () => {
          const job = startJob('Transcripts');
          try {
            await transcribeFootage(missing, job);
            job.done('Transcripts ready.');
            app.renderPanel();
          } catch (e) {
            job.fail(e);
          }
        }, { kind: 'primary', icon: 'doc' }),
      ),
    );
  }
  const draw = () => {
    lastQuery = search.value;
    const hits = searchFootage(store.project, search.value);
    if (!search.value.trim()) return results.replaceChildren(h('p', { class: 'hint' }, `Searches ${files.length - missing.length} ${files.length - missing.length === 1 ? 'file' : 'files'}. Each result can go on the timeline at the playhead as the whole sentence.`));
    if (!hits.length) return results.replaceChildren(h('p', { class: 'hint' }, `"${search.value.trim()}" is not said in any of them.`));
    results.replaceChildren(
      h('div', { class: 'hint' }, `${hits.length}${hits.length >= 60 ? '+' : ''} found`),
      ...hits.map((hit) => {
        const m = store.project.media[hit.mediaId];
        return h(
          'div',
          { class: 'fs-hit' },
          h('div', { class: 'fs-head' }, icon(m.kind === 'audio' ? 'music' : 'film', 12), h('span', { class: 'fs-name' }, hit.name), h('span', { class: 'dim' }, formatTime(hit.s))),
          h('p', { class: 'fs-text' }, hit.before ? hit.before + ' ' : '', h('mark', {}, hit.match), hit.after ? ' ' + hit.after : ''),
          h(
            'div',
            { class: 'btn-row' },
            button('Add at the playhead', () => {
              const r = sentenceAround(m, hit.s, hit.e);
              let added = [];
              store.commit('Add a moment', (pp) => (added = addRanges(pp, [{ mediaId: m.id, ...r }], store.playhead)));
              store.select(added.map((c) => c.id));
              if (added[0]) app.seek(added[0].start);
              toast(`Added ${Math.round(r.e - r.s)} s of ${m.name}.`, { timeout: 2200 });
            }, { icon: 'plus', kind: 'link' }),
            hit.places.length ? button('Go to it', () => app.seek(hit.places[0].t + 0.01), { icon: 'play', kind: 'link' }) : null,
          ),
        );
      }),
    );
  };
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 150);
  });
  body.append(results);
  draw();
  setTimeout(() => search.focus(), 0);
}

