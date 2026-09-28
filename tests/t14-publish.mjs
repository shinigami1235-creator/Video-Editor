// Publishing and voice: other shapes, caption translation and dubbing,
// YouTube chapters, my voice and presenter dialogs.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type', '-of', 'json', file]).toString());
}

await startServers();
try {
  const { browser, page, logs } = await openApp();
  const [vert, speech] = (await importAndWait(page, [`${FIX}/vertical.mp4`, `${FIX}/speech.wav`])).map((m) => m.id);

  // ---- other shapes ----------------------------------------------------------------
  const shape = await page.evaluate(async (vert) => {
    const s = window.__store;
    window.__app.addMedia([s.project.media[vert]], 0);
    await window.__app.cmd('addText');
    const txt = Object.values(s.project.items).find((i) => i.type === 'text');
    s.commit('pos', () => {
      txt.props.y = -600;
      txt.text = 'Skin boosters';
    });
    const R = await import('/src/export/resize.js');
    const wide = R.adaptProject(s.project, 1920, 1080, 'blur');
    const sq = R.adaptProject(s.project, 1080, 1080, 'cover');
    const clip = (p) => Object.values(p.items).find((i) => i.type === 'clip');
    const text = (p) => Object.values(p.items).find((i) => i.type === 'text');
    const X = await import('/src/export/export.js');
    await X.exportVideo(wide, { out: '/tmp/ve-test/wide.mp4', width: 320, height: 180, fps: 15, bitrateMbps: 2, t0: 0, t1: 1 });
    await X.exportFrame(wide, 0.5, '/tmp/ve-test/wide.png', { width: 640 });
    await X.exportFrame(sq, 0.5, '/tmp/ve-test/square.png', { width: 480 });
    return {
      own: R.shapeOf(s.project).id,
      wide: { w: wide.settings.width, h: wide.settings.height, backdrop: clip(wide).effects.backdrop, fit: clip(wide).fit, ty: text(wide).props.y, ts: text(wide).props.scale },
      sq: { fit: clip(sq).fit, backdrop: clip(sq).effects.backdrop, ts: text(sq).props.scale },
      orig: { w: s.project.settings.width, backdrop: clip(s.project).effects.backdrop },
    };
  }, vert);
  check('project shape is recognised', shape.own === '9x16', shape.own);
  check('16:9 copy fits the clip with a blurred copy and moves the title', shape.wide.w === 1920 && shape.wide.backdrop === 'blur' && shape.wide.fit === 'contain' && Math.abs(shape.wide.ty - -600 * (1080 / 1920)) < 1 && shape.wide.ts === 1, JSON.stringify(shape.wide));
  check('square copy fills the frame and shrinks the title', shape.sq.fit === 'cover' && !shape.sq.backdrop && Math.abs(shape.sq.ts - 0.75) < 0.01, JSON.stringify(shape.sq));
  check('the original project is untouched', shape.orig.w === 1080 && !shape.orig.backdrop, JSON.stringify(shape.orig));
  const pw = probe('/tmp/ve-test/wide.mp4').streams.find((x) => x.codec_type === 'video');
  check('the 16:9 export has the new size', pw.width === 320 && pw.height === 180, `${pw.width}x${pw.height}`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', '/tmp/ve-test/wide.png', '-i', '/tmp/ve-test/square.png', '-filter_complex', '[0:v]scale=-1:360[a];[1:v]scale=-1:360[b];[a][b]hstack', '/tmp/ve-sheet-shapes.png']);
  // the export dialog offers the other shapes
  await page.evaluate(() => window.__app.cmd('export'));
  await page.waitForSelector('.modal:has-text("Also export in these shapes")');
  const chips = await page.locator('.modal .chip').allTextContents();
  check('export dialog offers the other three shapes', ['4:5 feed', '1:1 square', '16:9 YouTube'].every((c) => chips.includes(c)), chips.join(', '));
  await page.click('.modal .chip:has-text("16:9 YouTube")');
  await page.screenshot({ path: '/tmp/ve-publish-1.png' });
  await page.keyboard.press('Escape');

  // ---- translate and dub -----------------------------------------------------------
  const tr = await page.evaluate(async (speech) => {
    const s = window.__store;
    for (const id of Object.keys(s.project.items)) delete s.project.items[id];
    s.commit('reset', () => {});
    window.__app.addMedia([s.project.media[speech]], 0);
    const c = await import('/src/ai/captions.js');
    s.commit('caps', (p) => c.addCaptionItems(p, c.chunkWords(c.spreadWords('Hello and welcome. Today we look at skin boosters. They help hydration.', 0.3, 4.5), { maxWords: 3 })));
    globalThis.__claudeMock = async (prompt) => {
      const arr = JSON.parse(prompt.slice(prompt.lastIndexOf('[')));
      return JSON.stringify(arr.map((x) => 'TL ' + x));
    };
    return c.allCaptions().length;
  }, speech);
  await page.evaluate(() => window.__app.cmd('translate'));
  await page.waitForSelector('.modal:has-text("Translate captions")');
  await page.click('.modal-foot button:has-text("Translate")');
  await page.waitForFunction(() => Object.values(window.__store.project.items).some((i) => i.translation), null, { timeout: 20000 });
  const tres = await page.evaluate(async () => {
    const s = window.__store;
    const items = Object.values(s.project.items);
    const X = await import('/src/export/export.js');
    return {
      orig: items.filter((i) => i.caption && !i.translation).length,
      trans: items.filter((i) => i.translation).map((i) => i.text),
      srt: X.captionsToSrt(s.project),
      track: s.project.tracks.find((t) => t.translation)?.name,
    };
  });
  check('translation adds a second line of captions', tres.trans.length === tr && tres.trans.every((t) => t.startsWith('TL ')) && tres.orig === tr, JSON.stringify(tres.trans));
  check('translated line has its own track and stays out of the SRT', /Filipino/.test(tres.track) && !tres.srt.includes('TL '), tres.track);
  await page.screenshot({ path: '/tmp/ve-publish-2.png' });
  const dub = await page.evaluate(async () => {
    const { saveSettings } = await import('/src/core/settings.js');
    const be = await import('/src/backend/index.js');
    const { toolsDir, locateTools } = await import('/src/media/tools.js');
    saveSettings({ piperPath: '/tmp/tools/piper/piper' });
    await be.mkdir(toolsDir('piper-voices'));
    await be.copy('/tmp/tools/voice/en-us-lessac-low.onnx', toolsDir('piper-voices', 'en_US-lessac-medium.onnx'));
    await be.copy('/tmp/tools/voice/en-us-lessac-low.onnx.json', toolsDir('piper-voices', 'en_US-lessac-medium.onnx.json'));
    await locateTools();
    const s = window.__store;
    const T = await import('/src/ai/translate.js');
    const caps = Object.values(s.project.items).filter((i) => i.translation).sort((a, b) => a.start - b.start);
    const groups = T.sentenceGroups(caps);
    await T.dub(window.__app, caps, 'en_US-lessac-medium');
    const items = Object.values(s.project.items);
    const dubIds = new Set(s.project.tracks.filter((t) => t.name.startsWith('Dub')).map((t) => t.id));
    const dubs = items.filter((i) => dubIds.has(i.trackId)).sort((a, b) => a.start - b.start);
    const orig = items.find((i) => i.type === 'clip' && !dubIds.has(i.trackId));
    // no two lines on the same dub track overlap
    const overlap = dubs.some((d) => dubs.some((e) => e !== d && e.trackId === d.trackId && e.start < d.start + d.duration - 1e-3 && e.start > d.start));
    return { groups: groups.map((g) => [+g.start.toFixed(2), g.text]), dubs: dubs.map((d) => [+d.start.toFixed(2), +d.duration.toFixed(2), d.speed]), origVol: orig.props.volume, overlap, tracks: dubIds.size };
  });
  check('dubbing reads each sentence at its caption time without overlaps', dub.dubs.length === dub.groups.length && !dub.overlap && dub.dubs.every((d, i) => Math.abs(d[0] - dub.groups[i][0]) < 0.01), JSON.stringify(dub));
  check('the original speech is turned down under the dub', dub.origVol === 0.15, String(dub.origVol));

  // ---- YouTube chapters --------------------------------------------------------------
  await page.evaluate(() => {
    globalThis.__claudeMock = async () => JSON.stringify({ chapters: [{ t: 3, title: 'Welcome' }, { t: 20, title: 'Skin boosters' }, { t: 40, title: 'Aftercare' }], titles: ['Skin boosters explained', 'What to expect'], description: 'How skin boosters work.', hashtags: ['#skinboosters'] });
  });
  await page.evaluate(() => window.__app.cmd('chapters'));
  await page.waitForSelector('.modal:has-text("YouTube chapters")', { timeout: 20000 });
  const desc = await page.locator('.modal .yt-text').inputValue();
  check('chapters start at 0:00 and go into the description', desc.includes('0:00 Welcome') && desc.includes('0:20 Skin boosters') && desc.includes('#skinboosters'), desc.replace(/\n/g, ' | '));
  await page.click('.modal button:has-text("Add the chapters as markers")');
  const mk = await page.evaluate(() => window.__store.project.markers.map((m) => [m.t, m.label]));
  check('chapters become markers', mk.length === 3 && mk[0][0] === 0, JSON.stringify(mk));
  await page.screenshot({ path: '/tmp/ve-publish-3.png' });
  await page.click('.modal-foot button:has-text("Done")');

  // ---- my voice and presenter -----------------------------------------------------------
  await page.evaluate(() => window.__app.cmd('myVoice'));
  await page.waitForSelector('.modal:has-text("My voice")');
  check('my voice dialog opens with a reading script', (await page.locator('.voice-script').textContent()).includes('skin booster'));
  await page.screenshot({ path: '/tmp/ve-publish-4.png' });
  await page.keyboard.press('Escape');
  const mine = await page.evaluate(async () => {
    const V = await import('/src/ai/voice-clone.js');
    try {
      await V.speakMine('hello');
      return 'no error';
    } catch (e) {
      return e.message;
    }
  });
  check('my voice asks for a sample first', /sample/.test(mine), mine);
  await page.evaluate(() => {
    window.__store.clearSelection();
    window.__app.cmd('avatar');
  });
  await page.waitForSelector('.modal:has-text("Talking presenter")');
  const av = await page.locator('.modal:has-text("Talking presenter")').textContent();
  check('presenter dialog explains what it needs', av.includes('Select a voice clip'), av.slice(0, 200));
  await page.keyboard.press('Escape');

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
