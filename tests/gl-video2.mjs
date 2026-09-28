import { chromium } from 'playwright';
for (const src of ['/v.mp4#nocs', '/v.mp4#premul', '/v.mp4#flip']) {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage();
  await p.goto('http://localhost:8765/');
  const r = await p.evaluate(async (src) => {
    const v = document.createElement('video');
    v.muted = true; v.src = src.split('#')[0]; v.crossOrigin = 'anonymous';
    await new Promise((res) => { v.onloadeddata = res; v.onerror = () => res('err'); });
    if (v.error) return { err: v.error.message };
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    const vs = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv=p; gl_Position=vec4(p*2.-1.,0,1);} `;
    const fs = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; void main(){ o = texture(t, uv); }`;
    const sh = (ty, s) => { const x = gl.createShader(ty); gl.shaderSource(x, s); gl.compileShader(x); return x; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr); gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (src.endsWith('nocs')) gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (src.endsWith('premul')) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (src.endsWith('flip')) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const px = new Uint8Array(4); gl.readPixels(160, 90, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    await new Promise((r) => setTimeout(r, 500));
    return { lost: gl.isContextLost(), px: [...px], w: v.videoWidth };
  }, src);
  console.log(src, JSON.stringify(r));
  await b.close();
}
