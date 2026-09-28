let idCounter = 0;
export function uid(prefix = 'i') {
  idCounter = (idCounter + 1) % 1e6;
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + idCounter.toString(36);
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

export function throttle(fn, ms) {
  let last = 0;
  let t = null;
  return (...a) => {
    const now = performance.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...a);
    } else {
      clearTimeout(t);
      t = setTimeout(() => {
        last = performance.now();
        fn(...a);
      }, wait);
    }
  };
}

/** 83.5 -> "01:23.50" (minutes:seconds.hundredths) or with hours when needed. */
export function formatTime(sec, { frames = false, fps = 30 } = {}) {
  if (!isFinite(sec)) sec = 0;
  const neg = sec < 0;
  sec = Math.abs(sec);
  sec = frames ? Math.round(sec * fps) / fps : Math.round(sec * 100) / 100;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  let tail;
  if (frames) tail = ':' + String(Math.floor((sec % 1) * fps + 1e-6)).padStart(2, '0');
  else tail = '.' + String(Math.floor((sec % 1) * 100 + 1e-6)).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return (neg ? '-' : '') + (h ? h + ':' + mm : mm) + ':' + ss + tail;
}

/** Short duration label like "4.2s" or "1:05". */
export function formatDuration(sec) {
  if (sec < 60) return (Math.round(sec * 10) / 10).toFixed(1) + 's';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

/** SRT timestamp 00:00:01,500 */
export function srtTime(sec, sepChar = ',') {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sepChar}${String(r).padStart(3, '0')}`;
}

export function parseColor(c) {
  if (!c) return [0, 0, 0, 1];
  if (Array.isArray(c)) return c;
  c = String(c).trim();
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] == null ? 1 : p[3]];
  }
  return [1, 1, 1, 1];
}

export function toHex([r, g, b]) {
  const h = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/** Stable short hash of a string (FNV-1a), hex. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this._h.get(ev)?.delete(fn);
  }
  emit(ev, ...a) {
    for (const fn of this._h.get(ev) || []) {
      try {
        fn(...a);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

/** Runs async tasks with at most `limit` in flight. */
export function limiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
