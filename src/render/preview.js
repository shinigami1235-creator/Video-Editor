// Live preview: keeps a pool of <video>/<audio> elements in step with the
// playhead, feeds their frames to the compositor and mixes their sound.

import { Compositor, framePlan, planSources } from './compositor.js';
import { store } from '../core/store.js';
import { itemEnd, instantSpeed, propAt, sourceTimeUnclamped, isVisualItem, trackItems } from '../core/model.js';
import { mediaUrl, loadImage } from '../media/library.js';
import { clamp } from '../core/util.js';
import { voiceActive } from '../export/audio-mix.js';
import { audioFx, EQ_BANDS, ensurePitched, pitchedSync, pitchFailed } from '../media/audio-fx.js';
import { fileUrl } from '../backend/index.js';

const PREROLL = 1.2;

export function audibleAt(project, t) {
  const out = [];
  for (const tr of project.tracks) {
    if (tr.muted) continue;
    for (const it of trackItems(project, tr.id)) {
      if (it.type !== 'clip' || it.muted) continue;
      if (t < it.start || t >= itemEnd(it)) continue;
      const m = project.media[it.mediaId];
      if (!m?.hasAudio) continue;
      out.push(it);
    }
  }
  return out;
}

/** Gain for an audio-producing item at time t (volume, fades, ducking). */
export function itemGain(project, it, t, audible) {
  const tr = project.tracks.find((x) => x.id === it.trackId);
  if (!tr || tr.muted || it.muted) return 0;
  let g = propAt(it, 'volume', t) * (tr.volume ?? 1);
  const local = t - it.start;
  if (it.fadeIn > 0 && local < it.fadeIn) g *= clamp(local / it.fadeIn, 0, 1);
  if (it.fadeOut > 0 && local > it.duration - it.fadeOut) g *= clamp((it.duration - local) / it.fadeOut, 0, 1);
  if (it.duck && audible && voiceActive(project, t, audible)) g *= project.settings.duckLevel ?? 0.25;
  return Math.max(0, g);
}

export class Preview {
  constructor(canvas) {
    this.canvas = canvas;
    this.comp = new Compositor(canvas);
    this.comp.onRestored = () => (this.dirty = true);
    this.comp.onAsyncLoad = () => (this.dirty = true);
    this.els = new Map();
    this.bitmaps = new Map();
    this.audioCtx = null;
    this.master = null;
    this.dirty = true;
    this.playing = false;
    this.displayWidth = 400;
    this.quality = 'auto';
    this.loop = false;
    this.volume = 1;
    this._clock = null;
    this.onTick = null;
    this.provider = { frame: (it) => this._frame(it) };
    this._raf = requestAnimationFrame((ts) => this._loop(ts));
    window.addEventListener('ve-fonts-changed', () => this.invalidate());
  }

  invalidate() {
    this.dirty = true;
  }

  get scale() {
    const W = store.project.settings.width;
    const base = Math.min(1, (this.displayWidth * (window.devicePixelRatio || 1)) / W);
    const q = this.quality === 'full' ? 1 : this.quality === 'half' ? 0.5 : this.quality === 'quarter' ? 0.3 : this.playing ? 0.6 : 1;
    return Math.max(0.1, base * q);
  }

  // ---- playback ---------------------------------------------------------------

  _ensureAudio() {
    if (this.audioCtx) return;
    try {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.audioCtx.createGain();
      this.master.connect(this.audioCtx.destination);
      // left and right analysers for the level meters
      const split = this.audioCtx.createChannelSplitter(2);
      this.master.connect(split);
      this.meters = [0, 1].map((ch) => {
        const a = this.audioCtx.createAnalyser();
        a.fftSize = 2048;
        split.connect(a, ch);
        return a;
      });
      for (const e of this.els.values()) this._route(e);
    } catch (err) {
      console.warn('audio context failed', err);
    }
  }

  _route(e) {
    if (!this.audioCtx || e.node) return;
    try {
      e.node = this.audioCtx.createMediaElementSource(e.el);
      e.gain = this.audioCtx.createGain();
      e.gain.gain.value = 0;
      e.eq = EQ_BANDS.map((b) => {
        const f = this.audioCtx.createBiquadFilter();
        f.type = b.type;
        f.frequency.value = b.f;
        if (b.type === 'peaking') f.Q.value = b.q;
        f.gain.value = 0;
        return f;
      });
      let node = e.node;
      for (const f of e.eq) node = node.connect(f);
      e.pan = this.audioCtx.createStereoPanner ? this.audioCtx.createStereoPanner() : null;
      if (e.pan) node.connect(e.gain).connect(e.pan).connect(this.master);
      else node.connect(e.gain).connect(this.master);
      e.el.volume = 1;
    } catch (err) {
      console.warn('audio routing failed', err);
    }
  }

