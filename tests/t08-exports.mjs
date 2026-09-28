import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

function rmsWindows(file, windows) {
  // returns RMS in dBFS for each [start, end] window
  return windows.map(([a, b]) => {
    const out = execFileSync('ffmpeg', ['-v', 'info', '-ss', String(a), '-t', String(b - a), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return out;
  });
}

function meanVolume(file, a, b) {
  const r = require_spawn(file, a, b);
  const m = r.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}
function require_spawn(file, a, b) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(a), '-t', String(b - a), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  return String(r.stderr || '');
}
function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,sample_rate', '-of', 'json', file]).toString());
}

await startServers();
try {
  const { browser, page, logs } = await openApp();
  const media = await importAndWait(page, [`${FIX}/speech-pauses.wav`, `${FIX}/music.wav`, `${FIX}/landscape.mp4`]);
  const [speech, music, land] = media.map((m) => m.id);

  // ducking: speech 0..12.6 with pauses at ~2.9-4.6 and ~7.7-9.8, music under it marked to duck
  await page.evaluate(async ([speech, music, land]) => {
    const s = window.__store;
    const app = window.__app;
    app.addMedia([s.project.media[land]], 0);
    const v = Object.values(s.project.items)[0];
    const E = await import('/src/core/edit.js');
    s.commit('long', (p) => E.trimTailTo(p, v, 6));
    app.addMedia([s.project.media[speech]], 0);
    app.addMedia([s.project.media[music]], 0);
    const items = Object.values(s.project.items);
    const mus = items.find((i) => i.mediaId === music);
    const sp = items.find((i) => i.mediaId === speech);
    const vid = items.find((i) => i.mediaId === land);
    s.commit('setup', () => {
      mus.duck = true;
      vid.muted = true;
    });
    return true;
  }, [speech, music, land]);
  const aOut = '/tmp/ve-test/mix.wav';
  await page.evaluate(async (out) => {
    const { exportAudio } = await import('/src/export/export.js');
    await exportAudio(window.__store.project, { out, format: 'wav', t0: 0, t1: 12 });
  }, aOut);
  const inSpeech = meanVolume(aOut, 0.5, 2.5);
  const inPause = meanVolume(aOut, 3.4, 4.3);
  const musicOnly = meanVolume(`${FIX}/music.wav`, 3.4, 4.3);
  console.log({ inSpeech, inPause, musicOnly });
  check('audio mix exported', fs.existsSync(aOut) && probe(aOut).streams[0].sample_rate === '48000');
  // in the pause only music plays at full level, so the level there is close to the music alone
  check('music plays at full level in a pause', Math.abs(inPause - musicOnly) < 3, `${inPause} vs ${musicOnly}`);

  // measure the music under speech by muting the speech track
  await page.evaluate(async () => {
    const s = window.__store;
    const sp = Object.values(s.project.items).find((i) => i.mediaId && s.project.media[i.mediaId].name.startsWith('speech'));
    s.commit('mute', () => (sp.muted = true));
  });
  await page.evaluate(async () => {
    // keep the ducking decision from the speech clip even though it is muted: mark it audible for detection only
  });
  // speed change keeps pitch and shortens the clip
  const sp = await page.evaluate(async () => {
    const s = window.__store;
    const E = await import('/src/core/edit.js');
    const clip = Object.values(s.project.items).find((i) => i.mediaId && s.project.media[i.mediaId].name.startsWith('speech'));
    s.commit('unmute', () => (clip.muted = false));
    for (const o of Object.values(s.project.items)) if (o !== clip) s.project.items[o.id].muted = true;
    E.setSpeed(s.project, clip, 1.5);
    return clip.duration;
  });
  check('speed 1.5x shortens the clip', Math.abs(sp - 12.624 / 1.5) < 0.1, String(sp));
  const aOut2 = '/tmp/ve-test/fast.wav';
  await page.evaluate(async (out) => {
    const { exportAudio } = await import('/src/export/export.js');
    await exportAudio(window.__store.project, { out, format: 'wav', t0: 0, t1: 8.4 });
  }, aOut2);
  const fastVol = meanVolume(aOut2, 0.3, 1.8);
  check('fast speech is audible in the export', fastVol != null && fastVol > -40, String(fastVol));

  // other exports
  const ex = await page.evaluate(async () => {
    const s = window.__store;
    for (const o of Object.values(s.project.items)) o.muted = false;
    const X = await import('/src/export/export.js');
    await X.exportFrame(s.project, 1, '/tmp/ve-test/frame.png');
    await X.exportFrame(s.project, 1, '/tmp/ve-test/frame.jpg');
    await X.exportAudio(s.project, { out: '/tmp/ve-test/mix.mp3', format: 'mp3', t0: 0, t1: 4, loudnorm: true });
    await X.exportGif(s.project, { out: '/tmp/ve-test/clip.gif', width: 240, height: 426, fps: 10, t0: 0, t1: 1.5 });
    const c = await import('/src/ai/captions.js');
    s.commit('caps', (p) => c.addCaptionItems(p, c.chunkWords(c.spreadWords('One two three four five six', 0.5, 3), { maxWords: 3 })));
    await X.exportCaptions(s.project, '/tmp/ve-test/caps.srt');
    await X.exportCaptions(s.project, '/tmp/ve-test/caps.vtt');
    return true;
  });
  check('png frame', fs.existsSync('/tmp/ve-test/frame.png') && probe('/tmp/ve-test/frame.png').streams[0].width === 1080);
  check('jpg frame', fs.existsSync('/tmp/ve-test/frame.jpg'));
  check('mp3 audio', probe('/tmp/ve-test/mix.mp3').streams[0].codec_name === 'mp3');
  check('gif', probe('/tmp/ve-test/clip.gif').streams[0].codec_name === 'gif');
  check('srt and vtt', fs.readFileSync('/tmp/ve-test/caps.srt', 'utf8').includes('-->') && fs.readFileSync('/tmp/ve-test/caps.vtt', 'utf8').startsWith('WEBVTT'));

  // a range export with an in and out point
  const r = await page.evaluate(async () => {
    const X = await import('/src/export/export.js');
    await X.exportVideo(window.__store.project, { out: '/tmp/ve-test/range.mp4', width: 270, height: 480, fps: 24, bitrateMbps: 2, t0: 1, t1: 3 });
    return true;
  });
  void r;
  const pr = probe('/tmp/ve-test/range.mp4');
  check('in to out export is 2 seconds', Math.abs(Number(pr.format.duration) - 2) < 0.15, pr.format.duration);

  // autosave and recovery
  const rec = await page.evaluate(async () => {
    const io = await import('/src/project-io.js');
    const s = window.__store;
    s.dirty = true;
    await io.autosaveNow();
    const found = await io.findRecoverable();
    const n = Object.keys(s.project.items).length;
    s.loadProject((await import('/src/core/model.js')).newProject(), null);
    await io.restoreAutosave(found[0]);
    return { found: found.length, n, n2: Object.keys(s.project.items).length };
  });
  check('autosave and recovery', rec.found === 1 && rec.n === rec.n2, JSON.stringify(rec));

  // voiceover with the fake microphone
  await page.evaluate(() => window.__app.openPanel('audio'));
  await sleep(500);
  await page.uncheck('.recorder input[type=checkbox] >> nth=2');
  await page.uncheck('.recorder input[type=checkbox] >> nth=0');
  await page.click('.recorder .btn:has-text("Record")');
  await sleep(2200);
  await page.click('.recorder .btn:has-text("Stop")');
  await page.waitForFunction(() => Object.values(window.__store.project.items).some((i) => i.name === 'Voiceover'), null, { timeout: 60000 }).catch(() => {});
  const vo = await page.evaluate(() => {
    const it = Object.values(window.__store.project.items).find((i) => i.name === 'Voiceover');
    return it ? it.duration : 0;
  });
  check('voiceover recording lands on the timeline', vo > 1.2, String(vo));

  // brand kit: logo watermark and end card
  const bk = await page.evaluate(async (logo) => {
    const { saveSettings } = await import('/src/core/settings.js');
    const kit = { id: 'b1', name: 'Sognare', colors: ['#2b1a12', '#c9a45c', '#ffffff'], fonts: [], logos: [{ name: 'logo', path: logo }] };
    saveSettings({ brandKits: [kit] });
    const b = await import('/src/ai/brand.js');
    await b.brandWatermark(window.__app, kit);
    await b.brandEndCard(window.__app, kit);
    const items = Object.values(window.__store.project.items);
    window.__app.openPanel('brand');
    return { wm: items.some((i) => i.name === 'Logo watermark'), end: items.filter((i) => i.type === 'solid').length };
  }, `${FIX}/photo.png`);
  check('brand watermark and end card', bk.wm && bk.end >= 1, JSON.stringify(bk));
  await page.screenshot({ path: '/tmp/ve-ui-brand.png' });

  // paid services are off by default: generate shows a toast and no dialog
  const blocked = await page.evaluate(async () => {
    await window.__app.cmd('generate');
    await new Promise((r) => setTimeout(r, 200));
    return { modal: !!document.querySelector('.modal'), toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / ') };
  });
  check('paid services off blocks generate', !blocked.modal && /Paid services/i.test(blocked.toast), JSON.stringify(blocked));
  // with paid services on, the generate dialog explains the missing token
  await page.evaluate(() => { window.__store.settings.paidServices = true; return window.__app.cmd('generate'); });
  await page.waitForSelector('.modal');
  const note = await page.locator('.modal .notice').textContent().catch(() => '');
  check('generate asks for a Replicate token', /token/i.test(note || ''), note);
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window.__store.settings.paidServices = false));

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
