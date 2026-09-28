// A small RGB curves editor.

import { h } from './dom.js';
import { sampleCurve, defaultCurves } from '../render/luts.js';
import { clamp } from '../core/util.js';

const COLORS = { master: '#e8e8e8', r: '#ff6b6b', g: '#5fd38d', b: '#5aa9ff' };

export function curveEditor(curves, onChange, onCommit) {
  let data = JSON.parse(JSON.stringify(curves || defaultCurves()));
  let channel = 'master';
  const size = 220;
  const cv = h('canvas', { width: size * 2, height: size * 2, class: 'curve-canvas', style: { width: size + 'px', height: size + 'px' } });
  const chans = h('div', { class: 'seg' });
  for (const [k, label] of [
    ['master', 'RGB'],
    ['r', 'Red'],
    ['g', 'Green'],
    ['b', 'Blue'],
  ]) {
    chans.append(
      h(
        'button',
        {
          class: 'seg-btn' + (k === channel ? ' active' : ''),
          type: 'button',
          onclick: (e) => {
            channel = k;
            chans.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            draw();
          },
        },
        label,
      ),
    );
  }
  const ctx = cv.getContext('2d');
  function draw() {
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#16181c';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#2c3037';
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((i * size) / 4, 0);
      ctx.lineTo((i * size) / 4, size);
      ctx.moveTo(0, (i * size) / 4);
      ctx.lineTo(size, (i * size) / 4);
      ctx.stroke();
    }
    for (const k of ['r', 'g', 'b', 'master']) {
      const s = sampleCurve(data[k]);
      ctx.strokeStyle = COLORS[k];
      ctx.globalAlpha = k === channel ? 1 : 0.25;
      ctx.lineWidth = k === channel ? 2 : 1;
      ctx.beginPath();
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * size;
        const y = size - s[i] * size;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS[channel];
    for (const [x, y] of data[channel]) {
      ctx.beginPath();
      ctx.arc(x * size, size - y * size, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const toPt = (e) => {
    const r = cv.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)];
  };
  cv.addEventListener('pointerdown', (e) => {
    const [x, y] = toPt(e);
    const pts = data[channel];
    let idx = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.05);
    if (idx < 0) {
      pts.push([x, y]);
      pts.sort((a, b) => a[0] - b[0]);
      idx = pts.findIndex((p) => p[0] === x && p[1] === y);
    }
    cv.setPointerCapture(e.pointerId);
    const isEnd = idx === 0 || idx === pts.length - 1;
    const move = (ev) => {
      const [nx, ny] = toPt(ev);
      const lo = idx > 0 ? pts[idx - 1][0] + 0.01 : 0;
      const hi = idx < pts.length - 1 ? pts[idx + 1][0] - 0.01 : 1;
      pts[idx] = [isEnd ? pts[idx][0] : clamp(nx, lo, hi), ny];
      draw();
      onChange(data);
    };
    const up = () => {
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      onCommit(data);
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    draw();
    onChange(data);
  });
  cv.addEventListener('dblclick', (e) => {
    const [x, y] = toPt(e);
    const pts = data[channel];
    const idx = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.05);
    if (idx > 0 && idx < pts.length - 1) {
      pts.splice(idx, 1);
      draw();
      onChange(data);
      onCommit(data);
    }
  });
  const reset = h('button', { class: 'btn btn-link', type: 'button', onclick: () => {
    data[channel] = defaultCurves()[channel];
    draw();
    onChange(data);
    onCommit(data);
  } }, 'Reset channel');
  draw();
  return h('div', { class: 'curves' }, chans, cv, h('div', { class: 'hint' }, 'Click to add a point, drag to shape, double-click a point to remove it.'), reset);
}
