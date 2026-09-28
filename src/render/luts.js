// 3D LUTs (.cube files and built-in looks) and RGB curves.

import { clamp } from '../core/util.js';

/** Parses a .cube file into { size, data: Uint8Array RGBA (size^3 * 4) }. */
export function parseCube(text) {
  let size = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('LUT_3D_SIZE')) size = parseInt(line.split(/\s+/)[1], 10);
    else if (up.startsWith('DOMAIN_MIN')) domainMin = line.split(/\s+/).slice(1).map(Number);
    else if (up.startsWith('DOMAIN_MAX')) domainMax = line.split(/\s+/).slice(1).map(Number);
    else if (up.startsWith('TITLE') || up.startsWith('LUT_1D_SIZE') || up.startsWith('LUT_3D_INPUT_RANGE')) continue;
    else if (/^[-+\d.eE]/.test(line)) {
      const p = line.split(/\s+/).map(Number);
      if (p.length >= 3) values.push(p[0], p[1], p[2]);
    }
  }
  if (!size || values.length < size * size * size * 3) throw new Error('This file is not a 3D .cube LUT.');
  const data = new Uint8Array(size * size * size * 4);
  for (let i = 0; i < size * size * size; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (values[i * 3 + c] - domainMin[c]) / (domainMax[c] - domainMin[c] || 1);
      data[i * 4 + c] = Math.round(clamp(v, 0, 1) * 255);
    }
    data[i * 4 + 3] = 255;
  }
  // .cube order is red fastest, which matches a 3D texture with x = red.
  return { size, data };
}

function makeLut(fn, size = 33) {
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data[i++] = Math.round(clamp(out[0], 0, 1) * 255);
        data[i++] = Math.round(clamp(out[1], 0, 1) * 255);
        data[i++] = Math.round(clamp(out[2], 0, 1) * 255);
        data[i++] = 255;
      }
  return { size, data };
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mix = (a, b, t) => a + (b - a) * t;
const scurve = (x, k) => {
  const y = x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 * (1 - x), k);
  return y;
};

export const BUILTIN_LUTS = {
  tealOrange: {
    name: 'Teal and orange',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const w = clamp((l - 0.15) / 0.7, 0, 1);
      const shadow = [0.0, 0.42, 0.48];
      const high = [1.0, 0.62, 0.35];
      const tint = [mix(shadow[0], high[0], w), mix(shadow[1], high[1], w), mix(shadow[2], high[2], w)];
      const k = 0.28;
      return [scurve(mix(r, tint[0] * l * 2, k), 1.25), scurve(mix(g, tint[1] * l * 2, k), 1.25), scurve(mix(b, tint[2] * l * 2, k), 1.25)];
    },
  },
  filmic: {
    name: 'Soft film',
    fn: (r, g, b) => {
      const f = (x) => 0.04 + 0.92 * scurve(x, 1.35);
      const l = luma(r, g, b);
      return [f(mix(l, r, 0.85)) + 0.015, f(mix(l, g, 0.85)), f(mix(l, b, 0.85)) - 0.01];
    },
  },
  warmGold: {
    name: 'Warm gold',
    fn: (r, g, b) => [scurve(r * 1.06 + 0.02, 1.15), scurve(g * 1.01 + 0.01, 1.15), scurve(b * 0.88, 1.15)],
  },
  cleanClinic: {
    name: 'Clean clinic',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const lift = (x) => Math.pow(clamp(x * 1.04 + 0.02, 0, 1), 0.92);
      return [lift(mix(l, r, 0.92)) - 0.01, lift(mix(l, g, 0.92)), lift(mix(l, b, 0.92)) + 0.02];
    },
  },
  richChocolate: {
    name: 'Rich chocolate',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const s = 1.18;
      const c = (x) => scurve(clamp(x, 0, 1), 1.3);
      return [c(mix(l, r, s) * 1.04), c(mix(l, g, s) * 0.98), c(mix(l, b, s) * 0.86)];
    },
  },
  moody: {
    name: 'Moody',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const c = (x) => 0.03 + 0.85 * scurve(x, 1.4);
      return [c(mix(l, r, 0.7)), c(mix(l, g, 0.7)) + 0.005, c(mix(l, b, 0.7)) + 0.03];
    },
  },
  blackWhite: {
    name: 'Black and white',
    fn: (r, g, b) => {
      const l = scurve(luma(r, g, b), 1.2);
      return [l, l, l];
    },
  },
  vintage: {
    name: 'Vintage',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const c = (x) => 0.08 + 0.82 * x;
      return [c(mix(l, r, 0.75)) + 0.04, c(mix(l, g, 0.75)) + 0.02, c(mix(l, b, 0.75)) - 0.03];
    },
  },
  coolBlue: {
    name: 'Cool blue',
    fn: (r, g, b) => [scurve(r * 0.92, 1.15), scurve(g * 1.0, 1.15), scurve(b * 1.08 + 0.03, 1.15)],
  },
  vivid: {
    name: 'Vivid',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const s = 1.35;
      return [scurve(mix(l, r, s), 1.15), scurve(mix(l, g, s), 1.15), scurve(mix(l, b, s), 1.15)];
    },
  },
};

