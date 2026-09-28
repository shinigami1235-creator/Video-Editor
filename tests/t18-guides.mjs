// How-to guides: every guide starts, lights up something real at each step,
// and a walker that only presses what the guide lights up reaches the end.
// Import dialogs are pre-answered, so the walker never needs a file picker.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import fs from 'node:fs';

const only = process.argv[2];
// guides that record from a microphone or run long AI models only get their first steps checked
const SHALLOW = new Set(['voiceover', 'removebg', 'faces']);

await startServers();
try {
  const { browser, page, logs } = await openApp({ width: 1536, height: 864 });
  page.setDefaultTimeout(5000);
  await page.evaluate(async () => {
    window.prompt = () => null;
    const { saveSettings } = await import('/src/core/settings.js');
    const be = await import('/src/backend/index.js');
    const { toolsDir, locateTools } = await import('/src/media/tools.js');
    saveSettings({ piperPath: '/tmp/tools/piper/piper', whisperPath: '/tmp/tools/whisper.cpp/build/bin/whisper-cli', whisperModel: 'small' });
    await be.mkdir(toolsDir('whisper', 'models'));
    if (await be.exists('/tmp/tools/whisper.cpp/models/for-tests-ggml-tiny.bin')) await be.copy('/tmp/tools/whisper.cpp/models/for-tests-ggml-tiny.bin', toolsDir('whisper', 'models', 'ggml-small-q5_1.bin'));
    await locateTools();
  });

  // ---- the list ---------------------------------------------------------------
  await page.keyboard.press('F1');
  await page.waitForSelector('.guide-item');
  const listed = await page.evaluate(() => [...document.querySelectorAll('.guide-item')].map((b) => b.textContent));
  check('F1 opens the guide list', listed.length >= 20, `${listed.length} guides`);
  await page.fill('.guide-search', 'sound');
  const found = await page.evaluate(() => [...document.querySelectorAll('.guide-item')].map((b) => b.textContent));
  check('search narrows the list', found.length > 0 && found.length < listed.length && found.some((t) => /Separate the sound/.test(t)), found.join(' | '));
  await page.keyboard.press('Escape');
  await page.click('.menu-btn:has-text("Help")');
  const help = await page.evaluate(() => [...document.querySelectorAll('.ctx-item span')].map((s) => s.textContent));
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('.ctx')?.remove());
  check('Help menu lists the guides', help[0] === 'How do I...' && help.includes('Separate the sound from a video'), help.join(', '));

  // ---- a project with media in the library and nothing on the timeline -------------
  const media = await importAndWait(page, [`${FIX}/talk.mp4`, `${FIX}/landscape.mp4`, `${FIX}/photo.png`, `${FIX}/music.wav`]);
  check('fixtures ready', media.every((m) => m.status === 'ready'), JSON.stringify(media.map((m) => m.status)));
  await page.evaluate(() => (window.__snapGuide = JSON.stringify(window.__store.project)));

  const restore = async (audio = false) => {
    await page.evaluate((audio) => {
      document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
      document.querySelector('.ctx')?.remove();
      window.__guide?.stop?.();
      const p = JSON.parse(window.__snapGuide);
      if (audio) p.settings.audioOnly = true;
      window.__store.loadProject(p, null);
      window.__store.clearSelection();
      window.__store.seek(0);
      window.__app.openPanel('media');
      window.__testDialogs = [];
    }, audio);
    await sleep(250);
  };

  /** What the guide shows now. */
  const state = () =>
    page.evaluate(() => {
      const g = window.__guide;
      if (!g || !document.querySelector('.guide')) return { gone: true };
      if (g.finished) return { finished: true, text: document.querySelector('.guide-text')?.textContent };
      const s = g.steps[g.index];
      const t = s?._target;
      const r = t?.getBoundingClientRect();
      const spot = document.querySelector('.guide-spot');
      const card = document.querySelector('.guide-card').getBoundingClientRect();
      return {
        index: g.index,
        text: s?.text,
        next: !!s?.next,
        rect: r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, l: r.left } : null,
        cls: t ? String(t.className?.baseVal ?? t.className) : '',
        tag: t?.tagName,
        spot: spot && getComputedStyle(spot).display !== 'none',
        cardOnScreen: card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
      };
    });

  const doStep = async (s, gid) => {
    const txt = s.text || '';
    if (s.next) return page.click('.guide-card .guide-btns button:last-child');
    if (/^Wait for/.test(txt)) return sleep(1500);
    if (!s.rect) return sleep(400);
    if (/m-card/.test(s.cls)) {
      // the + on a media card adds it at the playhead, same as dragging it in
      const id = await page.evaluate(() => window.__guide.steps[window.__guide.index]._target.dataset.id);
      const ok = await page.evaluate((id) => {
        const b = document.querySelector(`.m-card[data-id="${id}"] .m-add`);
        b?.click();
        return !!b;
      }, id);
      if (!ok) return sleep(300);
      // a second clip for the transition guide lands after the first
      if (/second clip/.test(txt)) await page.evaluate(() => window.__store.seek(0));
      // exports run on a 2-second clip to keep the test short
      if (/export|shapes/i.test(gid)) await page.evaluate(() => window.__store.commit('Short', (p) => Object.values(p.items).forEach((i) => (i.duration = Math.min(i.duration, 2)))));
      return;
    }
    if (/tl-ruler/.test(s.cls)) {
      const x = await page.evaluate(() => {
        const it = window.__store.primary;
        const el = document.querySelector(`.tl-clip[data-id="${it.id}"]`).getBoundingClientRect();
        const ru = document.querySelector('.tl-ruler').getBoundingClientRect();
        return (Math.max(el.left, ru.left) + Math.min(el.right, ru.right)) / 2;
      });
      if (process.env.GUIDE_LOG) console.log('    hit', x, await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e?.tagName + '.' + (e?.className?.baseVal ?? e?.className); }, [x, s.rect.y]));
      return page.mouse.click(x, s.rect.y);
    }
    if (/tl-handle/.test(s.cls)) {
      await page.mouse.move(s.rect.x, s.rect.y);
      await page.mouse.down();
      await page.mouse.move(s.rect.x + (/left/.test(s.cls) ? 40 : -40), s.rect.y, { steps: 6 });
      return page.mouse.up();
    }
    if (/tl-vol-hit/.test(s.cls)) {
      if (process.env.GUIDE_LOG) console.log('    hit', await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e?.tagName + '.' + (e?.className?.baseVal ?? e?.className); }, [s.rect.l + 60, s.rect.y]));
      const vx = await page.evaluate((l) => Math.max(l, document.querySelector('.tl-ruler').getBoundingClientRect().left) + 60, s.rect.l);
      await page.mouse.move(vx, s.rect.y);
      await page.mouse.down();
      await page.mouse.move(vx, s.rect.y + 12, { steps: 6 });
      return page.mouse.up();
    }
    if (/press Delete/.test(txt) && /tr-doc/.test(s.cls)) {
      await page.evaluate(() => {
        const doc = document.querySelector('.tr-doc');
        const w = doc.querySelectorAll('.tw');
        const r = document.createRange();
        r.setStartBefore(w[0]);
        r.setEndAfter(w[Math.min(1, w.length - 1)]);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        doc.focus();
      });
      return page.keyboard.press('Delete');
    }
    if (/press Delete/.test(txt)) {
      await page.evaluate(() => document.activeElement?.blur?.());
      return page.keyboard.press('Delete');
    }
    if (/Export and choose where|click Export and choose/i.test(txt)) await page.evaluate(() => window.__testDialogs.push('/tmp/ve-guide-export.' + (window.__store.project.settings.audioOnly ? 'mp3' : 'mp4')));
    if (/Stitch videos, then pick|Join audio files, then pick/.test(txt)) await page.evaluate((f) => window.__testDialogs.push([f + '/talk.mp4', f + '/landscape.mp4']), FIX);
    if (/save icon/.test(txt)) await page.evaluate(() => window.__testDialogs.push('/tmp/ve-guide-save.vproj'));
    return page.mouse.click(s.rect.x, s.rect.y);
  };

  const guides = await page.evaluate(async () => (await import('/src/ui/guide.js')).GUIDES.map((g) => ({ id: g.id, title: g.title, audio: !!g.audio })));
  for (const g of guides) {
    if (only && g.id !== only) continue;
    await restore(g.audio);
    // the test machine's speech model hears no words, so the transcript guide gets timed words put in by hand
    if (g.id === 'transcript')
      await page.evaluate(() => {
        const m = Object.values(window.__store.project.media).find((x) => x.name === 'talk.mp4');
        m.transcript = { words: 'Welcome to the clinic um today we look at skin boosters'.split(' ').map((t, i) => ({ t, s: 0.3 + i * 0.4, e: 0.6 + i * 0.4 })) };
      });
    await page.evaluate((id) => window.__app.cmd('guide', id), g.id);
    await sleep(300);
    const seenSteps = [];
    const problems = [];
    let st = await state();
    const limit = SHALLOW.has(g.id) ? 3 : 40;
    let n = 0;
    let stuck = 0;
    let lastKey = '';
    let dark = 0;
    while (!st.finished && !st.gone && n < limit) {
      if (SHALLOW.has(g.id) && /^Wait for/.test(st.text || '')) break;
      if (process.env.GUIDE_LOG) console.log('   ', g.id, st.index, (st.text || '').slice(0, 60), st.rect ? 'lit ' + st.cls.slice(0, 30) + ' ' + JSON.stringify(st.rect) : 'dark', JSON.stringify(await page.evaluate(() => [window.__store.playhead, window.__store.primary?.start, window.__store.primary?.duration, document.querySelector('.tl-scroll, .tl-wrap .scroll')?.scrollLeft])));
      dark = !st.rect && !/^Wait for/.test(st.text || '') && !st.next ? dark + 1 : 0;
      if (dark >= 3) problems.push(`step "${(st.text || '').slice(0, 50)}" lights up nothing`);
      if (!st.cardOnScreen) problems.push(`card off screen at "${(st.text || '').slice(0, 40)}"`);
      if (!seenSteps.includes(st.text)) seenSteps.push(st.text);
      await doStep(st, g.id).catch((e) => problems.push('action failed: ' + e.message.slice(0, 80)));
      await sleep(/^Wait for/.test(st.text || '') ? 300 : 500);
      st = await state();
      const key = `${st.index}|${st.text}`;
      stuck = key === lastKey ? stuck + 1 : 0;
      lastKey = key;
      // long jobs (captions, noise removal) get time; anything else stuck 6 times is a failure
      if (stuck > (/^Wait for/.test(st.text || '') ? 80 : 6)) {
        problems.push(`stuck at "${(st.text || '').slice(0, 60)}"`);
        break;
      }
      if (!/^Wait for/.test(st.text || '')) n++;
    }
    const uniq = [...new Set(problems)];
    if (SHALLOW.has(g.id)) check(`guide "${g.title}" starts and lights up its first steps`, uniq.length === 0 && seenSteps.length >= 1, uniq.join('; ') || seenSteps.join(' > ').slice(0, 200));
    else check(`guide "${g.title}" can be followed to the end`, st.finished && uniq.length === 0, uniq.join('; ') || (st.finished ? `${seenSteps.length} steps` : `ended at "${st.text}"`));
    await page.evaluate(() => window.__guide?.stop?.());
    if (g.id === 'separate') await page.screenshot({ path: '/tmp/ve-guide-separate.png' });
  }

  // one screenshot mid-guide for a visual check
  await restore();
  await page.evaluate(() => window.__app.cmd('guide', 'separate'));
  await sleep(300);
  await page.evaluate(() => document.querySelector('.m-card[data-kind="video"] .m-add').click());
  await sleep(600);
  await page.screenshot({ path: '/tmp/ve-guide-mid.png' });
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => !document.querySelector('.guide'));
  check('Escape closes a guide', closed);

  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource|AbortError|Cancelled/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | ').slice(0, 800));
  fs.rmSync('/tmp/ve-guide-export.mp4', { force: true });
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
