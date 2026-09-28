// Text to speech on this computer: Piper voices on Windows, the voices built
// into macOS on a Mac.

import { store } from '../core/store.js';
import { ensurePiper } from '../media/tools.js';
import { runProcess } from '../backend/proc.js';
import { invoke, procWrite, join, paths, mkdir, exists, dirname } from '../backend/index.js';
import { importFiles, whenReady } from '../media/library.js';
import * as E from '../core/edit.js';
import { newClip } from '../core/model.js';
import { hashString } from '../core/util.js';
import { isMac, loadVoices, resolveVoice } from '../media/voices.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { startJob } from '../ui/notify.js';

/** A Mac voice reads the text with macOS's own `say`, then FFmpeg makes it a WAV. */
async function macSpeak(text, voice, speed, job) {
  if (!voice?.startsWith('mac:')) throw new Error('No voice was found on this Mac. Add one in System Settings, Accessibility, Spoken Content.');
  const dir = join(paths.appData, 'tts');
  await mkdir(dir);
  const out = join(dir, `${hashString(voice + '|' + speed + '|' + text)}.wav`);
  if (await exists(out)) return out;
  const { writeText, remove } = await import('../backend/index.js');
  const txt = out + '.txt';
  const aiff = out + '.aiff';
  await writeText(txt, text.replace(/\s+/g, ' ').trim());
  await runProcess('/usr/bin/say', ['-v', voice.slice(4), '-r', String(Math.round(180 * speed)), '-o', aiff, '-f', txt], { signal: job?.signal });
  await ffmpeg(['-y', '-i', aiff, '-ar', '48000', '-ac', '1', out], { signal: job?.signal });
  await remove(txt).catch(() => {});
  await remove(aiff).catch(() => {});
  return out;
}

/** Speaks `text` into a WAV file and returns its path (cached by content). */
export async function speak(text, { voice, speed = 1, job } = {}) {
  if (voice === 'mine') {
    const { speakMine } = await import('./voice-clone.js');
    return speakMine(text, { job });
  }
  if (isMac()) {
    await loadVoices();
    return macSpeak(text, resolveVoice(voice), speed, job);
  }
  const pv = await ensurePiper(voice, (pr) => job?.download(pr), job?.signal);
  const dir = join(paths.appData, 'tts');
  await mkdir(dir);
  const out = join(dir, `${hashString(voice + '|' + speed + '|' + text)}.wav`);
  if (await exists(out)) return out;
  const bytes = new TextEncoder().encode(text.replace(/\s+/g, ' ').trim() + '\n');
  await runProcess(pv.bin, ['--model', pv.model, '--output_file', out, '--length_scale', (1 / speed).toFixed(3), '--sentence_silence', '0.25'], {
    cwd: dirname(pv.bin),
    signal: job?.signal,
    onStart: async (jobId) => {
      await procWrite(jobId, bytes);
      await invoke('proc_close_stdin', { jobId });
    },
  });
  return out;
}

export function paragraphs(text) {
  return text
    .split(/\n\s*\n|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Speaks each paragraph and lays the clips one after another from the playhead. */
export async function ttsToTimeline(app, text, { voice, speed = 1, at = store.playhead } = {}) {
  const job = startJob('Text to speech');
  try {
    const paras = paragraphs(text);
    const media = [];
    for (let i = 0; i < paras.length; i++) {
      job.update(i / paras.length, `Speaking paragraph ${i + 1} of ${paras.length}`);
      const wav = await speak(paras[i], { voice, speed, job });
      const [m] = await importFiles([wav]);
      await whenReady(m);
      m.name = paras[i].slice(0, 40) + (paras[i].length > 40 ? '...' : '');
      media.push(m);
    }
    const ids = [];
    store.commit('Text to speech', (p) => {
      let t = at;
      const track = E.findFreeTrack(p, 'audio', at, at + media.reduce((a, m) => a + m.duration + 0.3, 0));
      for (const m of media) {
        const c = newClip(m, track, t);
        c.name = m.name;
        p.items[c.id] = c;
        ids.push(c.id);
        t += m.duration + 0.3;
      }
    });
    store.select(ids);
    job.done('Voice added to the timeline.');
    return media;
  } catch (e) {
    job.fail(e);
    return [];
  }
}
