// The timeline: tracks, clips, ruler, playhead, trimming, moving, snapping,
// keyframes, transitions between clips, and drops from the media panel.

import { h, icon, iconButton, clear } from './dom.js';
import { store } from '../core/store.js';
import { itemEnd, sourceTime, keyframeTimes, trackItems, visualTracks, projectDuration, maxClipDuration, propAt, setKeyframe } from '../core/model.js';
import * as E from '../core/edit.js';
import { formatTime, clamp, throttle } from '../core/util.js';
import { fileUrl } from '../backend/index.js';
import { getPeaks, peaksSync } from '../media/library.js';
import { TRANSITION_TYPES } from '../render/shaders.js';

const HEAD_W = 190;
const RULER_H = 28;
const HANDLE = 7;
const VOL_MAX = 3;
const SVGNS = 'http://www.w3.org/2000/svg';
const volY = (v, H) => 4 + (1 - clamp(v, 0, VOL_MAX) / VOL_MAX) * (H - 8);
const yVol = (y, H) => clamp((1 - (y - 4) / (H - 8)) * VOL_MAX, 0, VOL_MAX);

export const dragSession = { active: null }; // set by the media panel while dragging media

export class Timeline {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.els = new Map();
    this.sprites = new Map();
    this.build();
    store.on('change', () => this.render());
    store.on('selection', () => this.render());
    store.on('seek', () => this.updatePlayhead());
    store.on('media', () => this.render());
    store.on('project', () => {
      this.scroll.scrollLeft = 0;
      this.render();
    });
    new ResizeObserver(() => this.render()).observe(this.scroll);
  }

  build() {
    const r = this.root;
    clear(r);
    r.classList.add('timeline');
    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.rulerCanvas = h('canvas', { class: 'tl-ruler' });
    this.rulerWrap = h('div', { class: 'tl-ruler-wrap' }, this.rulerCanvas);
    this.top = h('div', { class: 'tl-top' }, h('div', { class: 'tl-corner', style: { width: HEAD_W + 'px' } }, this._addTrackButtons()), this.rulerWrap);
    this.heads = h('div', { class: 'tl-heads', style: { width: HEAD_W + 'px' } });
    this.tracksEl = h('div', { class: 'tl-tracks' });
    this.playheadEl = h('div', { class: 'tl-playhead' }, h('div', { class: 'tl-playhead-cap' }));
    this.content = h('div', { class: 'tl-content' }, this.tracksEl, this.playheadEl);
    this.inner = h('div', { class: 'tl-inner' }, this.heads, this.content);
    this.scroll = h('div', { class: 'tl-scroll' }, this.inner);
    this.dropIndicator = h('div', { class: 'tl-drop' });
    this.snapLine = h('div', { class: 'tl-snap' });
    this.band = h('div', { class: 'tl-band' });
    this.content.append(this.dropIndicator, this.snapLine, this.band);
    r.append(this.toolbar, this.top, this.scroll);
    this.buildToolbar();

    this.scroll.addEventListener('scroll', throttle(() => {
      this.drawRuler();
      this.drawVisibleCanvases();
    }, 30));
    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.rulerWrap.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.rulerCanvas.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    this.content.addEventListener('pointerdown', (e) => this.onContentDown(e));
    // a click in the empty space under the tracks clears the selection too
    this.scroll.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && (e.target === this.scroll || e.target === this.inner) && !e.shiftKey && !e.ctrlKey) store.clearSelection();
    });
    this.content.addEventListener('contextmenu', (e) => this.onContext(e));
    this.content.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.tl-clip');
      if (el) this.app.focusInspector?.();
    });
  }

  _addTrackButtons() {
    return h(
      'div',
      { class: 'tl-addtracks' },
      iconButton('film', () => store.commit('Add video track', (p) => E.addTrack(p, 'video')), 'Add a video track', { size: 15, cls: 'video-only' }),
      iconButton('music', () => store.commit('Add audio track', (p) => E.addTrack(p, 'audio')), 'Add an audio track', { size: 15 }),
    );
  }

  buildToolbar() {
    const tb = this.toolbar;
    clear(tb);
    const a = this.app;
    const g1 = h(
      'div',
      { class: 'tl-group' },
      iconButton('split', () => a.cmd('split'), 'Split at playhead (S)'),
      iconButton('trash', () => a.cmd('delete'), 'Delete (Delete)'),
      iconButton('copy', () => a.cmd('duplicate'), 'Duplicate (Ctrl+D)'),
      iconButton('freeze', () => a.cmd('freeze'), 'Freeze frame (F)', { cls: 'video-only' }),
      iconButton('detach', () => a.cmd('detachAudio'), 'Separate audio', { cls: 'video-only' }),
      iconButton('crop', () => a.cmd('crop'), 'Crop on the preview (C)', { cls: 'video-only' }),
      iconButton('marker', () => a.cmd('marker'), 'Add marker (M)'),
      iconButton('keyframe', () => a.cmd('keyframe'), 'Add keyframe at playhead (K)'),
    );
    this.snapBtn = iconButton('magnet', () => {
      store.snapping = !store.snapping;
      this.snapBtn.classList.toggle('active', store.snapping);
    }, 'Snapping (N)', { active: store.snapping });
    this.magBtn = h('button', { class: 'ibtn text-btn', title: 'Main track keeps clips together with no gaps', onclick: () => {
      store.commit('Main track mode', (p) => {
        p.settings.magnetic = p.settings.magnetic === false;
        E.compactMagnetic(p);
      });
    } }, 'Magnetic');
    const g2 = h('div', { class: 'tl-group' }, this.snapBtn, this.magBtn);
    this.zoomRange = h('input', { type: 'range', min: 5, max: 600, step: 1, value: store.zoom, class: 'tl-zoom', title: 'Zoom' });
    this.zoomRange.addEventListener('input', () => this.setZoom(Number(this.zoomRange.value)));
    const g3 = h(
      'div',
      { class: 'tl-group right' },
      iconButton('zoomOut', () => this.setZoom(store.zoom / 1.4), 'Zoom out (-)'),
      this.zoomRange,
      iconButton('zoomIn', () => this.setZoom(store.zoom * 1.4), 'Zoom in (+)'),
      iconButton('fit', () => this.zoomToFit(), 'Fit the whole project (Shift+Z)'),
    );
    tb.append(g1, g2, g3);
  }

  setZoom(z, anchorTime = null) {
    const old = store.zoom;
    z = clamp(z, 2, 800);
    const vw = this.scroll.clientWidth - HEAD_W;
    const at = anchorTime ?? (this.scroll.scrollLeft + vw / 2) / old;
    const px = at * old - this.scroll.scrollLeft;
    store.zoom = z;
    this.zoomRange.value = z;
    this.render();
    this.scroll.scrollLeft = Math.max(0, at * z - px);
    this.drawRuler();
  }

  zoomToFit() {
    const d = Math.max(5, projectDuration(store.project));
    const vw = this.scroll.clientWidth - HEAD_W - 40;
    this.setZoom(vw / d);
    this.scroll.scrollLeft = 0;
  }

  timeAt(clientX) {
    const r = this.content.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / store.zoom);
  }

  trackAt(clientY) {
    for (const [id, row] of this.rows || []) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return id;
    }
    return null;
  }

  // ---- rendering ----------------------------------------------------------------

  render() {
    const p = store.project;
    const z = store.zoom;
    const dur = projectDuration(p);
    const viewW = this.scroll.clientWidth - HEAD_W;
    const width = Math.max(viewW, (dur + 30) * z);
    this.content.style.width = width + 'px';
    this.magBtn?.classList.toggle('active', p.settings.magnetic !== false);

    // track rows and heads
    clear(this.heads);
    const existingRows = this.rows || new Map();
    this.rows = new Map();
    // audio projects hide video tracks that have nothing on them
    const shown = (t) => !p.settings.audioOnly || t.kind === 'audio' || Object.values(p.items).some((it) => it.trackId === t.id);
    const order = [...p.tracks.filter((t) => t.kind === 'video'), ...p.tracks.filter((t) => t.kind === 'audio')].filter(shown);
    const main = E.spineTrack(p);
    let y = 0;
    const seen = new Set();
    for (const tr of order) {
      const hgt = tr.height || 60;
      const head = this._head(tr, tr === main);
      head.style.height = hgt + 'px';
      this.heads.append(head);
      let row = existingRows.get(tr.id);
      if (!row) {
        row = h('div', { class: 'tl-track' });
        row.dataset.track = tr.id;
      }
      row.className = `tl-track kind-${tr.kind} ${tr === main ? 'main' : ''} ${tr.locked ? 'locked' : ''} ${tr.hidden || tr.muted ? 'off' : ''}`;
      row.style.top = y + 'px';
      row.style.height = hgt + 'px';
      if (row.parentNode !== this.tracksEl) this.tracksEl.append(row);
      this.rows.set(tr.id, row);
      y += hgt;
      for (const it of trackItems(p, tr.id)) {
        seen.add(it.id);
        this._clip(it, row, hgt, tr);
      }
    }
    for (const [id, row] of existingRows) if (!this.rows.has(id)) row.remove();
    for (const [id, el] of this.els) {
      if (!seen.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
    this.tracksEl.style.height = y + 'px';
    this.content.style.height = y + 'px';
    this.heads.style.minHeight = y + 'px';

    // markers and in/out
    this.content.querySelectorAll('.tl-marker,.tl-range').forEach((m) => m.remove());
    for (const mk of p.markers || []) {
      const m = h('div', { class: 'tl-marker', title: mk.label || formatTime(mk.t), style: { left: mk.t * z + 'px', height: y + 'px', borderColor: mk.color || '#e0b84a' } });
      m.dataset.marker = mk.id;
      this.content.append(m);
    }
    if (store.inPoint != null || store.outPoint != null) {
      const a = store.inPoint ?? 0;
      const b = store.outPoint ?? dur;
      this.content.append(h('div', { class: 'tl-range', style: { left: a * z + 'px', width: Math.max(0, b - a) * z + 'px', height: y + 'px' } }));
    }
    this.updatePlayhead();
    this.drawRuler();
    this.drawVisibleCanvases();
  }

  _head(tr, isMain) {
    const p = store.project;
    const name = h('span', { class: 'tl-head-name', title: 'Double-click to rename' }, tr.name + (isMain ? ' (main)' : ''));
    name.addEventListener('dblclick', async () => {
      const { promptDialog } = await import('./notify.js');
      const v = await promptDialog('Rename track', 'Track name', tr.name);
      if (v) store.commit('Rename track', () => (tr.name = v));
    });
    const btns = h('div', { class: 'tl-head-btns' });
    if (tr.kind === 'video') {
      btns.append(iconButton(tr.hidden ? 'eyeOff' : 'eye', () => store.commit(tr.hidden ? 'Show track' : 'Hide track', () => (tr.hidden = !tr.hidden)), tr.hidden ? 'Show track' : 'Hide track', { size: 15, active: tr.hidden }));
      btns.append(iconButton(tr.muted ? 'mute' : 'volume', () => store.commit(tr.muted ? 'Unmute track' : 'Mute track', () => (tr.muted = !tr.muted)), tr.muted ? 'Unmute clip sound on this track' : 'Mute clip sound on this track', { size: 15, active: tr.muted }));
    } else {
      btns.append(iconButton(tr.muted ? 'mute' : 'volume', () => store.commit(tr.muted ? 'Unmute track' : 'Mute track', () => (tr.muted = !tr.muted)), tr.muted ? 'Unmute track' : 'Mute track', { size: 15, active: tr.muted }));
    }
    btns.append(iconButton('audioWave', () => store.commit(tr.height > 60 ? 'Shorter track' : 'Taller track', () => (tr.height = tr.height > 60 ? 60 : 120)), tr.height > 60 ? 'Make the track shorter' : 'Make the track taller to see the sound wave', { size: 15, active: tr.height > 60 }));
    btns.append(iconButton(tr.locked ? 'lock' : 'unlock', () => store.commit(tr.locked ? 'Unlock track' : 'Lock track', () => (tr.locked = !tr.locked)), tr.locked ? 'Unlock track' : 'Lock track', { size: 15, active: tr.locked }));
    const canRemove = p.tracks.filter((t) => t.kind === tr.kind).length > 1 && !isMain;
    if (canRemove) btns.append(iconButton('x', () => store.commit('Delete track', (pp) => E.removeTrack(pp, tr.id)), 'Delete track and its clips', { size: 14 }));
    const head = h('div', { class: `tl-head kind-${tr.kind}` }, h('span', { class: 'tl-head-icon' }, icon(tr.kind === 'video' ? 'film' : 'music', 14)), name, btns);
    return head;
  }

  _clip(it, row, hgt, tr) {
    const p = store.project;
    const z = store.zoom;
    let el = this.els.get(it.id);
    if (!el) {
      el = h('div', { class: 'tl-clip' });
      el.dataset.id = it.id;
      el.append(h('div', { class: 'tl-clip-canvas-wrap' }, h('canvas', { class: 'tl-clip-canvas' })), h('div', { class: 'tl-clip-label' }), h('div', { class: 'tl-handle left' }), h('div', { class: 'tl-handle right' }), h('div', { class: 'tl-badges' }), h('div', { class: 'tl-kfs' }));
      this.els.set(it.id, el);
    }
    if (el.parentNode !== row) row.append(el);
    const m = it.mediaId ? p.media[it.mediaId] : null;
    const sel = store.selection.has(it.id);
    const typeCls = it.type === 'clip' ? (m?.kind === 'audio' || tr.kind === 'audio' ? 'audio' : m?.kind === 'image' ? 'image' : 'video') : it.type;
    el.className = `tl-clip t-${typeCls} ${sel ? 'selected' : ''} ${it.muted ? 'muted' : ''} ${m && m.status !== 'ready' ? 'loading' : ''} ${it.caption ? 'caption' : ''}`;
    el.style.left = it.start * z + 'px';
    el.style.width = Math.max(2, it.duration * z) + 'px';
    el.style.height = hgt - 4 + 'px';
    const label = el.querySelector('.tl-clip-label');
    let text = it.name || it.type;
    if (it.type === 'text') text = it.text.replace(/\n/g, ' ');
    if (m && m.status === 'processing') text += ` (preparing ${Math.round((m.progress || 0) * 100)}%)`;
    if (m && m.status === 'error') text += ' (failed)';
    if (m && m.status === 'missing') text += ' (missing)';
    label.textContent = text;
    const badges = el.querySelector('.tl-badges');
    clear(badges);
    if (it.type === 'clip' && (it.speed !== 1 || it.speedCurve)) badges.append(h('span', { class: 'badge' }, it.speedCurve ? 'ramp' : it.speed.toFixed(2).replace(/\.?0+$/, '') + 'x'));
    if (it.freeze) badges.append(h('span', { class: 'badge' }, 'freeze'));
    if (it.origMediaId) badges.append(h('span', { class: 'badge' }, 'edited'));
    if (it.color?.lut || it.color?.filter) badges.append(h('span', { class: 'badge' }, 'look'));
    if (it.muted && it.type === 'clip' && m?.hasAudio) badges.append(h('span', { class: 'badge' }, icon('mute', 11)));
    if (it.duck) badges.append(h('span', { class: 'badge' }, 'ducks'));
    // transition marker at the head
    el.querySelector('.tl-trans')?.remove();
    const prev = tr.kind === 'video' && it.type !== 'blur' ? p.items && Object.values(p.items).find((o) => o.trackId === it.trackId && Math.abs(itemEnd(o) - it.start) < 0.02) : null;
    if (it.transitionIn || prev) {
      const tt = h('div', { class: 'tl-trans' + (it.transitionIn ? ' on' : ''), title: it.transitionIn ? `${TRANSITION_TYPES[it.transitionIn.type]?.name || 'Transition'} (${it.transitionIn.duration}s). Click to change.` : 'Add a transition' }, icon('transition', 12));
      if (it.transitionIn) tt.style.width = Math.max(14, it.transitionIn.duration * z) + 'px';
      tt.dataset.trans = it.id;
      el.append(tt);
    }
    // keyframes
    const kfs = el.querySelector('.tl-kfs');
    clear(kfs);
    if (sel) {
      for (const kt of keyframeTimes(it)) {
        const d = h('div', { class: 'tl-kf' + (store.selectedKeyframe?.id === it.id && Math.abs(store.selectedKeyframe.t - kt) < 1e-3 ? ' active' : ''), style: { left: kt * z + 'px' }, title: 'Keyframe at ' + formatTime(it.start + kt) });
        d.dataset.kf = kt;
        kfs.append(d);
      }
    }
    // fade handles for sound
    el.querySelectorAll('.tl-fade').forEach((f) => f.remove());
    if (it.type === 'clip' && m?.hasAudio && (tr.kind === 'audio' || sel)) {
      const fi = h('div', { class: 'tl-fade in', title: 'Drag to fade in', style: { left: (it.fadeIn || 0) * z + 'px' } });
      const fo = h('div', { class: 'tl-fade out', title: 'Drag to fade out', style: { right: (it.fadeOut || 0) * z + 'px' } });
      el.append(fi, fo);
    }
    // volume line: drag it up or down, click it to add a point, double-click a point to remove it
    el.querySelector('.tl-vol')?.remove();
    if (it.type === 'clip' && m?.hasAudio && !it.freeze && (tr.kind === 'audio' || m.kind === 'audio' || sel)) el.append(this._volumeLine(it, it.duration * z, hgt - 4, z));
    el._key = null; // force canvas redraw
  }

  _volumeLine(it, W, H, z) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'tl-vol');
    svg.setAttribute('width', Math.max(2, W));
    svg.setAttribute('height', H);
    const step = Math.max(3, W / 800);
    let d = '';
    for (let x = 0; x <= W + step; x += step) {
      const xx = Math.min(x, W);
      d += (x ? 'L' : 'M') + xx.toFixed(1) + ' ' + volY(propAt(it, 'volume', it.start + xx / z), H).toFixed(1);
      if (xx >= W) break;
    }
    const line = document.createElementNS(SVGNS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('class', 'tl-vol-line');
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'tl-vol-hit');
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = 'Volume. Drag up or down. Click to add a point.';
    hit.append(title);
    svg.append(line, hit);
    for (const k of it.kf?.volume || []) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', (k.t * z).toFixed(1));
      c.setAttribute('cy', volY(k.v, H).toFixed(1));
      c.setAttribute('r', 4.5);
      c.setAttribute('class', 'tl-vol-pt');
      c.dataset.t = k.t;
      const tt = document.createElementNS(SVGNS, 'title');
      tt.textContent = `${Math.round(k.v * 100)}%. Drag to move, double-click to remove.`;
      c.append(tt);
      svg.append(c);
    }
    return svg;
  }

  _volTip(clientX, clientY, v) {
    if (!this.volTipEl) {
      this.volTipEl = h('div', { class: 'tl-vol-tip' });
      document.body.append(this.volTipEl);
    }
    if (v == null) {
      this.volTipEl.style.display = 'none';
      return;
    }
    Object.assign(this.volTipEl.style, { display: 'block', left: clientX + 12 + 'px', top: clientY - 28 + 'px' });
    this.volTipEl.textContent = Math.round(v * 100) + '%';
  }

  /** Drags the volume line or one of its points. */
  _dragVolume(e, it, clipEl, pointT) {
    e.stopPropagation();
    if (!store.selection.has(it.id)) store.select(it.id);
    const svg = clipEl.querySelector('.tl-vol');
    const H = Number(svg.getAttribute('height'));
    const r = svg.getBoundingClientRect();
    const z = store.zoom;
    const kfs = it.kf?.volume || [];
    // pointer events carry no click count, so double-clicks are timed here
    const now = performance.now();
    const last = this._lastVolPt;
    this._lastVolPt = pointT != null ? { id: it.id, t: pointT, at: now } : null;
    if (pointT != null && last && last.id === it.id && Math.abs(last.t - pointT) < 1e-4 && now - last.at < 450) {
      this._lastVolPt = null;
      store.commit('Remove volume point', () => {
        const i = it.kf.volume.findIndex((k) => Math.abs(k.t - pointT) < 1e-4);
        if (i >= 0) it.kf.volume.splice(i, 1);
        if (!it.kf.volume.length) delete it.kf.volume;
      });
      return;
    }
    store.beginGesture();
    let key = pointT;
    let mode = pointT != null ? 'point' : kfs.length ? 'point' : 'level';
    if (pointT == null && kfs.length) {
      // clicking the line with points on it adds a point there
      key = clamp((e.clientX - r.left) / z, 0, it.duration);
      store.mutate(() => setKeyframe(it, 'volume', key, propAt(it, 'volume', it.start + key), 'linear'));
    }
    const startY = e.clientY;
    const startX = e.clientX;
    const origLevel = it.props?.volume ?? 1;
    const point = mode === 'point' ? it.kf.volume.find((x) => Math.abs(x.t - key) < 1e-4) : null;
    const t0 = point?.t ?? 0;
    const move = (ev) => {
      const dy = ev.clientY - startY;
      if (mode === 'level') {
        const v = clamp(origLevel - (dy / (H - 8)) * VOL_MAX, 0, VOL_MAX);
        store.mutate(() => {
          it.props.volume = Math.round(v * 100) / 100;
        });
        this._volTip(ev.clientX, ev.clientY, v);
        return;
      }
      // the undo system can swap item objects, so find the point on the live item
      const live = store.project.items[it.id];
      const list = live?.kf?.volume;
      const k = list && (list.includes(point) ? point : list.find((x) => Math.abs(x.t - key) < 1e-4));
      if (!k) return;
      const v = yVol(ev.clientY - r.top, H);
      const i = list.indexOf(k);
      const lo = i > 0 ? list[i - 1].t + 0.02 : 0;
      const hi = i < list.length - 1 ? list[i + 1].t - 0.02 : live.duration;
      const nt = Math.abs(ev.clientX - startX) < 3 ? t0 : clamp(t0 + (ev.clientX - startX) / z, lo, hi);
      store.mutate(() => {
        k.v = Math.round(v * 100) / 100;
        k.t = Math.round(nt * 1000) / 1000;
      });
      key = k.t;
      this._volTip(ev.clientX, ev.clientY, k.v);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this._volTip(0, 0, null);
      store.endGesture(mode === 'level' ? 'Volume' : 'Volume point');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  updatePlayhead() {
    const x = store.playhead * store.zoom;
    this.playheadEl.style.transform = `translateX(${x}px)`;
    this.playheadEl.style.height = Math.max(this.tracksEl.offsetHeight, this.scroll.clientHeight) + 'px';
    // keep the playhead visible while playing
    if (store.playing) {
      const vw = this.scroll.clientWidth - HEAD_W;
      const left = this.scroll.scrollLeft;
      if (x > left + vw - 40 || x < left) this.scroll.scrollLeft = Math.max(0, x - 60);
    }
    this.drawRuler();
  }

  drawRuler() {
    const c = this.rulerCanvas;
    const w = this.rulerWrap.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(RULER_H * dpr);
      c.style.width = w + 'px';
      c.style.height = RULER_H + 'px';
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, RULER_H);
    const z = store.zoom;
    const left = this.scroll.scrollLeft;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * z >= 80) || 600;
    const minor = major / (major >= 1 ? 5 : 2);
    ctx.fillStyle = '#8a8f98';
    ctx.strokeStyle = '#3a3f47';
    ctx.font = '10px Inter, sans-serif';
    const i0 = Math.floor(left / z / minor);
    for (let i = i0; i * minor * z - left < w; i++) {
      const t = Math.round(i * minor * 1000) / 1000;
      const x = Math.round(t * z - left) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 12 : 20);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      if (isMajor) ctx.fillText(formatTime(t).replace(/\.00$/, ''), x + 3, 10);
    }
    // in/out
    if (store.inPoint != null || store.outPoint != null) {
      ctx.fillStyle = 'rgba(201,164,92,0.35)';
      const a = (store.inPoint ?? 0) * z - left;
      const b = (store.outPoint ?? projectDuration(store.project)) * z - left;
      ctx.fillRect(a, RULER_H - 6, b - a, 6);
    }
    const px = store.playhead * z - left;
    ctx.fillStyle = '#e8c16a';
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px + 6, 12);
    ctx.lineTo(px, 18);
    ctx.lineTo(px - 6, 12);
    ctx.closePath();
    ctx.fill();
  }

  _sprite(m) {
    if (!m?.thumbs) return null;
    let s = this.sprites.get(m.thumbs.path);
    if (!s) {
      s = new Image();
      s.crossOrigin = 'anonymous';
      s.onload = () => this.drawVisibleCanvases(true);
      s.src = fileUrl(m.thumbs.path);
      this.sprites.set(m.thumbs.path, s);
    }
    return s.complete && s.naturalWidth ? s : null;
  }

  drawVisibleCanvases(force = false) {
    const p = store.project;
    const z = store.zoom;
    const left = this.scroll.scrollLeft;
    const vw = this.scroll.clientWidth - HEAD_W;
    for (const [id, el] of this.els) {
      const it = p.items[id];
      if (!it) continue;
      const x0 = it.start * z;
      const x1 = itemEnd(it) * z;
      const wrap = el.firstChild;
      const cv = wrap.firstChild;
      if (x1 < left - 50 || x0 > left + vw + 50) {
        cv.style.display = 'none';
        continue;
      }
      const visA = Math.max(0, left - x0 - 100);
      const visB = Math.min(x1 - x0, left + vw - x0 + 100);
      const w = Math.max(1, Math.round(visB - visA));
      const hh = el.clientHeight || 50;
      const m = it.mediaId ? p.media[it.mediaId] : null;
      const key = [visA, w, hh, z, it.start, it.duration, it.in, it.speed, JSON.stringify(it.speedCurve), m?.status, m?.thumbs?.path, !!peaksSync(m), it.fadeIn, it.fadeOut, JSON.stringify(it.kf?.volume || null), it.props?.volume].join('|');
      if (!force && el._key === key) continue;
      el._key = key;
      cv.style.display = 'block';
      cv.style.left = visA + 'px';
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hh * dpr);
      cv.style.width = w + 'px';
      cv.style.height = hh + 'px';
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hh);
      const tr = p.tracks.find((t) => t.id === it.trackId);
      if (it.type === 'clip' && m) {
        const isAudioRow = tr?.kind === 'audio' || m.kind === 'audio';
        if (!isAudioRow && m.kind === 'video') {
          const sp = this._sprite(m);
          if (sp) {
            const th = m.thumbs;
            const tileH = hh;
            const tileW = (th.w / th.h) * tileH;
            for (let x = Math.floor(visA / tileW) * tileW; x < visA + w; x += tileW) {
              const t = it.start + (x + tileW / 2) / z;
              const st = sourceTime(it, Math.min(t, itemEnd(it)));
              const idx = clamp(Math.floor(st / th.interval), 0, th.count - 1);
              const sx = (idx % th.cols) * th.w;
              const sy = Math.floor(idx / th.cols) * th.h;
              ctx.drawImage(sp, sx, sy, th.w, th.h, x - visA, 0, tileW, tileH);
            }
          }
        } else if (!isAudioRow && m.kind === 'image') {
          const img = this._imgThumb(m);
          if (img) {
            const tileW = (img.naturalWidth / img.naturalHeight) * hh;
            for (let x = Math.floor(visA / tileW) * tileW; x < visA + w; x += tileW) ctx.drawImage(img, x - visA, 0, tileW, hh);
          }
        }
        if (m.hasAudio) {
          const peaks = peaksSync(m);
          if (!peaks && m.peaks) getPeaks(m).then(() => this.drawVisibleCanvases(true));
          if (peaks) {
            const top = isAudioRow ? 0 : hh * 0.62;
            const ah = isAudioRow ? hh : hh * 0.38;
            ctx.fillStyle = isAudioRow ? 'rgba(120,200,160,0.85)' : 'rgba(255,255,255,0.55)';
            const mid = top + ah / 2;
            for (let x = 0; x < w; x += 2) {
              const t = it.start + (visA + x) / z;
              const st = sourceTime(it, t);
              const i = Math.floor(st * 100);
              const i2 = Math.max(i + 1, Math.floor(sourceTime(it, t + 2 / z) * 100));
              let pk = 0;
              for (let k = i; k < i2 && k < peaks.length; k++) pk = Math.max(pk, peaks[k]);
              const vol = Math.min(2, propAt(it, 'volume', t));
              const ph = (pk / 255) * (ah / 2) * Math.min(1.4, vol);
              ctx.fillRect(x, mid - ph, 1.5, Math.max(0.5, ph * 2));
            }
          }
        }
      } else if (it.type === 'text') {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(0, 0, w, hh);
      }
    }
  }

  _imgThumb(m) {
    const key = m.display || m.path;
    let s = this.sprites.get(key);
    if (!s) {
      s = new Image();
      s.crossOrigin = 'anonymous';
      s.onload = () => this.drawVisibleCanvases(true);
      s.src = fileUrl(key);
      this.sprites.set(key, s);
    }
    return s.complete && s.naturalWidth ? s : null;
  }

  // ---- input ---------------------------------------------------------------------

  /**
   * Mouse wheel: zooms in and out around the pointer. Shift+wheel or a
   * sideways trackpad swipe scrolls left and right. Over the track names, or
   * with Alt held, it scrolls the tracks up and down.
   */
  onWheel(e) {
    const r = this.scroll.getBoundingClientRect();
    const overHeads = e.clientX < r.left + HEAD_W && e.currentTarget === this.scroll;
    if (e.altKey || (overHeads && !e.ctrlKey && !e.metaKey)) return; // the browser scrolls the tracks
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.scroll.scrollLeft += e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      return;
    }
    // a mouse notch is about 100; trackpads send many small steps
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const factor = Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0016);
    // many wheel events in one frame become one redraw
    const w = (this._wheel ||= { factor: 1, t: 0, raf: 0 });
    w.factor *= factor;
    w.t = this.timeAt(Math.max(r.left + HEAD_W, e.clientX));
    if (!w.raf)
      w.raf = requestAnimationFrame(() => {
        w.raf = 0;
        const f = w.factor;
        w.factor = 1;
        this.setZoom(store.zoom * f, w.t);
      });
  }

  /** Scrolls so the playhead is in view, with a little room to its left. */
  revealPlayhead() {
    const x = store.playhead * store.zoom;
    const vw = this.scroll.clientWidth - HEAD_W;
    const left = this.scroll.scrollLeft;
    if (x < left + 20 || x > left + vw - 40) this.scroll.scrollLeft = Math.max(0, x - 60);
  }

  onRulerDown(e) {
    const rect = this.rulerCanvas.getBoundingClientRect();
    const move = (ev) => {
      const t = (ev.clientX - rect.left + this.scroll.scrollLeft) / store.zoom;
      store.seek(this._snapPlayhead(Math.max(0, t), ev));
      this.app.preview?.seeked();
    };
    move(e);
    this.rulerCanvas.setPointerCapture(e.pointerId);
    this.rulerCanvas.onpointermove = move;
    this.rulerCanvas.onpointerup = () => {
      this.rulerCanvas.onpointermove = null;
      this.rulerCanvas.onpointerup = null;
    };
  }

  _snapPlayhead(t, ev) {
    if (!store.snapping || ev?.altKey) return store.snapTime(t);
    const pts = this._snapPoints(new Set());
    const thr = 8 / store.zoom;
    let best = null;
    for (const s of pts) if (Math.abs(s - t) < thr && (best == null || Math.abs(s - t) < Math.abs(best - t))) best = s;
    return best ?? store.snapTime(t);
  }

  _snapPoints(exclude, includePlayhead = false) {
    const pts = [0];
    for (const it of Object.values(store.project.items)) {
      if (exclude.has(it.id)) continue;
      pts.push(it.start, itemEnd(it));
    }
    for (const m of store.project.markers || []) pts.push(m.t);
    if (includePlayhead) pts.push(store.playhead);
    if (store.inPoint != null) pts.push(store.inPoint);
    if (store.outPoint != null) pts.push(store.outPoint);
    return pts;
  }

  _snap(t, exclude, edges = [0]) {
    if (!store.snapping) return { t, snapped: null };
    const thr = 8 / store.zoom;
    const pts = this._snapPoints(exclude, true);
    let best = null;
    let bestD = thr;
    for (const off of edges) {
      for (const s of pts) {
        const d = Math.abs(t + off - s);
        if (d < bestD) {
          bestD = d;
          best = { t: s - off, at: s };
        }
      }
    }
    return best ? { t: best.t, snapped: best.at } : { t, snapped: null };
  }

  showSnap(at) {
    if (at == null) {
      this.snapLine.style.display = 'none';
      return;
    }
    this.snapLine.style.display = 'block';
    this.snapLine.style.left = at * store.zoom + 'px';
    this.snapLine.style.height = this.tracksEl.offsetHeight + 'px';
  }

  onContentDown(e) {
    if (e.button !== 0) return;
    const p = store.project;
    const trans = e.target.closest('.tl-trans');
    if (trans) {
      e.stopPropagation();
      store.select(trans.dataset.trans);
      this.app.openPanel('transitions', { cutItem: trans.dataset.trans });
      return;
    }
    const kf = e.target.closest('.tl-kf');
    const clipEl = e.target.closest('.tl-clip');
    if (kf && clipEl) return this._dragKeyframe(e, clipEl.dataset.id, Number(kf.dataset.kf));
    const fade = e.target.closest('.tl-fade');
    if (fade && clipEl) return this._dragFade(e, clipEl.dataset.id, fade.classList.contains('in'));
    const volPt = e.target.closest('.tl-vol-pt');
    const volHit = e.target.closest('.tl-vol-hit');
    if ((volPt || volHit) && clipEl && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
      const it = p.items[clipEl.dataset.id];
      const tr = p.tracks.find((t) => t.id === it?.trackId);
      if (it && !tr?.locked) return this._dragVolume(e, it, clipEl, volPt ? Number(volPt.dataset.t) : null);
    }
    const marker = e.target.closest('.tl-marker');
    if (marker) return this._dragMarker(e, marker.dataset.marker);
    if (clipEl) {
      const it = p.items[clipEl.dataset.id];
      if (!it) return;
      const tr = p.tracks.find((t) => t.id === it.trackId);
      if (e.ctrlKey || e.metaKey) {
        store.toggleSelect(it.id);
        return;
      }
      if (e.shiftKey) store.select(it.id, { add: true });
      else if (!store.selection.has(it.id)) store.select(it.id);
      if (tr?.locked) return;
      const handle = e.target.closest('.tl-handle');
      if (handle) return this._trim(e, it, handle.classList.contains('left'));
      return this._move(e, it);
    }
    // empty area: seek and start a selection band
    const t = this.timeAt(e.clientX);
    store.seek(this._snapPlayhead(t, e));
    this.app.preview?.seeked();
    this._bandSelect(e);
  }

  _bandSelect(e) {
    const r = this.content.getBoundingClientRect();
    const x0 = e.clientX - r.left;
    const y0 = e.clientY - r.top;
    let moved = false;
    const add = e.shiftKey || e.ctrlKey;
    const base = add ? new Set(store.selection) : new Set();
    const move = (ev) => {
      const x1 = ev.clientX - r.left;
      const y1 = ev.clientY - r.top;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 5) return;
      moved = true;
      const L = Math.min(x0, x1);
      const T = Math.min(y0, y1);
      const W = Math.abs(x1 - x0);
      const H = Math.abs(y1 - y0);
      Object.assign(this.band.style, { display: 'block', left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px' });
      const ids = new Set(base);
      for (const [id, el] of this.els) {
        const er = el.getBoundingClientRect();
        const ex = er.left - r.left;
        const ey = er.top - r.top;
        if (ex < L + W && ex + er.width > L && ey < T + H && ey + er.height > T) ids.add(id);
      }
      store.selection = ids;
      store.emit('selection');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.band.style.display = 'none';
      if (!moved && !add) store.clearSelection();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _move(e, it) {
    const p = store.project;
    const startX = e.clientX;
    const startY = e.clientY;
    const ids = [...store.selection].filter((id) => {
      const x = p.items[id];
      return x && !p.tracks.find((t) => t.id === x.trackId)?.locked;
    });
    const items = ids.map((id) => p.items[id]);
    const exclude = new Set(ids);
    const minStart = Math.min(...items.map((i) => i.start));
    const spanEnd = Math.max(...items.map(itemEnd));
    const origTrack = it.trackId;
    const kind = p.tracks.find((t) => t.id === origTrack)?.kind;
    const sameKind = p.tracks.filter((t) => t.kind === kind);
    const origIdx = sameKind.findIndex((t) => t.id === origTrack);
    let dt = 0;
    let dTrack = 0;
    let moved = false;
    const els = ids.map((id) => this.els.get(id)).filter(Boolean);
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4 && Math.abs(ev.clientY - startY) < 4) return;
      moved = true;
      let t = Math.max(0, minStart + dx / store.zoom);
      const sn = ev.altKey ? { t, snapped: null } : this._snap(t, exclude, [0, spanEnd - minStart]);
      t = Math.max(0, sn.t);
      this.showSnap(sn.snapped);
      dt = t - minStart;
      const overTrack = this.trackAt(ev.clientY);
      const overIdx = sameKind.findIndex((tt) => tt.id === overTrack);
      dTrack = overIdx >= 0 ? overIdx - origIdx : dTrack;
      const rowDy = overIdx >= 0 && overIdx !== origIdx ? this.rows.get(sameKind[overIdx].id).offsetTop - this.rows.get(origTrack).offsetTop : 0;
      for (const el of els) {
        el.style.transform = `translate(${dt * store.zoom}px, ${rowDy}px)`;
        el.classList.add('dragging');
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.showSnap(null);
      for (const el of els) {
        el.style.transform = '';
        el.classList.remove('dragging');
      }
      if (!moved) {
        if (!ev.shiftKey) store.select(it.id);
        const t = this.timeAt(ev.clientX);
        store.seek(this._snapPlayhead(t, ev));
        this.app.preview?.seeked();
        return;
      }
      const dropTime = this.timeAt(ev.clientX);
      store.commit('Move clip', (pp) => E.moveItems(pp, ids, dt, dTrack, { dropTime }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _trim(e, it, left) {
    const p = store.project;
    const startX = e.clientX;
    const origStart = it.start;
    const origEnd = itemEnd(it);
    const magnetic = E.isMagnetic(p, it.trackId);
    // neighbours limit trims on free tracks
    const siblings = trackItems(p, it.trackId).filter((o) => o.id !== it.id);
    const prevEnd = Math.max(0, ...siblings.filter((o) => itemEnd(o) <= origStart + 1e-3).map(itemEnd));
    const nextStart = Math.min(Infinity, ...siblings.filter((o) => o.start >= origEnd - 1e-3).map((o) => o.start));
    const snap = JSON.stringify(it);
    store.beginGesture();
    const exclude = new Set([it.id]);
    const move = (ev) => {
      let t = (left ? origStart : origEnd) + (ev.clientX - startX) / store.zoom;
      const sn = ev.altKey ? { t, snapped: null } : this._snap(t, exclude);
      t = sn.t;
      this.showSnap(sn.snapped);
      store.mutate((pp) => {
        const cur = pp.items[it.id];
        if (!cur) return;
        Object.assign(cur, JSON.parse(snap));
        if (left) {
          if (!magnetic) t = Math.max(t, prevEnd);
          E.trimHeadTo(pp, cur, t);
        } else {
          if (!magnetic) t = Math.min(t, nextStart);
          E.trimTailTo(pp, cur, t);
        }
        if (magnetic) E.compactMagnetic(pp);
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.showSnap(null);
      store.endGesture(left ? 'Trim start' : 'Trim end');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _dragKeyframe(e, id, kt) {
    const it = store.project.items[id];
    store.selectedKeyframe = { id, t: kt };
    store.seek(it.start + kt);
    this.app.preview?.seeked();
    store.emit('selection');
    const startX = e.clientX;
    let moved = false;
    store.beginGesture();
    const move = (ev) => {
      const dt = (ev.clientX - startX) / store.zoom;
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      const nt = clamp(store.snapTime(kt + dt), 0, it.duration);
      store.mutate(() => {
        for (const list of Object.values(it.kf)) {
          const k = list.find((x) => Math.abs(x.t - store.selectedKeyframe.t) < 1e-3);
          if (k) k.t = nt;
          list.sort((a, b) => a.t - b.t);
        }
        store.selectedKeyframe.t = nt;
      });
      store.seek(it.start + nt);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.endGesture('Move keyframe');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _dragFade(e, id, isIn) {
    const it = store.project.items[id];
    const startX = e.clientX;
    const orig = isIn ? it.fadeIn || 0 : it.fadeOut || 0;
    store.beginGesture();
    const move = (ev) => {
      const d = ((ev.clientX - startX) / store.zoom) * (isIn ? 1 : -1);
      store.mutate(() => {
        const v = clamp(orig + d, 0, it.duration / 2);
        if (isIn) it.fadeIn = Math.round(v * 100) / 100;
        else it.fadeOut = Math.round(v * 100) / 100;
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.endGesture(isIn ? 'Fade in' : 'Fade out');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _dragMarker(e, id) {
    const mk = store.project.markers.find((m) => m.id === id);
    if (!mk) return;
    const startX = e.clientX;
    const orig = mk.t;
    let moved = false;
    store.beginGesture();
    const move = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      store.mutate(() => (mk.t = Math.max(0, store.snapTime(orig + (ev.clientX - startX) / store.zoom))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.endGesture('Move marker');
      if (!moved) {
        store.seek(mk.t);
        this.app.preview?.seeked();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  onContext(e) {
    e.preventDefault();
    const clipEl = e.target.closest('.tl-clip');
    const markerEl = e.target.closest('.tl-marker');
    if (markerEl) {
      this.app.contextMenu(e.clientX, e.clientY, [
        ['Rename marker', () => this.app.cmd('renameMarker', markerEl.dataset.marker)],
        ['Delete marker', () => store.commit('Delete marker', (p) => (p.markers = p.markers.filter((m) => m.id !== markerEl.dataset.marker)))],
      ]);
      return;
    }
    if (!clipEl) {
      const t = this.timeAt(e.clientX);
      this.app.contextMenu(e.clientX, e.clientY, [
        ['Paste here', () => this.app.cmd('paste', t), !this.app.clipboard],
        ['Add text here', () => this.app.cmd('addText', t)],
        ['Add marker here', () => this.app.cmd('marker', t)],
        ['Close gaps on this track', () => {
          const tr = this.trackAt(e.clientY);
          if (tr) store.commit('Close gaps', (p) => E.closeGaps(p, tr));
        }],
      ]);
      return;
    }
    const it = store.project.items[clipEl.dataset.id];
    if (!store.selection.has(it.id)) store.select(it.id);
    this.app.clipMenu(e.clientX, e.clientY, it);
  }

  /** Called by the media panel while dragging media over the window. */
  dragOver(clientX, clientY, kind) {
    const r = this.scroll.getBoundingClientRect();
    if (clientX < r.left + HEAD_W || clientX > r.right || clientY < r.top || clientY > r.bottom) {
      this.dropIndicator.style.display = 'none';
      return null;
    }
    const t = this.timeAt(clientX);
    const trackId = this.trackAt(clientY);
    const tr = store.project.tracks.find((x) => x.id === trackId);
    const row = tr ? this.rows.get(tr.id) : null;
    Object.assign(this.dropIndicator.style, {
      display: 'block',
      left: t * store.zoom + 'px',
      top: (row ? row.offsetTop : this.tracksEl.offsetHeight - 4) + 'px',
      height: (row ? row.offsetHeight : 8) + 'px',
    });
    return { t, trackId: tr && (kind === 'audio') === (tr.kind === 'audio') ? tr.id : null };
  }

  dragEnd() {
    this.dropIndicator.style.display = 'none';
  }
}

export { HEAD_W, visualTracks, maxClipDuration };
