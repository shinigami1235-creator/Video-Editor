// Procedure tools: multi-camera sync and angle switching, before and after
// face alignment, freehand masks with tracking.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

await startServers();
try {
  const { browser, page, logs } = await openApp();
  await page.evaluate(() => (self.__ortProviders = ['wasm']));
  const [camA, camB] = (await importAndWait(page, [`${FIX}/camA.mp4`, `${FIX}/camB.mp4`])).map((m) => m.id);

  // ---- sync by sound ---------------------------------------------------------------
  const sync = await page.evaluate(
    async ([camA, camB]) => {
      const s = window.__store;
      window.__app.addMedia([s.project.media[camB]], 0);
      window.__app.addMedia([s.project.media[camA]], 0);
      const items = Object.values(s.project.items);
      // trim 2 s off the head of the clip on the main track, which becomes the reference
      const E = await import('/src/core/edit.js');
      const main = E.mainTrack(s.project);
      const refClip = items.filter((i) => i.trackId === main.id).sort((x, y) => x.start - y.start)[0];
      s.commit('trim', () => {
        refClip.in += 2;
        refClip.duration -= 2;
      });
      s.select(items.map((i) => i.id));
      await window.__app.cmd('syncAngles');
      const a = Object.values(s.project.items).find((i) => i.mediaId === camA);
      const b = Object.values(s.project.items).find((i) => i.mediaId === camB);
      return { aStart: a.start, aIn: a.in, bStart: b.start, bIn: b.in, bMuted: b.muted, aMuted: a.muted, sameTrack: a.trackId === b.trackId, mc: s.project.multicam?.angles.length };
    },
    [camA, camB],
  );
  // camB's sound is camA's from 3.2 s on, so at any moment camA's source time is 3.2 s ahead
  const aheadBy = sync.bStart - sync.bIn - (sync.aStart - sync.aIn);
  check('angles line up by sound', Math.abs(aheadBy - 3.2) < 0.05, JSON.stringify(sync));
  check('second angle sits on its own track with its sound muted', !sync.sameTrack && (sync.bMuted || sync.aMuted) && sync.mc === 2, JSON.stringify(sync));
  await page.screenshot({ path: '/tmp/ve-proc-1.png' });

  // ---- switch angles ----------------------------------------------------------------
  await page.evaluate(() => window.__app.cmd('switchAngles'));
  await page.waitForSelector('.angle-bar');
  await page.keyboard.press('2');
  const hid = await page.evaluate(() => {
    const s = window.__store;
    const b = s.project.items[s.project.multicam.angles[1]];
    return s.project.tracks.find((t) => t.id === b.trackId).hidden;
  });
  await page.keyboard.press('1');
  const hid1 = await page.evaluate(() => {
    const s = window.__store;
    const b = s.project.items[s.project.multicam.angles[1]];
    return s.project.tracks.find((t) => t.id === b.trackId).hidden;
  });
  check('number keys switch the visible angle', hid === false && hid1 === true, `${hid} ${hid1}`);
  await page.screenshot({ path: '/tmp/ve-proc-2.png' });
  await page.click('.angle-bar button:has-text("Close")');
  const cut = await page.evaluate(async () => {
    const s = window.__store;
    const mc = await import('/src/ai/multicam.js');
    const angles = s.project.multicam.angles;
    const b = s.project.items[angles[1]];
    const start = b.start;
    s.commit('switch', (p) => mc.applySwitches(p, angles, [[0, 0], [start + 1, 1], [start + 3, 0], [start + 5, 1]], 20));
    const pieces = Object.values(s.project.items).filter((i) => i.mediaId === b.mediaId).sort((x, y) => x.start - y.start);
    return pieces.map((pc) => [+(pc.start - start).toFixed(2), +pc.duration.toFixed(2), +(pc.in - b.in).toFixed(2)]);
  });
  check('recorded switches cut the second angle', cut.length === 2 && cut[0][0] === 1 && cut[0][1] === 2 && cut[1][0] === 5 && Math.abs(cut[1][2] - 5) < 0.01, JSON.stringify(cut));

  // ---- before and after alignment ------------------------------------------------------
  const [face, faceAfter] = (await importAndWait(page, [`${FIX}/portrait.jpg`, `${FIX}/portrait-after.jpg`])).map((m) => m.id);
  const al = await page.evaluate(
    async ([face, faceAfter]) => {
      const s = window.__store;
      s.loadProject((await import('/src/core/model.js')).newProject({ width: 1080, height: 1080 }));
      return true;
    },
    [face, faceAfter],
  );
  void al;
  const [f1, f2] = (await importAndWait(page, [`${FIX}/portrait.jpg`, `${FIX}/portrait-after.jpg`])).map((m) => m.id);
  const align = await page.evaluate(
    async ([f1, f2]) => {
      const s = window.__store;
      window.__app.addMedia([s.project.media[f1]], 0);
      const E = await import('/src/core/edit.js');
      const M = await import('/src/core/model.js');
      const after = M.newClip(s.project.media[f2], null, 0);
      s.commit('after', (p) => E.placeOverlay(p, after));
      const before = Object.values(s.project.items).find((i) => i.mediaId === f1);
      s.select([before.id, after.id]);
      s.seek(1);
      await window.__app.cmd('alignFaces');
      const { detectFaces } = await import('/src/ai/faces.js');
      const { renderFrameCanvas } = await import('/src/export/export.js');
      // compare where the face lands with only one layer showing at a time
      const center = async (hideAfter) => {
        s.mutate(() => (after.props.opacity = hideAfter ? 0 : 1));
        const c = await renderFrameCanvas(s.project, 1, 540);
        const fs = await detectFaces(c, 0.6);
        const f = fs.sort((p, q) => (q.x2 - q.x1) - (p.x2 - p.x1))[0];
        return f ? { x: (f.x1 + f.x2) / 2, y: (f.y1 + f.y2) / 2, w: f.x2 - f.x1 } : null;
      };
      const a = await center(true);
      const b = await center(false);
      document.querySelector('.modal-foot button')?.click();
      return { a, b, scale: after.props.scale };
    },
    [f1, f2],
  );
  const d = align.a && align.b ? Math.hypot(align.a.x - align.b.x, align.a.y - align.b.y) : 1;
  check('after face lands on the before face', d < 0.03 && Math.abs(align.a.w - align.b.w) < 0.03, JSON.stringify(align));

  // ---- freehand mask ----------------------------------------------------------------------
  const [pan] = (await importAndWait(page, [`${FIX}/pan.mp4`])).map((m) => m.id);
  await page.evaluate(async (pan) => {
    const s = window.__store;
    s.loadProject((await import('/src/core/model.js')).newProject({ width: 1280, height: 720 }));
  }, pan);
  const [pan2] = (await importAndWait(page, [`${FIX}/pan.mp4`])).map((m) => m.id);
  await page.evaluate((id) => {
    const s = window.__store;
    window.__app.addMedia([s.project.media[id]], 0);
    const it = Object.values(s.project.items)[0];
    s.select(it.id);
    s.seek(0.5);
    window.__app.cmd('freehandMask');
  }, pan2);
  await page.waitForSelector('.pen-frame');
  const fr = await page.locator('.pen-frame').boundingBox();
  // outline the photo, which starts near x 90..210 of 640 and y 100..220 of 360
  const pts = [
    [0.13, 0.26],
    [0.36, 0.26],
    [0.36, 0.64],
    [0.13, 0.64],
  ];
  for (const [x, y] of pts) await page.mouse.click(fr.x + x * fr.width, fr.y + y * fr.height);
  const mk = await page.evaluate(() => Object.values(window.__store.project.items)[0].mask);
  check('clicking on the preview draws a freehand mask', mk.type === 'path' && mk.points.length === 4, JSON.stringify(mk.points));
  await page.screenshot({ path: '/tmp/ve-proc-3.png' });
  const px = await page.evaluate(async () => {
    const s = window.__store;
    const { renderFrameCanvas } = await import('/src/export/export.js');
    const bmp = await renderFrameCanvas(s.project, 0.5, 640);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const at = (x, y) => [...g.getImageData(x, y, 1, 1).data];
    return { inside: at(160, 150), outside: at(500, 300) };
  });
  const lum = (c) => c[0] + c[1] + c[2];
  check('inside the mask shows, outside is cut away', lum(px.inside) > 60 && lum(px.outside) === 0, JSON.stringify(px));
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__app.cmd('trackMask'));
  await page.waitForFunction(() => Object.values(window.__store.project.items)[0].kf.maskDX?.length > 5, null, { timeout: 120000 });
  const tr = await page.evaluate(async () => {
    const it = Object.values(window.__store.project.items)[0];
    const M = await import('/src/core/model.js');
    return { d0: M.propAt(it, 'maskDX', 0.5), d3: M.propAt(it, 'maskDX', 3.5), dy: M.propAt(it, 'maskDY', 3.5) };
  });
  // the photo moves 60 px per second on a 640 px frame: 3 s is 0.28 of the width
  check('the mask follows the moving object', Math.abs(tr.d3 - tr.d0 - 0.28) < 0.04 && Math.abs(tr.dy) < 0.03, JSON.stringify(tr));

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