  play() {
    if (this.playing) return;
    this._ensureAudio();
    this.audioCtx?.resume();
    const end = this._endTime();
    if (store.playhead >= end - 0.02) store.seek(store.inPoint ?? 0);
    this.playing = true;
    store.playing = true;
    this._clock = { wall: performance.now(), t: store.playhead };
    store.emit('play', true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    store.playing = false;
    for (const e of this.els.values()) if (!e.el.paused) e.el.pause();
    store.seek(store.snapTime(store.playhead));
    this.dirty = true;
    store.emit('play', false);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Peak and RMS of the left and right output over the last few milliseconds, or null before playback starts. */
  levels() {
    if (!this.meters) return null;
    const buf = this._meterBuf || (this._meterBuf = new Float32Array(this.meters[0].fftSize));
    return this.meters.map((a) => {
      a.getFloatTimeDomainData(buf);
      let pk = 0;
      let sq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > pk) pk = v;
        sq += v * v;
      }
      return { peak: pk, rms: Math.sqrt(sq / buf.length) };
    });
  }

  _endTime() {
    if (store.outPoint != null) return store.outPoint;
    return store.duration;
  }

  // ---- element pool -----------------------------------------------------------

  _ensure(it, m, asAudio, key = it.id, forceUrl = null) {
    let e = this.els.get(key);
    const url = forceUrl || mediaUrl(m);
    if (e && e.url === url) return e;
    if (e) this._drop(key);
    if (!url) return null;
    const el = document.createElement(asAudio ? 'audio' : 'video');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.playsInline = true;
    el.muted = false;
    el.volume = 0;
    el.preservesPitch = true;
    el.src = url;
    e = { el, url, item: it.id, lastUsed: performance.now(), node: null, gain: null, eq: null, pending: null };
    el.addEventListener('seeked', () => {
      if (e.pending != null) {
        const p = e.pending;
        e.pending = null;
        el.currentTime = p;
      }
      this.dirty = true;
    });
    el.addEventListener('loadeddata', () => (this.dirty = true));
    el.addEventListener('error', () => console.warn('media element error', url, el.error));
    this.els.set(key, e);
    this._route(e);
    return e;
  }

  _drop(id) {
    const e = this.els.get(id);
    if (!e) return;
    try {
      e.el.pause();
      e.node?.disconnect();
      e.gain?.disconnect();
      e.eq?.forEach((f) => f.disconnect());
      e.el.removeAttribute('src');
      e.el.load();
    } catch {}
    this.els.delete(id);
    this.comp.forgetItem(id);
  }

  _seek(e, time) {
    const el = e.el;
    if (el.seeking) {
      e.pending = time;
      return;
    }
    if (Math.abs(el.currentTime - time) > 0.004) el.currentTime = time;
  }

