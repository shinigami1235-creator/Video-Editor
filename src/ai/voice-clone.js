// Your own voice and a talking presenter, both through Replicate with your
// token (paid per use). Voice: XTTS reads text in the voice of a 10 to 30
// second sample. Presenter: a photo is animated to speak an audio clip.

import { store } from '../core/store.js';
import { itemEnd, newClip, sourceSpan } from '../core/model.js';
import * as E from '../core/edit.js';
import { run } from './generate.js';
import { downloadTo } from '../media/tools.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { importFiles, whenReady } from '../media/library.js';
import { join, paths, mkdir, exists, readBytes, writeBytes, openDialog, stat } from '../backend/index.js';
import { modal, toast, startJob, errorToast } from '../ui/notify.js';
import { h, button, select } from '../ui/dom.js';
import { hashString, formatTime } from '../core/util.js';

const SAMPLE_SCRIPT = 'Good morning. Today I want to show you how we plan a skin booster treatment, from the first consultation to the last check-up. Every face is different, so we start by looking at hydration, texture and the areas that need the most support. After that we map the injection points and talk through what to expect in the first week.';

async function dataUri(path, mime) {
  const bytes = await readBytes(path);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

function needToken() {
  if (store.settings.replicateToken) return false;
  toast('Add your Replicate token in Settings first. Each use is billed to that account.', { kind: 'warn', timeout: 4000 });
  return true;
}

const voiceDir = () => join(paths.appData, 'voice');

/** Turns any recording into the 30-second mono WAV the voice model wants. */
async function saveSample(src) {
  await mkdir(voiceDir());
  const out = join(voiceDir(), 'my-voice.wav');
  await ffmpeg(['-i', src, '-t', '30', '-ac', '1', '-ar', '22050', '-af', 'highpass=f=70,loudnorm=I=-18', out]);
  store.settings.myVoiceSample = out;
  const { saveSettings } = await import('../core/settings.js');
  saveSettings({ myVoiceSample: out });
  return out;
}

export function hasMyVoice() {
  return !!store.settings.myVoiceSample;
}

/** Reads text in your voice and returns a WAV path (cached by text). */
export async function speakMine(text, { language = 'en', job } = {}) {
  const sample = store.settings.myVoiceSample;
  if (!sample || !(await exists(sample))) throw new Error('Record a sample of your voice first (Tools, My voice).');
  if (!store.settings.replicateToken) throw new Error('Add your Replicate token in Settings first.');
  const dir = join(paths.appData, 'tts');
  await mkdir(dir);
  // a new recording has a new size and time, so it never reuses the old voice
  const st = await stat(sample);
  const out = join(dir, `mine-${hashString(`${sample}|${st?.size}|${st?.mtimeMs}|${language}|${text}`)}.wav`);
  if (await exists(out)) return out;
  const model = store.settings.replicateVoiceModel || 'lucataco/xtts-v2';
  const urls = await run(model, { text, speaker: await dataUri(sample, 'audio/wav'), language, cleanup_voice: false }, job || { signal: new AbortController().signal, update() {} });
  const u = urls.find((x) => typeof x === 'string');
  if (!u) throw new Error('Replicate sent back no audio.');
  const tmp = out + '.dl';
  await downloadTo(u, tmp, null, job?.signal);
  await ffmpeg(['-i', tmp, '-ac', '1', '-ar', '44100', out]);
  return out;
}

export function myVoiceDialog(app) {
  let rec = null;
  const status = h('p', { class: 'hint' }, hasMyVoice() ? 'A sample is saved. Recording again replaces it.' : 'No sample yet.');
  const script = h('div', { class: 'voice-script' }, SAMPLE_SCRIPT);
  const recBtn = button('Record 30 seconds', () => (rec ? stopRec() : startRec()), { kind: 'primary', icon: 'mic' });
  const test = h('textarea', { rows: 2 });
  test.value = 'Hi, this is a test of my own voice in the video editor.';
  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.start(500);
      rec = { mr, stream, chunks, t0: performance.now() };
      recBtn.querySelector('span').textContent = 'Stop';
      status.textContent = 'Recording. Read the text above in your normal speaking voice.';
      rec.timer = setTimeout(stopRec, 32000);
    } catch (e) {
      errorToast(e, 'The microphone could not be opened.');
    }
  }
  async function stopRec() {
    const r = rec;
    rec = null;
    clearTimeout(r.timer);
    recBtn.querySelector('span').textContent = 'Record 30 seconds';
    await new Promise((res) => {
      r.mr.onstop = res;
      r.mr.stop();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    const secs = (performance.now() - r.t0) / 1000;
    if (secs < 8) {
      status.textContent = 'That was too short. The voice model needs at least 10 seconds.';
      return;
    }
    await mkdir(voiceDir());
    const raw = join(voiceDir(), 'raw.webm');
    await writeBytes(raw, new Uint8Array(await new Blob(r.chunks).arrayBuffer()), { offset: 0, truncate: true });
    await saveSample(raw);
    status.textContent = `Saved a ${Math.round(Math.min(30, secs))}-second sample.`;
  }
  modal(
    'My voice',
    h(
      'div',
      { class: 'stack' },
      h('p', {}, 'Record yourself reading the text below, or pick a recording of your voice. Text to speech and dubbing can then speak in your voice through Replicate, billed to your token.'),
      script,
      h('div', { class: 'btn-row' }, recBtn, button('Use a recording', async () => {
        const f = await openDialog({ title: 'A recording of your voice', filters: [{ name: 'Audio or video', extensions: ['wav', 'mp3', 'm4a', 'webm', 'ogg', 'mp4', 'mov'] }] });
        if (!f) return;
        await saveSample(f);
        status.textContent = 'Saved the first 30 seconds of that recording.';
      }, { kind: 'link' })),
      status,
      h('label', {}, 'Try it'),
      test,
      button('Speak this in my voice', async () => {
        if (needToken()) return;
        const job = startJob('My voice');
        try {
          job.update(null, 'Replicate is speaking');
          const wav = await speakMine(test.value, { job });
          const [m] = await importFiles([wav]);
          await whenReady(m);
          app.addMedia([m], store.playhead);
          job.done('Added at the playhead.');
        } catch (e) {
          job.fail(e);
        }
      }, { icon: 'play' }),
    ),
    { width: 560, onClose: () => rec && stopRec(), actions: [{ label: 'Done', primary: true, run: (close) => close() }] },
  );
}

// ---------------------------------------------------------------------------
// Talking presenter
// ---------------------------------------------------------------------------

export async function avatarDialog(app) {
  const p = store.project;
  const audioClip = store.selectedItems.find((i) => i.type === 'clip' && p.media[i.mediaId]?.hasAudio && p.media[i.mediaId]?.kind === 'audio');
  const photoClip = store.selectedItems.find((i) => i.type === 'clip' && p.media[i.mediaId]?.kind === 'image');
  let photoPath = photoClip ? p.media[photoClip.mediaId].display || p.media[photoClip.mediaId].path : store.settings.avatarPhoto || '';
  const photoLabel = h('span', { class: 'dim' }, photoPath ? photoPath.split(/[\\/]/).pop() : 'none chosen');
  const body = h(
    'div',
    { class: 'stack' },
    h('p', {}, 'A photo of a face is animated so it speaks the selected voice clip. It runs on Replicate and is billed to your token, usually a few minutes per clip.'),
    h('p', { class: audioClip ? 'hint' : 'notice' }, audioClip ? `Voice: ${audioClip.name || p.media[audioClip.mediaId].name} (${formatTime(audioClip.duration)})` : 'Select a voice clip on an audio track first, such as a voiceover or text to speech.'),
    h('div', { class: 'row' }, h('label', {}, 'Face photo'), photoLabel, button('Choose', async () => {
      const f = await openDialog({ title: 'A clear, front-facing photo', filters: [{ name: 'Photo', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
      if (!f) return;
      photoPath = f;
      photoLabel.textContent = f.split(/[\\/]/).pop();
      app.saveSetting('avatarPhoto', f);
    }, { kind: 'link' })),
  );
  modal('Talking presenter', body, {
    width: 520,
    actions: [
      { label: 'Cancel', run: (close) => close() },
      { label: 'Make it', primary: true, run: (close) => {
        if (!audioClip || !photoPath) return toast('Pick a voice clip and a face photo first.', { timeout: 2500 });
        if (needToken()) return;
        close();
        makeAvatar(app, audioClip, photoPath);
      } },
    ],
  });
}

async function makeAvatar(app, audioClip, photoPath) {
  const p = store.project;
  const m = p.media[audioClip.mediaId];
  const job = startJob('Talking presenter');
  try {
    await mkdir(join(paths.temp, 've-avatar'));
    const wav = join(paths.temp, 've-avatar', `${hashString(m.path + audioClip.in + audioClip.duration)}.wav`);
    await ffmpeg(['-ss', audioClip.in.toFixed(3), '-t', sourceSpan(audioClip).toFixed(3), '-i', m.path, '-ac', '1', '-ar', '16000', wav]);
    const ext = photoPath.split('.').pop().toLowerCase();
    const model = store.settings.replicateAvatarModel || 'cjwbw/sadtalker';
    job.update(null, 'Sending to Replicate');
    const urls = await run(model, { source_image: await dataUri(photoPath, `image/${ext === 'jpg' ? 'jpeg' : ext}`), driven_audio: await dataUri(wav, 'audio/wav'), preprocess: 'full', still: true, enhancer: 'gfpgan' }, job);
    const u = urls.find((x) => typeof x === 'string');
    if (!u) throw new Error('Replicate sent back no video.');
    const dir = join(paths.documents, 'Video Editor Generated');
    await mkdir(dir);
    const file = join(dir, `presenter-${hashString(u).slice(0, 8)}.mp4`);
    await downloadTo(u, file, (r, t) => job.update(t ? r / t : null, 'Downloading the video'));
    const [vm] = await importFiles([file]);
    await whenReady(vm);
    let clip = null;
    store.commit('Talking presenter', (pp) => {
      clip = newClip(vm, null, audioClip.start);
      clip.name = 'Presenter';
      clip.muted = true;
      clip.duration = Math.min(clip.duration, audioClip.duration);
      E.placeOverlay(pp, clip);
    });
    store.select(clip.id);
    job.done('The presenter is on the timeline above the voice clip.');
  } catch (e) {
    job.fail(e);
  }
}

export { itemEnd, select };
