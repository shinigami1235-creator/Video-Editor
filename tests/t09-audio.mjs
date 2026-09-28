// Audio editing: separate audio, volume line, lowering other sounds, track
// volume, pitch, tone and keep-pitch, in the preview and in the export.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

function meanVolume(file, a, b, af = '') {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(a), '-t', String(b - a), '-i', file, '-af', (af ? af + ',' : '') + 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = String(r.stderr).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

/** Dominant frequency by counting zero crossings of the left channel. */
function frequency(file, a, b) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(a), '-t', String(b - a), '-i', file, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const f = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  let z = 0;
  for (let i = 1; i < f.length; i++) if (f[i - 1] < 0 && f[i] >= 0) z++;
  return z / (f.length / 48000);
}

function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout.trim());
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
  const media = await importAndWait(page, [`${FIX}/tone440.wav`, `${FIX}/pink.wav`, `${FIX}/talk.mp4`, `${FIX}/music.wav`]);
  const [tone, pink, talk, music] = media.map((m) => m.id);

  // ---- separate audio ------------------------------------------------------
  const det = await page.evaluate(async (talk) => {
    const s = window.__store;
    window.__app.addMedia([s.project.media[talk]], 0);
    const v = Object.values(s.project.items)[0];
    s.select(v.id);
    window.__app.cmd('detachAudio');
    const a = Object.values(s.project.items).find((i) => i.linkedTo === v.id);
    const tr = s.project.tracks.find((t) => t.id === a?.trackId);
    return { muted: v.muted, audio: !!a, kind: tr?.kind, same: a && a.start === v.start && a.duration === v.duration };
  }, talk);
  check('separate audio puts the sound on an audio track', det.muted && det.audio && det.kind === 'audio' && det.same, JSON.stringify(det));
  await sleep(400);
  const hasLine = await page.locator('.tl-clip.t-audio .tl-vol-line').count();
  check('audio clip shows a volume line', hasLine >= 1, String(hasLine));
  await page.screenshot({ path: '/tmp/ve-audio-1.png' });

  // ---- drag the volume line down --------------------------------------------
  const line = page.locator('.tl-clip.t-audio .tl-vol-hit').first();
  const box = await line.boundingBox();
  const clip = await page.locator('.tl-clip.t-audio').first().boundingBox();
  const lineY = box.y + box.height / 2;
  const x = clip.x + Math.min(120, clip.width / 3);
  await page.mouse.move(x, lineY);
  await page.mouse.down();
  await page.mouse.move(x, lineY + 8, { steps: 4 });
  await page.mouse.up();
  const lvl = await page.evaluate(() => {
    const s = window.__store;
    const a = Object.values(s.project.items).find((i) => i.linkedTo);
    return a.props.volume;
  });
  check('dragging the line down lowers the volume', lvl < 0.95 && lvl > 0.2, String(lvl));

  // ---- click to add a point, then double-click it to remove --------------------
  const pts = await page.evaluate(() => {
    const s = window.__store;
    const a = Object.values(s.project.items).find((i) => i.linkedTo);
    s.commit('pts', () => {
      a.props.volume = 1;
      a.kf.volume = [
        { t: 0.5, v: 1, e: 'linear' },
        { t: 2, v: 0.3, e: 'linear' },
      ];
    });
    return a.kf.volume.length;
  });
  await sleep(300);
  const hit = await page.locator('.tl-clip.t-audio .tl-vol-hit').first().boundingBox();
  const c2 = await page.locator('.tl-clip.t-audio').first().boundingBox();
  const zoom = await page.evaluate(() => window.__store.zoom);
  // on the flat part after the last point (30%)
  const px = c2.x + 3 * zoom;
  const vy = await page.evaluate(([H]) => 4 + (1 - 0.3 / 3) * (H - 8), [c2.height]);
  await page.mouse.click(px, c2.y + vy);
  const afterAdd = await page.evaluate(() => Object.values(window.__store.project.items).find((i) => i.linkedTo).kf.volume.length);
  check('clicking the line adds a volume point', afterAdd === pts + 1, `${pts} -> ${afterAdd}`);
  void hit;
  await sleep(200);
  const dot = page.locator('.tl-clip.t-audio .tl-vol-pt').last();
  await dot.dblclick();
  const afterDel = await page.evaluate(() => Object.values(window.__store.project.items).find((i) => i.linkedTo).kf.volume?.length || 0);
  check('double-clicking a point removes it', afterDel === pts, String(afterDel));
  // dragging a point sideways follows the pointer
  await sleep(500);
  const dot0 = await page.locator('.tl-clip.t-audio .tl-vol-pt').first().boundingBox();
  const tBefore = await page.evaluate(() => Object.values(window.__store.project.items).find((i) => i.linkedTo).kf.volume[0].t);
  await page.mouse.move(dot0.x + dot0.width / 2, dot0.y + dot0.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(dot0.x + dot0.width / 2 + k * 5, dot0.y + dot0.height / 2);
  await page.mouse.up();
  const tAfter = await page.evaluate(() => Object.values(window.__store.project.items).find((i) => i.linkedTo).kf.volume[0].t);
  check('dragging a point sideways moves it with the pointer', Math.abs(tAfter - tBefore - 30 / zoom) < 0.05, `${tBefore} -> ${tAfter} (expected +${(30 / zoom).toFixed(3)})`);

  // ---- lower other sounds under a voiceover --------------------------------------
  const duck = await page.evaluate(async ([music, tone]) => {
    const s = window.__store;
    for (const id of Object.keys(s.project.items)) delete s.project.items[id];
    s.commit('reset', () => {});
    window.__app.addMedia([s.project.media[music]], 0);
    const mus = Object.values(s.project.items)[0];
    const E = await import('/src/core/edit.js');
    const vo = E.addMediaToTimeline ? null : null;
    void vo;
    window.__app.addMedia([s.project.media[tone]], 3);
    const t = Object.values(s.project.items).find((i) => i.mediaId === tone);
    s.commit('place', () => {
      t.start = 3;
    });
    window.__app.cmd('duckOthers', t);
    // pressing it again must not dip twice
    window.__app.cmd('duckOthers', t);
    const M = await import('/src/core/model.js');
    return {
      before: M.propAt(mus, 'volume', 2),
      during: M.propAt(mus, 'volume', 4.5),
      after: M.propAt(mus, 'volume', 7.6),
      n: mus.kf.volume?.length,
      toneStart: t.start,
      toneEnd: t.start + t.duration,
    };
  }, [music, tone]);
  check('lower other sounds dips the music and brings it back', duck.before === 1 && Math.abs(duck.during - 0.2) < 0.01 && duck.after === 1 && duck.n === 4, JSON.stringify(duck));
  // export: music alone under the tone should be about 14 dB quieter
  await page.evaluate(([tone]) => {
    const s = window.__store;
    const t = Object.values(s.project.items).find((i) => i.mediaId === tone);
    s.commit('mute tone', () => (t.muted = true));
  }, [tone]);
  await exportMix(page, '/tmp/ve-test/duck.wav', 9);
  const loud = meanVolume('/tmp/ve-test/duck.wav', 0.5, 2.5);
  const quiet = meanVolume('/tmp/ve-test/duck.wav', 3.8, 6.5);
  check('the dip is in the export', loud - quiet > 11 && loud - quiet < 17, `${loud} vs ${quiet}`);
  await page.screenshot({ path: '/tmp/ve-audio-2.png' });

  // ---- track volume ---------------------------------------------------------------
  const tv = await page.evaluate(() => {
    const s = window.__store;
    const mus = Object.values(s.project.items).find((i) => s.project.media[i.mediaId].name.startsWith('music'));
    const tr = s.project.tracks.find((t) => t.id === mus.trackId);
    s.commit('tv', () => {
      tr.volume = 0.5;
      delete mus.kf.volume;
    });
    return tr.volume;
  });
  await exportMix(page, '/tmp/ve-test/trackvol.wav', 3);
  const half = meanVolume('/tmp/ve-test/trackvol.wav', 0.5, 2.5);
  check('whole track volume at 50% is about 6 dB quieter', Math.abs(loud - half - 6) < 1.2, `${loud} vs ${half} (${tv})`);

  // ---- pitch ---------------------------------------------------------------------
  const pitched = await page.evaluate(async ([tone]) => {
    const s = window.__store;
    for (const id of Object.keys(s.project.items)) delete s.project.items[id];
    for (const tr of s.project.tracks) tr.volume = 1;
    s.commit('reset', () => {});
    window.__app.addMedia([s.project.media[tone]], 0);
    const t = Object.values(s.project.items)[0];
    s.commit('pitch', () => (t.audioFx = { pitch: 12 }));
    s.select(t.id);
    await window.__app.cmd('preparePitch', t);
    const fx = await import('/src/media/audio-fx.js');
    const m = s.project.media[tone];
    return { ready: !!fx.pitchedSync(m, 12), dur: t.duration };
  }, [tone]);
  check('pitch makes a pitched copy', pitched.ready, JSON.stringify(pitched));
  await exportMix(page, '/tmp/ve-test/pitch.wav', 4);
  const f12 = frequency('/tmp/ve-test/pitch.wav', 0.5, 3.5);
  check('+12 semitones plays at 880 Hz', Math.abs(f12 - 880) < 20, f12.toFixed(1));
  check('pitch keeps the length', Math.abs(duration('/tmp/ve-test/pitch.wav') - 4) < 0.05);
  // preview plays the pitched copy
  await page.evaluate(() => {
    window.__store.seek(1);
    window.__app.preview.play();
  });
  await sleep(1200);
  const pv = await page.evaluate(() => {
    const els = [...window.__app.preview.els.entries()];
    window.__app.preview.pause();
    return els.map(([k, e]) => ({ k, src: e.el.src.slice(-20), paused: e.el.paused }));
  });
  check('preview plays the pitched copy', pv.some((e) => e.k.endsWith('#fx') && /m4a/.test(e.src)), JSON.stringify(pv));

  // ---- speed without keeping pitch --------------------------------------------------
  await page.evaluate(async () => {
    const s = window.__store;
    const E = await import('/src/core/edit.js');
    const t = Object.values(s.project.items)[0];
    s.commit('speed', (p) => {
      t.audioFx = { pitch: 0, keepPitch: false };
      E.setSpeed(p, t, 2);
    });
  });
  await exportMix(page, '/tmp/ve-test/tape.wav', 2);
  const fTape = frequency('/tmp/ve-test/tape.wav', 0.2, 1.8);
  check('2x speed with pitch off plays at 880 Hz', Math.abs(fTape - 880) < 20, fTape.toFixed(1));
  await page.evaluate(() => {
    const t = Object.values(window.__store.project.items)[0];
    window.__store.commit('keep', () => (t.audioFx.keepPitch = true));
  });
  await exportMix(page, '/tmp/ve-test/keep.wav', 2);
  const fKeep = frequency('/tmp/ve-test/keep.wav', 0.2, 1.8);
  check('2x speed keeping pitch stays at 440 Hz', Math.abs(fKeep - 440) < 15, fKeep.toFixed(1));

  // ---- tone: phone preset cuts the bass on pink noise ------------------------------
  await page.evaluate(async ([pink]) => {
    const s = window.__store;
    for (const id of Object.keys(s.project.items)) delete s.project.items[id];
    s.commit('reset', () => {});
    window.__app.addMedia([s.project.media[pink]], 0);
  }, [pink]);
  await exportMix(page, '/tmp/ve-test/flat.wav', 4);
  await page.evaluate(async () => {
    const fx = await import('/src/media/audio-fx.js');
    const t = Object.values(window.__store.project.items)[0];
    window.__store.commit('tone', () => (t.audioFx = { tone: 'phone', eq: { ...fx.TONE_PRESETS.phone.eq } }));
  });
  await exportMix(page, '/tmp/ve-test/phone.wav', 4);
  const bassFlat = meanVolume('/tmp/ve-test/flat.wav', 0.5, 3.5, 'lowpass=f=100,lowpass=f=100');
  const bassPhone = meanVolume('/tmp/ve-test/phone.wav', 0.5, 3.5, 'lowpass=f=100,lowpass=f=100');
  const midFlat = meanVolume('/tmp/ve-test/flat.wav', 0.5, 3.5, 'bandpass=f=1500:w=400');
  const midPhone = meanVolume('/tmp/ve-test/phone.wav', 0.5, 3.5, 'bandpass=f=1500:w=400');
  check('phone tone cuts the bass', bassFlat - bassPhone > 10, `${bassFlat} -> ${bassPhone}`);
  check('phone tone lifts the middle', midPhone - midFlat > 3, `${midFlat} -> ${midPhone}`);

  // ---- inspector controls ------------------------------------------------------------
  await page.evaluate(() => {
    const t = Object.values(window.__store.project.items)[0];
    window.__store.select(t.id);
  });
  await sleep(300);
  await page.locator('.inspector .tab:has-text("Audio"), .inspector button:has-text("Audio")').first().click().catch(() => {});
  await sleep(300);
  const ui = await page.evaluate(() => ({
    pitch: !!document.querySelector('.inspector')?.textContent.includes('Pitch and tone'),
    duck: !!document.querySelector('.inspector')?.textContent.includes('Lower other sounds here'),
    track: !!document.querySelector('.inspector')?.textContent.includes('Whole track'),
  }));
  check('audio tab has pitch, tone, track volume and lower others', ui.pitch && ui.duck && ui.track, JSON.stringify(ui));
  await page.screenshot({ path: '/tmp/ve-audio-3.png' });

  // taller track
  const hBefore = await page.locator('.tl-track.kind-audio').first().evaluate((el) => el.offsetHeight);
  await page.locator('.tl-head.kind-audio button[title*="taller"]').first().click();
  await sleep(200);
  const hAfter = await page.locator('.tl-track.kind-audio').first().evaluate((el) => el.offsetHeight);
  check('track can be made taller for the wave', hAfter > hBefore, `${hBefore} -> ${hAfter}`);
  await page.screenshot({ path: '/tmp/ve-audio-4.png' });

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
