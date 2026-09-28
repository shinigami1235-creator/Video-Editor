// Voiceover recording from a microphone, optionally while the timeline plays.

import { h, button, select, toggle } from '../ui/dom.js';
import { store } from '../core/store.js';
import { writeBytes, join, paths, mkdir } from '../backend/index.js';
import { importFiles, whenReady } from '../media/library.js';
import * as E from '../core/edit.js';
import { newClip } from '../core/model.js';
import { toast, errorToast } from '../ui/notify.js';
import { formatTime } from '../core/util.js';

let recorder = null;

export function recorderUi(app, { autoFocus = false } = {}) {
  const wrap = h('div', { class: 'recorder' });
  const devSel = h('select', {});
  const meter = h('div', { class: 'meter' }, h('div', { class: 'meter-fill' }));
  const timeEl = h('span', { class: 'tc' }, '00:00.00');
  let playAlong = true;
  let muteTimeline = true;
  let countIn = true;
  let prompter = !!store.settings.prompterWithVoice;
  const btn = button('Record', () => (recorder ? stop() : start()), { kind: 'primary', icon: 'record' });
  wrap.append(
    h('div', { class: 'row' }, h('label', {}, 'Microphone'), devSel),
    toggle('Play the video while recording', playAlong, (v) => (playAlong = v)),
    toggle('Mute the timeline while recording', muteTimeline, (v) => (muteTimeline = v)),
    toggle('Count down 3 seconds first', countIn, (v) => (countIn = v)),
    toggle('Show my script on a teleprompter', prompter, (v) => {
      prompter = v;
      app.saveSetting('prompterWithVoice', v);
    }),
    button('Write or edit the script', async () => (await import('../ui/teleprompter.js')).openTeleprompter(app), { kind: 'link', icon: 'prompter' }),
    h('div', { class: 'row' }, btn, meter, timeEl),
    h('div', { class: 'hint' }, 'The recording starts on the timeline where the playhead is. Headphones stop the speakers bleeding into the microphone.'),
  );
  const listDevices = async () => {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      devSel.replaceChildren(...devs.map((d, i) => h('option', { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
    } catch {}
  };
  listDevices();
  if (autoFocus) setTimeout(() => btn.focus(), 50);

  async function start() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: devSel.value ? { exact: devSel.value } : undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      return errorToast(e, 'The microphone could not be opened.');
    }
    listDevices();
    if (countIn) {
      for (let n = 3; n > 0; n--) {
        btn.querySelector('span').textContent = `Starting in ${n}`;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const at = store.playhead;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 160000 } : {});
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const fill = meter.firstChild;
    const t0 = performance.now();
    const prevVol = app.preview.volume;
    let raf = 0;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let pk = 0;
      for (const v of buf) pk = Math.max(pk, Math.abs(v));
      fill.style.width = Math.min(100, Math.sqrt(pk) * 100) + '%';
      fill.classList.toggle('hot', pk > 0.9);
      timeEl.textContent = formatTime((performance.now() - t0) / 1000);
      raf = requestAnimationFrame(tick);
    };
    tick();
    recorder = { mr, stream, ctx, at, chunks, raf, prevVol };
    mr.start(500);
    if (muteTimeline) app.preview.volume = 0;
    if (playAlong) app.preview.play();
    if (prompter) (await import('../ui/teleprompter.js')).openTeleprompter(app, { autoPlay: true });
    btn.querySelector('span').textContent = 'Stop';
    btn.classList.add('recording');
  }

  async function stop() {
    const r = recorder;
    recorder = null;
    btn.querySelector('span').textContent = 'Record';
    btn.classList.remove('recording');
    cancelAnimationFrame(r.raf);
    app.preview.pause();
    app.preview.volume = r.prevVol;
    (await import('../ui/teleprompter.js')).teleprompterOpen()?.pause();
    await new Promise((res) => {
      r.mr.onstop = res;
      r.mr.stop();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close();
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
    const dir = join(paths.documents, 'Video Editor Recordings');
    await mkdir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = join(dir, `Voiceover ${stamp}.webm`);
    await writeBytes(file, new Uint8Array(await blob.arrayBuffer()), { offset: 0, truncate: true });
    const [m] = await importFiles([file]);
    try {
      await whenReady(m);
    } catch (e) {
      return errorToast(e, 'The recording could not be prepared.');
    }
    let clip = null;
    store.commit('Voiceover', (p) => {
      const track = E.findFreeTrack(p, 'audio', r.at, r.at + m.duration);
      clip = newClip(m, track, r.at);
      clip.name = 'Voiceover';
      p.items[clip.id] = clip;
    });
    store.select(clip.id);
    toast(`Recording added (${formatTime(m.duration)}). It is saved in Documents\\Video Editor Recordings.`);
  }
  return wrap;
}

export { select };
