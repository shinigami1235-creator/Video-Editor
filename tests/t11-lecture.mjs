// Lecture tools: edit by text, teleprompter, screen recording, shorts.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import fs from 'node:fs';

const SCRIPT = 'Hello and welcome to this lecture. Um today we look at skin boosters. They improve hydration and texture. Uh the first product is injected in small amounts. We space the points one centimetre apart. That is all for today.';

await startServers();
try {
  const { browser, page, logs } = await openApp();
  const [talk, lecture] = (await importAndWait(page, [`${FIX}/talk.mp4`, `${FIX}/lecture90.mp4`])).map((m) => m.id);

  // ---- edit by text ------------------------------------------------------------
  await page.evaluate(
    async ([talk, text]) => {
      const s = window.__store;
      const m = s.project.media[talk];
      const words = text.split(' ');
      const step = 12 / words.length;
      m.transcript = { words: words.map((t, i) => ({ t, s: +(i * step).toFixed(3), e: +(i * step + step * 0.8).toFixed(3) })) };
      window.__app.addMedia([m], 0);
      window.__app.openPanel('transcript');
    },
    [talk, SCRIPT],
  );
  await page.waitForSelector('.tr-doc .tw', { timeout: 10000 });
  const nWords = await page.locator('.tr-doc .tw').count();
  check('transcript shows every word', nWords === SCRIPT.split(' ').length, String(nWords));
  const fillers = await page.locator('.tr-doc .tw.filler').count();
  check('filler words are marked', fillers === 2, String(fillers));
  await page.screenshot({ path: '/tmp/ve-lecture-1.png' });
  // select "They improve hydration and texture." and press Delete
  const before = await page.evaluate(() => Object.values(window.__store.project.items)[0].duration);
  await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.tr-doc .tw')];
    const a = spans.findIndex((s) => s.textContent.trim() === 'They');
    const b = spans.findIndex((s) => s.textContent.trim() === 'texture.');
    const r = document.createRange();
    r.setStart(spans[a].firstChild, 0);
    r.setEnd(spans[b].firstChild, spans[b].textContent.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.querySelector('.tr-doc').focus();
  });
  await page.keyboard.press('Delete');
  await sleep(400);
  const after = await page.evaluate(() => {
    const items = Object.values(window.__store.project.items).filter((i) => i.type === 'clip');
    return { n: items.length, dur: items.reduce((a, i) => a + i.duration, 0) };
  });
  const wordLen = 12 / SCRIPT.split(' ').length;
  check('deleting words cuts the video', after.n === 2 && Math.abs(before - after.dur - 5 * wordLen) < wordLen, `${before.toFixed(2)} -> ${after.dur.toFixed(2)} in ${after.n} pieces`);
  const left = await page.locator('.tr-doc .tw').allTextContents();
  check('cut words leave the transcript', !left.join('').includes('hydration') && left.join('').includes('boosters.'), String(left.length));
  const kept = await page.evaluate(() => Object.keys(window.__store.project.items).length);
  void kept;
  await page.click('button:has-text("Cut filler words")');
  await sleep(300);
  const noFill = await page.locator('.tr-doc .tw.filler').count();
  check('cut filler words removes them all', noFill === 0, String(noFill));
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await sleep(300);
  const back = await page.locator('.tr-doc .tw').count();
  check('undo brings the words back', back === nWords, String(back));
  // clicking a word seeks there
  await page.locator('.tr-doc .tw').nth(10).click();
  const ph = await page.evaluate(() => window.__store.playhead);
  check('clicking a word moves the playhead', Math.abs(ph - 10 * wordLen) < 0.1, ph.toFixed(2));

  // ---- teleprompter ----------------------------------------------------------------
  await page.evaluate(async (text) => {
    const { saveSettings } = await import('/src/core/settings.js');
    saveSettings({ prompterScript: text + '\n\n' + text + '\n\n' + text, prompterWpm: 240 });
    await window.__app.cmd('teleprompter');
  }, SCRIPT);
  await page.waitForSelector('.prompter');
  await page.click('.prompter-bar button:has-text("Start")');
  await sleep(1500);
  const scrolled = await page.evaluate(() => document.querySelector('.prompter-scroll').scrollTop);
  check('teleprompter scrolls while running', scrolled > 20, String(scrolled));
  await page.screenshot({ path: '/tmp/ve-lecture-2.png' });
  await page.keyboard.press('Escape');
  check('teleprompter closes', (await page.locator('.prompter').count()) === 0);

  // ---- screen recording (a canvas stands in for the screen) -----------------------
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      const g = c.getContext('2d');
      let f = 0;
      setInterval(() => {
        g.fillStyle = `hsl(${(f += 7) % 360},70%,50%)`;
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff';
        g.font = '80px sans-serif';
        g.fillText('Screen ' + f, 100, 360);
      }, 33);
      return c.captureStream(30);
    };
    window.__store.seek(0);
  });
  await page.evaluate(() => window.__app.cmd('recordScreen'));
  await page.waitForSelector('.modal:has-text("Record the screen")');
  await page.uncheck('.modal label:has-text("Count down") input');
  await page.click('.modal-foot button:has-text("Start")');
  await page.waitForSelector('.rec-bar', { timeout: 10000 });
  await sleep(2500);
  await page.click('.rec-bar button:has-text("Stop")');
  await page.waitForFunction(() => Object.values(window.__store.project.items).some((i) => i.name === 'Screen recording'), null, { timeout: 90000 });
  await sleep(500);
  const rec = await page.evaluate(() => {
    const items = Object.values(window.__store.project.items);
    const scr = items.find((i) => i.name === 'Screen recording');
    const cam = items.find((i) => i.name === 'Webcam');
    return { scr: scr?.duration, cam: !!cam, camScale: cam?.props.scale, camTrackMain: cam ? cam.trackId === scr.trackId : null };
  });
  check('screen recording lands on the timeline', rec.scr > 1.5, JSON.stringify(rec));
  check('webcam lands as picture in picture', rec.cam && rec.camScale < 0.5 && rec.camTrackMain === false, JSON.stringify(rec));
  await page.screenshot({ path: '/tmp/ve-lecture-3.png' });

  // ---- shorts (Claude answer is simulated) -----------------------------------------
  const shorts = await page.evaluate(async (lecture) => {
    const s = window.__store;
    const m = s.project.media[lecture];
    const words = [];
    for (let t = 0; t < 88; t += 0.5) words.push({ t: (Math.floor(t) % 6 === 5 && t % 1 === 0.5 ? 'end.' : 'word'), s: t, e: t + 0.4 });
    m.transcript = { words };
    window.__claudePrompt = null;
    globalThis.__claudeMock = async (prompt) => {
      window.__claudePrompt = prompt;
      return 'Here you go: [{"start": 6.1, "end": 29.8, "title": "Why hydration matters", "why": "Clear hook"}, {"start": 40, "end": 70.2, "title": "Spacing the points", "why": "Practical"}, {"start": 20, "end": 35, "title": "Overlap", "why": "x"}]';
    };
    for (const id of Object.keys(s.project.items)) delete s.project.items[id];
    s.commit('reset', () => {});
    window.__app.addMedia([m], 0);
    const clip = Object.values(s.project.items)[0];
    s.select(clip.id);
    const sh = await import('/src/ai/shorts.js');
    const found = await sh.findMoments(clip, { count: 5, length: 'mid' });
    const p = sh.buildShortProject(s.project, clip, found[0], { framing: 'blur', captions: true, title: true });
    const items = Object.values(p.items);
    return {
      found: found.map((f) => [f.start, f.end, f.title]),
      promptHasTimes: /\[\d+\.\d-\d+\.\d\]/.test(window.__claudePrompt),
      size: [p.settings.width, p.settings.height],
      clip: items.filter((i) => i.type === 'clip').map((i) => [i.in, i.duration, i.effects.backdrop]),
      captions: items.filter((i) => i.caption).length,
      title: items.find((i) => i.name === 'Title')?.text,
    };
  }, lecture);
  check('Claude gets the transcript with times', shorts.promptHasTimes);
  check('moments snap to sentences and overlaps are dropped', shorts.found.length === 2 && shorts.found[0][2] === 'Why hydration matters', JSON.stringify(shorts.found));
  check('a short is a 9:16 project with the moment, captions and title', shorts.size.join('x') === '1080x1920' && shorts.clip.length === 1 && shorts.captions > 5 && shorts.title === 'Why hydration matters', JSON.stringify(shorts));
  // through the dialog, saving projects without exporting
  await page.evaluate(() => window.__app.cmd('shorts'));
  await page.waitForSelector('.modal:has-text("Make shorts")');
  await page.uncheck('.modal label:has-text("Export each one") input');
  await page.click('.modal button:has-text("Find moments")');
  await page.waitForSelector('.short-row', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/ve-lecture-4.png' });
  await page.click('.modal-foot button:has-text("Make the shorts")');
  await page.waitForFunction(() => document.body.textContent.includes('Made 2 shorts'), null, { timeout: 30000 });
  const dir = '/tmp/ve-test/documents/Video Editor Shorts';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  check('shorts are saved as projects', files.filter((f) => f.endsWith('.vproj')).length === 2, files.join(', '));

  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | ').slice(0, 800));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
