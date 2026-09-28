// Sound effects synthesised by the editor, so nothing needs licensing.

import { store } from '../core/store.js';
import { writeBytes, join, paths, mkdir, exists } from '../backend/index.js';
import { importFiles, whenReady } from '../media/library.js';
import * as E from '../core/edit.js';
import { newClip } from '../core/model.js';
import { errorToast } from '../ui/notify.js';

const SR = 48000;

function noise(ctx, dur) {
  const b = ctx.createBuffer(1, Math.ceil(dur * SR), SR);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = b;
  return s;
}

function env(g, t0, a, peak, dcy, end = 0.0001) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(end, t0 + a + dcy);
}

export const SFX = {
  whoosh: {
    name: 'Whoosh',
    dur: 0.9,
    build(ctx) {
      const n = noise(ctx, 0.9);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(300, 0);
      f.frequency.exponentialRampToValueAtTime(4000, 0.45);
      f.frequency.exponentialRampToValueAtTime(600, 0.9);
      const g = ctx.createGain();
      env(g, 0, 0.35, 0.9, 0.55);
      n.connect(f).connect(g).connect(ctx.destination);
      n.start(0);
    },
  },
  swooshUp: {
    name: 'Riser',
    dur: 2.2,
    build(ctx) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(120, 0);
      o.frequency.exponentialRampToValueAtTime(1400, 2.1);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(400, 0);
      f.frequency.exponentialRampToValueAtTime(6000, 2.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.35, 2.0);
      g.gain.exponentialRampToValueAtTime(0.0001, 2.2);
      const n = noise(ctx, 2.2);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, 0);
      ng.gain.exponentialRampToValueAtTime(0.25, 2.0);
      ng.gain.exponentialRampToValueAtTime(0.0001, 2.2);
      n.connect(f);
      o.connect(f).connect(g).connect(ctx.destination);
      n.connect(ng).connect(ctx.destination);
      o.start(0);
      n.start(0);
    },
  },
  impact: {
    name: 'Impact',
    dur: 1.6,
    build(ctx) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(110, 0);
      o.frequency.exponentialRampToValueAtTime(38, 1.2);
      const g = ctx.createGain();
      env(g, 0, 0.005, 1, 1.5);
      o.connect(g).connect(ctx.destination);
      const n = noise(ctx, 0.3);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1800;
      const ng = ctx.createGain();
      env(ng, 0, 0.002, 0.7, 0.25);
      n.connect(f).connect(ng).connect(ctx.destination);
      o.start(0);
      n.start(0);
    },
  },
  pop: {
    name: 'Pop',
    dur: 0.25,
    build(ctx) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(700, 0);
      o.frequency.exponentialRampToValueAtTime(180, 0.12);
      const g = ctx.createGain();
      env(g, 0, 0.003, 0.9, 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(0);
    },
  },
  click: {
    name: 'Click',
    dur: 0.08,
    build(ctx) {
      const n = noise(ctx, 0.08);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2500;
      const g = ctx.createGain();
      env(g, 0, 0.001, 0.8, 0.05);
      n.connect(f).connect(g).connect(ctx.destination);
      n.start(0);
    },
  },
  ding: {
    name: 'Ding',
    dur: 1.8,
    build(ctx) {
      for (const [fr, amp] of [
        [1320, 0.5],
        [2640, 0.18],
        [3960, 0.08],
      ]) {
        const o = ctx.createOscillator();
        o.frequency.value = fr;
        const g = ctx.createGain();
        env(g, 0, 0.004, amp, 1.7);
        o.connect(g).connect(ctx.destination);
        o.start(0);
      }
    },
  },
  sparkle: {
    name: 'Sparkle',
    dur: 1.4,
    build(ctx) {
      const notes = [2093, 2637, 3136, 3520, 4186];
      notes.forEach((fr, i) => {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = fr;
        const g = ctx.createGain();
        env(g, i * 0.07, 0.003, 0.22, 0.9);
        o.connect(g).connect(ctx.destination);
        o.start(i * 0.07);
      });
    },
  },
  shutter: {
    name: 'Camera shutter',
    dur: 0.35,
    build(ctx) {
      for (const at of [0, 0.12]) {
        const n = noise(ctx, 0.1);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 3000;
        const g = ctx.createGain();
        env(g, at, 0.001, 0.9, 0.08);
        n.connect(f).connect(g).connect(ctx.destination);
        n.start(at);
      }
    },
  },
  notify: {
    name: 'Notification',
    dur: 0.7,
    build(ctx) {
      [880, 1318].forEach((fr, i) => {
        const o = ctx.createOscillator();
        o.frequency.value = fr;
        const g = ctx.createGain();
        env(g, i * 0.13, 0.005, 0.4, 0.5);
        o.connect(g).connect(ctx.destination);
        o.start(i * 0.13);
      });
    },
  },
  typing: {
    name: 'Typing',
    dur: 2.0,
    build(ctx) {
      let t = 0.02;
      while (t < 1.9) {
        const n = noise(ctx, 0.04);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1800 + Math.random() * 1500;
        const g = ctx.createGain();
        env(g, t, 0.001, 0.5 + Math.random() * 0.3, 0.03);
        n.connect(f).connect(g).connect(ctx.destination);
        n.start(t);
        t += 0.07 + Math.random() * 0.12;
      }
    },
  },
};

function wav(buffer) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + len * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, SR, true);
  out.setUint32(28, SR * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, len * ch * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
      out.setInt16(o, v * 32767, true);
      o += 2;
    }
  return new Uint8Array(out.buffer);
}

export async function sfxFile(key) {
  const def = SFX[key];
  const dir = join(paths.appData, 'sfx');
  await mkdir(dir);
  const file = join(dir, key + '.wav');
  if (await exists(file)) return file;
  const ctx = new OfflineAudioContext(2, Math.ceil(def.dur * SR), SR);
  def.build(ctx);
  const buf = await ctx.startRendering();
  await writeBytes(file, wav(buf), { offset: 0, truncate: true });
  return file;
}

export async function addSfx(app, key, at = store.playhead) {
  try {
    const file = await sfxFile(key);
    let m = Object.values(store.project.media).find((x) => x.path === file);
    if (!m) [m] = await importFiles([file]);
    m.name = SFX[key].name;
    await whenReady(m);
    let clip = null;
    store.commit('Add sound effect', (p) => {
      const track = E.findFreeTrack(p, 'audio', at, at + m.duration);
      clip = newClip(m, track, at);
      clip.name = SFX[key].name;
      p.items[clip.id] = clip;
    });
    store.select(clip.id);
  } catch (e) {
    errorToast(e, 'The sound effect could not be added.');
  }
}
