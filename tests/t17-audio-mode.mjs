// Audio projects: the start screen choice, the sound-wave preview and meters,
// the audio-only rail and menus, videos bringing only their sound, the
// magnetic first audio track, left / right pan in the export, joining files,
// the transcript export, the voice leveller and switching project type.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

function channelVolume(file, ch, a, b) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(a), '-t', String(b - a), '-i', file, '-af', `pan=mono|c0=c${ch},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = String(r.stderr).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

await startServers();
try {
  const { browser, page, logs } = await openApp();

  // ---- start screen: pick Audio -------------------------------------------------
  await page.evaluate(() => window.__app.cmd('newProject'));
  await page.waitForSelector('.welcome-modal');
  await page.locator('.welcome-modal .seg-btn', { hasText: 'Audio' }).click();
  const welcome = await page.evaluate(() => ({
    grid: getComputedStyle(document.querySelector('.welcome-modal .preset-cards').closest('.stack')).display,
    quick: [...document.querySelectorAll('.welcome-quick button')].map((b) => b.textContent),
  }));
  check('start screen hides picture options for audio', welcome.grid === 'none' && welcome.quick.includes('Edit an audio file') && welcome.quick.includes('Join audio files'), JSON.stringify(welcome));
  await page.locator('.welcome-modal button', { hasText: 'Create project' }).click();
  await sleep(300);
  const mode = await page.evaluate(() => ({
    audio: !!window.__store.project.settings.audioOnly,
    body: document.body.classList.contains('audio-mode'),
    rail: [...document.querySelectorAll('.rail-btn')].map((b) => b.dataset.panel),
    frame: getComputedStyle(document.querySelector('.viewer-frame')).display,
    view: getComputedStyle(document.querySelector('.audio-view')).display,
    videoHeads: document.querySelectorAll('.tl-head.kind-video').length,
    audioHeads: document.querySelectorAll('.tl-head.kind-audio').length,
    safe: getComputedStyle(document.querySelector('.viewer .transport-right .video-only')).display,
  }));
  check('new audio project', mode.audio && mode.body, JSON.stringify(mode));
  check('rail keeps only the sound panels', JSON.stringify(mode.rail) === JSON.stringify(['media', 'audio', 'transcript', 'ai']), mode.rail.join(','));
  check('preview shows the sound wave instead of the picture', mode.frame === 'none' && mode.view !== 'none' && mode.safe === 'none', JSON.stringify(mode));
  check('timeline shows audio tracks only', mode.videoHeads === 0 && mode.audioHeads === 2, `${mode.videoHeads} video, ${mode.audioHeads} audio`);
  await page.screenshot({ path: '/tmp/ve-audiomode-1.png' });

  // ---- a video brings only its sound, a photo stays out ---------------------------
  const media = await importAndWait(page, [`${FIX}/tone440.wav`, `${FIX}/talk.mp4`, `${FIX}/photo.png`, `${FIX}/pink.wav`]);
  const [tone, talk, photo, pink] = media.map((m) => m.id);
  const placed = await page.evaluate(([tone, talk, photo]) => {
    const s = window.__store;
    const p = s.project;
    window.__app.addMedia([p.media[tone], p.media[talk], p.media[photo]], 0);
    const items = Object.values(p.items).sort((a, b) => a.start - b.start);
    const first = p.tracks.find((t) => t.kind === 'audio');
    return {
      n: items.length,
      tracks: items.map((i) => p.tracks.find((t) => t.id === i.trackId)?.kind),
      onFirst: items.every((i) => i.trackId === first.id),
      touching: items.length === 2 && Math.abs(items[0].start + items[0].duration - items[1].start) < 0.01 && items[0].start === 0,
    };
  }, [tone, talk, photo]);
  check('video brings only its sound and the photo stays out', placed.n === 2 && placed.tracks.every((k) => k === 'audio'), JSON.stringify(placed));
  check('first audio track is magnetic', placed.onFirst && placed.touching, JSON.stringify(placed));
  await sleep(800);
  const wave = await page.evaluate(() => {
    const c = document.querySelector('.av-canvas');
    const g = c.getContext('2d');
    const d = g.getImageData(Math.round(c.width * 0.75), 0, 1, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] > 150) lit++;
    return { lit, w: c.width, h: c.height, now: document.querySelector('.av-now').textContent, empty: getComputedStyle(document.querySelector('.av-empty')).display };
  });
  check('sound wave is drawn with the playing clip name', wave.lit > 10 && /tone440/i.test(wave.now) && wave.empty === 'none', JSON.stringify(wave));

  // ---- meters move while playing -------------------------------------------------
  await page.click('.viewer .play');
  await sleep(1200);
  const lv = await page.evaluate(() => {
    const l = window.__app.preview.levels();
    return { l, fill: document.querySelector('.av-meter-fill').style.height };
  });
  await page.click('.viewer .play');
  check('level meters follow the sound', lv.l && lv.l[0].peak > 0.01 && parseFloat(lv.fill) < 100, JSON.stringify(lv));
  await page.screenshot({ path: '/tmp/ve-audiomode-2.png' });

  // ---- click on the wave moves the playhead ----------------------------------------
  const before = await page.evaluate(() => window.__store.playhead);
  const box = await page.locator('.av-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  const after = await page.evaluate(() => window.__store.playhead);
  check('clicking the wave moves the playhead', after > before + 2, `${before.toFixed(2)} -> ${after.toFixed(2)}`);

  // ---- picture tools are blocked, menus are audio ones ------------------------------
  const blocked = await page.evaluate(async () => {
    const n = Object.keys(window.__store.project.items).length;
    await window.__app.cmd('addText');
    await window.__app.cmd('addShape', 'rect');
    return { same: Object.keys(window.__store.project.items).length === n, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / ') };
  });
  check('picture tools stay out of audio projects', blocked.same && /for video/i.test(blocked.toast), JSON.stringify(blocked));
  await page.click('.menu-btn:has-text("Add")');
  const addMenu = await page.evaluate(() => [...document.querySelectorAll('.ctx-item span')].map((s) => s.textContent));
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('.ctx')?.remove());
  check('Add menu is the audio one', addMenu.includes('Join audio files') && !addMenu.includes('Text'), addMenu.join(', '));

  // ---- inspector and smart panel ---------------------------------------------------
  const insp = await page.evaluate(() => {
    const s = window.__store;
    const it = Object.values(s.project.items).sort((a, b) => a.start - b.start)[0];
    s.select(it.id);
    return it.id;
  });
  await sleep(200);
  await page.locator('.inspector .tab', { hasText: 'Audio' }).first().click().catch(() => {});
  const inspText = await page.evaluate(() => document.querySelector('.inspector').textContent);
  check('inspector has left / right and the voice leveller, no captions', /Left \/ right/.test(inspText) && /Level out the voice/.test(inspText) && !/Auto captions/.test(inspText), '');
  await page.evaluate(() => window.__app.openPanel('ai'));
  const smart = await page.evaluate(() => document.querySelector('.panel').textContent);
  check('Smart panel shows the audio tools', /Level out the voice/.test(smart) && /Record a voice-over/.test(smart) && !/Remove background\b(?! noise)/.test(smart.replace('Remove background noise', '')), '');

  // ---- pan: hard left leaves the right channel silent in the export --------------------
  const out1 = '/tmp/ve-audiomode-pan.wav';
  fs.rmSync(out1, { force: true });
  await page.evaluate(async ([id, out]) => {
    const s = window.__store;
    s.commit('Pan', (p) => (p.items[id].pan = -1));
    const { exportAudio } = await import('/src/export/export.js');
    await exportAudio(s.project, { out, format: 'wav', t0: 0, t1: 2 });
  }, [insp, out1]);
  const L = channelVolume(out1, 0, 0.2, 1.8);
  const R = channelVolume(out1, 1, 0.2, 1.8);
  check('hard left pan leaves the right channel silent', L != null && L > -40 && (R == null || R < L - 30), `L ${L} dB, R ${R} dB`);
  await page.evaluate((id) => window.__store.commit('Pan', (p) => (p.items[id].pan = 0)), insp);

  // ---- cutting on the first track closes the gap ------------------------------------
  const ripple = await page.evaluate(() => {
    const s = window.__store;
    const items = () => Object.values(s.project.items).sort((a, b) => a.start - b.start);
    s.select(items()[0].id);
    window.__app.cmd('rippleDelete');
    const left = items();
    return { n: left.length, start: left[0]?.start };
  });
  check('deleting on the first audio track closes the gap', ripple.n === 1 && Math.abs(ripple.start) < 0.01, JSON.stringify(ripple));

  // ---- join audio files ----------------------------------------------------------
  const joined = await page.evaluate(async ([tone, pink]) => {
    const s = window.__store;
    const { stitchMedia } = await import('/src/ui/stitch.js');
    let added = [];
    s.commit('Join', (p) => (added = stitchMedia(p, [p.media[tone], p.media[pink]], { soft: true })));
    const first = s.project.tracks.find((t) => t.kind === 'audio');
    const all = Object.values(s.project.items).filter((i) => i.trackId === first.id).sort((a, b) => a.start - b.start);
    let gaps = 0;
    for (let i = 1; i < all.length; i++) if (Math.abs(all[i - 1].start + all[i - 1].duration - all[i].start) > 0.01) gaps++;
    return { added: added.length, fades: added.every((c) => c.fadeIn > 0 && c.fadeOut > 0), gaps, total: all.length };
  }, [tone, pink]);
  check('join puts the files end to end with soft joins', joined.added === 2 && joined.fades && joined.gaps === 0 && joined.total === 3, JSON.stringify(joined));

  // ---- export dialog and transcript export ------------------------------------------
  await page.evaluate(() => window.__app.cmd('export'));
  await page.waitForSelector('.modal .export');
  const fmts = await page.evaluate(() => [...document.querySelectorAll('.modal .seg-btn')].map((b) => b.textContent));
  const estimate = await page.evaluate(() => document.querySelector('.modal .export .hint:last-child')?.textContent || '');
  await page.keyboard.press('Escape');
  check('export offers audio and transcript only', JSON.stringify(fmts) === JSON.stringify(['Audio', 'Transcript']), fmts.join(','));
  check('audio export shows a size estimate', /MB for/.test(estimate), estimate);
  const txtOut = '/tmp/ve-audiomode-transcript.txt';
  const srtOut = '/tmp/ve-audiomode-transcript.srt';
  const tr = await page.evaluate(async ([talk, txtOut, srtOut]) => {
    const s = window.__store;
    const m = s.project.media[talk];
    m.transcript = { words: [{ t: 'Hello', s: 0.2, e: 0.5 }, { t: 'there.', s: 0.55, e: 0.9 }, { t: 'This', s: 2.1, e: 2.3 }, { t: 'is', s: 2.35, e: 2.45 }, { t: 'audio.', s: 2.5, e: 2.9 }] };
    const { exportTranscript } = await import('/src/ai/transcript.js');
    await exportTranscript(s.project, txtOut);
    await exportTranscript(s.project, srtOut);
    return true;
  }, [talk, txtOut, srtOut]);
  const txt = fs.existsSync(txtOut) ? fs.readFileSync(txtOut, 'utf8') : '';
  const srt = fs.existsSync(srtOut) ? fs.readFileSync(srtOut, 'utf8') : '';
  check('transcript exports as text with times', tr && /\[\d\d:\d\d\.\d\d\] Hello there\./.test(txt) && /This is audio\./.test(txt), JSON.stringify(txt));
  check('transcript exports as SRT', /^1\n\d\d:\d\d:\d\d,\d{3} --> /.test(srt) && /\n2\n/.test(srt), JSON.stringify(srt.slice(0, 120)));

  // ---- voice leveller ------------------------------------------------------------
  const comp = await page.evaluate(async () => {
    const s = window.__store;
    const it = Object.values(s.project.items).find((i) => s.project.media[i.mediaId]?.kind === 'audio');
    await window.__app.cmd('compressClip', it);
    return s.project.items[it.id]?.derivations || [];
  });
  check('voice leveller makes a levelled copy', comp.includes('comp'), JSON.stringify(comp));

  // ---- switch to video and back ---------------------------------------------------
  const sw = await page.evaluate(async () => {
    await window.__app.cmd('projectType', false);
    await new Promise((r) => setTimeout(r, 200));
    const video = { audio: !!window.__store.project.settings.audioOnly, body: document.body.classList.contains('audio-mode'), rail: document.querySelectorAll('.rail-btn').length, frame: getComputedStyle(document.querySelector('.viewer-frame')).display };
    window.__store.undo();
    await new Promise((r) => setTimeout(r, 200));
    const back = { audio: !!window.__store.project.settings.audioOnly, body: document.body.classList.contains('audio-mode'), rail: document.querySelectorAll('.rail-btn').length };
    return { video, back };
  });
  check('switching to a video project brings the picture tools back', !sw.video.audio && !sw.video.body && sw.video.rail === 10 && sw.video.frame !== 'none', JSON.stringify(sw.video));
  check('undo switches back to audio', sw.back.audio && sw.back.body && sw.back.rail === 4, JSON.stringify(sw.back));

  // a video project with a gap on its audio track turns magnetic off when switched, so nothing moves
  const gapSwitch = await page.evaluate(async ([tone]) => {
    const { createProject } = await import('/src/project-io.js');
    const model = await import('/src/core/model.js');
    const s = window.__store;
    const old = s.project;
    createProject({ name: 'Gap test' });
    const p = s.project;
    p.media[tone] = old.media[tone];
    s.commit('Place', (pp) => {
      const { newClip } = model;
      const a = pp.tracks.find((t) => t.kind === 'audio');
      const c = newClip(pp.media[tone], a.id, 3);
      pp.items[c.id] = c;
    });
    await window.__app.cmd('projectType', true);
    const it = Object.values(s.project.items)[0];
    return { start: it.start, magnetic: s.project.settings.magnetic };
  }, [tone]);
  check('switching keeps clips where they are', Math.abs(gapSwitch.start - 3) < 0.01 && gapSwitch.magnetic === false, JSON.stringify(gapSwitch));

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
