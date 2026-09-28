// Caption translation with Claude, and dubbing: a voice reads the translated
// captions in their time slots while the original speech is turned down.

import { store } from '../core/store.js';
import { itemEnd, newTrack } from '../core/model.js';
import * as E from '../core/edit.js';
import { allCaptions, spreadWords, captionTrack } from './captions.js';
import { askClaudeJson, hasClaude } from './llm.js';
import { speak } from './tts.js';
import { importFiles, whenReady } from '../media/library.js';
import { newClip } from '../core/model.js';
import { voicesForLang } from '../media/voices.js';
import { modal, toast, startJob } from '../ui/notify.js';
import { h, select, toggle } from '../ui/dom.js';
import { uid, clone } from '../core/util.js';

export const LANGUAGES = [
  ['Filipino (Tagalog)', 'tl'],
  ['English', 'en'],
  ['Thai', 'th'],
  ['Spanish', 'es'],
  ['Chinese (Simplified)', 'zh'],
  ['Japanese', 'ja'],
  ['Korean', 'ko'],
  ['Vietnamese', 'vi'],
  ['Indonesian', 'id'],
  ['French', 'fr'],
  ['Arabic', 'ar'],
];

/** Voices that can read each language (Piper, on this computer). */
export function voicesFor(lang) {
  return voicesForLang(lang);
}

/** Translates caption texts in batches. Returns the new texts in the same order. */
export async function translateTexts(texts, langName, { signal, onProgress } = {}) {
  const out = [];
  const size = 80;
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    const prompt = `Translate these video captions into ${langName}. They are consecutive lines of one video about aesthetic medicine or chocolate products, so keep product names, brand names and medical terms as they are when there is no common translation. Keep each line short like a caption, and keep the same number of lines in the same order.

Answer with only a JSON array of ${batch.length} strings.

${JSON.stringify(batch)}`;
    const res = await askClaudeJson(prompt, { signal, maxTokens: 8000, system: 'You translate captions. You answer with JSON only.' });
    if (!Array.isArray(res) || res.length !== batch.length) throw new Error('Claude sent back a different number of lines. Try again.');
    out.push(...res.map((x) => String(x).trim()));
    onProgress?.(Math.min(1, (i + size) / texts.length));
  }
  return out;
}

/** Groups captions into sentences for a voice to read naturally. */
export function sentenceGroups(caps, maxGap = 0.6) {
  const groups = [];
  let cur = null;
  for (const c of caps) {
    if (!cur || c.start - cur.end > maxGap || /[.!?。！？]$/.test(cur.text.trim()) || cur.text.length > 180) {
      cur = { start: c.start, end: itemEnd(c), text: c.text };
      groups.push(cur);
    } else {
      cur.text += ' ' + c.text;
      cur.end = itemEnd(c);
    }
  }
  return groups;
}

export function translateDialog(app) {
  const caps = allCaptions().filter((c) => !c.translation);
  if (!caps.length) return toast('Make captions first (Captions panel), then translate them.', { timeout: 3000 });
  const opts = { lang: store.settings.translateLang || 'tl', mode: 'add', dub: false, voice: '' };
  const voiceRow = h('div', {});
  const drawVoice = () => {
    const vs = voicesFor(opts.lang);
    voiceRow.replaceChildren(
      vs.length
        ? h('div', { class: 'stack' }, toggle('Dub it: a voice reads the translation and the original speech is turned down', opts.dub, (v) => (opts.dub = v)), select('Voice', vs.map(([k, v]) => [k, v.label]), (opts.voice = vs[0][0]), (v) => (opts.voice = v)))
        : h('p', { class: 'hint' }, 'There is no voice on this computer for this language yet, so it is captions only.'),
    );
  };
  drawVoice();
  const body = h(
    'div',
    { class: 'stack' },
    h('p', {}, `Claude translates the ${caps.length} captions. The timing stays the same.`),
    hasClaude() ? null : h('p', { class: 'notice' }, 'Add your Claude API key in Settings to use this.'),
    select('Into', LANGUAGES.map(([n, c]) => [c, n]), opts.lang, (v) => {
      opts.lang = v;
      drawVoice();
    }),
    select('Result', [['add', 'Add as a second line of captions'], ['replace', 'Replace the captions']], opts.mode, (v) => (opts.mode = v)),
    voiceRow,
  );
  modal('Translate captions', body, {
    width: 520,
    actions: [
      { label: 'Cancel', run: (close) => close() },
      { label: 'Translate', primary: true, run: (close) => { close(); runTranslate(app, opts); } },
    ],
  });
}

