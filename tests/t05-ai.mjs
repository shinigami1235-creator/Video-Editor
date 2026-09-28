import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import fs from 'node:fs';

const only = process.argv[2] || '';
const run = (name) => !only || only.split(',').includes(name);

await startServers();
try {
  const { browser, page, logs } = await openApp();
  // helper programs for the test machine
  await page.evaluate(async () => {
    const { saveSettings } = await import('/src/core/settings.js');
    const be = await import('/src/backend/index.js');
    const { toolsDir, locateTools } = await import('/src/media/tools.js');
    saveSettings({ piperPath: '/tmp/tools/piper/piper', whisperPath: '/tmp/tools/whisper.cpp/build/bin/whisper-cli', whisperModel: 'small' });
    await be.mkdir(toolsDir('piper-voices'));
    await be.copy('/tmp/tools/voice/en-us-lessac-low.onnx', toolsDir('piper-voices', 'en_US-lessac-medium.onnx'));
    await be.copy('/tmp/tools/voice/en-us-lessac-low.onnx.json', toolsDir('piper-voices', 'en_US-lessac-medium.onnx.json'));
    await be.mkdir(toolsDir('whisper', 'models'));
    if (await be.exists('/tmp/tools/whisper.cpp/models/for-tests-ggml-tiny.bin')) await be.copy('/tmp/tools/whisper.cpp/models/for-tests-ggml-tiny.bin', toolsDir('whisper', 'models', 'ggml-small-q5_1.bin'));
    await locateTools();
  });
  const media = await importAndWait(page, [`${FIX}/talk.mp4`, `${FIX}/music.wav`, `${FIX}/faces.mp4`, `${FIX}/vertical.mp4`, `${FIX}/photo.png`]);
  check('imported', media.every((m) => m.status === 'ready'), JSON.stringify(media.map((m) => m.error)));
  const [talk, music, faces, vertical, photo] = media.map((m) => m.id);

  const waitJobs = async (ms = 240000) => {
    await page.waitForFunction(() => !document.querySelector('.job'), null, { timeout: ms });
  };
  const clickModal = async (label) => {
    await page.waitForSelector('.modal', { timeout: 10000 });
    await page.click(`.modal-foot .btn:has-text("${label}"), .modal-body .btn:has-text("${label}")`);
  };

  if (run('tts')) {
    const r = await page.evaluate(async () => {
      const { ttsToTimeline } = await import('/src/ai/tts.js');
      window.__app.seek(0);
      const m = await ttsToTimeline(window.__app, 'Hello from the clinic.\nSecond paragraph here.', { voice: 'en_US-lessac-medium', speed: 1 });
      const s = window.__store;
      return { n: m.length, items: Object.values(s.project.items).filter((i) => i.name && m.some((x) => x.id === i.mediaId)).length, durs: m.map((x) => x.duration) };
    });
    check('text to speech makes two clips', r.n === 2 && r.items === 2, JSON.stringify(r));
  }

  if (run('beats')) {
    const r = await page.evaluate(async (id) => {
      const { detectBeats } = await import('/src/ai/speech-edit.js');
      const m = window.__store.project.media[id];
      return detectBeats(m, 0, m.duration);
    }, music);
    check('beat detection finds about 120 bpm', Math.abs(r.bpm - 120) < 3 || Math.abs(r.bpm - 60) < 2, `bpm ${r.bpm.toFixed(1)}, ${r.beats.length} beats`);
  }

  if (run('silence')) {
    const r = await page.evaluate(async (id) => {
      const s = window.__store;
      s.loadProject((await import('/src/core/model.js')).newProject({ width: 1280, height: 720 }));
      return true;
    }, talk).catch(() => false);
    void r;
    // keep media from the first project: re-import into this project
    const m2 = await importAndWait(page, [`${FIX}/talk.mp4`]);
    const res = await page.evaluate(async (id) => {
      const app = window.__app;
      const s = window.__store;
      app.addMedia([s.project.media[id]], 0);
      const it = Object.values(s.project.items)[0];
      const { findSilences } = await import('/src/ai/speech-edit.js');
      const f = await findSilences(it, { minSilence: 0.8, pad: 0.1 });
      return { silent: f.silent, dur: it.duration, id: it.id };
    }, m2[0].id);
    check('finds the two long pauses', res.silent.length >= 2, JSON.stringify(res.silent.map((r) => r.map((x) => x.toFixed(2)))));
    const p = page.evaluate((id) => window.__app.cmd('silenceCut', window.__store.project.items[id]), res.id);
    await clickModal('Cut silences');
    await p;
    const after = await page.evaluate(() => Object.values(window.__store.project.items).filter((i) => i.type === 'clip').map((i) => [+i.start.toFixed(2), +i.duration.toFixed(2), +i.in.toFixed(2)]));
    const total = after.reduce((a, x) => a + x[1], 0);
    check('silence cut shortens the clip', after.length >= 3 && total < res.dur - 2.5, JSON.stringify(after));
    check('pieces are back to back', after.every((x, i) => i === 0 || Math.abs(x[0] - (after[i - 1][0] + after[i - 1][1])) < 0.02));
  }

  if (run('captions')) {
    const hasWhisper = fs.existsSync('/tmp/tools/whisper.cpp/build/bin/whisper-cli');
    if (!hasWhisper) console.log('SKIP  whisper-cli not built yet');
    else {
      const r = await page.evaluate(async () => {
        const s = window.__store;
        const clip = Object.values(s.project.items).find((i) => i.type === 'clip' && s.project.media[i.mediaId]?.hasAudio);
        const { transcribeClip } = await import('/src/ai/captions.js');
        try {
          const words = await transcribeClip(clip, { language: 'en', model: 'small', job: { update() {}, download() {}, signal: null } });
          return { ok: true, n: words.length, sample: words.slice(0, 3) };
        } catch (e) {
          return { ok: false, err: String(e.message || e) };
        }
      });
      check('whisper runs and its JSON parses', r.ok, JSON.stringify(r).slice(0, 300));
    }
    const r2 = await page.evaluate(async () => {
      const c = await import('/src/ai/captions.js');
      const s = window.__store;
      const words = c.spreadWords('This is a caption test with several words in it. And a second sentence here.', 1, 7);
      s.commit('caps', (p) => c.addCaptionItems(p, c.chunkWords(words, { maxWords: 4 })));
      const caps = c.allCaptions();
      const srt = (await import('/src/export/export.js')).captionsToSrt(s.project);
      const parsed = c.parseSrt(srt);
      c.applyCaptionPreset('pill');
      c.setCaptionY(0.5, true);
      c.rechunkCaptions(2);
      return { n: caps.length, parsed: parsed.length, after: c.allCaptions().length, y: c.allCaptions()[0].props.y, style: c.allCaptions()[0].style.highlightMode };
    });
    check('captions from words, SRT round trip', r2.n >= 3 && r2.parsed === r2.n, JSON.stringify(r2));
    check('caption preset, height and rechunk', r2.after > r2.n && Math.abs(r2.y) < 1 && r2.style === 'box', JSON.stringify(r2));
  }

  if (run('faces')) {
    const m3 = await importAndWait(page, [`${FIX}/faces.mp4`]);
    const r = await page.evaluate(async (id) => {
      const s = window.__store;
      const app = window.__app;
      s.loadProject((await import('/src/core/model.js')).newProject({ width: 1080, height: 1920 }));
      return id;
    }, m3[0].id);
    void r;
    const m4 = await importAndWait(page, [`${FIX}/faces.mp4`]);
    const res = await page.evaluate(async (id) => {
      const s = window.__store;
      const app = window.__app;
      app.addMedia([s.project.media[id]], 0);
      const it = Object.values(s.project.items)[0];
      const { framesAt } = await import('/src/ai/frames.js');
      const { detectFaces } = await import('/src/ai/faces.js');
      let found = 0;
      for await (const f of framesAt(s.project.media[id], [1], { width: 640 })) found = (await detectFaces(f.canvas)).length;
      await (await import('/src/ai/faces.js')).faceBlur(it);
      const blurs = Object.values(s.project.items).filter((i) => i.type === 'blur');
      await (await import('/src/ai/faces.js')).autoReframe(it);
      return { found, blurs: blurs.length, kf: blurs[0]?.kf?.x?.length || 0, reframeKf: it.kf?.x?.length || 0, fit: it.fit };
    }, m4[0].id);
    check('face detector finds faces', res.found >= 3, JSON.stringify(res));
    check('face blur adds tracked regions', res.blurs >= 3 && res.kf >= 3, JSON.stringify(res));
    check('auto reframe adds a moving frame', res.fit === 'cover' && res.reframeKf >= 2, JSON.stringify(res));

    // track a region
    const tr = await page.evaluate(async () => {
      const s = window.__store;
      const blur = Object.values(s.project.items).find((i) => i.type === 'blur');
      const clip = Object.values(s.project.items).find((i) => i.type === 'clip');
      delete clip.kf.x;
      delete clip.kf.y;
      clip.props.x = 0;
      delete blur.kf.x;
      delete blur.kf.y;
      blur.props.x = 100;
      blur.props.y = -50;
      window.__app.seek(blur.start + 0.05);
      await (await import('/src/ai/tracker.js')).trackRegion(blur);
      const xs = blur.kf.x?.map((k) => k.v) || [];
      return { n: xs.length, first: xs[0], last: xs[xs.length - 1] };
    });
    check('tracker follows the panning image', tr.n > 10 && tr.last < tr.first - 50, JSON.stringify(tr));
  }

  if (run('bg')) {
    const m5 = await importAndWait(page, [`${FIX}/vertical.mp4`, `${FIX}/photo.png`]);
    const res = await page.evaluate(async ([vid, pid]) => {
      const s = window.__store;
      const app = window.__app;
      window.__ortProviders = ['wasm'];
      app.addMedia([s.project.media[vid], s.project.media[pid]], 0);
      const clips = Object.values(s.project.items).filter((i) => i.mediaId === vid || i.mediaId === pid);
      const E = await import('/src/core/edit.js');
      // a short range keeps the test quick on this machine
      s.commit('trim', (p) => E.trimTailTo(p, clips.find((c) => c.mediaId === vid), 0.5));
      window.__clipsBg = clips.map((c) => c.id);
      return clips.map((c) => c.id);
    }, m5.map((m) => m.id));
    for (const id of res) {
      const p = page.evaluate((cid) => window.__app.cmd('removeBackground', window.__store.project.items[cid]), id);
      await page.waitForSelector('.modal', { timeout: 10000 });
      await page.click('.modal-body .btn:has-text("Fast preview quality")');
      await p;
      await waitJobs(600000);
    }
    const out = await page.evaluate((ids) => {
      const s = window.__store;
      return ids.map((id) => {
        const it = s.project.items[id];
        const m = s.project.media[it.mediaId];
        return { derived: it.derivations, packed: m.alphaPacked, kind: m.kind, status: m.status, w: m.width, h: m.height, dur: m.duration };
      });
    }, res);
    check('background removed from a video (packed alpha)', out[0].derived?.includes('bg') && out[0].packed && out[0].status === 'ready', JSON.stringify(out[0]));
    check('background removed from a photo', out[1].derived?.includes('bg') && out[1].kind === 'image', JSON.stringify(out[1]));
    // revert
    const rv = await page.evaluate(async (id) => {
      await window.__app.cmd('removeBackground', window.__store.project.items[id]);
      return window.__store.project.items[id].derivations;
    }, res[1]);
    check('removing again puts the background back', rv.length === 0, JSON.stringify(rv));
  }

  if (run('process')) {
    const m6 = await importAndWait(page, [`${FIX}/talk.mp4`]);
    const res = await page.evaluate(async (id) => {
      const s = window.__store;
      const app = window.__app;
      s.loadProject((await import('/src/core/model.js')).newProject({ width: 1280, height: 720 }));
      return true;
    }, m6[0].id);
    void res;
    const m7 = await importAndWait(page, [`${FIX}/talk.mp4`]);
    const out = await page.evaluate(async (id) => {
      const s = window.__store;
      const app = window.__app;
      app.addMedia([s.project.media[id]], 0);
      const it = Object.values(s.project.items)[0];
      const E = await import('/src/core/edit.js');
      // shorten to 1.5 s so the heavy filters finish quickly
      s.commit('trim', (p) => E.trimTailTo(p, it, 1.5));
      const P = await import('/src/ai/processing.js');
      const res = {};
      await P.reverseClip(it);
      res.reverse = [...it.derivations];
      P.revertMedia(it);
      await P.denoiseClip(it);
      res.denoise = [...it.derivations];
      P.revertMedia(it);
      await P.stabilizeClip(it);
      res.stab = [...it.derivations];
      P.revertMedia(it);
      s.commit('slow', (p) => E.setSpeed(p, it, 0.5));
      await P.smoothSlowmo(it);
      res.smooth = [...it.derivations];
      res.smoothFps = s.project.media[it.mediaId].fps;
      return res;
    }, m7[0].id);
    check('reverse makes a new clip', out.reverse.includes('reverse'), JSON.stringify(out));
    check('noise removal makes a new clip', out.denoise.includes('denoise'));
    check('stabilise makes a new clip', out.stab.includes('stab'));
    check('smooth slow motion doubles the frame rate', out.smooth.includes('smooth') && out.smoothFps >= 55, JSON.stringify(out));
  }

  if (run('sfx')) {
    const r = await page.evaluate(async () => {
      const { SFX, addSfx } = await import('/src/ai/sfx.js');
      for (const k of Object.keys(SFX)) await addSfx(window.__app, k, 0);
      const s = window.__store;
      return Object.values(s.project.items).filter((i) => Object.values(SFX).some((d) => d.name === i.name)).length;
    });
    check('every sound effect is made and added', r === 10, String(r));
  }

  if (run('script')) {
    const m8 = await importAndWait(page, [`${FIX}/photo.png`, `${FIX}/vertical.mp4`]);
    const before = await page.evaluate(() => Object.keys(window.__store.project.items).length);
    await page.evaluate(() => window.__app.cmd('scriptToVideo'));
    await page.waitForSelector('.modal textarea');
    await page.fill('.modal textarea', 'Scene one is about the product.\n\nScene two shows the result.');
    await clickModal('Make the video');
    await sleep(500);
    await waitJobs(240000);
    const after = await page.evaluate(() => {
      const s = window.__store;
      const items = Object.values(s.project.items);
      return { n: items.length, caps: items.filter((i) => i.caption).length, voice: items.filter((i) => /Scene \d voice/.test(i.name)).length };
    });
    check('script to video lays voice, visuals and captions', after.voice === 2 && after.caps >= 2 && after.n > before + 4, JSON.stringify({ before, ...after }));
  }

  await page.screenshot({ path: '/tmp/ve-shot-05.png' });
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
