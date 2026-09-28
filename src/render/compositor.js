// WebGL2 compositor shared by the preview and the export. It draws every
// visible item at time t, bottom track first, into premultiplied layers.

import { VS_QUAD, VS_FULL, FS_LAYER, FS_ADJUST, FS_COPY, FS_BLUR, FS_COMPOSITE, FS_ADD, FS_TRANSITION, FS_REGION, FS_PARTICLES, TRANSITION_TYPES } from './shaders.js';
import { visualTracks, trackItems, itemEnd, propAt, animState, sourceTimeUnclamped, previousAdjacent, nextAdjacent } from '../core/model.js';
import { parseColor, clamp } from '../core/util.js';
import { rasterText, rasterShape } from './text.js';
import { builtinLut, curvesTexture, isIdentityCurves } from './luts.js';
import { lutRegistry } from './lut-registry.js';
import { fileUrl } from '../backend/index.js';

const BLENDS = { normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4, darken: 5, lighten: 6, softlight: 7 };

// ---------------------------------------------------------------------------
// Frame plan: which items draw at time t, and how. Shared by preview/export.
// ---------------------------------------------------------------------------

export function framePlan(project, t) {
  const ops = [];
  const tracks = visualTracks(project);
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    const tr = tracks[ti];
    if (tr.hidden) continue;
    const items = trackItems(project, tr.id);
    const done = new Set();
    for (const it of items) {
      if (done.has(it.id)) continue;
      const s = it.start;
      const e = itemEnd(it);
      // transition into this item from the previous one
      const tin = it.transitionIn;
      if (tin?.type && tin.duration > 0) {
        const prev = previousAdjacent(project, it);
        const d = tin.duration;
        if (prev) {
          const w0 = s - d / 2;
          const w1 = s + d / 2;
          if (t >= w0 && t < w1) {
            ops.push({ kind: 'transition', a: prev, b: it, p: (t - w0) / d, type: tin.type });
            done.add(prev.id);
            done.add(it.id);
            continue;
          }
        } else if (t >= s && t < s + d) {
          ops.push({ kind: 'transition', a: null, b: it, p: (t - s) / d, type: tin.type });
          done.add(it.id);
          continue;
        }
      }
      if (t >= s - 1e-6 && t < e - 1e-6) {
        // the next item's transition may already have started
        const next = nextAdjacent(project, it);
        const nt = next?.transitionIn;
        if (next && nt?.type && nt.duration > 0 && t >= next.start - nt.duration / 2) {
          ops.push({ kind: 'transition', a: it, b: next, p: (t - (next.start - nt.duration / 2)) / nt.duration, type: nt.type });
          done.add(it.id);
          done.add(next.id);
          continue;
        }
        if (it.type === 'blur') ops.push({ kind: 'region', item: it });
        else if (it.type === 'adjust') ops.push({ kind: 'adjust', item: it });
        else ops.push({ kind: 'layer', item: it });
        done.add(it.id);
      }
    }
  }
  return ops;
}

