// Small DOM helpers and form controls used across the interface.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const P = {
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  toStart: '<path d="M5 5v14"/><path d="M19 5v14l-6-7z M13 5v14l-6-7z" fill="currentColor" stroke="none"/>',
  toEnd: '<path d="M19 5v14"/><path d="M5 5v14l6-7z M11 5v14l6-7z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 5v14L8 12z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>',
  next: '<path d="M6 5v14l10-7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>',
  stepBack: '<path d="M15 6l-6 6 6 6"/>',
  stepFwd: '<path d="M9 6l6 6-6 6"/>',
  split: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  captions: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
  sparkles: '<path d="M12 3l1.8 4.9L19 9.5l-5.2 1.6L12 16l-1.8-4.9L5 9.5l5.2-1.6z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>',
  layers: '<path d="M12 2l10 6-10 6L2 8z"/><path d="M2 14l10 6 10-6"/>',
  template: '<rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="8" height="7" rx="1"/><rect x="15" y="14" width="6" height="7" rx="1"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 000 20c1.7 0 2-1.3 2-2.2 0-1.4-1-1.8-1-3 0-1 .8-1.8 1.8-1.8H17a5 5 0 005-5C22 5.6 17.5 2 12 2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  save: '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.9 17.9A10.8 10.8 0 0112 20C5 20 1 12 1 12a18.5 18.5 0 015.1-5.9M9.9 4.2A9.1 9.1 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.2 3.2M1 1l22 22"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.9-1"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6"/>',
  magnet: '<path d="M6 15V7a6 6 0 0112 0v8"/><path d="M6 11h4M14 11h4M6 15a6 6 0 0012 0"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  freeze: '<path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v5M8 22h8"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14M18 22V8a2 2 0 00-2-2H2"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  record: '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
  arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  blur: '<circle cx="12" cy="12" r="9" stroke-dasharray="2 2.5"/><circle cx="12" cy="12" r="4"/>',
  speed: '<path d="M12 14l4-4"/><path d="M3.3 17A10 10 0 1120.7 17"/>',
  audioWave: '<path d="M2 12h2M6 8v8M10 5v14M14 9v6M18 7v10M22 12h-2"/>',
  detach: '<path d="M4 7h10M4 17h6M17 14v7M14 17h6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  keyframe: '<path d="M12 3l9 9-9 9-9-9z"/>',
  marker: '<path d="M6 3h12v13l-6 5-6-5z"/>',
  mask: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="5"/>',
  transition: '<path d="M3 5h8v14H3zM13 5h8v14h-8z"/><path d="M9 12h6"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M5 21a7 7 0 0114 0"/>',
  brand: '<path d="M12 2l3 6 6 .9-4.5 4.3 1 6.3L12 16.5 6.5 19.5l1-6.3L3 8.9 9 8z"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  reverse: '<path d="M3 12a9 9 0 109-9 9.5 9.5 0 00-6.5 2.7L3 8"/><path d="M3 3v5h5"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/>',
  fit: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M12 8v8"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  shape: '<rect x="3" y="11" width="10" height="10" rx="1"/><circle cx="16" cy="8" r="5"/>',
  adjust: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 010 18" fill="currentColor"/>',
  doc: '<path d="M6 2h9l4 4v16H6z"/><path d="M14 2v5h5M9 12h7M9 16h7M9 8h2"/>',
  screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  prompter: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  cameras: '<rect x="2" y="7" width="12" height="10" rx="2"/><path d="M14 11l4-3v8l-4-3"/><circle cx="20" cy="5" r="1.5"/>',
  align: '<path d="M12 2v20M5 7h4M5 17h4M15 7h4M15 17h4"/><rect x="3" y="5" width="8" height="14" rx="1"/><rect x="13" y="5" width="8" height="14" rx="1"/>',
  pen: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3"/>',
  depth: '<path d="M3 17l6-6 4 4 8-8"/><path d="M3 21h18"/><circle cx="17" cy="6" r="2"/>',
  particles: '<circle cx="6" cy="6" r="1.5"/><circle cx="17" cy="8" r="1"/><circle cx="10" cy="14" r="2"/><circle cx="19" cy="18" r="1.5"/><circle cx="5" cy="19" r="1"/>',
  upscale: '<path d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  scissorsAi: '<circle cx="6" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M8.5 7.5L20 18M8.5 16.5L20 6"/>',
  robot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 13h.01M15 13h.01M9 17h6"/>',
};

