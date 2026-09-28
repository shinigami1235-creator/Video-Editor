// YouTube chapters, title ideas, description and hashtags written by Claude
// from what is said in the video. The chapters also land as timeline markers.

import { store } from '../core/store.js';
import { itemEnd } from '../core/model.js';
import { allCaptions } from './captions.js';
import { transcriptClips, clipWords, transcribeMedia } from './transcript.js';
import { askClaudeJson, hasClaude, sentences } from './llm.js';
import { modal, toast, startJob } from '../ui/notify.js';
import { h, button } from '../ui/dom.js';
import { uid, formatTime } from '../core/util.js';

const ytTime = (t) => {
  const s = Math.max(0, Math.floor(t));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

/** What is said, in timeline seconds: captions if there are any, else transcripts. */
async function spokenLines(job) {
  const caps = allCaptions().filter((c) => !c.translation);
  if (caps.length) return sentences(caps.map((c) => ({ t: c.text, s: c.start, e: itemEnd(c) })), { maxLen: 60 });
  const clips = transcriptClips(store.project, 'main');
  const words = [];
  for (const c of clips) {
    const m = store.project.media[c.mediaId];
    if (!m.transcript) await transcribeMedia(m, job);
    for (const w of clipWords(c) || []) words.push({ t: w.t, s: w.ts, e: w.te });
  }
  return sentences(words);
}

export async function showChapters(app) {
  if (!hasClaude()) return toast('Add your Claude API key in Settings to use this.', { kind: 'warn', timeout: 3000 });
  const job = startJob('YouTube chapters');
  let res;
  try {
    job.update(null, 'Reading what is said');
    const lines = await spokenLines(job);
    if (lines.length < 3) {
      job.done();
      return toast('There is not enough speech in the project. Make captions or a transcript first.', { kind: 'warn' });
    }
    job.update(null, 'Claude is writing the chapters');
    const text = lines.map((l) => `[${l.s.toFixed(0)}] ${l.text}`).join('\n');
    res = await askClaudeJson(
      `Below is what is said in a video, one sentence per line with its start time in seconds. The video is for ${store.project.name || 'a clinic or a chocolate brand'}.

Write:
1. YouTube chapters: 3 to 10 of them, the first at 0 seconds, each at least 10 seconds after the previous one, each title at most 6 words.
2. Three title ideas under 70 characters.
3. A description of 2 short paragraphs in plain words, no hype.
4. Up to 8 hashtags.

Answer with only JSON like {"chapters": [{"t": 0, "title": "..."}], "titles": ["..."], "description": "...", "hashtags": ["#..."]}.

${text}`,
      { signal: job.signal, maxTokens: 3000, system: 'You write YouTube metadata. You answer with JSON only.' },
    );
    job.done();
  } catch (e) {
    return job.fail(e);
  }
  const chapters = (res.chapters || []).map((c) => ({ t: Math.max(0, Number(c.t) || 0), title: String(c.title || '').trim() })).filter((c) => c.title).sort((a, b) => a.t - b.t);
  if (chapters.length) chapters[0].t = 0;
  const chapterText = chapters.map((c) => `${ytTime(c.t)} ${c.title}`).join('\n');
  const desc = [res.description || '', '', chapterText, '', (res.hashtags || []).join(' ')].join('\n').trim();
  const copy = (txt) => navigator.clipboard?.writeText(txt).then(() => toast('Copied.'));
  const area = (txt, rows = 6) => {
    const a = h('textarea', { rows, class: 'yt-text' });
    a.value = txt;
    return a;
  };
  const descArea = area(desc, 12);
  modal(
    'YouTube chapters and description',
    h(
      'div',
      { class: 'stack' },
      h('label', {}, 'Title ideas'),
      h('ul', { class: 'yt-titles' }, ...(res.titles || []).map((t) => h('li', {}, t, ' ', button('Copy', () => copy(t), { kind: 'link' })))),
      h('label', {}, 'Description with chapters'),
      descArea,
      h('div', { class: 'btn-row' }, button('Copy the description', () => copy(descArea.value), { icon: 'copy' }), button('Add the chapters as markers', () => {
        store.commit('Chapter markers', (p) => {
          for (const c of chapters) p.markers.push({ id: uid('k'), t: c.t, label: c.title, color: '#6fb3e0' });
        });
        toast(`Added ${chapters.length} markers.`);
      }, { icon: 'marker' })),
      h('p', { class: 'hint' }, `Chapters at ${chapters.map((c) => formatTime(c.t).replace(/\.\d+$/, '')).join(', ')}. YouTube needs the first one at 0:00 and at least three.`),
    ),
    { width: 640, actions: [{ label: 'Done', primary: true, run: (close) => close() }] },
  );
}