const builtCache = new Map();
export function builtinLut(key) {
  if (!BUILTIN_LUTS[key]) return null;
  if (!builtCache.has(key)) builtCache.set(key, makeLut(BUILTIN_LUTS[key].fn));
  return builtCache.get(key);
}

/** Writes a LUT as .cube text (used to export the built-in looks). */
export function lutToCube(lut, title = 'Look') {
  const { size, data } = lut;
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`];
  for (let i = 0; i < size * size * size; i++) lines.push(`${(data[i * 4] / 255).toFixed(5)} ${(data[i * 4 + 1] / 255).toFixed(5)} ${(data[i * 4 + 2] / 255).toFixed(5)}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Curves: each channel is a list of [x, y] points in 0..1.
// ---------------------------------------------------------------------------

export function defaultCurves() {
  const id = () => [
    [0, 0],
    [1, 1],
  ];
  return { master: id(), r: id(), g: id(), b: id() };
}

/** Monotone cubic interpolation through points, sampled to 256 values. */
export function sampleCurve(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const out = new Float32Array(256);
  if (n < 2) {
    for (let i = 0; i < 256; i++) out[i] = i / 255;
    return out;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    if (x <= xs[0]) {
      out[k] = ys[0];
      continue;
    }
    if (x >= xs[n - 1]) {
      out[k] = ys[n - 1];
      continue;
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[k] = clamp((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1], 0, 1);
  }
  return out;
}

export function isIdentityCurves(c) {
  if (!c) return true;
  return ['master', 'r', 'g', 'b'].every((k) => {
    const p = c[k];
    return !p || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1);
  });
}

/** 256x1 RGBA bytes: r,g,b channel curves and the master curve in alpha. */
export function curvesTexture(c) {
  const r = sampleCurve(c.r || defaultCurves().r);
  const g = sampleCurve(c.g || defaultCurves().g);
  const b = sampleCurve(c.b || defaultCurves().b);
  const m = sampleCurve(c.master || defaultCurves().master);
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = Math.round(r[i] * 255);
    data[i * 4 + 1] = Math.round(g[i] * 255);
    data[i * 4 + 2] = Math.round(b[i] * 255);
    data[i * 4 + 3] = Math.round(m[i] * 255);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Filter presets: named combinations of colour settings and a look.
// ---------------------------------------------------------------------------

export const FILTERS = {
  none: { name: 'None', color: {} },
  cinematic: { name: 'Cinematic', color: { contrast: 0.12, saturation: -0.05, lut: 'builtin:tealOrange', lutIntensity: 0.8, vignette: 0.25 } },
  film: { name: 'Soft film', color: { lut: 'builtin:filmic', lutIntensity: 1, grain: 0.15, fade: 0.1 } },
  gold: { name: 'Warm gold', color: { lut: 'builtin:warmGold', lutIntensity: 0.9, temperature: 0.15 } },
  clinic: { name: 'Clean clinic', color: { lut: 'builtin:cleanClinic', lutIntensity: 1, exposure: 0.08, highlights: 0.1 } },
  chocolate: { name: 'Rich chocolate', color: { lut: 'builtin:richChocolate', lutIntensity: 0.9, contrast: 0.08, vignette: 0.2 } },
  moody: { name: 'Moody', color: { lut: 'builtin:moody', lutIntensity: 1, exposure: -0.1, vignette: 0.35 } },
  bw: { name: 'Black and white', color: { lut: 'builtin:blackWhite', lutIntensity: 1 } },
  vintage: { name: 'Vintage', color: { lut: 'builtin:vintage', lutIntensity: 1, grain: 0.25, vignette: 0.3 } },
  cool: { name: 'Cool blue', color: { lut: 'builtin:coolBlue', lutIntensity: 0.9 } },
  vivid: { name: 'Vivid', color: { lut: 'builtin:vivid', lutIntensity: 0.8, vibrance: 0.2 } },
  bright: { name: 'Bright and airy', color: { exposure: 0.2, contrast: -0.1, shadows: 0.25, saturation: -0.08, temperature: 0.05 } },
  punchy: { name: 'Punchy', color: { contrast: 0.25, vibrance: 0.3, sharpen: 0.3 } },
};
