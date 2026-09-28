// Screen recording with an optional webcam and microphone. The screen and the
// webcam are saved as separate files, so the webcam lands as a picture in
// picture that can still be moved, resized or cut away.

import { h, button, toggle, select } from '../ui/dom.js';
import { modal, toast, errorToast } from '../ui/notify.js';
import { store } from '../core/store.js';
import { writeBytes, join, paths, mkdir } from '../backend/index.js';
import { importFiles, whenReady } from '../media/library.js';
import * as E from '../core/edit.js';
import { newClip } from '../core/model.js';
import { formatTime } from '../core/util.js';

let active = null;

export function isRecordingScreen() {
  return !!active;
}

async function devices(kind) {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  } catch {
    return [];
  }
}

function pickMime(video) {
  const list = video ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['audio/webm;codecs=opus'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export async function showScreenRecorder(app) {
  if (active) return toast('A screen recording is already running.');
  if (!navigator.mediaDevices?.getDisplayMedia) return toast(paths.platform === 'macos' ? 'Screen recording does not work inside the app on a Mac. Press Shift+Command+5 to record the screen, then import the file.' : 'Screen recording is not available on this computer.', { timeout: 7000 });
  const s = store.settings;
  const opts = { webcam: s.recWebcam ?? true, mic: s.recMic ?? true, system: s.recSystem ?? false, countIn: true, prompter: false };
  const cams = await devices('videoinput');
  const mics = await devices('audioinput');
  const camSel = select('Webcam', cams.length ? cams.map((d, i) => [d.deviceId, d.label || `Camera ${i + 1}`]) : [['', 'No webcam found']], s.recCamId || cams[0]?.deviceId || '', (v) => app.saveSetting('recCamId', v));
  const micSel = select('Microphone', mics.length ? mics.map((d, i) => [d.deviceId, d.label || `Microphone ${i + 1}`]) : [['', 'No microphone found']], s.recMicId || mics[0]?.deviceId || '', (v) => app.saveSetting('recMicId', v));
  const body = h(
    'div',
    { class: 'stack' },
    h('p', {}, 'Pick a screen or a window after pressing Start. The recording lands on the timeline at the playhead, with the webcam as a picture in picture.'),
    toggle('Record my webcam too', opts.webcam, (v) => (opts.webcam = v)),
    camSel,
    toggle('Record my microphone', opts.mic, (v) => (opts.mic = v)),
    micSel,
    toggle('Record the computer sound', opts.system, (v) => (opts.system = v), { title: 'Sound from videos or apps playing on the computer' }),
    toggle('Count down 3 seconds first', opts.countIn, (v) => (opts.countIn = v)),
    toggle('Show my script on a teleprompter', opts.prompter, (v) => (opts.prompter = v)),
    h('p', { class: 'hint' }, 'Recordings are saved in Documents\\Video Editor Recordings.'),
  );
  modal('Record the screen', body, {
    width: 500,
    actions: [
      { label: 'Cancel', run: (close) => close() },
      {
        label: 'Start',
        primary: true,
        run: (close) => {
          close();
          app.saveSetting('recWebcam', opts.webcam);
          app.saveSetting('recMic', opts.mic);
          app.saveSetting('recSystem', opts.system);
          startRecording(app, { ...opts, camId: camSel.querySelector('select').value, micId: micSel.querySelector('select').value });
        },
      },
    ],
  });
}

async function startRecording(app, opts) {
  const streams = [];
  let screen;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: opts.system });
    streams.push(screen);
  } catch (e) {
    if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') errorToast(e, 'The screen could not be recorded.');
    return;
  }
  let cam = null;
  let mic = null;
  try {
    if (opts.webcam) {
      cam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: opts.camId ? { exact: opts.camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: 30 } });
      streams.push(cam);
    }
    if (opts.mic) {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: opts.micId ? { exact: opts.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streams.push(mic);
    }
  } catch (e) {
    streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    return errorToast(e, opts.webcam && !cam ? 'The webcam could not be opened.' : 'The microphone could not be opened.');
  }
  // one sound track: microphone and computer sound mixed
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  let hasAudio = false;
  for (const st of [mic, screen]) {
    if (st?.getAudioTracks().length) {
      ctx.createMediaStreamSource(st).connect(dest);
      hasAudio = true;
    }
  }
  const mixed = new MediaStream([...screen.getVideoTracks(), ...(hasAudio ? dest.stream.getAudioTracks() : [])]);
  if (opts.countIn) {
    const cd = h('div', { class: 'rec-countdown' }, '3');
    document.body.append(cd);
    for (let n = 3; n > 0; n--) {
      cd.textContent = String(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    cd.remove();
  }
  const at = store.playhead;
  const recs = [];
  const dir = join(paths.documents, 'Video Editor Recordings');
  await mkdir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // each chunk goes straight to the file, so long recordings never sit in memory
  const make = async (stream, video, name) => {
    const mime = pickMime(video);
    const file = join(dir, `${name} ${stamp}.webm`);
    await writeBytes(file, new Uint8Array(0), { offset: 0, truncate: true });
    const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: video ? 8_000_000 : undefined, audioBitsPerSecond: 160000 });
    const r = { mr, file, queue: Promise.resolve(), failed: null };
    mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      r.queue = r.queue.then(async () => writeBytes(file, new Uint8Array(await blob.arrayBuffer()), { offset: -1 })).catch((err) => (r.failed ||= err));
    };
    recs.push(r);
    return r;
  };
  const main = await make(mixed, true, 'Screen');
  const camRec = cam ? await make(cam, true, 'Webcam') : null;
  recs.forEach((r) => r.mr.start(1000));
  const t0 = performance.now();
  const timeEl = h('span', { class: 'tc' }, '00:00');
  const bar = h('div', { class: 'rec-bar' }, h('span', { class: 'rec-dot' }), h('span', {}, 'Recording the screen'), timeEl, button('Stop', () => stop(), { kind: 'danger', icon: 'x' }));
  document.body.append(bar);
  const timer = setInterval(() => (timeEl.textContent = formatTime((performance.now() - t0) / 1000).replace(/\.\d+$/, '')), 250);
  let prompter = null;
  if (opts.prompter) prompter = (await import('../ui/teleprompter.js')).openTeleprompter(app, { autoPlay: true, host: document.body });
  screen.getVideoTracks()[0].addEventListener('ended', () => stop());
  active = { stop };

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    bar.remove();
    prompter?.close();
    await Promise.all(recs.map((r) => new Promise((res) => {
      if (r.mr.state === 'inactive') return res();
      r.mr.onstop = res;
      r.mr.stop();
    })));
    await Promise.all(recs.map((r) => r.queue));
    streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    ctx.close();
    active = null;
    try {
      await place(app, at, main, camRec);
    } catch (e) {
      errorToast(e, 'The recording could not be added.');
    }
  }
}

async function place(app, at, main, camRec) {
  const bad = [main, camRec].find((r) => r?.failed);
  if (bad) throw bad.failed;
  const files = [main.file];
  if (camRec) files.push(camRec.file);
  toast('Preparing the recording.');
  const media = await importFiles(files);
  await Promise.all(media.map((m) => whenReady(m)));
  const [scr, camM] = media;
  let camClip = null;
  store.commit('Screen recording', (p) => {
    const added = E.addMediaToTimeline(p, [scr], at);
    added[0].name = 'Screen recording';
    if (camM) {
      camClip = newClip(camM, null, added[0].start);
      camClip.name = 'Webcam';
      camClip.duration = Math.min(camClip.duration, added[0].duration);
      E.placeOverlay(p, camClip);
    }
  });
  if (camClip) {
    store.select(camClip.id);
    app.cmd('pip', 'br');
  }
  toast(`Screen recording added (${formatTime(scr.duration)}).`);
}
