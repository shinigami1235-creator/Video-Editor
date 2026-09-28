import { startServers, stopServers, openApp, summary, FIX, importAndWait } from './harness.mjs';

await startServers();
try {
  const { browser, page, logs } = await openApp();
  const media = await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/photo.png`]);
  const info = await page.evaluate(async (ids) => {
    const app = window.__app;
    const s = window.__store;
    const out = [];
    out.push = (x) => { console.log('STEP', JSON.stringify(x)); Array.prototype.push.call(out, x); };
    const pc = app.preview.comp;
    out.push({ step: 'start', lost: pc.gl.isContextLost() });
    app.addMedia(ids.map((id) => s.project.media[id]), 0);
    await new Promise((r) => setTimeout(r, 300));
    out.push({ step: 'after add', lost: pc.gl.isContextLost() });
    app.preview.quality = 'full';
    const { Compositor } = await import('/src/render/compositor.js');
    const c = document.createElement('canvas');
    document.body.append(c);
    const comp = new Compositor(c);
    out.push({ step: 'new comp', lost: comp.gl.isContextLost(), err: comp.gl.getError() });
    // image only
    const bmp = await (await import('/src/media/library.js')).loadImage(s.project.media[ids[1]].path);
    const provider = { frame: (it) => (it.mediaId === ids[1] ? { image: bmp, w: bmp.width, h: bmp.height } : null) };
    comp.render(s.project, 7, provider, { scale: 0.2 });
    out.push({ step: 'render image', lost: comp.gl.isContextLost(), err: comp.gl.getError() });
    // video
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.src = (await import('/src/media/library.js')).mediaUrl(s.project.media[ids[0]]);
    await new Promise((r) => (v.onloadeddata = r));
    const prov2 = { frame: (it) => (it.mediaId === ids[0] ? { image: v, w: v.videoWidth, h: v.videoHeight } : null) };
    const e = comp._upload('x', comp.itemTex, v, v.videoWidth, v.videoHeight);
    await new Promise((r) => setTimeout(r, 300));
    out.push({ step: 'upload only', lost: comp.gl.isContextLost(), ok: e.ok, rs: v.readyState });
    const c2 = new OffscreenCanvas(v.videoWidth, v.videoHeight); c2.getContext('2d').drawImage(v, 0, 0);
    const prov3 = { frame: (it) => (it.mediaId === ids[0] ? { image: c2, w: c2.width, h: c2.height } : null) };
    comp.render(s.project, 1, prov3, { scale: 0.2 });
    await new Promise((r) => setTimeout(r, 300));
    out.push({ step: 'render via canvas copy', lost: comp.gl.isContextLost() });
    comp.render(s.project, 1, prov2, { scale: 0.2 });
    await new Promise((r) => setTimeout(r, 300));
    out.push({ step: 'render video', lost: comp.gl.isContextLost(), err: comp.gl.getError() });
    for (let i = 0; i < 5; i++) comp.render(s.project, 1 + i * 0.1, prov2, { scale: 0.5 });
    await new Promise((r) => setTimeout(r, 300));
    out.push({ step: 'render video x5', lost: comp.gl.isContextLost(), err: comp.gl.getError(), prevLost: pc.gl.isContextLost() });
    return out;
  }, media.map((m) => m.id));
  console.log(JSON.stringify(info, null, 1));
  console.log(logs.filter((l) => /lost|gpu|webgl|error|warn/i.test(l)).slice(0, 30).join('\n'));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
} finally {
  stopServers();
}
process.exit(summary());
