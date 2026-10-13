// Shape from the layer below: a clip shown only inside, or only outside, the
// cut-out shape on the layer under it, checked on exported frames, plus the
// Fill the subject button that cuts out a copy of the clip below.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { spawnSync } from 'node:child_process';

/** RGB of one pixel of a PNG, read with FFmpeg. */
function pixel(file, x, y) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  return [...r.stdout.subarray(0, 3)];
}
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

await startServers();
try {
  const { browser, page, logs } = await openApp();

  // a red circle on a transparent square, standing in for a cut-out subject
  const circle = await page.evaluate(async () => {
    const be = await import('/src/backend/index.js');
    const c = new OffscreenCanvas(400, 400);
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000';
    g.beginPath();
    g.arc(200, 200, 120, 0, Math.PI * 2);
    g.fill();
    const blob = await c.convertToBlob({ type: 'image/png' });
    const path = be.join(be.paths.temp, 'circle.png');
    await be.writeBytes(path, new Uint8Array(await blob.arrayBuffer()), { offset: 0, truncate: true });
    (await import('/src/project-io.js')).createProject({ name: 'Matte', width: 400, height: 400 });
    return path;
  });
  const [circ, land] = (await importAndWait(page, [circle, `${FIX}/landscape.mp4`])).map((m) => m.id);
  const ids = await page.evaluate(([circ, land]) => {
    const s = window.__store;
    let out = {};
    return import('/src/core/model.js').then((M) => {
      s.commit('Set up', (p) => {
        const base = M.newClip(p.media[circ], p.tracks.find((t) => t.kind === 'video').id, 0, { duration: 3 });
        p.items[base.id] = base;
        const tr = M.newTrack('video', 'Video 2');
        p.tracks.unshift(tr);
        const v = M.newClip(p.media[land], tr.id, 0, { duration: 3 });
        v.fit = 'cover';
        p.items[v.id] = v;
        out = { base: base.id, top: v.id };
      });
      return out;
    });
  }, [circ, land]);

  const frame = async (matte, name) => {
    const out = `/tmp/ve-matte-${name}.png`;
    await page.evaluate(
      async ([id, matte, out]) => {
        const s = window.__store;
        s.commit('Matte', (p) => (matte ? (p.items[id].matte = matte) : delete p.items[id].matte));
        const { exportFrame } = await import('/src/export/export.js');
        await exportFrame(s.project, 1, out);
      },
      [ids.top, matte, out],
    );
    return { center: pixel(out, 200, 200), corner: pixel(out, 10, 10) };
  };
  const off = await frame(null, 'off');
  const inside = await frame('inside', 'inside');
  const outside = await frame('outside', 'outside');
  const black = [0, 0, 0];
  const red = [255, 0, 0];
  check('without the shape the video covers the frame', !near(off.corner, black, 20) && !near(off.center, red), JSON.stringify(off));
  check('inside: the video fills the circle and nothing else', near(inside.center, off.center) && near(inside.corner, black, 12), JSON.stringify(inside));
  check('outside: the circle stays and the video fills around it', near(outside.center, red) && near(outside.corner, off.corner), JSON.stringify(outside));

  // the inspector control
  await page.evaluate((id) => window.__store.select(id), ids.top);
  await page.locator('.inspector .tab', { hasText: 'Video' }).first().click();
  await sleep(200);
  const ui = await page.evaluate(() => {
    const t = document.querySelector('.inspector').textContent;
    return { section: /Shape from the layer below/.test(t), button: /Fill the subject of the clip below/.test(t) };
  });
  check('Video tab has the shape controls', ui.section && ui.button, JSON.stringify(ui));

  // Fill the subject: closing the model window leaves nothing behind
  await page.evaluate(async () => {
    (await import('/src/project-io.js')).createProject({ name: 'Fill', width: 1080, height: 1080 });
    self.__ortProviders = ['wasm'];
  });
  const [photo, land2] = (await importAndWait(page, [`${FIX}/photo.png`, `${FIX}/landscape.mp4`])).map((m) => m.id);
  const pair = await page.evaluate(async ([photo, land2]) => {
    const s = window.__store;
    const M = await import('/src/core/model.js');
    let out = null;
    s.commit('Set up', (p) => {
      const base = M.newClip(p.media[photo], p.tracks.find((t) => t.kind === 'video').id, 0, { duration: 3 });
      p.items[base.id] = base;
      const tr = M.newTrack('video', 'Video 2');
      p.tracks.unshift(tr);
      const v = M.newClip(p.media[land2], tr.id, 0, { duration: 3 });
      p.items[v.id] = v;
      out = { base: base.id, top: v.id, tracks: p.tracks.length };
    });
    s.select(out.top);
    return out;
  }, [photo, land2]);
  let pending = page.evaluate((id) => window.__app.cmd('fillSubjectBelow', window.__store.project.items[id]), pair.top);
  await page.waitForSelector('.modal');
  await page.keyboard.press('Escape');
  await pending;
  const cancelled = await page.evaluate((pair) => {
    const p = window.__store.project;
    return { tracks: p.tracks.length, items: Object.keys(p.items).length, matte: p.items[pair.top].matte || null };
  }, pair);
  check('closing the model window leaves the project as it was', cancelled.tracks === pair.tracks && cancelled.items === 2 && !cancelled.matte, JSON.stringify(cancelled));

  // Fill the subject: a cut-out copy between the two, the top clip inside it
  pending = page.evaluate((id) => window.__app.cmd('fillSubjectBelow', window.__store.project.items[id]), pair.top);
  await page.waitForSelector('.modal');
  await page.click('.modal-body .btn:has-text("Fast preview quality")');
  await pending;
  await page.waitForFunction(() => !document.querySelector('.job'), null, { timeout: 300000 });
  const filled = await page.evaluate((pair) => {
    const p = window.__store.project;
    const vids = p.tracks.filter((t) => t.kind === 'video');
    const top = p.items[pair.top];
    const base = p.items[pair.base];
    const copy = Object.values(p.items).find((i) => i.id !== pair.top && i.id !== pair.base);
    const idx = (id) => vids.findIndex((t) => t.id === id);
    return {
      matte: top.matte,
      copyCut: copy?.derivations?.includes('bg'),
      copyMuted: copy?.muted,
      between: copy && idx(top.trackId) < idx(copy.trackId) && idx(copy.trackId) < idx(base.trackId),
      baseUntouched: !(base.derivations || []).length,
    };
  }, pair);
  check('Fill the subject cuts out a copy between the two clips', filled.copyCut && filled.copyMuted && filled.between && filled.baseUntouched, JSON.stringify(filled));
  check('the top clip shows only inside the cut-out', filled.matte === 'inside', JSON.stringify(filled));
  await page.screenshot({ path: '/tmp/ve-matte.png' });

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
