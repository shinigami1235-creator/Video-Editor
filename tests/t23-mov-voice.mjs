// iPhone footage and voice clean-up: an HDR HEVC .MOV shot upright opens as a
// portrait clip and exports as an Instagram-ready MP4, a file that will not
// open says why, and Make the voice clearer cuts the noise in the pauses.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const DIR = '/tmp/ve-mov';
fs.mkdirSync(DIR, { recursive: true });
const run = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 26 });
// like an iPhone clip: HEVC 10-bit HLG, hvc1 tag, held upright (rotation in the file), upper-case name
const MOV = `${DIR}/IMG_0421.MOV`;
if (!fs.existsSync(MOV)) {
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30,format=yuv420p10le', '-f', 'lavfi', '-i', 'sine=f=330:sample_rate=48000', '-t', '4', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-c:a', 'aac', `${DIR}/flat.mov`]);
  run(['-display_rotation:v:0', '90', '-i', `${DIR}/flat.mov`, '-c', 'copy', MOV]);
}
const BROKEN = `${DIR}/broken.mov`;
fs.writeFileSync(BROKEN, Buffer.alloc(4096, 7));
// a voice with steady background noise
const NOISY = `${DIR}/noisy-voice.wav`;
if (!fs.existsSync(NOISY)) run(['-i', `${FIX}/speech-pauses.wav`, '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.04:r=48000', '-filter_complex', '[0]aresample=48000,aformat=channel_layouts=mono[s];[1]aformat=channel_layouts=mono[n];[s][n]amix=inputs=2:duration=first:normalize=0', NOISY]);

/** RMS level in dB of a stretch of a file's sound. */
function rms(file, ss, t) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(ss), '-t', String(t), '-i', file, '-af', 'astats', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...r.stderr.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].pop();
  return m ? Number(m[1] === '-inf' ? -120 : m[1]) : 0;
}
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  return JSON.parse(r.stdout || '{}');
}

