// Settings: helper program locations, performance, AI service token.

import { h, button, select, toggle, section, textInput } from './dom.js';
import { modal, toast, confirmDialog } from './notify.js';
import { store } from '../core/store.js';
import { saveSettings } from '../core/settings.js';
import { openDialog, paths, invoke } from '../backend/index.js';
import { locateTools, tools, toolsDir, ensureWhisper, WHISPER_MODELS } from '../media/tools.js';
import { startJob } from './notify.js';
import { exists, join } from '../backend/index.js';
import { clearCache } from '../media/library.js';

export function showSettings(app) {
  const s = store.settings;
  const pathRow = (label, key, hint) => {
    const inp = h('input', { type: 'text', value: s[key] || '', placeholder: 'Found automatically' });
    inp.addEventListener('change', () => saveSettings({ [key]: inp.value.trim() }));
    const browse = button('Browse', async () => {
      const p = await openDialog({ title: label });
      if (p) {
        inp.value = p;
        saveSettings({ [key]: p });
      }
    });
    return h('div', { class: 'row col' }, h('label', {}, label), h('div', { class: 'row tight' }, inp, browse), hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const status = h('div', { class: 'hint' }, 'Checking helper programs');
  locateTools().then(() => {
    status.textContent = `FFmpeg: ${tools.ffmpeg ? 'ready' : 'not found'}. Captions engine: ${tools.whisper ? 'ready' : 'downloads on first use'}. Voice engine: ${paths.platform === 'macos' ? 'built into macOS' : tools.piper ? 'ready' : 'downloads on first use'}.`;
  });
  // speech to text: what is downloaded, and a button to get it ready before the first use
  const speechStatus = h('div', { class: 'hint' }, 'Checking');
  const refreshSpeech = async () => {
    await locateTools();
    const m = WHISPER_MODELS[store.settings.whisperModel] || WHISPER_MODELS.small;
    const haveModel = await exists(toolsDir('whisper', 'models', m.file));
    speechStatus.textContent = `Engine: ${tools.whisper ? 'ready' : 'not downloaded yet'}. ${m.label.split(':')[0]} model: ${haveModel ? 'ready' : `not downloaded yet (${m.size})`}.`;
    return tools.whisper && haveModel;
  };
  refreshSpeech();
  const speechLang = select('Language', [['auto', 'Detect automatically'], ['en', 'English'], ['tl', 'Filipino / Tagalog'], ['th', 'Thai'], ['es', 'Spanish'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean']], s.whisperLanguage || 'auto', (v) => saveSettings({ whisperLanguage: v }));
  const speechModel = select('Accuracy', Object.entries(WHISPER_MODELS).map(([k, v]) => [k, `${v.label} (${v.size})`]), s.whisperModel || 'small', (v) => {
    saveSettings({ whisperModel: v });
    refreshSpeech();
  });
  const speechBtn = button('Download now', async () => {
    const job = startJob('Speech to text');
    try {
      job.update(null, 'Getting Whisper ready');
      await ensureWhisper(store.settings.whisperModel || 'small', (pr) => job.download(pr), job.signal);
      job.done('Whisper is ready.');
    } catch (e) {
      job.fail(e);
    }
    refreshSpeech();
  }, { kind: 'primary', icon: 'download' });
  const token = h('input', { type: 'password', value: s.replicateToken || '', placeholder: 'r8_...' });
  token.addEventListener('change', () => saveSettings({ replicateToken: token.value.trim() }));
  const claudeKey = h('input', { type: 'password', value: s.claudeKey || '', placeholder: 'sk-ant-...' });
  claudeKey.addEventListener('change', () => saveSettings({ claudeKey: claudeKey.value.trim() }));
  const model = (label, key) => textInput(label, s[key], null, { onCommit: (v) => saveSettings({ [key]: v.trim() }) });
  const paidBox = h(
    'div',
    { class: 'paid-box', hidden: !s.paidServices },
    section(
      'Generate with AI (Replicate)',
      h('div', { class: 'row col' }, h('label', {}, 'API token'), token),
      h('div', { class: 'hint' }, 'Create a token at replicate.com/account/api-tokens. Each generation is billed to your Replicate account.'),
      model('Image model', 'replicateImageModel'),
      model('Video model', 'replicateVideoModel'),
      model('Music model', 'replicateMusicModel'),
      model('Photo upscale model', 'replicateUpscaleModel'),
      model('My voice model', 'replicateVoiceModel'),
      model('Talking presenter model', 'replicateAvatarModel'),
    ),
    section(
      'Claude (shorts, translation, chapters)',
      h('div', { class: 'row col' }, h('label', {}, 'API key'), claudeKey),
      h('div', { class: 'hint' }, 'Create a key at console.anthropic.com. Picking shorts from a 30-minute lecture costs a few US cents on that account.'),
      textInput('Model', s.claudeModel || 'claude-sonnet-5', null, { onCommit: (v) => saveSettings({ claudeModel: v.trim() }) }),
    ),
  );
  const body = h(
    'div',
    { class: 'settings' },
    section(
      'Helper programs',
      status,
      pathRow('FFmpeg', 'ffmpegPath', 'Leave empty to use the copy that comes with the editor.'),
      pathRow('FFprobe', 'ffprobePath'),
      pathRow('whisper.cpp (whisper-cli)', 'whisperPath'),
      paths.platform === 'macos' ? null : pathRow('Piper', 'piperPath'),
      button('Open the tools folder', () => invoke('open_path', { path: toolsDir() }).catch(() => toast('The tools folder is created on first download.'))),
    ),
    section(
      'Speech to text (Whisper)',
      h('p', { class: 'hint' }, paths.platform === 'macos' ? 'Whisper turns speech into text on this computer for captions, the transcript and filler word removal. It is free and nothing leaves your Mac. The engine comes with the app and uses the Mac\'s graphics chip. The Small model is 190 MB and downloads the first time you use one of those, or now with the button.' : 'Whisper turns speech into text on this computer for captions, the transcript and filler word removal. It is free and nothing leaves your laptop. The engine is 4 MB and the Small model 190 MB. Both download the first time you use one of those, or now with the button.'),
      speechStatus,
      speechModel,
      speechLang,
      paths.platform === 'windows'
        ? toggle('Use the NVIDIA GPU (a 457 MB engine, about 5 times faster)', s.whisperGpu, (v) => {
            saveSettings({ whisperGpu: v });
            refreshSpeech();
          })
        : null,
      speechBtn,
    ),
    section(
      'Performance',
      select('Edit copies', [[720, '720p (fastest, small files)'], [1080, '1080p (recommended)'], [1440, '1440p'], [2160, '4K (slow, large files)']], s.editCopyHeight, (v) => saveSettings({ editCopyHeight: Number(v) })),
      h('div', { class: 'hint' }, 'Each imported video gets an edit copy that plays and scrubs smoothly. The export uses these copies, so choose 4K only for 4K projects. New imports use the new size.'),
      select('Autosave every', [[15, '15 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes']], s.autosaveSeconds, (v) => saveSettings({ autosaveSeconds: Number(v) })),
      toggle('Magnetic main track in new projects', s.magneticDefault !== false, (v) => saveSettings({ magneticDefault: v })),
      button('Delete edit copies and thumbnails', async () => {
        if (!(await confirmDialog('Clear cache', 'This deletes every edit copy, waveform and thumbnail. Open projects rebuild them, which takes a while for long videos.', { ok: 'Delete', danger: true }))) return;
        await clearCache();
        toast('Cache cleared.');
      }, { kind: 'danger' }),
    ),
    section(
      'Paid services',
      h('p', { class: 'hint' }, 'Claude (shorts, translation, chapters) and Replicate (generated images, video, music, your cloned voice, AI upscale) charge per use. They stay off and hidden until you switch them on here. Everything else in the editor is free and runs on this computer.'),
      toggle('Allow paid services (Claude and Replicate)', !!s.paidServices, (v) => {
        saveSettings({ paidServices: v });
        paidBox.hidden = !v;
        app.renderPanel?.();
        app.inspector?.render?.();
      }),
    ),
    paidBox,
    section('About', h('div', { class: 'hint' }, `Video Editor 0.4.0. App data: ${paths.appData}. Cache: ${paths.cache}.`)),
  );
  modal('Settings', body, { width: 620, actions: [{ label: 'Done', primary: true, run: (close) => close(true) }] });
}