async function runTranslate(app, opts) {
  const langName = LANGUAGES.find(([, c]) => c === opts.lang)?.[0] || opts.lang;
  app.saveSetting('translateLang', opts.lang);
  const caps = allCaptions().filter((c) => !c.translation);
  const job = startJob('Translate captions');
  try {
    job.update(null, `Claude is translating into ${langName}`);
    const texts = await translateTexts(caps.map((c) => c.text), langName, { signal: job.signal, onProgress: (f) => job.update(f * 0.9) });
    let made = [];
    store.commit('Translate captions', (p) => {
      if (opts.mode === 'replace') {
        caps.forEach((c0, i) => {
          const c = p.items[c0.id];
          if (!c) return;
          c.text = texts[i];
          c.words = spreadWords(texts[i], 0, c.duration);
          c.lang = opts.lang;
        });
        made = caps.map((c) => p.items[c.id]).filter(Boolean);
      } else {
        const tr = newTrack('video', `Captions (${langName})`);
        tr.translation = true;
        const base = captionTrack(p);
        p.tracks.splice(p.tracks.indexOf(base), 0, tr);
        caps.forEach((c0, i) => {
          const c = p.items[c0.id];
          if (!c) return;
          const n = clone(c);
          n.id = uid('c');
          n.trackId = tr.id;
          n.text = texts[i];
          n.words = spreadWords(texts[i], 0, c.duration);
          n.reveal = 'none';
          n.lang = opts.lang;
          n.translation = true;
          n.props.y = c.props.y + Math.round(c.style.size * 1.5);
          n.style = { ...c.style, size: Math.round(c.style.size * 0.8), highlightMode: 'none' };
          p.items[n.id] = n;
          made.push(n);
        });
      }
    });
    job.done(`Translated ${made.length} captions into ${langName}.`);
    if (opts.dub && opts.voice) await dub(app, made, opts.voice);
  } catch (e) {
    job.fail(e);
  }
}

/** A voice reads captions in their slots; the original speech drops to 15%. */
export async function dub(app, caps, voice) {
  const groups = sentenceGroups(caps);
  const job = startJob('Dubbing');
  try {
    const clips = [];
    for (let i = 0; i < groups.length; i++) {
      job.update(i / groups.length, `Reading line ${i + 1} of ${groups.length}`);
      const wav = await speak(groups[i].text, { voice, speed: 1, job });
      const [m] = await importFiles([wav]);
      await whenReady(m);
      clips.push({ g: groups[i], m });
    }
    store.commit('Dubbing', (p) => {
      const tracks = [newTrack('audio', 'Dub')];
      p.tracks.push(tracks[0]);
      const ends = [0];
      const dubTracks = new Set([tracks[0].id]);
      clips.forEach(({ g, m }, i) => {
        const next = clips[i + 1]?.g.start ?? Infinity;
        const slot = Math.max(0.3, Math.min(next, g.end + 0.6) - g.start);
        // read faster when the translation is longer than the original, up to 1.4x
        const sp = Math.min(1.4, Math.max(1, m.duration / slot));
        // a line that still runs long goes on a second dub track instead of overlapping
        let ti = ends.findIndex((e) => e <= g.start + 1e-3);
        if (ti < 0) {
          const t2 = newTrack('audio', 'Dub ' + (tracks.length + 1));
          p.tracks.push(t2);
          tracks.push(t2);
          ends.push(0);
          dubTracks.add(t2.id);
          ti = tracks.length - 1;
        }
        const c = newClip(m, tracks[ti].id, g.start);
        c.name = 'Dub: ' + g.text.slice(0, 30);
        p.items[c.id] = c;
        if (sp > 1.01) E.setSpeed(p, c, +sp.toFixed(2));
        ends[ti] = c.start + c.duration;
      });
      for (const it of Object.values(p.items)) {
        if (it.type !== 'clip' || dubTracks.has(it.trackId) || it.duck || !p.media[it.mediaId]?.hasAudio || it.muted) continue;
        it.props.volume = Math.min(it.props.volume ?? 1, 0.15);
        for (const k of it.kf?.volume || []) k.v = Math.min(k.v, 0.15);
        if (it.duck2) delete it.duck2;
      }
    });
    job.done(`Dubbed ${clips.length} lines. The original speech is at 15%.`);
  } catch (e) {
    job.fail(e);
  }
}
