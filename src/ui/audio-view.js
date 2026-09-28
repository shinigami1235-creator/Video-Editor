// The preview for audio projects: a big sound wave of the whole mix scrolling
// past the playhead, the names of what is playing, and left / right meters.

import { h } from './dom.js';
import { store } from '../core/store.js';
import { itemEnd, sourceTimeUnclamped, trackItems } from '../core/model.js';
import { itemGain } from '../render/preview.js';
import { getPeaks, peaksSync } from '../media/library.js';
import { clamp, formatTime } from '../core/util.js';

const TRACK_COLORS = ['#c9a45c', '#5fb3a1', '#7f9ee0', '#d98a6a', '#b58ad9', '#8fbf6a'];

/** Clips that make sound somewhere in [t0, t1), with their track index. */
function soundClips(p, t0, t1) {
  const out = [];
  p.tracks.forEach((tr, ti) => {
    if (tr.muted) return;
    for (const it of trackItems(p, tr.id)) {
      if (it.type !== 'clip' || it.muted || it.start >= t1 || itemEnd(it) <= t0) continue;
      const m = p.media[it.mediaId];
      if (!m?.hasAudio) continue;
      out.push({ it, m, ti });
    }
  });
  return out;
}

export class AudioView {
  constructor(viewer) {
    this.viewer = viewer;
    this.span = store.settings.audioViewSpan || 12;
    this.canvas = h('canvas', { class: 'av-canvas' });
    this.now = h('div', { class: 'av-now' });
    this.meterL = h('div', { class: 'av-meter-fill' });
    this.meterR = h('div', { class: 'av-meter-fill' });
    this.holdL = h('div', { class: 'av-meter-hold' });
    this.holdR = h('div', { class: 'av-meter-hold' });
    const meter = (fill, hold, label) => h('div', { class: 'av-meter' }, h('div', { class: 'av-meter-bar' }, fill, hold), h('span', {}, label));
    const scale = h('div', { class: 'av-scale' }, ...[0, -6, -12, -24, -48].map((db) => h('span', { style: { bottom: this.dbPos(db) * 100 + '%' } }, String(db))));
    this.empty = h('div', { class: 'av-empty' }, h('strong', {}, 'Audio project'), h('p', {}, 'Drop sound files or videos here (a video brings only its sound), record a voice-over from the Audio panel, or press Ctrl+I to import.'));
    this.root = h(
      'div',
      { class: 'audio-view' },
      h('div', { class: 'av-main' }, this.now, h('div', { class: 'av-wave' }, this.canvas, this.empty), h('div', { class: 'hint av-hint' }, 'Click or drag on the wave to move the playhead. Scroll to zoom.')),
      h('div', { class: 'av-meters', title: 'Output level. Keep the loudest parts under 0 dB, the red top.' }, scale, meter(this.meterL, this.holdL, 'L'), meter(this.meterR, this.holdR, 'R')),
    );
    this.lv = [0, 0];
    this.hold = [0, 0];
    this.dirty = true;
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.span = clamp(this.span * (e.deltaY > 0 ? 1.2 : 1 / 1.2), 2, 120);
      this.viewer.app.saveSetting?.('audioViewSpan', Math.round(this.span * 10) / 10);
      this.dirty = true;
    }, { passive: false });
    for (const ev of ['change', 'seek', 'media', 'project', 'selection']) store.on(ev, () => (this.dirty = true));
    new ResizeObserver(() => (this.dirty = true)).observe(this.canvas);
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.root.isConnected || this.root.offsetParent === null) return;
      this.tick();
    };
    requestAnimationFrame(loop);
  }

  /** 0..1 height on the meter for a level in dB (-48 dB at the bottom). */
  dbPos(db) {
    return clamp((db + 48) / 48, 0, 1);
  }

  timeAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, store.playhead + ((clientX - r.left) / r.width - 0.5) * this.span);
  }

  onDown(e) {
    const r = this.canvas.getBoundingClientRect();
    const x0 = e.clientX;
    const t0 = store.playhead;
    this.canvas.setPointerCapture(e.pointerId);
    let dragged = false;
    const move = (ev) => {
      if (Math.abs(ev.clientX - x0) > 3) dragged = true;
      // dragging pulls the sound past the playhead, like moving tape
      if (dragged) this.viewer.app.seek(Math.max(0, t0 - ((ev.clientX - x0) / r.width) * this.span));
    };
    const up = (ev) => {
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      if (!dragged) this.viewer.app.seek(this.timeAt(ev.clientX));
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
  }

  tick() {
    const levels = store.playing ? this.viewer.preview.levels?.() : null;
    let target = [0, 0];
    if (levels) target = levels.map((l) => l.peak);
    else if (!store.playing) target = [0, 0];
    let moving = false;
    for (let i = 0; i < 2; i++) {
      // fast rise, slow fall, like a real meter
      this.lv[i] = target[i] > this.lv[i] ? target[i] : this.lv[i] * 0.9;
      if (this.lv[i] < 0.001) this.lv[i] = 0;
      this.hold[i] = Math.max(this.hold[i] * 0.985, this.lv[i]);
      if (this.hold[i] < 0.001) this.hold[i] = 0;
      if (this.lv[i] || this.hold[i]) moving = true;
      const db = this.lv[i] > 0 ? 20 * Math.log10(this.lv[i]) : -99;
      const hdb = this.hold[i] > 0 ? 20 * Math.log10(this.hold[i]) : -99;
      const fill = i ? this.meterR : this.meterL;
      const hold = i ? this.holdR : this.holdL;
      fill.style.height = (1 - this.dbPos(db)) * 100 + '%';
      hold.style.bottom = this.dbPos(hdb) * 100 + '%';
      hold.classList.toggle('over', hdb > -0.5);
    }
    if (this.dirty || store.playing || moving) {
      this.dirty = false;
      this.draw();
    }
  }

  draw() {
    const p = store.project;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(c.clientWidth * dpr));
    const H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    const t = store.playhead;
    const span = this.span;
    const t0 = t - span / 2;
    const t1 = t + span / 2;
    const clips = soundClips(p, Math.max(0, t0), t1);
    this.empty.style.display = Object.values(p.items).some((i) => i.type === 'clip') ? 'none' : '';
    const rulerH = 18 * dpr;
    const mid = (H - rulerH) / 2;
    const amp = mid * 0.92;
    // time ruler
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => (s / span) * W > 70 * dpr) || 60;
    g.fillStyle = '#6c737d';
    g.font = `${10 * dpr}px Inter, sans-serif`;
    g.textAlign = 'center';
    for (let s = Math.ceil(Math.max(0, t0) / step) * step; s <= t1; s += step) {
      const x = ((s - t0) / span) * W;
      g.fillRect(x, H - rulerH, 1, 5 * dpr);
      g.fillText(formatTime(s), x, H - 4 * dpr);
    }
    g.fillStyle = '#2c323b';
    g.fillRect(0, mid, W, 1);
    // before zero there is nothing
    if (t0 < 0) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, 0, ((0 - t0) / span) * W, H - rulerH);
    }
    const cols = Math.min(W, 1600);
    const colW = W / cols;
    const mix = new Float32Array(cols);
    const byTrack = new Map();
    const sel = store.selection;
    const selMix = new Float32Array(cols);
    for (const { it, m, ti } of clips) {
      const peaks = peaksSync(m);
      if (!peaks) {
        if (m.peaks) getPeaks(m).then(() => (this.dirty = true));
        continue;
      }
      let arr = byTrack.get(ti);
      if (!arr) byTrack.set(ti, (arr = new Float32Array(cols)));
      for (let k = 0; k < cols; k++) {
        const ta = t0 + (k / cols) * span;
        const tb = ta + span / cols;
        if (tb <= it.start || ta >= itemEnd(it)) continue;
        const tm = clamp((ta + tb) / 2, it.start, itemEnd(it) - 1e-4);
        const sa = Math.max(0, sourceTimeUnclamped(it, Math.max(ta, it.start)));
        const sb = Math.max(sa, sourceTimeUnclamped(it, Math.min(tb, itemEnd(it) - 1e-4)));
        let pk = 0;
        const i0 = Math.floor(sa * 100);
        const i1 = Math.min(peaks.length - 1, Math.max(i0, Math.floor(sb * 100)));
        for (let i = i0; i <= i1; i++) if (peaks[i] > pk) pk = peaks[i];
        const a = (pk / 255) ** 2 * itemGain(p, it, tm, null);
        arr[k] += a;
        mix[k] += a;
        if (sel.has(it.id)) selMix[k] += a;
      }
    }
    // each track as a faint layer, then the whole mix on top
    const y = (a) => Math.sqrt(Math.min(1.2, a)) * amp;
    const shape = (arr, fill) => {
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(0, mid);
      for (let k = 0; k < cols; k++) g.lineTo(k * colW, mid - y(arr[k]));
      g.lineTo(W, mid);
      for (let k = cols - 1; k >= 0; k--) g.lineTo(k * colW, mid + y(arr[k]));
      g.closePath();
      g.fill();
    };
    if (byTrack.size > 1) for (const [ti, arr] of byTrack) shape(arr, TRACK_COLORS[ti % TRACK_COLORS.length] + '55');
    const grad = g.createLinearGradient(0, mid - amp, 0, mid + amp);
    grad.addColorStop(0, '#e8c16a');
    grad.addColorStop(0.5, '#c9a45c');
    grad.addColorStop(1, '#e8c16a');
    shape(mix, byTrack.size > 1 ? 'rgba(232,193,106,0.55)' : grad);
    if (sel.size) shape(selMix, 'rgba(255,255,255,0.35)');
    // too loud: anything that would clip shows red
    g.fillStyle = '#e5645f';
    for (let k = 0; k < cols; k++) if (mix[k] > 0.98) g.fillRect(k * colW, 0, Math.max(1, colW), 3 * dpr);
    // what has already played is dimmed
    g.fillStyle = 'rgba(15,17,20,0.35)';
    g.fillRect(0, 0, W / 2, H - rulerH);
    // cuts on the tracks and markers
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (const { it } of clips) for (const e of [it.start, itemEnd(it)]) if (e > t0 && e < t1) g.fillRect(((e - t0) / span) * W, 0, 1, H - rulerH);
    for (const mk of p.markers || []) {
      if (mk.t < t0 || mk.t > t1) continue;
      g.fillStyle = mk.color || '#c9a45c';
      g.fillRect(((mk.t - t0) / span) * W - 1, 0, 2, 8 * dpr);
    }
    // playhead
    g.fillStyle = '#ffffff';
    g.fillRect(W / 2 - dpr, 0, 2 * dpr, H - rulerH);
    // names under the playhead
    const playing = clips.filter(({ it }) => t >= it.start && t < itemEnd(it)).map(({ it, m }) => it.name || m.name);
    const txt = playing.length ? playing.join('  ·  ') : 'Silence';
    if (this.now.textContent !== txt) this.now.textContent = txt;
  }
}
