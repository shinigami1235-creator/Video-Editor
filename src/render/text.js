// Rasterises text and shape items to canvases in project pixel units.

import { clamp } from '../core/util.js';

const cache = new Map();
let fontEpoch = 0;
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener?.('loadingdone', () => {
    fontEpoch++;
    cache.clear();
    window.dispatchEvent(new Event('ve-fonts-changed'));
  });
}

export function clearTextCache() {
  cache.clear();
}

function fontString(st, size) {
  return `${st.italic ? 'italic ' : ''}${st.weight || 400} ${size}px "${st.font}", "Inter", sans-serif`;
}

export function requestFont(st) {
  if (!document.fonts) return;
  const f = fontString(st, 40);
  if (!document.fonts.check(f)) document.fonts.load(f).catch(() => {});
}

/** Which characters/words are visible and highlighted at local time `local`. */
export function revealState(it, local) {
  const text = it.style?.uppercase ? it.text.toUpperCase() : it.text;
  const r = it.reveal || 'none';
  if (it.words?.length && (r === 'karaoke' || r === 'word' || r === 'highlight')) {
    let active = -1;
    let shown = 0;
    for (let i = 0; i < it.words.length; i++) {
      if (local >= it.words[i].start - 0.02) shown = i + 1;
      if (local >= it.words[i].start - 0.02 && local < (it.words[i + 1]?.start ?? it.words[i].end + 10)) active = i;
    }
    return { mode: r, active, shown: r === 'word' ? shown : it.words.length };
  }
  if (r === 'typewriter') {
    const total = [...text].length;
    const dur = Math.min(it.duration * 0.7, total * 0.045 + 0.2);
    const n = clamp(Math.floor((local / Math.max(0.05, dur)) * total), 0, total);
    return { mode: r, chars: n };
  }
  if (r === 'word') {
    const words = text.split(/\s+/).filter(Boolean);
    const per = Math.min(0.35, (it.duration * 0.7) / Math.max(1, words.length));
    return { mode: 'wordsplit', shown: clamp(Math.floor(local / per) + 1, 0, words.length) };
  }
  return { mode: 'none' };
}

function wrapWords(ctx, words, maxW, spaceW) {
  const lines = [];
  let line = [];
  let w = 0;
  for (const word of words) {
    const ww = ctx.measureText(word.text).width;
    if (line.length && w + spaceW + ww > maxW) {
      lines.push({ words: line, width: w });
      line = [];
      w = 0;
    }
    word.w = ww;
    w += (line.length ? spaceW : 0) + ww;
    line.push(word);
  }
  if (line.length) lines.push({ words: line, width: w });
  return lines;
}

/**
 * Returns { canvas, w, h } where w/h are in project pixels. `scale` is the
 * raster resolution (canvas pixels per project pixel).
 */