await startServers();
try {
  const { browser, page, logs } = await openApp();
  await page.evaluate(async () => (await import('/src/project-io.js')).createProject({ name: 'Phone', width: 1080, height: 1920 }));

  const [mov] = await importAndWait(page, [MOV]);
  const movInfo = await page.evaluate((id) => {
    const m = window.__store.project.media[id];
    return { status: m.status, kind: m.kind, w: m.width, h: m.height, ew: m.editWidth, eh: m.editHeight, hdr: m.hdr };
  }, mov.id);
  check('an iPhone HDR .MOV held upright opens as a portrait video', movInfo.status === 'ready' && movInfo.kind === 'video' && movInfo.w === 1080 && movInfo.h === 1920 && movInfo.eh === 1920 && movInfo.hdr, JSON.stringify(movInfo));

  // export it the way Instagram wants it
  const out = `${DIR}/for-instagram.mp4`;
  await page.evaluate(
    async ([id, out]) => {
      const s = window.__store;
      const M = await import('/src/core/model.js');
      s.commit('Put it on', (p) => {
        const c = M.newClip(p.media[id], p.tracks.find((t) => t.kind === 'video').id, 0);
        p.items[c.id] = c;
      });
      const { exportVideo, EXPORT_PRESETS } = await import('/src/export/export.js');
      const pr = EXPORT_PRESETS.find((x) => x.id === 'reels');
      await exportVideo(s.project, { out, width: pr.w, height: pr.h, fps: pr.fps, bitrateMbps: pr.bitrate });
    },
    [mov.id, out],
  );
  const pi = probe(out);
  const v = pi.streams?.find((x) => x.codec_type === 'video');
  const a = pi.streams?.find((x) => x.codec_type === 'audio');
  const ig = { v: v?.codec_name, pix: v?.pix_fmt, w: v?.width, h: v?.height, a: a?.codec_name, rate: a?.sample_rate, dur: Number(pi.format?.duration).toFixed(1) };
  check('the Reels and Stories export is H.264, AAC, 1080 x 1920', ig.v === 'h264' && ig.pix === 'yuv420p' && ig.w === 1080 && ig.h === 1920 && ig.a === 'aac' && ig.rate === '48000' && Math.abs(ig.dur - 4) < 0.2, JSON.stringify(ig));
  const mid = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', out, '-vf', 'crop=w=4:h=4:x=540:y=300,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout;
  check('the picture comes through (not black or grey)', mid.length === 3 && Math.max(...mid) - Math.min(...mid) > 40, JSON.stringify([...mid]));

  // a file that will not open says why
  await importAndWait(page, [BROKEN], 30000);
  await sleep(300);
  const toastText = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  check('a .mov that will not open shows the reason', /broken\.mov would not open: Invalid data/.test(toastText), toastText.slice(0, 300));

  // Make the voice clearer on a sound clip
  const [voice] = await importAndWait(page, [NOISY]);
  const vid = await page.evaluate(async (id) => {
    const s = window.__store;
    const M = await import('/src/core/model.js');
    let cid = null;
    s.commit('Voice', (p) => {
      const tr = p.tracks.find((t) => t.kind === 'audio');
      const c = M.newClip(p.media[id], tr.id, 0);
      p.items[c.id] = c;
      cid = c.id;
    });
    return cid;
  }, voice.id);
  await page.evaluate((id) => window.__app.cmd('clearVoice', window.__store.project.items[id]), vid);
  await page.waitForFunction(() => !document.querySelector('.jobs .job'), null, { timeout: 120000 });
  const cleaned = await page.evaluate((id) => {
    const p = window.__store.project;
    const it = p.items[id];
    const m = p.media[it.mediaId];
    return { der: it.derivations, edit: m.edit, dur: m.duration };
  }, vid);
  check('Make the voice clearer swaps in a cleaned copy', cleaned.der?.includes('clear') && !!cleaned.edit, JSON.stringify(cleaned));
  const before = { speech: rms(NOISY, 4.9, 2.5), pause: rms(NOISY, 7.8, 2.0) };
  const after = { speech: rms(cleaned.edit, 4.9, 2.5), pause: rms(cleaned.edit, 7.8, 2.0) };
  const gain = after.speech - after.pause - (before.speech - before.pause);
  check('the noise in the pauses drops well below the voice', gain > 8, JSON.stringify({ before, after, gain: gain.toFixed(1) }));
  check('the voice ends up near Instagram loudness', after.speech > -20 && after.speech < -12, JSON.stringify(after));
  check('the cleaned copy keeps its length', Math.abs(cleaned.dur - 12.6) < 0.2, String(cleaned.dur));

  // on a video clip the picture stays and the sound is cleaned
  const [talk] = await importAndWait(page, [`${FIX}/talk.mp4`]);
  const tid = await page.evaluate(async (id) => {
    const s = window.__store;
    const M = await import('/src/core/model.js');
    let cid = null;
    s.commit('Talk', (p) => {
      const c = M.newClip(p.media[id], p.tracks.find((t) => t.kind === 'video').id, 10);
      p.items[c.id] = c;
      cid = c.id;
    });
    return cid;
  }, talk.id);
  const talkDur = await page.evaluate((id) => window.__store.project.media[id].duration, talk.id);
  await page.evaluate((id) => window.__app.cmd('clearVoice', window.__store.project.items[id]), tid);
  await page.waitForFunction(() => !document.querySelector('.jobs .job'), null, { timeout: 180000 });
  const tv = await page.evaluate((id) => {
    const p = window.__store.project;
    const m = p.media[p.items[id].mediaId];
    return { der: p.items[id].derivations, edit: m.edit, dur: m.duration, w: m.width };
  }, tid);
  const tp = probe(tv.edit);
  check('on a video clip the picture stays and only the sound changes', tv.der?.includes('clear') && tp.streams?.some((x) => x.codec_type === 'video') && tp.streams?.some((x) => x.codec_type === 'audio') && Math.abs(tv.dur - talkDur) < 0.2, JSON.stringify({ ...tv, talkDur }));

  // the buttons
  await page.evaluate((id) => window.__store.select(id), vid);
  await sleep(200);
  const ui = await page.evaluate(() => document.querySelector('.inspector').textContent);
  check('the Audio tab shows the cleaned state', /Voice cleaned up/.test(ui), ui.slice(0, 200));

  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource|import failed/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | ').slice(0, 800));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
