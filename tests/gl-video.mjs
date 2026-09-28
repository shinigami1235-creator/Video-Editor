import { chromium } from 'playwright';
for (const args of [['--use-angle=swiftshader', '--enable-unsafe-swiftshader']]) {
for (const mode of ['plain','nocs','premul0','flip0','all']) {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', ...args] });
  const p = await b.newPage();
  const logs = [];
  p.on('console', (m) => logs.push(m.text()));
  await p.goto('http://localhost:8765/'); await p.evaluate((m)=>window.__mode=m, mode);
  const r = await p.evaluate(async () => {
    const v = document.createElement('video');
    v.muted = true; v.src = window.__src || '/v.webm'; v.crossOrigin = 'anonymous';
    await new Promise((res) => { v.onloadeddata = res; v.onerror = res; });
    v.currentTime = 1; await new Promise((res) => (v.onseeked = res));
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; document.body.append(c);
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    const out = { renderer: gl.getParameter(gl.RENDERER) };
    const mode = window.__mode;
    if (mode==='nocs'||mode==='all') gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (mode==='premul0'||mode==='all') gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (mode==='flip0'||mode==='all') gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); out.upload = 'ok'; } catch (e) { out.upload = e.message; }
    await new Promise((r) => setTimeout(r, 1000));
    out.lostAfterVideo = gl.isContextLost();
    // canvas 2d path
    const c2 = new OffscreenCanvas(320, 180); c2.getContext('2d').drawImage(v, 0, 0, 320, 180);
    if (!gl.isContextLost()) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c2); }
    await new Promise((r) => setTimeout(r, 500));
    out.lostAfterCanvas = gl.isContextLost();
    // VideoFrame path
    try { const vf = new VideoFrame(v); if (!gl.isContextLost()) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vf); vf.close(); out.vf = 'ok'; } catch (e) { out.vf = e.message; }
    await new Promise((r) => setTimeout(r, 500));
    out.lostAfterVF = gl.isContextLost();
    return out;
  });
  console.log(mode, JSON.stringify(r), logs.filter((l) => /lost|GPU/i.test(l)).slice(0, 3));
  await b.close();
}
}