  _frame(it) {
    const m = store.project.media[it.mediaId];
    if (!m) return null;
    if (m.kind === 'image') {
      const path = m.display || m.path;
      const b = this.bitmaps.get(path);
      if (b) return { image: b, w: b.width, h: b.height };
      if (!this.bitmaps.has(path)) {
        this.bitmaps.set(path, null);
        loadImage(path)
          .then((bmp) => {
            this.bitmaps.set(path, bmp);
            this.dirty = true;
          })
          .catch(() => this.bitmaps.delete(path));
      }
      return null;
    }
    const e = this.els.get(it.id);
    if (!e || e.el.readyState < 2) return null;
    return { image: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
  }

  /** Brings elements in line with time t. */
  _sync(t) {
    const project = store.project;
    const now = performance.now();
    const plan = framePlan(project, t);
    const needed = planSources(project, plan, t);
    const want = new Map();
    for (const n of needed) if (n.media.kind === 'video') want.set(n.item.id, { item: n.item, media: n.media, time: n.time, audio: false });
    const audible = audibleAt(project, t);
    for (const it of audible) {
      if (want.has(it.id)) continue;
      const m = project.media[it.mediaId];
      want.set(it.id, { item: it, media: m, time: clamp(sourceTimeUnclamped(it, t), 0, m.duration || 0), audio: !isVisualItem(project, it) || m.kind === 'audio' });
    }
    // preroll upcoming clips so they start without a stall
    const horizon = this.playing ? PREROLL : 0.25;
    for (const it of Object.values(project.items)) {
      if (it.type !== 'clip' || want.has(it.id)) continue;
      if (it.start > t && it.start - t < horizon) {
        const m = project.media[it.mediaId];
        if (!m || m.kind === 'image' || m.status !== 'ready') continue;
        const visual = isVisualItem(project, it);
        if (!visual && !m.hasAudio) continue;
        want.set(it.id, { item: it, media: m, time: it.in, audio: !visual || m.kind === 'audio', preroll: true });
      }
    }
    const keep = new Set();
    for (const [id, w] of want) {
      if (w.media.status !== 'ready') continue;
      const gain = w.preroll ? 0 : itemGain(project, w.item, t, audible);
      const hasSound = w.media.hasAudio && audible.includes(w.item);
      const fx = audioFx(w.item);
      let pitched = null;
      if (fx.pitch && w.media.hasAudio) {
        pitched = pitchedSync(w.media, fx.pitch);
        if (!pitched && !pitchFailed(w.media, fx.pitch)) ensurePitched(w.media, fx.pitch).then(() => (this.dirty = true)).catch((err) => console.warn('pitch failed', err));
      }
      if (!(pitched && w.audio)) {
        // the picture (and the sound, unless it is pitched) comes from this element
        const e = this._ensure(w.item, w.media, w.audio);
        if (!e) continue;
        keep.add(id);
        this._drive(e, w, pitched || !hasSound ? 0 : gain, fx, now, t);
      }
      if (pitched) {
        const key = id + '#fx';
        const ea = this._ensure(w.item, w.media, true, key, fileUrl(pitched.play));
        if (ea) {
          keep.add(key);
          this._drive(ea, w, hasSound ? gain : 0, fx, now, t);
        }
      }
    }
    for (const [id, e] of this.els) {
      if (keep.has(id)) continue;
      if (!e.el.paused) e.el.pause();
      if (e.gain && this.audioCtx) e.gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.01);
      const itemId = id.split('#')[0];
      if (now - e.lastUsed > 4000 || !project.items[itemId]) this._drop(id);
    }
    return plan;
  }

  /** Plays, pauses and seeks one element for a wanted item. */
  _drive(e, w, gain, fx, now, t) {
    e.lastUsed = now;
    const el = e.el;
    if (e.gain && this.audioCtx) {
      e.gain.gain.setTargetAtTime(gain * this.volume, this.audioCtx.currentTime, 0.015);
      const pan = clamp(w.item.pan || 0, -1, 1);
      if (e.pan && Math.abs(e.pan.pan.value - pan) > 0.001) e.pan.pan.setTargetAtTime(pan, this.audioCtx.currentTime, 0.02);
      if (e.eq) EQ_BANDS.forEach((b, i) => {
        if (Math.abs(e.eq[i].gain.value - fx.eq[b.key]) > 0.01) e.eq[i].gain.setTargetAtTime(fx.eq[b.key], this.audioCtx.currentTime, 0.02);
      });
    } else el.volume = clamp(gain * this.volume, 0, 1);
    // ramps are resampled in the export, so their pitch follows the speed there too
    const keep = fx.keepPitch && !w.item.speedCurve;
    if (el.preservesPitch !== keep) el.preservesPitch = keep;
    {
      if (this.playing && !w.preroll) {
        const rate = instantSpeed(w.item, t);
        if (rate <= 0.001) {
          if (!el.paused) el.pause();
          this._seek(e, w.time);
          return;
        }
        const r = clamp(rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - r) > 0.001) el.playbackRate = r;
        const drift = el.currentTime - w.time;
        if (Math.abs(drift) > 0.15 * Math.max(1, r) && !el.seeking) el.currentTime = w.time;
        if (el.paused && el.readyState >= 2) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        this._seek(e, w.time);
      }
    }
  }

  _loop() {
    this._raf = requestAnimationFrame((ts) => this._loop(ts));
    const project = store.project;
    if (this.playing) {
      let t = this._clock.t + (performance.now() - this._clock.wall) / 1000;
      const end = this._endTime();
      if (t >= end) {
        if (this.loop && end > 0) {
          t = store.inPoint ?? 0;
          this._clock = { wall: performance.now(), t };
        } else {
          t = end;
          store.seek(t, { fromPlayer: true });
          this.pause();
          return;
        }
      }
      store.seek(t, { fromPlayer: true });
      const plan = this._sync(t);
      this.comp.render(project, t, this.provider, { scale: this.scale, plan });
      this.onTick?.(t);
      return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const t = store.playhead;
    const plan = this._sync(t);
    this.comp.render(project, t, this.provider, { scale: this.scale, plan });
  }

  /** Called when the playhead is moved by the user. */
  seeked() {
    if (this.playing) this._clock = { wall: performance.now(), t: store.playhead };
    this.dirty = true;
  }

  dropAll() {
    for (const id of [...this.els.keys()]) this._drop(id);
    this.dirty = true;
  }
}
