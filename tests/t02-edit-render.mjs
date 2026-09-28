import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { execFileSync } from 'node:child_process';

await startServers();
try {
  const { browser, page } = await openApp();
  const caps = await page.evaluate(async () => (await import('/src/media/library.js')).codecCaps());
  console.log('codec caps', caps);
  const media = await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/vertical.mp4`, `${FIX}/photo.png`, `${FIX}/music.wav`]);
  check('imported', media.every((m) => m.status === 'ready'), JSON.stringify(media.map((m) => m.status + ' ' + (m.error || ''))));
  const r1 = await page.evaluate(async (ids) => {
    const app = window.__app;
    const s = window.__store;
    const list = ids.slice(0, 3).map((id) => s.project.media[id]);
    app.addMedia(list, 0);
    const items = Object.values(s.project.items).sort((a, b) => a.start - b.start);
    return items.map((i) => [i.name, +i.start.toFixed(3), +i.duration.toFixed(3), i.trackId]);
  }, media.map((m) => m.id));
  console.log(r1);
  check('three clips laid end to end', r1.length === 3 && Math.abs(r1[1][1] - 6) < 0.05 && Math.abs(r1[2][1] - 11) < 0.05);

  // split, text, transition, music
  const r2 = await page.evaluate(async (musicId) => {
    const app = window.__app;
    const s = window.__store;
    s.clearSelection();
    app.seek(3);
    await app.cmd('split');
    const n1 = Object.keys(s.project.items).length;
    const t = await app.cmd('addText', 1, 'Hello clinic');
    const clips = Object.values(s.project.items).filter((i) => i.type === 'clip').sort((a, b) => a.start - b.start);
    s.commit('Transition', () => (clips[2].transitionIn = { type: 'dissolve', duration: 1 }));
    app.addMedia([s.project.media[musicId]], 0);
    const music = Object.values(s.project.items).find((i) => i.mediaId === musicId);
    s.commit('duck', () => (music.duck = true));
    return { n1, count: Object.keys(s.project.items).length, undo: s.undoStack.length, tracks: s.project.tracks.map((t) => t.kind) };
  }, media[3].id);
  console.log(r2);
  check('split made 4 clips', r2.n1 === 4);
  check('text and music added', r2.count === 6);

  // render preview frames and read pixels
  const px = await page.evaluate(async () => {
    const app = window.__app;
    const s = window.__store;
    const out = {};
    for (const t of [0.5, 1.5, 5.8, 6.3, 12]) {
      app.seek(t);
      // wait for video elements to seek and the preview to draw
      for (let k = 0; k < 40; k++) {
        await new Promise((r) => setTimeout(r, 100));
        const els = [...app.preview.els.values()];
        if (els.every((e) => e.el.readyState >= 2 && !e.el.seeking)) break;
      }
      app.preview.invalidate();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const { data, width, height } = app.preview.comp.readPixels();
      let sum = 0;
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += data[i] + data[i + 1] + data[i + 2];
        if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) bright++;
      }
      out[t] = { mean: +(sum / (data.length / 4) / 3).toFixed(1), bright, width, height };
    }
    return out;
  });
  console.log(px);
  check('frame at 0.5s is not black', px['0.5'].mean > 20);
  check('text draws white pixels at 1.5s', px['1.5'].bright > px['0.5'].bright + 50, `${px['1.5'].bright} vs ${px['0.5'].bright}`);
  check('transition frame renders', px['6.3'].mean > 10);
  check('photo frame renders', px['12'].mean > 20);
  await page.screenshot({ path: '/tmp/ve-shot-02.png' });

  // undo and redo
  const ur = await page.evaluate(() => {
    const s = window.__store;
    const snap = () => JSON.stringify(s.project.items);
    const before = snap();
    s.undo();
    s.undo();
    const afterUndo = snap();
    s.redo();
    s.redo();
    return { same: snap() === before, changed: afterUndo !== before };
  });
  check('undo and redo', ur.same && ur.changed, JSON.stringify(ur));

  // export
  const ex = await page.evaluate(async () => {
    const { exportVideo } = await import('/src/export/export.js');
    const s = window.__store;
    const t0 = performance.now();
    const res = await exportVideo(s.project, { out: '/tmp/ve-test/out.mp4', width: 360, height: 640, fps: 30, bitrateMbps: 3, onProgress: () => {} });
    return { ...res, secs: (performance.now() - t0) / 1000 };
  });
  console.log('export', ex);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height', '-of', 'json', '/tmp/ve-test/out.mp4']).toString());
  console.log(JSON.stringify(probe));
  const vs = probe.streams.find((x) => x.codec_type === 'video');
  const as = probe.streams.find((x) => x.codec_type === 'audio');
  check('export has h264 video 360x640', vs?.codec_name === 'h264' && vs.width === 360 && vs.height === 640);
  check('export has aac audio', as?.codec_name === 'aac');
  check('export duration about 16s', Math.abs(Number(probe.format.duration) - 16) < 0.3, probe.format.duration);
  // grab frames from the export to compare
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1.5', '-i', '/tmp/ve-test/out.mp4', '-frames:v', '1', '/tmp/ve-export-1_5.png']);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '6.3', '-i', '/tmp/ve-test/out.mp4', '-frames:v', '1', '/tmp/ve-export-6_3.png']);
  const vol = execFileSync('ffmpeg', ['-v', 'info', '-i', '/tmp/ve-test/out.mp4', '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  void vol;

  // save and reopen
  const so = await page.evaluate(async () => {
    const s = window.__store;
    window.__testDialogs = ['/tmp/ve-test/documents/Test.vproj'];
    const { saveProject, openProjectPath } = await import('/src/project-io.js');
    const ok = await saveProject();
    const n = Object.keys(s.project.items).length;
    await openProjectPath('/tmp/ve-test/documents/Test.vproj');
    return { ok, n, n2: Object.keys(s.project.items).length, name: s.project.name };
  });
  check('save and reopen keeps items', so.ok && so.n === so.n2, JSON.stringify(so));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
