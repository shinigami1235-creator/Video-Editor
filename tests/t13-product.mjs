// Product tools: overlays (dust, sparkles, bokeh, cocoa, snow, light leak,
// flare), moving photo with depth, upscale.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

await startServers();
try {
  const { browser, page, logs } = await openApp();
  await page.evaluate(() => (self.__ortProviders = ['wasm']));

  // ---- overlays ------------------------------------------------------------------
  const ov = await page.evaluate(async () => {
    const s = window.__store;
    const M = await import('/src/core/model.js');
    s.loadProject(M.newProject({ width: 540, height: 960 }));
    window.__app.cmd('addSolid');
    await new Promise((r) => setTimeout(r, 100));
    const solid = Object.values(s.project.items)[0];
    s.commit('bg', () => (solid.fillColor = '#1e2a33'));
    const { renderFrameCanvas } = await import('/src/export/export.js');
    const stats = async () => {
      const c = await renderFrameCanvas(s.project, 1.3, 270);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let diff = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0x1e) + Math.abs(d[i + 1] - 0x2a) + Math.abs(d[i + 2] - 0x33) > 24) diff++;
      return { diff: diff / (d.length / 4), url: await (await c.convertToBlob()).arrayBuffer().then((b) => btoa(String.fromCharCode(...new Uint8Array(b)))) };
    };
    const out = {};
    for (const k of Object.keys(M.FX_PRESETS)) {
      s.seek(0);
      await window.__app.cmd('addFx', k);
      const it = s.primary;
      const r = await stats();
      out[k] = { diff: +r.diff.toFixed(4), png: r.url, type: it.type, blend: it.blend };
      s.commit('rm', (p) => delete p.items[it.id]);
    }
    return out;
  });
  for (const [k, v] of Object.entries(ov)) {
    fs.writeFileSync(`/tmp/ve-fx-${k}.png`, Buffer.from(v.png, 'base64'));
    check(`overlay ${k} draws something`, v.type === 'fx' && v.diff > 0.002, String(v.diff));
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...Object.keys(ov).flatMap((k) => ['-i', `/tmp/ve-fx-${k}.png`]), '-filter_complex', `${Object.keys(ov).map((_, i) => `[${i}:v]`).join('')}hstack=inputs=${Object.keys(ov).length}`, '/tmp/ve-sheet-fx.png']);
  // inspector shows the overlay controls
  await page.evaluate(() => window.__app.cmd('addFx', 'sparkle'));
  await sleep(300);
  const insp = await page.evaluate(() => document.querySelector('.inspector')?.textContent || '');
  check('overlay inspector has its controls', /Overlay/.test(insp) && /Amount/.test(insp) && /Direction/.test(insp) && /Shuffle/.test(insp), insp.slice(0, 120));
  await page.screenshot({ path: '/tmp/ve-product-1.png' });

  // ---- moving photo -------------------------------------------------------------------
  const [photo] = (await importAndWait(page, [`${FIX}/face.jpg`])).map((m) => m.id);
  const depth = await page.evaluate(async (photo) => {
    const s = window.__store;
    const B = await import('/src/backend/index.js');
    const T = await import('/src/media/tools.js');
    await B.mkdir(T.toolsDir('models'));
    await B.invoke('fs_copy', { from: '/tmp/tools/models/depth_anything_v2_vits.onnx', to: T.toolsDir('models', 'depth_anything_v2_vits.onnx') });
    for (const id of Object.keys(s.project.items)) delete s.project.items[id];
    s.commit('reset', () => {});
    window.__app.addMedia([s.project.media[photo]], 0);
    const it = Object.values(s.project.items)[0];
    const D = await import('/src/ai/depth.js');
    const t0 = performance.now();
    await D.makeDepthShot(it, { motion: 'orbitPush', amount: 1.5, focus: 'middle' });
    const secs = (performance.now() - t0) / 1000;
    const map = it.effects.depth3d?.map;
    const bmp = await (await import('/src/media/library.js')).loadImage(map);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      lo = Math.min(lo, d[i]);
      hi = Math.max(hi, d[i]);
    }
    // top rows (people at the back) should be further than bottom rows (front)
    const rowMean = (y0, y1) => {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(y0 * c.height); y < y1 * c.height; y++) for (let x = 0; x < c.width; x += 4) { sum += d[(y * c.width + x) * 4]; n++; }
      return sum / n;
    };
    const { renderFrameCanvas } = await import('/src/export/export.js');
    const b64 = (u8) => {
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    const frame = async (t) => {
      const fc = await renderFrameCanvas(s.project, t, 540);
      return b64(new Uint8Array(await (await fc.convertToBlob()).arrayBuffer()));
    };
    const a = await frame(0.05);
    const b = await frame(it.duration - 0.05);
    return { map, secs, lo, hi, top: rowMean(0, 0.25), bottom: rowMean(0.75, 1), a, b, w: bmp.width, h: bmp.height };
  }, photo);
  fs.writeFileSync('/tmp/ve-depth-a.png', Buffer.from(depth.a, 'base64'));
  fs.writeFileSync('/tmp/ve-depth-b.png', Buffer.from(depth.b, 'base64'));
  check('depth map is made', !!depth.map && depth.hi - depth.lo > 100, JSON.stringify({ lo: depth.lo, hi: depth.hi, secs: depth.secs, w: depth.w }));
  check('the front of the photo is nearer than the back', depth.bottom > depth.top + 20, `${depth.top.toFixed(1)} vs ${depth.bottom.toFixed(1)}`);
  const diff = execFileSync('ffmpeg', ['-v', 'info', '-i', '/tmp/ve-depth-a.png', '-i', '/tmp/ve-depth-b.png', '-lavfi', 'ssim', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const ssimRun = String(execFileSync('bash', ['-c', "ffmpeg -hide_banner -i /tmp/ve-depth-a.png -i /tmp/ve-depth-b.png -lavfi ssim -f null - 2>&1 | grep -o 'All:[0-9.]*'"])).trim();
  void diff;
  const ssim = Number(ssimRun.split(':')[1]);
  check('the camera moves through the photo', ssim < 0.9 && ssim > 0.2, ssimRun);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', '/tmp/ve-depth-a.png', '-i', '/tmp/ve-depth-b.png', '-filter_complex', 'hstack=inputs=2', '/tmp/ve-sheet-depth.png']);

  // ---- upscale -------------------------------------------------------------------------
  const [land] = (await importAndWait(page, [`${FIX}/landscape.mp4`])).map((m) => m.id);
  const up = await page.evaluate(async (land) => {
    const s = window.__store;
    for (const id of Object.keys(s.project.items)) delete s.project.items[id];
    s.commit('reset', () => {});
    window.__app.addMedia([s.project.media[land]], 0);
    const it = Object.values(s.project.items)[0];
    const before = s.project.media[it.mediaId];
    await window.__app.cmd('upscale', it);
    const after = s.project.media[it.mediaId];
    return { before: [before.width, before.height], after: [after.width, after.height], der: it.derivations, status: after.status };
  }, land);
  check('upscale makes a bigger copy', up.after[1] === Math.min(2160, up.before[1] * 2) && up.der.includes('upscale'), JSON.stringify(up));

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
