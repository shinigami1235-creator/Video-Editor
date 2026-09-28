// Voices for text to speech. Windows uses Piper voices that download on first
// use. A Mac uses the voices built into macOS through the `say` program, since
// Piper has no working Mac build.

import { PIPER_VOICES } from './tools.js';
import { paths } from '../backend/index.js';
import { runProcess } from '../backend/proc.js';

export const isMac = () => paths.platform === 'macos';

// joke voices that come with macOS
const NOVELTY = new Set(['Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Deranged', 'Good News', 'Hysterical', 'Jester', 'Organ', 'Pipe Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Junior', 'Ralph', 'Fred', 'Kathy', 'Princess', 'Agnes', 'Bruce', 'Vicki', 'Victoria']);

let macVoices = null;

function languageName(lang) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang.replace('_', '-')) || lang;
  } catch {
    return lang;
  }
}

/** Reads the Mac's voices once. Does nothing on Windows. */
export async function loadVoices() {
  if (!isMac() || macVoices) return macVoices;
  try {
    const { lines } = await runProcess('/usr/bin/say', ['-v', '?'], { keep: 3000 });
    const out = [];
    for (const l of lines) {
      const m = l.match(/^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/);
      if (!m) continue;
      const name = m[1].trim();
      if (NOVELTY.has(name.replace(/\s*\(.*\)$/, ''))) continue;
      const lang = m[2].replace('-', '_');
      out.push([`mac:${name}`, { label: `${name}, ${languageName(lang)}`, lang }]);
    }
    // English first, then the rest by language
    out.sort((a, b) => (a[1].lang.startsWith('en') ? 0 : 1) - (b[1].lang.startsWith('en') ? 0 : 1) || a[1].lang.localeCompare(b[1].lang) || a[0].localeCompare(b[0]));
    macVoices = out;
  } catch {
    macVoices = [];
  }
  return macVoices;
}

/** [[key, { label, lang }]] for the voices this computer can use. */
export function voiceList() {
  if (isMac()) return macVoices || [];
  return Object.entries(PIPER_VOICES).map(([k, v]) => [k, { ...v, lang: k.split('-')[0] }]);
}

/** Voices for a language code such as "es" or "zh". */
export function voicesForLang(lang) {
  return voiceList().filter(([, v]) => v.lang === lang || v.lang.startsWith(lang + '_'));
}

/** The voice to use when the saved one is not on this computer. */
export function resolveVoice(key) {
  if (key === 'mine') return key;
  const list = voiceList();
  if (list.some(([k]) => k === key)) return key;
  const lang = (key || 'en').split(/[-:]/)[0].split('_')[0];
  const same = isMac() ? list.filter(([, v]) => v.lang.startsWith(lang)) : [];
  const pick = same.find(([k]) => /Samantha|Daniel|Karen/.test(k)) || same[0] || list.find(([, v]) => v.lang.startsWith('en')) || list[0];
  return pick ? pick[0] : key;
}
