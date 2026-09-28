// Preview area: canvas, transport controls and on-canvas handles for moving,
// scaling, rotating and cropping the selected item.

import { h, icon, iconButton, clear } from './dom.js';
import { store } from '../core/store.js';
import { Preview } from '../render/preview.js';
import { AudioView } from './audio-view.js';
import { formatTime, clamp } from '../core/util.js';
import { itemBox, setProp, getProp } from '../core/props.js';
import { activeVisualItems, itemEnd, isVisualItem, projectDuration, propAt } from '../core/model.js';

export class Viewer {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.mode = 'transform'; // or 'crop'
    this.showSafe = false;
    this.showGrid = false;
    this.build();
    this.preview = new Preview(this.canvas);
    this.preview.onTick = () => this.updateTime();
    this.audioView = new AudioView(this);
    this.stage.append(this.audioView.root);
    this.applyMode();
    store.on('change', () => this.applyMode());
    store.on('change', () => {
      this.preview.invalidate();
      this.fit();
      this.drawOverlay();
    });
    store.on('seek', () => {
      this.preview.invalidate();
      this.updateTime();
      this.drawOverlay();
    });
    store.on('selection', () => this.drawOverlay());
    store.on('media', () => this.preview.invalidate());
    store.on('play', (on) => {
      this.playBtn.replaceChildren(icon(on ? 'pause' : 'play', 20));
      this.drawOverlay();
    });
    store.on('project', () => {
      this.preview.dropAll();
      this.applyMode();
      this.fit();
    });
    new ResizeObserver(() => this.fit()).observe(this.stage);
  }

  build() {
    const r = this.root;
    clear(r);
    r.classList.add('viewer');
    this.canvas = h('canvas', { class: 'viewer-canvas' });
    this.overlay = h('div', { class: 'viewer-overlay' });
    this.frame = h('div', { class: 'viewer-frame' }, this.canvas, this.overlay);
    this.stage = h('div', { class: 'viewer-stage' }, this.frame);
    this.timeEl = h('span', { class: 'tc' }, '00:00.00');
    this.durEl = h('span', { class: 'tc dim' }, '00:00.00');
    this.playBtn = h('button', { class: 'ibtn play', title: 'Play or pause (Space)', onclick: () => this.preview.toggle() }, icon('play', 20));
    this.qualitySel = h('select', { class: 'mini', title: 'Preview quality' }, ...[['auto', 'Auto'], ['full', 'Full'], ['half', 'Half'], ['quarter', 'Quarter']].map(([v, l]) => h('option', { value: v }, l)));
    this.qualitySel.value = store.settings.previewQuality || 'auto';
    this.qualitySel.addEventListener('change', () => {
      this.preview.quality = this.qualitySel.value;
      this.preview.invalidate();
      this.app.saveSetting('previewQuality', this.qualitySel.value);
    });
    this.loopBtn = iconButton('loop', () => {
      this.preview.loop = !this.preview.loop;
      this.loopBtn.classList.toggle('active', this.preview.loop);
    }, 'Loop playback');
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1, class: 'mini-range', title: 'Preview volume' });
    vol.addEventListener('input', () => (this.preview.volume = Number(vol.value)));
    this.safeBtn = iconButton('grid', () => {
      this.showSafe = !this.showSafe;
      this.safeBtn.classList.toggle('active', this.showSafe);
      this.drawOverlay();
    }, 'Show safe zones for Reels and TikTok buttons');
    const transport = h(
      'div',
      { class: 'transport' },
      h('div', { class: 'transport-left' }, this.timeEl, h('span', { class: 'dim' }, ' / '), this.durEl),
      h(
        'div',
        { class: 'transport-mid' },
        iconButton('prev', () => this.app.cmd('prevEdit'), 'Previous cut (Up)'),
        iconButton('stepBack', () => this.app.cmd('stepFrame', -1), 'Back one frame (Left)'),
        this.playBtn,
        iconButton('stepFwd', () => this.app.cmd('stepFrame', 1), 'Forward one frame (Right)'),
        iconButton('next', () => this.app.cmd('nextEdit'), 'Next cut (Down)'),
      ),
      h('div', { class: 'transport-right' }, this.loopBtn, this.safeBtn, h('span', { class: 'icon-wrap', title: 'Preview volume' }, icon('volume', 16)), vol, this.qualitySel, (this.fullBtn = iconButton('expand', () => this.fullscreen(), 'Full screen preview'))),
    );
    for (const el of [this.safeBtn, this.qualitySel, this.fullBtn]) el.classList.add('video-only');
    r.append(this.stage, transport);
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('dblclick', (e) => {
      const it = this.selectedVisual();
      if (it?.type === 'text') this.app.editTextInline?.(it);
    });
  }

  /** Audio projects show the sound wave and meters instead of the picture. */
  applyMode() {
    const audio = !!store.project?.settings.audioOnly;
    if (this._audio === audio) return;
    this._audio = audio;
    this.root.classList.toggle('audio-mode', audio);
    this.frame.style.display = audio ? 'none' : '';
    this.audioView.root.style.display = audio ? '' : 'none';
    this.audioView.dirty = true;
    if (!audio) setTimeout(() => this.fit(), 0);
  }

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.stage.requestFullscreen?.();
  }

  fit() {
    const W = store.project.settings.width;
    const H = store.project.settings.height;
    const sw = this.stage.clientWidth - 24;
    const sh = this.stage.clientHeight - 24;
    if (sw <= 0 || sh <= 0) return;
    const k = Math.min(sw / W, sh / H);
    const w = Math.floor(W * k);
    const hh = Math.floor(H * k);
    this.frame.style.width = w + 'px';
    this.frame.style.height = hh + 'px';
    this.k = k;
    this.preview.displayWidth = w;
    this.preview.invalidate();
    this.updateTime();
    this.drawOverlay();
  }

  updateTime() {
    const fps = store.project.settings.fps;
    this.timeEl.textContent = formatTime(store.playhead, { frames: false, fps });
    this.durEl.textContent = formatTime(projectDuration(store.project));
  }

  selectedVisual() {
    const it = store.primary;
    if (!it || !isVisualItem(store.project, it)) return null;
    if (store.playhead < it.start - 1e-6 || store.playhead >= itemEnd(it)) return null;
    if (it.type === 'adjust') return null;
    return it;
  }

  // ---- overlay -----------------------------------------------------------------

  drawOverlay() {
    const ov = this.overlay;
    clear(ov);
    const k = this.k || 1;
    const p = store.project;
    if (this.showSafe) {
      const W = p.settings.width;
      const H = p.settings.height;
      if (H > W) {
        // Reels/TikTok: top 14%, bottom 20% and right 16% carry buttons and captions
        ov.append(h('div', { class: 'safe', style: { left: 0, top: 0, width: '100%', height: '14%' } }));
        ov.append(h('div', { class: 'safe', style: { left: 0, bottom: 0, width: '100%', height: '22%' } }));
        ov.append(h('div', { class: 'safe', style: { right: 0, top: '14%', width: '16%', height: '64%' } }));
      } else {
        ov.append(h('div', { class: 'safe-frame', style: { left: '5%', top: '5%', width: '90%', height: '90%' } }));
      }
    }
    if (store.playing) return;
    const it = this.selectedVisual();
    if (!it) return;
    const b = itemBox(p, it);
    if (this.mode === 'pen') return this.drawPen(it, b, k);
    if (this.mode === 'crop' && it.type === 'clip') {
      const full = h('div', { class: 'box crop-full', style: boxStyle(b.fullCx, b.fullCy, b.fullW, b.fullH, b.rot, k) });
      ov.append(full);
    }
    const box = h('div', { class: 'box' + (this.mode === 'crop' ? ' crop' : ''), style: boxStyle(b.cx, b.cy, b.w, b.h, b.rot, k) });
    const handles = this.mode === 'crop' ? ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] : ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
    for (const hd of handles) box.append(h('div', { class: 'hd hd-' + hd, 'data-h': hd }));
    if (this.mode !== 'crop' && it.type !== 'blur') box.append(h('div', { class: 'hd-rot', 'data-h': 'rot', title: 'Rotate' }));
    ov.append(box);
  }

  toProject(e) {
    const r = this.frame.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.k, y: (e.clientY - r.top) / this.k };
  }

  hitTest(pt) {
    const p = store.project;
    // full-frame overlays other than a flare would cover everything, so clicks go through them
    const items = activeVisualItems(p, store.playhead).filter((i) => i.type !== 'adjust' && !(i.type === 'fx' && i.fx?.kind !== 'flare') && !p.tracks.find((t) => t.id === i.trackId)?.locked);
    for (let i = items.length - 1; i >= 0; i--) {
      const b = itemBox(p, items[i]);
      const a = (-b.rot * Math.PI) / 180;
      const dx = pt.x - b.cx;
      const dy = pt.y - b.cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return items[i];
    }
    return null;
  }

  // ---- freehand mask ---------------------------------------------------------------

  /** Draws the freehand mask points of the selected item over its full frame. */
  drawPen(it, b, k) {
    const ov = this.overlay;
    const frameBox = h('div', { class: 'pen-frame', style: boxStyle(b.fullCx, b.fullCy, b.fullW, b.fullH, b.rot, k) });
    const pts = it.mask?.points || [];
    const t = store.playhead;
    const dx = propAt(it, 'maskDX', t);
    const dy = propAt(it, 'maskDY', t);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'pen-svg');
    if (pts.length > 1) {
      const poly = document.createElementNS('http://www.w3.org/2000/svg', pts.length > 2 ? 'polygon' : 'polyline');
      poly.setAttribute('points', pts.map(([x, y]) => `${x + dx},${y + dy}`).join(' '));
      poly.setAttribute('class', 'pen-shape');
      svg.append(poly);
    }
    frameBox.append(svg);
    pts.forEach(([x, y], i) => {
      const d = h('div', { class: 'pen-pt' + (i === 0 ? ' first' : ''), style: { left: (x + dx) * 100 + '%', top: (y + dy) * 100 + '%' }, title: 'Drag to move. Double-click to remove.' });
      d.dataset.pt = i;
      frameBox.append(d);
    });
    ov.append(frameBox, h('div', { class: 'pen-help' }, pts.length < 3 ? 'Click around the area to outline it.' : 'Click to add points, drag to move them, double-click one to remove it.', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.setMode('transform') }, 'Done')));
    this._penBox = { b, dx, dy };
  }

  /** Converts a pointer position into the item's local 0..1 frame. */
  penLocal(e) {
    const { b } = this._penBox;
    const pt = this.toProject(e);
    const a = (-b.rot * Math.PI) / 180;
    const x = pt.x - b.fullCx;
    const y = pt.y - b.fullCy;
    return [clamp((x * Math.cos(a) - y * Math.sin(a)) / b.fullW + 0.5, -0.2, 1.2), clamp((x * Math.sin(a) + y * Math.cos(a)) / b.fullH + 0.5, -0.2, 1.2)];
  }

  onPenDown(e) {
    const it = this.selectedVisual();
    if (!it || !this._penBox) return;
    e.preventDefault();
    const { dx, dy } = this._penBox;
    const ptEl = e.target.closest('.pen-pt');
    const now = performance.now();
    if (ptEl) {
      const i = Number(ptEl.dataset.pt);
      if (this._lastPen && this._lastPen.i === i && now - this._lastPen.at < 450) {
        this._lastPen = null;
        store.commit('Remove mask point', () => it.mask.points.splice(i, 1));
        return;
      }
      this._lastPen = { i, at: now };
      store.beginGesture();
      this.overlay.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const [x, y] = this.penLocal(ev);
        store.mutate(() => (it.mask.points[i] = [+(x - dx).toFixed(4), +(y - dy).toFixed(4)]));
      };
      const up = () => {
        this.overlay.removeEventListener('pointermove', move);
        this.overlay.removeEventListener('pointerup', up);
        store.endGesture('Move mask point');
      };
      this.overlay.addEventListener('pointermove', move);
      this.overlay.addEventListener('pointerup', up);
      return;
    }
    if (e.target.closest('.pen-help')) return;
    const [x, y] = this.penLocal(e);
    store.commit('Add mask point', () => {
      it.mask.type = 'path';
      it.mask.points ||= [];
      it.mask.points.push([+(x - dx).toFixed(4), +(y - dy).toFixed(4)]);
    });
  }

  onDown(e) {
    if (this.mode === 'pen' && e.button === 0 && !store.playing) return this.onPenDown(e);
    if (e.button !== 0 || store.playing) return;
    const p = store.project;
    const handle = e.target.dataset?.h;
    let it = this.selectedVisual();
    const pt0 = this.toProject(e);
    if (!handle) {
      const hit = this.hitTest(pt0);
      if (!hit) {
        store.clearSelection();
        return;
      }
      if (hit !== it) {
        store.select(hit.id);
        it = hit;
      }
    }
    if (!it) return;
    const W = p.settings.width;
    const H = p.settings.height;
    const b0 = itemBox(p, it);
    const start = {
      x: getProp(it, 'x'),
      y: getProp(it, 'y'),
      scale: getProp(it, 'scale'),
      rot: getProp(it, 'rotation'),
      crop: { ...b0.crop },
      w: it.w,
      h: it.h,
    };
    store.beginGesture();
    this.overlay.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const pt = this.toProject(ev);
      const dx = pt.x - pt0.x;
      const dy = pt.y - pt0.y;
      store.mutate(() => {
        if (!handle) {
          let nx = start.x + dx;
          let ny = start.y + dy;
          // snap the centre to the frame centre lines
          const thr = 8 / this.k;
          this.guides = [];
          if (!ev.altKey) {
            if (Math.abs(nx + (b0.cx - W / 2 - start.x)) < thr) {
              nx = -(b0.cx - W / 2 - start.x);
              this.guides.push('v');
            }
            if (Math.abs(ny + (b0.cy - H / 2 - start.y)) < thr) {
              ny = -(b0.cy - H / 2 - start.y);
              this.guides.push('h');
            }
          }
          setProp(it, 'x', Math.round(nx));
          setProp(it, 'y', Math.round(ny));
        } else if (handle === 'rot') {
          const a0 = Math.atan2(pt0.y - b0.cy, pt0.x - b0.cx);
          const a1 = Math.atan2(pt.y - b0.cy, pt.x - b0.cx);
          let r = start.rot + ((a1 - a0) * 180) / Math.PI;
          if (ev.shiftKey) r = Math.round(r / 15) * 15;
          else for (const snapA of [-180, -90, 0, 90, 180]) if (Math.abs(r - snapA) < 3) r = snapA;
          setProp(it, 'rotation', Math.round(r * 10) / 10);
        } else if (this.mode === 'crop' && it.type === 'clip') {
          const a = (-b0.rot * Math.PI) / 180;
          const lx = dx * Math.cos(a) - dy * Math.sin(a);
          const ly = dx * Math.sin(a) + dy * Math.cos(a);
          const fx = lx / b0.fullW;
          const fy = ly / b0.fullH;
          const c = { ...start.crop };
          if (handle.includes('w')) c.l = clamp(start.crop.l + fx, 0, 0.95 - c.r);
          if (handle.includes('e')) c.r = clamp(start.crop.r - fx, 0, 0.95 - c.l);
          if (handle.includes('n')) c.t = clamp(start.crop.t + fy, 0, 0.95 - c.b);
          if (handle.includes('s')) c.b = clamp(start.crop.b - fy, 0, 0.95 - c.t);
          setProp(it, 'cropL', c.l);
          setProp(it, 'cropR', c.r);
          setProp(it, 'cropT', c.t);
          setProp(it, 'cropB', c.b);
        } else if (it.type === 'blur' || (it.type === 'shape' && handle.length === 1)) {
          const a = (-b0.rot * Math.PI) / 180;
          const lx = dx * Math.cos(a) - dy * Math.sin(a);
          const ly = dx * Math.sin(a) + dy * Math.cos(a);
          const s = start.scale || 1;
          if (handle.includes('e') || handle.includes('w')) it.w = Math.max(16, start.w + (handle.includes('e') ? lx : -lx) * 2 / s);
          if (handle.includes('n') || handle.includes('s')) it.h = Math.max(16, start.h + (handle.includes('s') ? ly : -ly) * 2 / s);
        } else {
          const d0 = Math.hypot(pt0.x - b0.cx, pt0.y - b0.cy);
          const d1 = Math.hypot(pt.x - b0.cx, pt.y - b0.cy);
          const ns = Math.max(0.02, (start.scale * d1) / Math.max(1, d0));
          setProp(it, 'scale', Math.round(ns * 1000) / 1000);
        }
      });
      this.drawGuides();
    };
    const up = () => {
      this.overlay.removeEventListener('pointermove', move);
      this.overlay.removeEventListener('pointerup', up);
      this.guides = [];
      store.endGesture(handle ? (handle === 'rot' ? 'Rotate' : this.mode === 'crop' ? 'Crop' : 'Resize') : 'Move');
    };
    this.overlay.addEventListener('pointermove', move);
    this.overlay.addEventListener('pointerup', up);
  }

  drawGuides() {
    this.overlay.querySelectorAll('.guide').forEach((g) => g.remove());
    for (const g of this.guides || []) this.overlay.append(h('div', { class: 'guide guide-' + g }));
  }

  setMode(mode) {
    const changed = this.mode !== mode;
    this.mode = mode;
    this.drawOverlay();
    if (changed) store.emit('viewer-mode', mode);
  }
}

function boxStyle(cx, cy, w, hh, rot, k) {
  return {
    left: (cx - w / 2) * k + 'px',
    top: (cy - hh / 2) * k + 'px',
    width: w * k + 'px',
    height: hh * k + 'px',
    transform: `rotate(${rot}deg)`,
  };
}