/** Media clips whose frames are needed for a plan, with their source times. */
export function planSources(project, plan, t) {
  const out = [];
  const add = (it) => {
    if (!it || it.type !== 'clip') return;
    const m = project.media[it.mediaId];
    if (!m || m.kind === 'audio') return;
    const fps = m.fps || 30;
    const st = m.kind === 'image' ? 0 : clamp(sourceTimeUnclamped(it, t), 0, Math.max(0, (m.duration || 0) - 1 / fps));
    out.push({ item: it, media: m, time: st });
  };
  for (const op of plan) {
    if (op.kind === 'layer') add(op.item);
    else if (op.kind === 'transition') {
      add(op.a);
      add(op.b);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, desynchronized: false });
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    this.userLuts = new Map(); // key -> {size, data}
    this._init();
    this.lost = false;
    canvas.addEventListener?.('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener?.('webglcontextrestored', () => {
      this._init();
      this.lost = false;
      this.onRestored?.();
    });
  }

  /** Creates every GL resource. Runs again after the GPU resets. */
  _init() {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.progs = {
      layer: this._program(VS_QUAD, FS_LAYER),
      adjust: this._program(VS_FULL, FS_ADJUST),
      copy: this._program(VS_FULL, FS_COPY),
      blur: this._program(VS_FULL, FS_BLUR),
      composite: this._program(VS_FULL, FS_COMPOSITE),
      add: this._program(VS_FULL, FS_ADD),
      transition: this._program(VS_FULL, FS_TRANSITION),
      region: this._program(VS_FULL, FS_REGION),
      particles: this._program(VS_FULL, FS_PARTICLES),
    };
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.pool = [];
    this.itemTex = new Map(); // item id -> texture (video frames, text)
    this.imageTex = new Map(); // bitmap -> texture
    this.lutTex = new Map();
    this.maskTex = new Map(); // path mask shape -> texture
    this.depthTex = new Map(); // depth map path -> { tex, ok, promise }
    this.curveTex = new Map();
    this.white = this._makeTex(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.dummy3d = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.dummy3d);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  // ---- GL plumbing --------------------------------------------------------

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program: ' + gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    let unit = 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, name);
      const u = { type: info.type, loc };
      if (info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_3D) u.unit = unit++;
      uniforms[name] = u;
    }
    return { p, uniforms };
  }

  _use(prog, values) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    for (const [name, u] of Object.entries(prog.uniforms)) {
      if (u.unit != null) {
        gl.activeTexture(gl.TEXTURE0 + u.unit);
        const v = values[name];
        if (u.type === gl.SAMPLER_3D) gl.bindTexture(gl.TEXTURE_3D, v || this.dummy3d);
        else gl.bindTexture(gl.TEXTURE_2D, v || this.white);
        gl.uniform1i(u.loc, u.unit);
        continue;
      }
      if (!(name in values)) continue;
      const v = values[name];
      switch (u.type) {
        case gl.FLOAT:
          gl.uniform1f(u.loc, v);
          break;
        case gl.INT:
        case gl.BOOL:
          gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : v | 0);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(u.loc, v);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(u.loc, v);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(u.loc, v);
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(u.loc, false, v);
          break;
      }
    }
  }

  _makeTex(w, h, data = null) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _target(w, h) {
    const i = this.pool.findIndex((t) => !t.used && t.w === w && t.h === h);
    if (i >= 0) {
      this.pool[i].used = true;
      return this.pool[i];
    }
    const gl = this.gl;
    const tex = this._makeTex(w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fb, w, h, used: true };
    this.pool.push(t);
    return t;
  }

  _release(...ts) {
    for (const t of ts) if (t) t.used = false;
  }

  _bind(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
  }

  _clear(target) {
    const gl = this.gl;
    this._bind(target);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  _full(prog, values, target) {
    this._bind(target);
    this.gl.disable(this.gl.BLEND);
    this._use(prog, values);
    this._draw();
  }

  _upload(key, map, source, w, h, isStatic = false) {
    const gl = this.gl;
    let e = map.get(key);
    if (!e) {
      e = { tex: this._makeTex(1, 1), w: 0, h: 0 };
      map.set(key, e);
    }
    if (isStatic && e.src === source && e.ok) return e;
    e.src = isStatic ? source : null;
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      e.w = w;
      e.h = h;
      e.ok = true;
    } catch (err) {
      if (!e.warned) console.warn('texture upload failed', err);
      e.warned = true;
    }
    return e;
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      // drop pooled targets of the old size
      const gl = this.gl;
      for (const t of this.pool) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fb);
      }
      this.pool = [];
    }
  }

  /** Loads a depth map once. Returns its texture when ready, else null (and redraws later). */
  _depthMap(path) {
    let e = this.depthTex.get(path);
    if (e) return e.ok ? e.tex : null;
    e = { tex: null, ok: false };
    this.depthTex.set(path, e);
    e.promise = fetch(fileUrl(path))
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        if (this.lost) return;
        e.tex = this._makeTex(1, 1);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        e.ok = true;
        this.onAsyncLoad?.();
      })
      .catch((err) => console.warn('depth map failed', path, err));
    return null;
  }

  /** Waits for every depth map a project uses (the export calls this first). */
  async preload(project) {
    const maps = Object.values(project.items).map((it) => it.effects?.depth3d?.map).filter(Boolean);
    for (const m of maps) this._depthMap(m);
    await Promise.all(maps.map((m) => this.depthTex.get(m)?.promise));
  }

  /** Camera move for a moving photo at time t. */
  _depthUniforms(d, it, t) {
    const tex = this._depthMap(d.map);
    if (!tex) return null;
    const q = clamp((t - it.start) / Math.max(0.01, it.duration), 0, 1);
    const e = q * q * (3 - 2 * q);
    const s = e * 2 - 1;
    const a = d.amount ?? 1;
    let shift = [0, 0];
    let zoom = 0;
    switch (d.motion) {
      case 'pull':
        zoom = 0.22 * a * (1 - e);
        break;
      case 'orbit':
        shift = [0.045 * a * s, 0];
        break;
      case 'rise':
        shift = [0, -0.04 * a * s];
        break;
      case 'orbitPush':
        shift = [0.035 * a * s, 0];
        zoom = 0.14 * a * e;
        break;
      default:
        zoom = 0.22 * a * e;
    }
    const focus = { front: 1, middle: 0.5, back: 0 }[d.focus] ?? 0.5;
    // a little extra zoom keeps the edges from showing stretched pixels
    return { tex, shift, zoom, focus, margin: 0.05 * a };
  }

  /** Texture of a freehand mask: the closed shape filled white, softened by its feather. */
  _pathMask(mk) {
    const pts = mk.points;
    if (!pts || pts.length < 3) return null;
    const key = JSON.stringify([pts, mk.feather ?? 0.02, !!mk.smooth]);
    let e = this.maskTex.get(key);
    if (e) {
      e.used = performance.now();
      return e.tex;
    }
    const N = 512;
    const c = new OffscreenCanvas(N, N);
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, N, N);
    const blur = Math.max(0, (mk.feather ?? 0.02) * N);
    if (blur > 0.5) g.filter = `blur(${blur.toFixed(1)}px)`;
    g.fillStyle = '#fff';
    g.beginPath();
    if (mk.smooth && pts.length > 2) {
      // closed curve through the points (midpoint quadratic smoothing)
      const P = pts.map(([x, y]) => [x * N, y * N]);
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const m0 = mid(P[P.length - 1], P[0]);
      g.moveTo(m0[0], m0[1]);
      for (let i = 0; i < P.length; i++) {
        const m = mid(P[i], P[(i + 1) % P.length]);
        g.quadraticCurveTo(P[i][0], P[i][1], m[0], m[1]);
      }
    } else {
      pts.forEach(([x, y], i) => (i ? g.lineTo(x * N, y * N) : g.moveTo(x * N, y * N)));
    }
    g.closePath();
    g.fill();
    const gl = this.gl;
    const tex = this._makeTex(1, 1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    e = { tex, used: performance.now() };
    this.maskTex.set(key, e);
    // keep the cache small while a shape is being edited
    if (this.maskTex.size > 24) {
      const old = [...this.maskTex.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 8);
      for (const [k, v] of old) {
        gl.deleteTexture(v.tex);
        this.maskTex.delete(k);
      }
    }
    return tex;
  }

  forgetItem(id) {
    const e = this.itemTex.get(id);
    if (e) {
      this.gl.deleteTexture(e.tex);
      this.itemTex.delete(id);
    }
  }

  setUserLut(key, lut) {
    this.userLuts.set(key, lut);
    lutRegistry.set(key, lut);
    const old = this.lutTex.get(key);
    if (old) {
      this.gl.deleteTexture(old);
      this.lutTex.delete(key);
    }
  }

  _lut(key) {
    if (!key) return null;
    if (this.lutTex.has(key)) return this.lutTex.get(key);
    let lut = null;
    if (key.startsWith('builtin:')) lut = builtinLut(key.slice(8));
    else lut = this.userLuts.get(key) || lutRegistry.get(key);
    if (!lut) return null;
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    t.size = lut.size;
    this.lutTex.set(key, t);
    return t;
  }

  _curves(curves) {
    if (!curves || isIdentityCurves(curves)) return null;
    const key = JSON.stringify(curves);
    if (this.curveTex.has(key)) return this.curveTex.get(key);
    if (this.curveTex.size > 40) {
      for (const t of this.curveTex.values()) this.gl.deleteTexture(t);
      this.curveTex.clear();
    }
    const t = this._makeTex(256, 1, curvesTexture(curves));
    this.curveTex.set(key, t);
    return t;
  }

  // ---- blur -----------------------------------------------------------------

  /** Returns a new target holding a blurred copy of src (radius in target pixels). */
  _blurred(src, radius) {
    let cur = src;
    let owned = [];
    let level = 0;
    while (radius / 2 ** level > 5 && level < 6 && cur.w > 8 && cur.h > 8) {
      const nt = this._target(Math.max(1, cur.w >> 1), Math.max(1, cur.h >> 1));
      this._full(this.progs.copy, { u_src: cur.tex, u_opaque: false, u_bg: [0, 0, 0, 0] }, nt);
      owned.push(nt);
      cur = nt;
      level++;
    }
    const r = Math.max(0.5, radius / 2 ** level);
    const sigma = Math.max(0.6, r / 2.5);
    const step = Math.max(1, r / 8 / 1.2);
    const a = this._target(cur.w, cur.h);
    const b = this._target(cur.w, cur.h);
    this._full(this.progs.blur, { u_src: cur.tex, u_dir: [step / cur.w, 0], u_sigma: sigma / step }, a);
    this._full(this.progs.blur, { u_src: a.tex, u_dir: [0, step / cur.h], u_sigma: sigma / step }, b);
    this._release(a, ...owned);
    if (level === 0) return b;
    const out = this._target(src.w, src.h);
    this._full(this.progs.copy, { u_src: b.tex, u_opaque: false, u_bg: [0, 0, 0, 0] }, out);
    this._release(b);
    return out;
  }

  // ---- layer drawing ----------------------------------------------------------

  _colorUniforms(c = {}, it) {
    const lutTex = this._lut(c.lut);
    const curves = this._curves(c.curves);
    return {
      u_exposure: c.exposure || 0,
      u_contrast: c.contrast || 0,
      u_saturation: c.saturation || 0,
      u_vibrance: c.vibrance || 0,
      u_temperature: c.temperature || 0,
      u_tint: c.tint || 0,
      u_highlights: c.highlights || 0,
      u_shadows: c.shadows || 0,
      u_whites: c.whites || 0,
      u_blacks: c.blacks || 0,
      u_fade: c.fade || 0,
      u_hue: c.hue || 0,
      u_useCurves: !!curves,
      u_curves: curves || this.white,
      u_useLut: !!lutTex,
      u_lut: lutTex || this.dummy3d,
      u_lutMix: lutTex ? c.lutIntensity ?? 1 : 0,
      u_lutSize: lutTex?.size || 2,
      _grade: !!(
        lutTex ||
        curves ||
        c.exposure ||
        c.contrast ||
        c.saturation ||
        c.vibrance ||
        c.temperature ||
        c.tint ||
        c.highlights ||
        c.shadows ||
        c.whites ||
        c.blacks ||
        c.fade ||
        c.hue
      ),
      _it: it,
    };
  }

  /**
   * Draws a single item into a fresh target. Returns the target, or null when
   * there is nothing to draw yet.
   */
  _layer(project, it, t, provider, ctx) {
    if (it.type === 'fx') return this._fxLayer(it, t, ctx);
    const { W, H, s } = ctx;
    const gl = this.gl;
    let tex = null;
    let cw = 0;
    let ch = 0;
    let packed = 0;
    let mode = 0;
    let solid = null;
    let solid2 = null;
    let texW = 1;
    let texH = 1;
    if (it.type === 'clip') {
      const m = project.media[it.mediaId];
      if (!m) return null;
      const src = provider.frame(it);
      let e = null;
      if (src?.image) {
        if (m.kind === 'image') {
          e = this.imageTex.get(src.image);
          if (!e) e = this._upload(src.image, this.imageTex, src.image, src.w, src.h);
        } else e = this._upload(it.id, this.itemTex, src.image, src.w, src.h);
      } else e = this.itemTex.get(it.id);
      if (!e?.ok) return null;
      tex = e.tex;
      texW = e.w;
      texH = e.h;
      packed = m.alphaPacked === 'v' ? 1 : m.alphaPacked === 'h' ? 2 : 0;
      const mw = m.width || texW;
      const mh = m.height || texH;
      const fit = it.fit === 'cover' ? Math.max(W / mw, H / mh) : it.fit === 'stretch' ? 0 : Math.min(W / mw, H / mh);
      if (fit === 0) {
        cw = W;
        ch = H;
      } else {
        cw = mw * fit;
        ch = mh * fit;
      }
    } else if (it.type === 'text') {
      const r = rasterText(it, t - it.start, W, Math.min(2, s * Math.max(1, it.props.scale || 1)));
      const e = this._upload(it.id, this.itemTex, r.canvas, r.canvas.width, r.canvas.height, true);
      tex = e.tex;
      texW = e.w;
      texH = e.h;
      cw = r.w;
      ch = r.h;
    } else if (it.type === 'shape') {
      const r = rasterShape(it, Math.min(2, s * Math.max(1, it.props.scale || 1)));
      const e = this._upload(it.id, this.itemTex, r.canvas, r.canvas.width, r.canvas.height, true);
      tex = e.tex;
      texW = e.w;
      texH = e.h;
      cw = r.w;
      ch = r.h;
    } else if (it.type === 'solid') {
      mode = it.gradient ? 2 : 1;
      solid = parseColor(it.fillColor);
      solid2 = it.gradient ? parseColor(it.gradient.color2) : solid;
      cw = W;
      ch = H;
    } else return null;

    const an = animState(it, t);
    const P = (k) => propAt(it, k, t);
    const scale = P('scale') * an.scale;
    const sx = scale * (it.props.scaleX ?? 1);
    const sy = scale * (it.props.scaleY ?? 1);
    const rot = ((P('rotation') + an.rotation) * Math.PI) / 180;
    const cx = W / 2 + P('x') + an.dx * W;
    const cy = H / 2 + P('y') + an.dy * H;
    const cl = clamp(P('cropL'), 0, 0.95);
    const ct = clamp(P('cropT'), 0, 0.95);
    const cr = clamp(P('cropR'), 0, 0.95 - cl);
    const cb = clamp(P('cropB'), 0, 0.95 - ct);
    // quad (0..1) -> crop region -> centred content px -> rotate -> translate -> clip space
    const x0 = cl;
    const y0 = ct;
    const qw = 1 - cl - cr;
    const qh = 1 - ct - cb;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // local (lx,ly) -> px: ((x0 + lx*qw) - 0.5)*cw*sx, ((y0 + ly*qh) - 0.5)*ch*sy
    const ax = qw * cw * sx;
    const bx = (x0 - 0.5) * cw * sx;
    const ay = qh * ch * sy;
    const by = (y0 - 0.5) * ch * sy;
    // x' = cos*px - sin*py + cx ; y' = sin*px + cos*py + cy
    // ndc.x = x'/W*2-1 ; ndc.y = 1 - y'/H*2
    const m00 = (cos * ax * 2) / W;
    const m01 = (-sin * ay * 2) / W;
    const m02 = ((cos * bx - sin * by + cx) * 2) / W - 1;
    const m10 = (-(sin * ax) * 2) / H;
    const m11 = (-(cos * ay) * 2) / H;
    const m12 = 1 - ((sin * bx + cos * by + cy) * 2) / H;
    const mat = new Float32Array([m00, m10, 0, m01, m11, 0, m02, m12, 1]);

    const c = it.color || {};
    const fx = it.effects || {};
    const mk = it.mask || {};
    const cu = this._colorUniforms(c, it);
    const depth = it.type === 'clip' && fx.depth3d?.map ? this._depthUniforms(fx.depth3d, it, t) : null;
    let maskType = { none: 0, rect: 1, ellipse: 2, wipe: 3, split: 3, path: 4 }[mk.type] || 0;
    const maskTex = maskType === 4 ? this._pathMask(mk) : null;
    if (maskType === 4 && !maskTex) maskType = 0;
    const target = this._target(ctx.rw, ctx.rh);
    this._clear(target);
    gl.disable(gl.BLEND);
    this._use(this.progs.layer, {
      ...cu,
      u_mat: mat,
      u_src: tex || this.white,
      u_mode: mode,
      u_color: solid || [1, 1, 1, 1],
      u_color2: solid2 || [1, 1, 1, 1],
      u_gradAngle: it.gradient?.angle ?? 180,
      u_uvRect: [0, 0, 1, 1],
      u_localRect: [x0, y0, x0 + qw, y0 + qh],
      u_packed: packed,
      u_flipX: !!it.flipX,
      u_flipY: !!it.flipY,
      u_opacity: clamp(P('opacity') * an.opacity, 0, 1),
      u_texel: [1 / Math.max(1, texW), 1 / Math.max(1, texH)],
      u_sharpen: c.sharpen || 0,
      u_res: [ctx.rw, ctx.rh],
      u_time: t,
      u_grain: c.grain || 0,
      u_vignette: c.vignette || 0,
      u_chromatic: fx.chromatic || 0,
      u_pixelate: fx.pixelate || 0,
      u_chroma: !!fx.chroma?.enabled,
      u_chromaColor: parseColor(fx.chroma?.color || '#00ff00').slice(0, 3),
      u_chromaSim: fx.chroma?.similarity ?? 0.35,
      u_chromaSmooth: fx.chroma?.smoothness ?? 0.08,
      u_chromaSpill: fx.chroma?.spill ?? 0.3,
      u_maskType: maskType,
      u_mask: [mk.x ?? 0.5, mk.y ?? 0.5, mk.w ?? 0.6, mk.h ?? 0.6],
      u_maskRadius: mk.radius || 0,
      u_maskAngle: mk.angle || 0,
      u_maskFeather: mk.feather ?? 0.02,
      u_maskPos: P('maskPos'),
      u_maskTex: maskTex,
      u_depthOn: !!depth,
      u_depth: depth?.tex || null,
      u_depthShift: depth?.shift || [0, 0],
      u_depthZoom: depth?.zoom || 0,
      u_depthFocus: depth?.focus || 0,
      u_depthMargin: depth?.margin || 0,
      u_maskOff: [P('maskDX') || 0, P('maskDY') || 0],
      u_maskInvert: !!mk.invert,
      u_maskLine: maskType === 3 && mk.line !== false,
      u_maskLineColor: parseColor(mk.lineColor || '#ffffff'),
      u_maskLineWidth: (mk.lineWidth ?? 4) * s,
      u_wipe: an.wipe,
      u_letterbox: fx.letterbox || 0,
      u_mirror: !!fx.mirror,
      u_grade: cu._grade,
    });
    this._draw();

    let out = target;
    const blurPx = Math.max((P('blur') || 0) * 40, an.blur || 0);
    if (blurPx > 0.3) {
      const b = this._blurred(out, blurPx * s);
      this._release(out);
      out = b;
    }
    if (fx.glow > 0.01) {
      const g = this._blurred(out, 18 * s);
      const o2 = this._target(ctx.rw, ctx.rh);
      this._full(this.progs.add, { u_a: out.tex, u_b: g.tex, u_amount: fx.glow * 1.5 }, o2);
      this._release(out, g);
      out = o2;
    }
    return out;
  }

  /** Procedural overlay (dust, sparkles, bokeh, light leak, flare). */
  _fxLayer(it, t, ctx) {
    const f = it.fx || {};
    const an = animState(it, t);
    const P = (k) => propAt(it, k, t);
    const kinds = { dust: 0, sparkle: 1, bokeh: 2, leak: 3, flare: 4 };
    const out = this._target(ctx.rw, ctx.rh);
    this._full(
      this.progs.particles,
      {
        u_res: [ctx.rw, ctx.rh],
        u_scale: ctx.s,
        u_time: t - it.start + (f.seed || 0) * 3.1,
        u_kind: kinds[f.kind] ?? 0,
        u_color: parseColor(f.color || '#ffffff').slice(0, 3),
        u_density: clamp(f.density ?? 0.5, 0, 1),
        u_size: f.size ?? 12,
        u_speed: f.speed ?? 0.5,
        u_seed: f.seed || 0,
        u_angle: f.angle ?? -90,
        u_variety: f.variety || 0,
        u_opacity: clamp(P('opacity') * an.opacity, 0, 1),
        u_pos: [0.5 + P('x') / ctx.W, 0.5 + P('y') / ctx.H],
      },
      out,
    );
    return out;
  }

  /** A clip layer, with its blurred-copy backdrop underneath when that effect is on. */
  _layerFull(project, it, t, provider, ctx) {
    if (it.type !== 'clip' || !it.effects?.backdrop) return this._layer(project, it, t, provider, ctx);
    const bgItem = {
      ...it,
      fit: 'cover',
      props: { ...it.props, x: 0, y: 0, scale: 1.08, rotation: 0, opacity: 1, cropL: 0, cropR: 0, cropT: 0, cropB: 0, blur: 1.1 },
      kf: {},
      anim: { in: null, out: null, loop: null },
      mask: { type: 'none' },
      effects: { chroma: it.effects.chroma },
      color: { ...it.color, exposure: (it.color?.exposure || 0) - 0.35 },
      flipX: false,
      flipY: false,
    };
    const B = this._layer(project, bgItem, t, provider, ctx);
    const L = this._layer(project, it, t, provider, ctx);
    if (!B) return L;
    if (!L) return B;
    const out = this._composite(B, L);
    this._release(L);
    return out;
  }

  _composite(acc, layer, blend = 'normal', amount = 1) {
    const out = this._target(acc.w, acc.h);
    this._full(this.progs.composite, { u_dst: acc.tex, u_src: layer.tex, u_blend: BLENDS[blend] ?? 0, u_amount: amount }, out);
    this._release(acc);
    return out;
  }

  _region(acc, it, t, ctx) {
    const { W, H, s } = ctx;
    const P = (k) => propAt(it, k, t);
    const scale = P('scale');
    const cx = (W / 2 + P('x')) * s;
    const cy = (H / 2 + P('y')) * s;
    const hw = ((it.w * scale) / 2) * s;
    const hh = ((it.h * scale) / 2) * s;
    const mode = { blur: 0, pixelate: 1, solid: 2 }[it.mode] ?? 0;
    let blurred = null;
    if (mode === 0) blurred = this._blurred(acc, Math.max(4, (it.amount ?? 0.6) * 60 * s));
    const out = this._target(acc.w, acc.h);
    const an = animState(it, t);
    this._full(
      this.progs.region,
      {
        u_src: acc.tex,
        u_blurred: blurred ? blurred.tex : acc.tex,
        u_mode: mode,
        u_fill: parseColor(it.fillColor || '#000'),
        u_res: [acc.w, acc.h],
        u_center: [cx, cy],
        u_half: [hw * an.scale, hh * an.scale],
        u_rot: (P('rotation') * Math.PI) / 180,
        u_shape: it.shape === 'rect' ? 0 : 1,
        u_feather: it.feather ?? 0.2,
        u_amount: (it.amount ?? 0.6) * s,
      },
      out,
    );
    this._release(acc, blurred);
    return out;
  }

  _adjust(acc, it, t, ctx) {
    const c = it.color || {};
    const cu = this._colorUniforms(c, it);
    const out = this._target(acc.w, acc.h);
    const an = animState(it, t);
    this._full(
      this.progs.adjust,
      {
        ...cu,
        u_src: acc.tex,
        u_amount: clamp(propAt(it, 'opacity', t) * an.opacity, 0, 1),
        u_res: [acc.w, acc.h],
        u_time: t,
        u_grain: c.grain || 0,
        u_vignette: c.vignette || 0,
        u_letterbox: it.effects?.letterbox || 0,
      },
      out,
    );
    this._release(acc);
    let res = out;
    const blur = propAt(it, 'blur', t);
    if (blur > 0.01) {
      const b = this._blurred(res, blur * 40 * ctx.s);
      this._release(res);
      res = b;
    }
    return res;
  }

  /**
   * Renders the frame at time t. provider.frame(item) returns
   * { image, w, h } for media clips (or null while loading).
   * scale is render pixels per project pixel.
   */
  render(project, t, provider, { scale = 1, plan = null, transparent = false, size = null } = {}) {
    if (this.lost) return;
    const gl = this.gl;
    const W = project.settings.width;
    const H = project.settings.height;
    // exports pass an exact size so rounding never changes the encoded frame size
    const rw = size ? size[0] : Math.max(2, Math.round(W * scale));
    const rh = size ? size[1] : Math.max(2, Math.round(H * scale));
    this.resize(rw, rh);
    const ctx = { W, H, s: scale, rw, rh };
    plan ||= framePlan(project, t);
    let acc = this._target(rw, rh);
    this._clear(acc);
    for (const op of plan) {
      try {
        if (op.kind === 'layer') {
          const L = this._layerFull(project, op.item, t, provider, ctx);
          if (L) {
            acc = this._composite(acc, L, op.item.blend);
            this._release(L);
          }
        } else if (op.kind === 'transition') {
          const A = op.a ? this._layerFull(project, op.a, t, provider, ctx) : null;
          const B = this._layerFull(project, op.b, t, provider, ctx);
          const out = this._target(rw, rh);
          const empty = this._target(rw, rh);
          this._clear(empty);
          const type = TRANSITION_TYPES[op.type]?.id ?? 0;
          let ab = null;
          if (type === 11) {
            const mixT = this._target(rw, rh);
            this._full(this.progs.transition, { u_a: (A || empty).tex, u_b: (B || empty).tex, u_p: op.p, u_type: 0, u_res: [rw, rh] }, mixT);
            ab = this._blurred(mixT, 40 * scale);
            this._release(mixT);
          }
          this._full(
            this.progs.transition,
            { u_a: (A || empty).tex, u_b: (B || empty).tex, u_ab: (ab || empty).tex, u_p: op.p, u_type: type, u_res: [rw, rh] },
            out,
          );
          acc = this._composite(acc, out, op.b.blend);
          this._release(A, B, out, empty, ab);
        } else if (op.kind === 'region') {
          acc = this._region(acc, op.item, t, ctx);
        } else if (op.kind === 'adjust') {
          acc = this._adjust(acc, op.item, t, ctx);
        }
      } catch (e) {
        console.error('render op failed', op, e);
      }
    }
    const bg = parseColor(project.settings.background || '#000');
    this._bind(null);
    gl.disable(gl.BLEND);
    this._use(this.progs.copy, { u_src: acc.tex, u_bg: bg, u_opaque: !transparent });
    this._draw();
    this._release(acc);
    for (const p of this.pool) p.used = false;
  }

  /** Reads the canvas as an ImageData-like RGBA buffer (top row first). */
  readPixels() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const row = w * 4;
    const tmp = new Uint8Array(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row;
      const b = (h - 1 - y) * row;
      tmp.set(buf.subarray(a, a + row));
      buf.copyWithin(a, b, b + row);
      buf.set(tmp, b);
    }
    return { data: buf, width: w, height: h };
  }

  dispose() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
