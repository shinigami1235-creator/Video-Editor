// Click-free cuts, bleeping words and searching footage by what was said.
// Checks the exported sound sample by sample, and the panels that drive them.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const OUT = '/tmp/ve-clean';
fs.mkdirSync(OUT, { recursive: true });

function samples(file, a, b) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(a), '-t', String(b - a), '-i', file, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
}
const maxJump = (f) => {
  let m = 0;
  for (let i = 1; i < f.length; i++) m = Math.max(m, Math.abs(f[i] - f[i - 1]));
  return m;
};
const rms = (f) => Math.sqrt(f.reduce((k, v) => k + v * v, 0) / Math.max(1, f.length));
function frequency(file, a, b) {
  const f = samples(file, a, b);
  let z = 0;
  for (let i = 1; i < f.length; i++) if (f[i - 1] < 0 && f[i] >= 0) z++;
  return z / (f.length / 48000);
}

async function exportMix(page, out, t1) {
  await page.evaluate(
    async ([out, t1]) => {
      const { exportAudio } = await import('/src/export/export.js');
      await exportAudio(window.__store.project, { out, format: 'wav', t0: 0, t1 });
    },
    [out, t1],
  );
}

await startServers();
try {
  const { browser, page, logs } = await openApp();
  const [tone, land] = (await importAndWait(page, [`${FIX}/tone440.wav`, `${FIX}/landscape.mp4`])).map((m) => m.id);

  // ---- click-free cuts --------------------------------------------------------
  // a split that plays straight on stays seamless
  const T = 1 + 0.25 / 440; // the tone is at its peak here
  await page.evaluate(async ([tone, T]) => {
    const s = window.__store;
    const E = await import('/src/core/edit.js');
    window.__app.addMedia([s.project.media[tone]], 0);
    const a = Object.values(s.project.items)[0];
    s.commit('split', (p) => E.splitAt(p, [p.items[a.id]], T));
  }, [tone, T]);
  const nItems = await page.evaluate(() => Object.keys(window.__store.project.items).length);
  await exportMix(page, `${OUT}/seamless.wav`, 3);
  const around = samples(`${OUT}/seamless.wav`, T - 0.01, T + 0.01);
  const away = samples(`${OUT}/seamless.wav`, 0.5, 0.52);
  check('a split that plays straight on has no dip', nItems === 2 && Math.abs(rms(around) - rms(away)) / rms(away) < 0.05 && maxJump(around) < 0.012, `items ${nItems}, rms ${rms(around).toFixed(4)} vs ${rms(away).toFixed(4)}, jump ${maxJump(around).toFixed(4)}`);

  // a real cut: the second piece starts half a wave later, which pops without the fade
  await page.evaluate(([T]) => {
    const s = window.__store;
    const b = Object.values(s.project.items).find((i) => i.start > 0.5);
    s.commit('jump', (p) => (p.items[b.id].in = T + 0.25 + 0.5 / 440));
  }, [T]);
  await exportMix(page, `${OUT}/cut-on.wav`, 3);
  await page.evaluate(() => window.__store.commit('off', (p) => (p.settings.clickFree = false)));
  await exportMix(page, `${OUT}/cut-off.wav`, 3);
  await page.evaluate(() => window.__store.commit('on', (p) => delete p.settings.clickFree));
  const jOn = maxJump(samples(`${OUT}/cut-on.wav`, T - 0.01, T + 0.01));
  const jOff = maxJump(samples(`${OUT}/cut-off.wav`, T - 0.01, T + 0.01));
  check('a cut pops without click-free cuts', jOff > 0.15, jOff.toFixed(4));
  check('click-free cuts take the pop out', jOn < 0.03, jOn.toFixed(4));
  const clipStart = maxJump(samples(`${OUT}/cut-on.wav`, 0, 0.01));
  check('the first sample of a clip fades in too', clipStart < 0.03, clipStart.toFixed(4));
  const inspector = await page.evaluate(() => {
    window.__store.clearSelection();
    return [...document.querySelectorAll('.inspector label')].map((l) => l.textContent).filter((t) => /Click-free|Bleep sound/.test(t));
  });
  await sleep(200);
  const insp2 = await page.evaluate(() => [...document.querySelectorAll('.inspector *')].filter((e) => e.childElementCount === 0 && /Click-free cuts|Bleep sound/.test(e.textContent)).length);
  check('the project settings show click-free cuts and the bleep sound', insp2 >= 2 || inspector.length >= 2, `${insp2} ${JSON.stringify(inspector)}`);

  // ---- bleeps ------------------------------------------------------------------
  await page.evaluate(([tone]) => {
    const s = window.__store;
    s.commit('clear', (p) => (p.items = {}));
    const m = s.project.media[tone];
    m.transcript = { words: [{ t: 'Hello', s: 0.4, e: 0.9 }, { t: 'shit!', s: 1.5, e: 2.0 }, { t: 'tang', s: 2.4, e: 2.6 }, { t: 'ina', s: 2.6, e: 2.9 }, { t: 'okay.', s: 3.2, e: 3.6 }] };
    window.__app.addMedia([m], 0);
  }, [tone]);
  await page.evaluate(() => window.__app.cmd('bleep'));
  await page.waitForSelector('.bleep-words', { timeout: 5000 });
  const dlgText = await page.evaluate(() => document.querySelector('.bleep-words').closest('.modal, .dialog, [role=dialog]')?.textContent || document.body.textContent);
  check('the bleep dialog finds the swear words in the transcript', /Found 2/.test(dlgText) && /shit/.test(dlgText) && /tang ina/.test(dlgText), (dlgText.match(/Found[^.]*/) || [''])[0]);
  await page.getByRole('button', { name: 'Bleep them' }).click();
  await page.waitForFunction(() => Object.values(window.__store.project.items)[0]?.bleeps?.length === 2, null, { timeout: 10000 });
  const bl = await page.evaluate(() => Object.values(window.__store.project.items)[0].bleeps);
  check('bleeps land on the words, in seconds of the file', bl.length === 2 && Math.abs(bl[0].s - 1.47) < 0.01 && Math.abs(bl[1].e - 2.93) < 0.01, JSON.stringify(bl));
  await exportMix(page, `${OUT}/bleep.wav`, 4);
  const fIn = frequency(`${OUT}/bleep.wav`, 1.55, 1.95);
  const fOut = frequency(`${OUT}/bleep.wav`, 0.5, 1.2);
  const fTang = frequency(`${OUT}/bleep.wav`, 2.45, 2.85);
  check('a beep plays over a bleeped word', Math.abs(fIn - 1000) < 30, fIn.toFixed(0) + ' Hz');
  check('a two-word entry ("tang ina") is bleeped too', Math.abs(fTang - 1000) < 30, fTang.toFixed(0) + ' Hz');
  check('the sound around it is untouched', Math.abs(fOut - 440) < 15, fOut.toFixed(0) + ' Hz');
  await page.evaluate(() => window.__store.commit('mute', (p) => (p.settings.bleepSound = 'mute')));
  await exportMix(page, `${OUT}/bleep-mute.wav`, 4);
  const quiet = rms(samples(`${OUT}/bleep-mute.wav`, 1.55, 1.95));
  const loud = rms(samples(`${OUT}/bleep-mute.wav`, 0.5, 1.2));
  check('the silence setting mutes the word instead', quiet < loud * 0.01, `${quiet.toFixed(5)} vs ${loud.toFixed(4)}`);
  await page.evaluate(() => window.__store.commit('beep', (p) => delete p.settings.bleepSound));

  // the bleep stays on the word after a split and at double speed
  await page.evaluate(async () => {
    const s = window.__store;
    const E = await import('/src/core/edit.js');
    const a = Object.values(s.project.items)[0];
    s.commit('split', (p) => E.splitAt(p, [p.items[a.id]], 1.0));
    const b = Object.values(s.project.items).find((i) => i.start > 0.5);
    s.commit('speed', (p) => E.setSpeed(p, p.items[b.id], 2));
  });
  await exportMix(page, `${OUT}/bleep-fast.wav`, 3);
  // the word at 1.5-2.0 s of the file now plays at 1 + (0.5..1.0)/2 = 1.25-1.5 s
  const fFast = frequency(`${OUT}/bleep-fast.wav`, 1.27, 1.48);
  check('a bleep follows its word after a split and a speed change', Math.abs(fFast - 1000) < 40, fFast.toFixed(0) + ' Hz');
  const lvl = await page.evaluate(async () => {
    const { beepLevel, audibleAt } = await import('/src/render/preview.js');
    const p = window.__store.project;
    return [beepLevel(p, 1.35, audibleAt(p, 1.35)), beepLevel(p, 0.6, audibleAt(p, 0.6))];
  });
  check('the preview plays the beep only during the word', lvl[0] > 0.1 && lvl[1] === 0, JSON.stringify(lvl));
  await page.evaluate(async () => {
    (await import('/src/ai/transcript.js')).setTranscriptScope('all');
    window.__app.openPanel('transcript');
  });
  await sleep(500);
  const struck = await page.evaluate(() => [...document.querySelectorAll('.tw.bleeped')].map((e) => e.textContent.trim()));
  check('the Transcript panel strikes out bleeped words', struck.includes('shit!') && struck.includes('ina'), JSON.stringify(struck));

  // ---- footage search ------------------------------------------------------------
  await page.evaluate(([land]) => {
    const s = window.__store;
    s.commit('clear', (p) => (p.items = {}));
    const words = 'Today we talk about lip fillers and how long they last. The next part is about Botox for the forehead.'.split(' ');
    s.project.media[land].transcript = { words: words.map((t, i) => ({ t, s: +(0.25 + i * 0.25).toFixed(2), e: +(0.25 + i * 0.25 + 0.2).toFixed(2) })) };
  }, [land]);
  const hits = await page.evaluate(async () => {
    const { searchFootage } = await import('/src/ai/footage.js');
    const p = window.__store.project;
    return { lip: searchFootage(p, 'lip fill'), botox: searchFootage(p, 'BOTOX'), none: searchFootage(p, 'cheek') };
  });
  check('search finds a phrase by the start of each word', hits.lip.length === 1 && hits.lip[0].match === 'lip fillers' && Math.abs(hits.lip[0].s - 1.25) < 0.01, JSON.stringify(hits.lip[0] || null).slice(0, 200));
  check('search ignores case and finds nothing that is not said', hits.botox.length === 1 && hits.none.length === 0, `${hits.botox.length} ${hits.none.length}`);
  await page.evaluate(() => window.__app.cmd('searchFootage'));
  await page.waitForSelector('.transcript-panel .tr-search', { timeout: 5000 });
  await page.fill('.transcript-panel .tr-search', 'lip fill');
  await page.waitForSelector('.fs-hit', { timeout: 5000 });
  const hitText = await page.textContent('.fs-hit');
  check('the panel lists the hit with the words around it', /lip fillers/.test(hitText) && /landscape/.test(hitText), hitText.slice(0, 120));
  await page.click('.fs-hit >> text=Add at the playhead');
  await sleep(300);
  const addedClip = await page.evaluate(() => Object.values(window.__store.project.items).map((i) => ({ in: i.in, d: i.duration, media: i.mediaId })));
  // the sentence runs from "Today" (0.25 s) to "last." (ends 2.95 s), with a little room each side
  check('Add at the playhead puts the whole sentence on the timeline', addedClip.length === 1 && Math.abs(addedClip[0].in - 0) < 0.01 && Math.abs(addedClip[0].in + addedClip[0].d - 3.3) < 0.05, JSON.stringify(addedClip));
  await page.fill('.transcript-panel .tr-search', 'botox');
  await page.waitForFunction(() => /Botox/.test(document.querySelector('.fs-hit')?.textContent || ''), null, { timeout: 5000 });
  await page.fill('.transcript-panel .tr-search', 'lip');
  await page.waitForFunction(() => /Go to it/.test(document.querySelector('.fs-hit')?.textContent || ''), null, { timeout: 5000 });
  check('a moment already on the timeline offers Go to it', true);
  await page.screenshot({ path: '/tmp/ve-search.png' });

  // the With Claude prompts
  await page.evaluate(() => window.__app.openPanel('ai'));
  await sleep(300);
  const withClaude = await page.evaluate(() => [...document.querySelectorAll('.panel-body h3, .panel-body .section-title, .panel-body summary')].map((e) => e.textContent).join('|'));
  await page.evaluate(() => window.__app.cmd('withClaude', 'video'));
  await page.waitForSelector('.claude-prompt', { timeout: 5000 });
  const prompt = await page.inputValue('.claude-prompt');
  check('Do it with Claude hands over a ready prompt', /Video Editor/.test(prompt) && /build_video/.test(prompt), prompt.slice(0, 120));
  await page.screenshot({ path: '/tmp/ve-with-claude.png' });
  void withClaude;

  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | ').slice(0, 600));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
