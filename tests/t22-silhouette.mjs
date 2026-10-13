// Silhouette: a cut-out subject turned into a solid colour, a shaded colour or
// an outline, a shadow that follows it, and a second video inside the shape,
// all checked on exported frames.
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
    const path = be.join(be.paths.temp, 'sil-circle.png');
    await be.writeBytes(path, new Uint8Array(await blob.arrayBuffer()), { offset: 0, truncate: true });
    (await import('/src/project-io.js')).createProject({ name: 'Silhouette', width: 400, height: 400 });
    return path;
  });
  const [circ, land, photo] = (await importAndWait(page, [circle, `${FIX}/landscape.mp4`, `${FIX}/photo.png`])).map((m) => m.id);
  const base = await page.evaluate(async (circ) => {
    const s = window.__store;
    const M = await import('/src/core/model.js');
    let id = null;
    s.commit('Set up', (p) => {
      const c = M.newClip(p.media[circ], p.tracks.find((t) => t.kind === 'video').id, 0, { duration: 3 });
      p.items[c.id] = c;
      id = c.id;
    });
    return id;
  }, circ);

  const frame = async (name, edit) => {
    const out = `/tmp/ve-sil-${name}.png`;
    await page.evaluate(
      async ([id, edit, out]) => {
        const s = window.__store;
        if (edit) s.commit('Edit', (p) => (p.items[id].effects.silhouette = edit));
        const { exportFrame } = await import('/src/export/export.js');
        await exportFrame(s.project, 1, out);
      },
      [base, edit, out],
    );
    return out;
  };

  // Make a silhouette on a photo that already has transparency: no model window
  await page.evaluate((id) => window.__store.select(id), base);
  await page.evaluate((id) => window.__app.cmd('silhouette', window.__store.project.items[id]), base);
  const made = await page.evaluate((id) => ({ sil: window.__store.project.items[id].effects.silhouette, modal: !!document.querySelector('.modal') }), base);
  check('Make a silhouette on a see-through photo turns it on without asking for a model', made.sil?.on && made.sil.style === 'fill' && !made.modal, JSON.stringify(made));

  let f = await frame('fill', { on: true, style: 'fill', color: '#00ff00', width: 6 });
  check('solid colour: the shape is green and the rest stays clear', near(pixel(f, 200, 200), [0, 255, 0], 8) && near(pixel(f, 10, 10), [0, 0, 0], 8), JSON.stringify([pixel(f, 200, 200), pixel(f, 10, 10)]));

  f = await frame('shaded', { on: true, style: 'shaded', color: '#00ff00', width: 6 });
  const sh = pixel(f, 200, 200);
  check('colour with shading: a darker green that follows the brightness', sh[1] > 60 && sh[1] < 180 && sh[1] > sh[0] * 3 && sh[1] > sh[2] * 3, JSON.stringify(sh));

  f = await frame('outline', { on: true, style: 'outline', color: '#00ff00', width: 10 });
  const ol = { edge: pixel(f, 320, 200), middle: pixel(f, 200, 200), outside: pixel(f, 345, 200) };
  check('outline only: a green line on the edge, empty inside and out', ol.edge[1] > 150 && near(ol.middle, [0, 0, 0], 10) && near(ol.outside, [0, 0, 0], 10), JSON.stringify(ol));

  // shadow: a soft dark copy on the layer below, offset down and right
  await page.evaluate(
    (id) =>
      window.__store.commit('White', (p) => {
        p.settings.background = '#ffffff';
        p.items[id].effects.silhouette.on = false;
      }),
    base,
  );
  const shadowId = await page.evaluate((id) => window.__app.cmd('silhouetteShadow', window.__store.project.items[id]), base);
  const shadow = await page.evaluate(
    ([id, sid]) => {
      const p = window.__store.project;
      const vids = p.tracks.filter((t) => t.kind === 'video');
      const s = p.items[sid];
      const idx = (tid) => vids.findIndex((t) => t.id === tid);
      return { below: idx(s.trackId) > idx(p.items[id].trackId), sil: s.effects.silhouette, opacity: s.props.opacity, muted: s.muted, x: s.props.x, y: s.props.y };
    },
    [base, shadowId],
  );
  check('Add a shadow puts a black, half see-through copy on the layer below', shadow.below && shadow.sil?.on && shadow.sil.color === '#000000' && shadow.opacity === 0.5 && shadow.muted && shadow.x > 0 && shadow.y > 0, JSON.stringify(shadow));
  f = await frame('shadow');
  const sp = { corner: pixel(f, 10, 10), shadow: pixel(f, 326, 212), subject: pixel(f, 200, 200) };
  check('the shadow shows grey beside the subject on a white frame', near(sp.corner, [255, 255, 255], 6) && sp.shadow[0] < 225 && sp.shadow[0] > 60 && near(sp.shadow, [sp.shadow[0], sp.shadow[0], sp.shadow[0]], 12) && near(sp.subject, [255, 0, 0], 10), JSON.stringify(sp));

  // a second video inside the shape
  const top = await page.evaluate(async (land) => {
    const s = window.__store;
    const M = await import('/src/core/model.js');
    let id = null;
    s.commit('Top', (p) => {
      const tr = M.newTrack('video', 'Video 3');
      p.tracks.unshift(tr);
      const v = M.newClip(p.media[land], tr.id, 0, { duration: 3 });
      v.fit = 'cover';
      p.items[v.id] = v;
      id = v.id;
    });
    return id;
  }, land);
  await page.evaluate((id) => window.__app.cmd('fillSilhouette', window.__store.project.items[id]), base);
  const matte = await page.evaluate((id) => window.__store.project.items[id].matte, top);
  f = await frame('filled');
  const fp = { corner: pixel(f, 10, 10), centre: pixel(f, 200, 200) };
  check('Fill it with the clip above shows the video only inside the shape', matte === 'inside' && near(fp.corner, [255, 255, 255], 6) && !near(fp.centre, [255, 0, 0], 40), JSON.stringify({ matte, ...fp }));

  // the inspector section
  await page.evaluate((id) => window.__store.commit('On', (p) => (p.items[id].effects.silhouette.on = true)), base);
  await page.evaluate((id) => window.__store.select(id), base);
  await page.locator('.inspector .tab', { hasText: 'Effects' }).first().click();
  await sleep(200);
  const ui = await page.evaluate(() => {
    const t = document.querySelector('.inspector').textContent;
    return { section: /Silhouette/.test(t), look: /Outline only/.test(t), shadow: /Add a shadow that follows it/.test(t), fill: /Fill it with the clip above/.test(t) };
  });
  check('Effects tab has the silhouette controls', Object.values(ui).every(Boolean), JSON.stringify(ui));
  await page.locator('.inspector .chip', { hasText: 'Gold' }).first().click();
  const gold = await page.evaluate((id) => window.__store.project.items[id].effects.silhouette.color, base);
  check('the colour chips change the colour', gold === '#c9a24a', gold);

  // a photo with no transparency asks for the model first, and closing that leaves it alone
  const opaque = await page.evaluate(async (photo) => {
    const s = window.__store;
    const M = await import('/src/core/model.js');
    let id = null;
    s.commit('Photo', (p) => {
      const c = M.newClip(p.media[photo], p.tracks.find((t) => t.kind === 'video').id, 5, { duration: 3 });
      p.items[c.id] = c;
      id = c.id;
    });
    return id;
  }, photo);
  const pending = page.evaluate((id) => window.__app.cmd('silhouette', window.__store.project.items[id]), opaque);
  await page.waitForSelector('.modal');
  await page.keyboard.press('Escape');
  await pending;
  const left = await page.evaluate((id) => window.__store.project.items[id].effects.silhouette || null, opaque);
  check('a photo without transparency asks for the model, and closing it changes nothing', !left, JSON.stringify(left));
  await page.screenshot({ path: '/tmp/ve-sil.png' });

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