export function rasterText(it, local, projectW, scale = 1) {
  const st = it.style;
  const rs = revealState(it, local);
  const key = [it.id, it.text, JSON.stringify(st), it.reveal, JSON.stringify(rs), projectW, scale.toFixed(3), fontEpoch, it.words ? it.words.length : 0].join('|');
  const hit = cache.get(it.id);
  if (hit && hit.key === key) return hit.out;

  const size = st.size;
  const measure = new OffscreenCanvas(8, 8).getContext('2d');
  measure.font = fontString(st, size);
  if ('letterSpacing' in measure) measure.letterSpacing = (st.letterSpacing || 0) + 'px';
  const text = st.uppercase ? it.text.toUpperCase() : it.text;
  const spaceW = measure.measureText(' ').width;
  const maxW = Math.max(size * 2, (st.maxWidth || 0.86) * projectW);

  // words carry their index into it.words for highlighting
  let words;
  if (it.words?.length) words = it.words.map((w, i) => ({ text: st.uppercase ? w.text.toUpperCase() : w.text, idx: i, br: false }));
  else {
    words = [];
    let idx = 0;
    const paras = text.split('\n');
    paras.forEach((p, pi) => {
      const ws = p.split(/\s+/).filter(Boolean);
      ws.forEach((w) => words.push({ text: w, idx: idx++ }));
      if (pi < paras.length - 1) words.push({ text: '', idx: -1, br: true });
    });
  }
  // wrap with manual line breaks
  const lines = [];
  let chunk = [];
  const flush = () => {
    if (!chunk.length) {
      lines.push({ words: [], width: 0 });
      return;
    }
    lines.push(...wrapWords(measure, chunk, maxW, spaceW));
    chunk = [];
  };
  for (const w of words) {
    if (w.br) flush();
    else chunk.push(w);
  }
  flush();

  const lh = size * (st.lineHeight || 1.15);
  const pad = st.boxEnabled ? st.boxPadding || 20 : 0;
  const outline = st.outlineWidth || 0;
  const shadowM = (st.shadowBlur || 0) + Math.max(Math.abs(st.shadowX || 0), Math.abs(st.shadowY || 0));
  const margin = Math.ceil(pad + outline + shadowM + 4);
  const contentW = Math.max(1, ...lines.map((l) => l.width));
  const contentH = lines.length * lh;
  const w = Math.ceil(contentW + margin * 2);
  const h = Math.ceil(contentH + margin * 2);
  const canvas = new OffscreenCanvas(Math.max(2, Math.ceil(w * scale)), Math.max(2, Math.ceil(h * scale)));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.font = fontString(st, size);
  if ('letterSpacing' in ctx) ctx.letterSpacing = (st.letterSpacing || 0) + 'px';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  let charBudget = rs.mode === 'typewriter' ? rs.chars : Infinity;
  const visibleWord = (w) => {
    if (rs.mode === 'word' || rs.mode === 'wordsplit') return w.idx < rs.shown;
    return true;
  };

  // background box behind all lines
  if (st.boxEnabled) {
    ctx.fillStyle = st.boxColor;
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      if (!L.words.some(visibleWord)) continue;
      const x0 = lineX(L.width) - pad;
      const y0 = margin + li * lh - pad * 0.35;
      roundRect(ctx, x0, y0, L.width + pad * 2, lh + pad * 0.7, st.boxRadius || 0);
      ctx.fill();
    }
  }

  function lineX(lw) {
    if (st.align === 'left') return margin;
    if (st.align === 'right') return w - margin - lw;
    return (w - lw) / 2;
  }

  const drawPass = (pass) => {
    let budget = charBudget;
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      let x = lineX(L.width);
      const y = margin + li * lh + lh / 2;
      for (const word of L.words) {
        if (!visibleWord(word)) {
          x += word.w + spaceW;
          continue;
        }
        let t = word.text;
        if (budget !== Infinity) {
          const chars = [...t];
          if (budget <= 0) break;
          if (chars.length > budget) t = chars.slice(0, budget).join('');
          budget -= chars.length + 1;
        }
        const active = rs.active === word.idx && (rs.mode === 'karaoke' || rs.mode === 'highlight');
        if (pass === 'hlbox' && active && st.highlightMode === 'box') {
          ctx.fillStyle = st.highlightColor;
          roundRect(ctx, x - size * 0.12, y - lh * 0.46, word.w + size * 0.24, lh * 0.92, size * 0.18);
          ctx.fill();
        }
        if (pass === 'outline' && outline > 0) {
          ctx.strokeStyle = st.outlineColor;
          ctx.lineWidth = outline * 2;
          ctx.strokeText(t, x, y);
        }
        if (pass === 'fill') {
          let color = st.color;
          if (active && st.highlightMode !== 'box') color = st.highlightColor;
          if (active && st.highlightMode === 'box') color = st.color;
          ctx.fillStyle = color;
          if (active && rs.mode === 'karaoke' && st.highlightMode === 'scale') {
            ctx.save();
            ctx.translate(x + word.w / 2, y);
            ctx.scale(1.12, 1.12);
            ctx.fillText(t, -word.w / 2, 0);
            ctx.restore();
          } else ctx.fillText(t, x, y);
        }
        x += word.w + spaceW;
      }
    }
  };

  if (st.shadowBlur > 0 || st.shadowX || st.shadowY) {
    ctx.save();
    ctx.shadowColor = st.shadowColor;
    ctx.shadowBlur = st.shadowBlur * scale;
    ctx.shadowOffsetX = (st.shadowX || 0) * scale;
    ctx.shadowOffsetY = (st.shadowY || 0) * scale;
    if (outline > 0) drawPass('outline');
    else drawPass('fill');
    ctx.restore();
  }
  drawPass('hlbox');
  drawPass('outline');
  drawPass('fill');

  const out = { canvas, w, h };
  cache.set(it.id, { key, out });
  return out;
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function rasterShape(it, scale = 1) {
  const key = [it.id, it.shape, it.w, it.h, it.fill, it.stroke, it.strokeWidth, it.radius, scale.toFixed(3)].join('|');
  const hit = cache.get(it.id);
  if (hit && hit.key === key) return hit.out;
  const sw = it.strokeWidth || 0;
  const m = Math.ceil(sw + 4);
  const isLine = it.shape === 'line' || it.shape === 'arrow';
  const w = Math.ceil(it.w + m * 2);
  const h = Math.ceil((isLine ? Math.max(it.h, sw * 4) : it.h) + m * 2);
  const canvas = new OffscreenCanvas(Math.max(2, Math.ceil(w * scale)), Math.max(2, Math.ceil(h * scale)));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = it.fill;
  ctx.strokeStyle = it.stroke;
  ctx.lineWidth = sw;
  if (it.shape === 'rect' || it.shape === 'callout') {
    roundRect(ctx, m, m, it.w, it.h, it.shape === 'callout' ? it.h / 2 : it.radius || 0);
    ctx.fill();
    if (sw) ctx.stroke();
  } else if (it.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, it.w / 2, it.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    if (sw) ctx.stroke();
  } else if (isLine) {
    const y = h / 2;
    const x0 = m;
    const x1 = w - m;
    ctx.strokeStyle = it.fill === 'rgba(255,255,255,0.0)' ? it.stroke : it.fill;
    ctx.lineWidth = Math.max(2, sw);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(it.shape === 'arrow' ? x1 - sw * 2.2 : x1, y);
    ctx.stroke();
    if (it.shape === 'arrow') {
      const head = Math.max(16, sw * 3.2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x1 - head, y - head * 0.6);
      ctx.lineTo(x1 - head, y + head * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }
  const out = { canvas, w, h };
  cache.set(it.id, { key, out });
  return out;
}
