// Image, video and music generation through the Replicate API (paid, with
// the user's own token). Results are downloaded and added to the library.

import { store } from '../core/store.js';
import { h, select, slider, button } from '../ui/dom.js';
import { modal, toast, startJob } from '../ui/notify.js';
import { invoke, join, paths, mkdir, readBytes } from '../backend/index.js';
import { downloadTo } from '../media/tools.js';
import { importFiles } from '../media/library.js';
import { uid, sleep } from '../core/util.js';

export async function api(method, url, body) {
  // nothing reaches Replicate while paid services are switched off
  const { paidOn, PAID_OFF_MESSAGE } = await import('../core/settings.js');
  if (!paidOn()) throw new Error(PAID_OFF_MESSAGE);
  const token = store.settings.replicateToken;
  if (!token) throw new Error('Add your Replicate token in Settings first.');
  const res = await invoke('http_request', {
    method,
    url,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'wait=30' },
    body: body ? JSON.stringify(body) : null,
  });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {}
  if (res.status >= 400) throw new Error(`Replicate answered ${res.status}: ${json?.detail || json?.title || res.body.slice(0, 200)}`);
  return json;
}

export async function run(model, input, job) {
  const info = await api('GET', `https://api.replicate.com/v1/models/${model}`);
  const version = info?.latest_version?.id;
  let pred;
  if (version) pred = await api('POST', 'https://api.replicate.com/v1/predictions', { version, input });
  else pred = await api('POST', `https://api.replicate.com/v1/models/${model}/predictions`, { input });
  const started = Date.now();
  while (pred.status !== 'succeeded') {
    if (pred.status === 'failed' || pred.status === 'canceled') throw new Error('Generation failed: ' + (pred.error || pred.status));
    if (job.signal.aborted) {
      if (pred.urls?.cancel) await api('POST', pred.urls.cancel).catch(() => {});
      throw new DOMException('Cancelled', 'AbortError');
    }
    job.update(null, `Generating (${Math.round((Date.now() - started) / 1000)}s)`);
    await sleep(2500);
    pred = await api('GET', pred.urls.get);
  }
  const out = pred.output;
  return Array.isArray(out) ? out : [out];
}

export async function imageDataUri(m) {
  const bytes = await readBytes(m.display || m.path);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const ext = (m.display || m.path).split('.').pop().toLowerCase();
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${btoa(bin)}`;
}

export function generateDialog(app) {
  let kind = 'image';
  let seconds = 10;
  const prompt = h('textarea', { rows: 4, placeholder: 'Describe what to make, for example "slow push-in on a dark chocolate bar breaking, warm studio light, shallow depth of field".' });
  const images = Object.values(store.project.media).filter((m) => m.kind === 'image' && !m.hidden);
  let startImage = '';
  const extra = h('div', {});
  const drawExtra = () => {
    extra.replaceChildren();
    if (kind === 'video' && images.length) extra.append(select('Start from a photo (optional)', [['', 'No photo'], ...images.map((m) => [m.id, m.name])], startImage, (v) => (startImage = v)));
    if (kind === 'music') extra.append(slider('Length', { value: seconds, min: 5, max: 30, step: 1, format: (v) => v + ' s', onInput: (v) => (seconds = v) }));
  };
  const kindSel = select('Make', [['image', 'An image'], ['video', 'A short video'], ['music', 'Music']], kind, (v) => {
    kind = v;
    drawExtra();
  });
  drawExtra();
  const tokenNote = store.settings.replicateToken ? null : h('p', { class: 'notice' }, 'Add your Replicate API token in Settings to use this.');
  modal('Generate with AI', h('div', { class: 'stack' }, tokenNote, kindSel, prompt, extra, h('p', { class: 'hint' }, `Models: ${store.settings.replicateImageModel}, ${store.settings.replicateVideoModel}, ${store.settings.replicateMusicModel}. Change them in Settings. Video takes a few minutes and costs more than images.`)), {
    width: 560,
    actions: [
      { label: 'Cancel', run: (c) => c(null) },
      {
        label: 'Generate',
        primary: true,
        run: (c) => {
          if (!prompt.value.trim()) return toast('Describe what to make first.', { timeout: 1500 });
          c(true);
          generate(app, kind, prompt.value.trim(), { seconds, startImage: images.find((m) => m.id === startImage) });
        },
      },
    ],
  });
}

async function generate(app, kind, prompt, { seconds, startImage }) {
  const job = startJob('Generate ' + kind);
  try {
    const s = store.settings;
    const W = store.project.settings.width;
    const H = store.project.settings.height;
    const aspect = W > H * 1.2 ? '16:9' : H > W * 1.2 ? '9:16' : W === H ? '1:1' : '4:5';
    let model;
    let input;
    if (kind === 'image') {
      model = s.replicateImageModel;
      input = { prompt, aspect_ratio: aspect, output_format: 'png' };
    } else if (kind === 'video') {
      model = s.replicateVideoModel;
      input = { prompt, prompt_optimizer: true };
      if (startImage) input.first_frame_image = await imageDataUri(startImage);
    } else {
      model = s.replicateMusicModel;
      input = { prompt, duration: seconds, output_format: 'wav', model_version: 'stereo-large', normalization_strategy: 'peak' };
    }
    job.update(null, 'Sending the request');
    const urls = await run(model, input, job);
    const dir = join(paths.documents, 'Video Editor Generated');
    await mkdir(dir);
    const files = [];
    for (const u of urls.filter((x) => typeof x === 'string')) {
      const ext = (u.split('?')[0].split('.').pop() || (kind === 'music' ? 'wav' : kind === 'video' ? 'mp4' : 'png')).slice(0, 4);
      const file = join(dir, `${kind}-${uid('')}.${ext}`);
      await downloadTo(u, file, (r, t) => job.update(t ? r / t : null, 'Downloading the result'));
      files.push(file);
    }
    const media = await importFiles(files);
    app.openPanel(kind === 'music' ? 'audio' : 'media');
    job.done(`${media.length} result${media.length === 1 ? '' : 's'} added to the library.`);
  } catch (e) {
    job.fail(e);
  }
}
