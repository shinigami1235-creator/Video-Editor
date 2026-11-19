// Bleep words: the transcript finds every word on the list (swear words by
// default) and each one goes silent with a beep over it, or just silent. The
// bleeps sit on the clip in seconds of the source file, so they stay on the
// right word after trims, splits and speed changes.

import { store } from '../core/store.js';
import { sourceSpan } from '../core/model.js';
import { transcribeMedia, transcriptClips } from './transcript.js';
import { DEFAULT_BLEEP_WORDS, bleepMatchers, matchWords } from '../media/clean-audio.js';
import { h, select } from '../ui/dom.js';
import { modal, toast, startJob } from '../ui/notify.js';

const PAD = 0.03;

/** The clips to bleep: the selected ones with sound, else every clip with sound. */
export function bleepTargets(p = store.project) {
  const sel = store.selectedItems.filter((i) => i.type === 'clip' && p.media[i.mediaId]?.hasAudio && !i.muted);
  return sel.length ? sel : transcriptClips(p, 'all');
}

/** Bleeps for the matching words, per clip id: { clipId: [{ s, e, w }] }. */
export function findBleeps(p, clips, words) {
  const matchers = bleepMatchers(words);
  const out = {};
  for (const c of clips) {
    const m = p.media[c.mediaId];
    const list = m?.transcript?.words;
    if (!list) continue;
    const a = c.in;
    const b = c.in + sourceSpan(c);
    const hits = [];
    let prev = -2;
    for (const i of matchWords(list, matchers)) {
      const w = list[i];
      if (!(w.e > a && w.s < b)) continue;
      // words next to each other ("tang ina") make one bleep
      const last = hits[hits.length - 1];
      if (last && i === prev + 1 && w.s - (last.e - PAD) < 0.15) {
        last.e = +(w.e + PAD).toFixed(3);
        last.w += ' ' + w.t.trim();
      } else hits.push({ s: +(w.s - PAD).toFixed(3), e: +(w.e + PAD).toFixed(3), w: w.t.trim() });
      prev = i;
    }
    if (hits.length) out[c.id] = hits;
  }
  return out;
}

/** Adds bleeps to clips, skipping any already there. Returns how many were added. */
export function addBleeps(p, found) {
  let n = 0;
  for (const [id, list] of Object.entries(found)) {
    const it = p.items[id];
    if (!it) continue;
    const have = (it.bleeps ||= []);
    for (const b of list) {
      if (have.some((x) => Math.abs(x.s - b.s) < 0.02 && Math.abs(x.e - b.e) < 0.02)) continue;
      have.push({ ...b });
      n++;
    }
    have.sort((x, y) => x.s - y.s);
  }
  return n;
}

export function removeBleeps(p, clips) {
  let n = 0;
  for (const c of clips) {
    const it = p.items[c.id];
    if (!it?.bleeps?.length) continue;
    n += it.bleeps.length;
    delete it.bleeps;
  }
  return n;
}

/** Transcribes the clips that have no transcript yet. */
export async function ensureTranscripts(clips, job) {
  const p = store.project;
  const missing = [...new Set(clips.map((c) => p.media[c.mediaId]).filter((m) => m && !m.transcript))];
  for (let i = 0; i < missing.length; i++) {
    job?.update(i / missing.length, `Transcript of ${missing[i].name} (${i + 1} of ${missing.length})`);
    await transcribeMedia(missing[i], job);
  }
  return missing.length;
}

export function bleepDialog(app) {
  const p = store.project;
  const clips = bleepTargets(p);
  if (!clips.length) return toast('Put a clip with speech on the timeline first.', { timeout: 2500 });
  const area = h('textarea', { rows: 4, class: 'bleep-words' });
  area.value = (store.settings.bleepWords || DEFAULT_BLEEP_WORDS).join(', ');
  const count = h('p', { class: 'hint' });
  const missing = () => clips.filter((c) => !store.project.media[c.mediaId]?.transcript);
  const recount = () => {
    const found = findBleeps(store.project, clips, area.value);
    const n = Object.values(found).reduce((k, l) => k + l.length, 0);
    const words = [...new Set(Object.values(found).flat().map((b) => b.w.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '')))];
    const left = missing().length;
    count.textContent = left ? `${left} ${left === 1 ? 'clip has' : 'clips have'} no transcript yet, so they are made first.` : n ? `Found ${n}: ${words.slice(0, 12).join(', ')}${words.length > 12 ? '…' : ''}` : 'None of these words are said.';
    return found;
  };
  area.addEventListener('input', recount);
  recount();
  const had = clips.some((c) => c.bleeps?.length);
  modal(
    'Bleep words',
    h(
      'div',
      { class: 'stack' },
      h('p', {}, `Every word on the list goes quiet in ${clips.length === 1 ? (clips[0].name || p.media[clips[0].mediaId].name) : `${clips.length} clips`}. Separate the words with commas, and a * at the end matches any ending, so "fuck*" also catches "fucking".`),
      area,
      count,
      select('Sound', [['beep', 'Beep over the word'], ['mute', 'Silence']], p.settings.bleepSound || 'beep', (v) => store.commit('Bleep sound', (pp) => (pp.settings.bleepSound = v))),
    ),
    {
      width: 560,
      actions: [
        had ? { label: 'Remove the bleeps', run: (close) => {
          close();
          let n = 0;
          store.commit('Remove bleeps', (pp) => (n = removeBleeps(pp, clips)));
          toast(`Removed ${n} bleep${n === 1 ? '' : 's'}.`);
        } } : null,
        { label: 'Cancel', run: (close) => close() },
        {
          label: 'Bleep them',
          primary: true,
          run: async (close) => {
            close();
            const list = area.value.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
            app.saveSetting('bleepWords', list);
            const job = startJob('Bleep words');
            try {
              await ensureTranscripts(clips, job);
              const found = findBleeps(store.project, clips.map((c) => store.project.items[c.id]).filter(Boolean), list);
              let n = 0;
              store.commit('Bleep words', (pp) => (n = addBleeps(pp, found)));
              job.done(n ? `Bleeped ${n} word${n === 1 ? '' : 's'}.` : 'None of those words are said.');
            } catch (e) {
              job.fail(e);
            }
          },
        },
      ].filter(Boolean),
    },
  );
}

/** Bleeps words picked in the Transcript panel: Map clipId -> word indexes in the media transcript. */
export function bleepPicked(p, selection) {
  const found = {};
  for (const [clipId, idxs] of selection) {
    const it = p.items[clipId];
    const words = it && p.media[it.mediaId]?.transcript?.words;
    if (!words) continue;
    found[clipId] = idxs.map((i) => words[i]).filter(Boolean).map((w) => ({ s: +(w.s - PAD).toFixed(3), e: +(w.e + PAD).toFixed(3), w: w.t.trim() }));
  }
  return addBleeps(p, found);
}