// Panels build their content with optional parts (cond ? node : null). The
// DOM would print those as the word "null", so empty parts are skipped here
// for every element.
for (const name of ['append', 'prepend', 'replaceChildren']) {
  const native = Element.prototype[name];
  if (native.__safe) continue;
  const safe = function (...nodes) {
    return native.apply(this, nodes.filter((n) => n != null && n !== false));
  };
  safe.__safe = true;
  Element.prototype[name] = safe;
  if (DocumentFragment.prototype[name] === native) DocumentFragment.prototype[name] = safe;
}

export function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.classList.add('icon');
  s.innerHTML = P[name] || P.info;
  return s;
}

export function button(label, onClick, { icon: ic, cls = '', title, disabled, kind } = {}) {
  const b = h('button', { class: `btn ${kind ? 'btn-' + kind : ''} ${cls}`.trim(), title: title || null, onclick: onClick, type: 'button' });
  if (ic) b.append(icon(ic, 16));
  if (label) b.append(h('span', {}, label));
  if (disabled) b.disabled = true;
  return b;
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '');
/** Shortcut text for this computer: Ctrl on Windows, Cmd on a Mac. */
export const keyLabel = (k) => (IS_MAC && k ? k.replace(/Ctrl\+/g, 'Cmd+') : k);

export function iconButton(name, onClick, title, { cls = '', active = false, size = 18, disabled = false } = {}) {
  title = keyLabel(title);
  const b = h('button', { class: `ibtn ${cls} ${active ? 'active' : ''}`.trim(), title, 'aria-label': title, onclick: onClick, type: 'button' });
  if (disabled) b.disabled = true;
  b.append(icon(name, size));
  return b;
}

/**
 * A labelled slider with a number box. onInput fires while dragging,
 * onCommit when the drag ends (for undo grouping).
 */
export function slider(label, { value, min = 0, max = 1, step = 0.01, onInput, onCommit, format, unit = '', keyframe } = {}) {
  const row = h('div', { class: 'row slider-row' });
  const lab = h('label', {}, label);
  const range = h('input', { type: 'range', min, max, step, value });
  const num = h('input', { type: 'text', inputmode: 'decimal', value: fmt(value), class: 'num' });
  function fmt(v) {
    if (format) return format(v);
    const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return Number(v).toFixed(d);
  }
  let dragging = false;
  range.addEventListener('pointerdown', () => (dragging = true));
  range.addEventListener('input', () => {
    num.value = fmt(range.value);
    onInput?.(Number(range.value), dragging);
  });
  range.addEventListener('change', () => {
    dragging = false;
    onCommit?.(Number(range.value));
  });
  range.addEventListener('dblclick', () => {
    const def = row.dataset.default;
    if (def != null) {
      range.value = def;
      num.value = fmt(def);
      onInput?.(Number(def), false);
      onCommit?.(Number(def));
    }
  });
  num.addEventListener('change', () => {
    let raw = parseFloat(String(num.value).replace(',', '.'));
    if (!isFinite(raw)) raw = Number(range.value);
    // "25%" means 0.25 when the slider runs 0..1 or beyond
    if (/%\s*$/.test(num.value) && Number(max) <= 10) raw /= 100;
    const v = Math.min(Number(max), Math.max(Number(min), raw));
    range.value = v;
    num.value = fmt(v);
    onInput?.(v, false);
    onCommit?.(v);
  });
  row.append(lab, range, num);
  if (unit) row.append(h('span', { class: 'unit' }, unit));
  if (keyframe) row.append(keyframe);
  row.set = (v) => {
    range.value = v;
    num.value = fmt(v);
  };
  return row;
}

