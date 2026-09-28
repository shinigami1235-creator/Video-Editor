// Script to video: a voice reads the script, captions follow it, and the
// chosen clips or slides are laid under each paragraph.

import { store } from '../core/store.js';
import { h, select, slider, button } from '../ui/dom.js';
import { modal, toast, startJob } from '../ui/notify.js';
import { voiceList } from '../media/voices.js';
import { speak, paragraphs } from './tts.js';
import { importFiles, whenReady, thumbUrl } from '../media/library.js';
import { newClip, maxClipDuration } from '../core/model.js';
import * as E from '../core/edit.js';
import { addCaptionItems, chunkWords, spreadWords } from './captions.js';
import { saveSettings } from '../core/settings.js';

export function scriptToVideo(app) {
  const visuals = Object.values(store.project.media).filter((m) => !m.hidden && (m.kind === 'video' || m.kind === 'image') && m.status === 'ready');
  const chosen = new Set(visuals.map((m) => m.id));
  const text = h('textarea', { rows: 10, placeholder: 'Write or paste the script. Each paragraph becomes one scene.' });
  text.value = store.settings.lastScript || '';
  let voice = store.settings.piperVoice;
  let speed = 1;
  let captions = true;
  const pick = h('div', { class: 'pick-grid' });
  for (const m of visuals) {
    const el = h('button', { class: 'pick active', type: 'button', title: m.name }, h('img', { src: thumbUrl(m) || '', alt: '' }), h('span', {}, m.name));
    el.addEventListener('click', () => {
      if (chosen.has(m.id)) chosen.delete(m.id);
      else chosen.add(m.id);
      el.classList.toggle('active', chosen.has(m.id));
    });
    pick.append(el);
  }
  const capToggle = h('input', { type: 'checkbox', checked: true, onchange: (e) => (captions = e.target.checked) });
  const body = h(
    'div',
    { class: 'stack' },
    text,
    select('Voice', [...voiceList().map(([k, v]) => [k, v.label]), ...(store.settings.myVoiceSample && store.settings.paidServices ? [['mine', 'My own voice (Replicate, paid)']] : [])], voice, (v) => (voice = v)),
    slider('Speed', { value: 1, min: 0.7, max: 1.4, step: 0.05, format: (v) => Number(v).toFixed(2) + 'x', onInput: (v) => (speed = v) }),
    h('label', { class: 'row toggle' }, capToggle, h('span', {}, 'Add captions')),
    h('div', { class: 'row col' }, h('label', {}, visuals.length ? 'Clips and slides to use, in order' : 'Import clips or PDF slides first to lay them under the voice.'), pick),
  );
  modal('Script to video', body, {
    width: 680,
    actions: [
      { label: 'Cancel', run: (c) => c(null) },
      {
        label: 'Make the video',
        primary: true,
        run: (c) => {
          if (!text.value.trim()) return toast('Write the script first.', { timeout: 1500 });
          saveSettings({ lastScript: text.value, piperVoice: voice });
          c(true);
          build(app, text.value, { voice, speed, captions, media: visuals.filter((m) => chosen.has(m.id)) });
        },
      },
    ],
  });
}

async function build(app, script, { voice, speed, captions, media }) {
  const job = startJob('Script to video');
  try {
    const paras = paragraphs(script);
    const voiced = [];
    for (let i = 0; i < paras.length; i++) {
      job.update(i / paras.length, `Reading scene ${i + 1} of ${paras.length}`);
      const wav = await speak(paras[i], { voice, speed, job });
      const [m] = await importFiles([wav]);
      await whenReady(m);
      m.name = `Scene ${i + 1} voice`;
      voiced.push({ text: paras[i], m });
    }
    job.update(null, 'Laying out the scenes');
    const at = store.playhead;
    store.commit('Script to video', (p) => {
      let t = at;
      const audioTrack = E.findFreeTrack(p, 'audio', at, at + voiced.reduce((a, v) => a + v.m.duration + 0.35, 0));
      const main = E.mainTrack(p);
      const visualClips = [];
      const allWords = [];
      voiced.forEach((v, i) => {
        const dur = v.m.duration + 0.35;
        const a = newClip(v.m, audioTrack, t);
        a.name = `Scene ${i + 1} voice`;
        p.items[a.id] = a;
        if (media.length) {
          const src = media[i % media.length];
          const c = newClip(src, main.id, t, { duration: dur });
          if (src.kind === 'video') c.duration = Math.min(dur, maxClipDuration(p, c));
          c.muted = true;
          c.anim = { in: null, out: null, loop: src.kind === 'image' ? { type: 'kenBurns', period: 2, amount: 0.8 } : null };
          if (i > 0) c.transitionIn = { type: 'dissolve', duration: 0.4 };
          p.items[c.id] = c;
          visualClips.push(c);
        }
        allWords.push(...spreadWords(v.text, t + 0.05, t + v.m.duration));
        t += dur;
      });
      if (visualClips.length) E.insertIntoMain(p, visualClips, at);
      if (captions) addCaptionItems(p, chunkWords(allWords, { maxWords: p.captionStyle.maxWords || 4, maxChars: p.captionStyle.maxChars || 26 }));
    });
    job.done('The video is laid out. Play it through and swap any clip that does not fit its scene.');
  } catch (e) {
    job.fail(e);
  }
}
