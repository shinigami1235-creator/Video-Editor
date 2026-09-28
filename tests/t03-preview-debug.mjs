import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

await startServers();
try {
  const { browser, page, logs } = await openApp();
  const media = await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/photo.png`]);
  const info = await page.evaluate(async (ids) => {
    const app = window.__app;
    const s = window.__store;
    app.addMedia(ids.map((id) => s.project.media[id]), 0);
    const out = [];
    for (const t of [0.5, 2, 7]) {
      app.seek(t);
      await new Promise((r) => setTimeout(r, 1500));
      const gl = app.preview.comp.gl;
      const els = [...app.preview.els.values()].map((e) => ({ rs: e.el.readyState, seeking: e.el.seeking, ct: e.el.currentTime, err: e.el.error?.message || null, src: e.el.src.slice(0, 80), vw: e.el.videoWidth }));
      const { data } = app.preview.comp.readPixels();
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
      out.push({ t, lost: gl.isContextLost(), compLost: app.preview.comp.lost, mean: sum / (data.length / 4) / 3, els, plan: (await import('/src/render/compositor.js')).framePlan(s.project, t).map((o) => o.kind + ':' + (o.item?.name || '')) });
    }
    return out;
  }, media.map((m) => m.id));
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: '/tmp/ve-shot-03.png' });
  console.log(logs.filter((l) => /lost|gpu|webgl|error|warn/i.test(l)).slice(0, 30).join('\n'));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
} finally {
  stopServers();
}
process.exit(summary());