export function select(label, options, value, onChange) {
  const sel = h('select', { onchange: () => onChange(sel.value) });
  for (const o of options) {
    const [v, text] = Array.isArray(o) ? o : [o.value ?? o, o.label ?? o];
    const opt = h('option', { value: v }, text);
    if (String(v) === String(value)) opt.selected = true;
    sel.append(opt);
  }
  return label ? h('div', { class: 'row' }, h('label', {}, label), sel) : sel;
}

export function toggle(label, value, onChange, { title } = {}) {
  const inp = h('input', { type: 'checkbox', onchange: () => onChange(inp.checked) });
  inp.checked = !!value;
  return h('label', { class: 'row toggle', title: title || null }, inp, h('span', {}, label));
}

export function colorInput(label, value, onChange, { alpha = false } = {}) {
  const hex = toHexColor(value);
  const inp = h('input', { type: 'color', value: hex });
  inp.addEventListener('input', () => onChange(inp.value, false));
  inp.addEventListener('change', () => onChange(inp.value, true));
  const row = h('div', { class: 'row color-row' }, h('label', {}, label), inp);
  if (alpha) {
    const a = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: alphaOf(value), title: 'Opacity' });
    a.addEventListener('input', () => onChange(withAlpha(inp.value, Number(a.value)), false));
    a.addEventListener('change', () => onChange(withAlpha(inp.value, Number(a.value)), true));
    inp.addEventListener('input', () => onChange(withAlpha(inp.value, Number(a.value)), false));
    row.append(a);
  }
  return row;
}

export function toHexColor(c) {
  if (!c) return '#000000';
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c.slice(0, 7);
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return '#000000';
  const [r, g, b] = m[1].split(',').map((x) => parseInt(x, 10));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function alphaOf(c) {
  const m = String(c).match(/rgba\([^)]*,\s*([\d.]+)\)/);
  return m ? Number(m[1]) : 1;
}

export function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function section(title, ...children) {
  const body = h('div', { class: 'section-body' }, ...children);
  const head = h('div', { class: 'section-head' }, h('span', {}, title));
  const sec = h('div', { class: 'section' }, head, body);
  head.addEventListener('click', () => sec.classList.toggle('collapsed'));
  return sec;
}

export function tabs(list, active, onChange) {
  const bar = h('div', { class: 'tabs' });
  for (const [id, label] of list) {
    const b = h('button', { class: 'tab' + (id === active ? ' active' : ''), type: 'button', onclick: () => onChange(id) }, label);
    bar.append(b);
  }
  return bar;
}

export function textInput(label, value, onChange, { placeholder = '', multiline = false, onCommit } = {}) {
  const inp = multiline ? h('textarea', { rows: 3, placeholder }) : h('input', { type: 'text', placeholder });
  inp.value = value ?? '';
  inp.addEventListener('input', () => onChange?.(inp.value));
  inp.addEventListener('change', () => onCommit?.(inp.value));
  return label ? h('div', { class: 'row col' }, h('label', {}, label), inp) : inp;
}

export function grid(items, cls = 'grid') {
  return h('div', { class: cls }, ...items);
}

export function card(title, { onClick, preview, sub, active = false, cls = '', title2 } = {}) {
  const c = h('button', { class: `card ${active ? 'active' : ''} ${cls}`.trim(), type: 'button', onclick: onClick, title: title2 || title });
  if (preview) c.append(h('div', { class: 'card-preview' }, preview));
  c.append(h('div', { class: 'card-title' }, title));
  if (sub) c.append(h('div', { class: 'card-sub' }, sub));
  return c;
}
