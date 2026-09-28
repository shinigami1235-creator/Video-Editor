// Left-hand panels: media, audio, text, captions, transitions, effects,
// templates, smart tools and brand kits.

import { h, icon, button, select, slider, toggle, textInput, section, card, colorInput, clear } from './dom.js';
import { store } from '../core/store.js';
import * as E from '../core/edit.js';
import { FX_PRESETS, itemEnd, isVisualItem, newText, defaultTextStyle } from '../core/model.js';
import { formatDuration, clone, uid } from '../core/util.js';
import { fileUrl } from '../backend/index.js';
import { TRANSITION_TYPES } from '../render/shaders.js';
import { FILTERS } from '../render/luts.js';
import { toast } from './notify.js';
import { applyFilter } from './inspector.js';
import { contentSize } from '../core/props.js';
import { WHISPER_MODELS } from '../media/tools.js';
import { voiceList, resolveVoice, isMac } from '../media/voices.js';
import { paidOn } from '../core/settings.js';
import { CAPTION_PRESETS, TEXT_PRESETS } from './presets.js';
import { BUILTIN_TEMPLATES } from './templates.js';

export const PANELS = [
  { id: 'media', audio: true, label: 'Media', title: 'Media', icon: 'film', render: mediaPanel },
  { id: 'audio', audio: true, label: 'Audio', title: 'Audio', icon: 'music', render: audioPanel },
  { id: 'text', label: 'Text', title: 'Text and shapes', icon: 'text', render: textPanel },
  { id: 'captions', label: 'Captions', title: 'Captions', icon: 'captions', render: captionsPanel },
  { id: 'transcript', audio: true, label: 'Transcript', title: 'Edit by text', icon: 'doc', render: (app) => lazyPanel(app, 'transcript', () => import('../ai/transcript.js').then((m) => m.transcriptPanel)) },
  { id: 'transitions', label: 'Transitions', title: 'Transitions', icon: 'transition', render: transitionsPanel },
  { id: 'effects', label: 'Effects', title: 'Looks and effects', icon: 'palette', render: effectsPanel },
  { id: 'templates', label: 'Templates', title: 'Templates', icon: 'template', render: templatesPanel },
  { id: 'ai', audio: true, label: 'Smart', title: 'Smart tools', icon: 'sparkles', render: aiPanel },
  { id: 'brand', label: 'Brand', title: 'Brand kits', icon: 'brand', render: brandPanel },
];

// Panels that live in their own module load on first open.
const lazyRenderers = {};
function lazyPanel(app, key, load) {
  if (lazyRenderers[key]) return lazyRenderers[key](app);
  load().then((fn) => {
    lazyRenderers[key] = fn;
    if (app.panel === key) app.renderPanel();
  });
  return h('div', { class: 'panel-body' }, h('p', { class: 'hint' }, 'Loading'));
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

let mediaFilter = 'all';

function mediaCard(app, m, { onClick } = {}) {
  const thumb = h('div', { class: 'm-thumb' });
  if (m.kind === 'image') thumb.style.backgroundImage = `url("${fileUrl(m.display || m.path)}")`;
  else if (m.kind === 'video' && m.thumbs) {
    const th = m.thumbs;
    const idx = Math.min(th.count - 1, Math.floor(th.count * 0.2));
    thumb.style.backgroundImage = `url("${fileUrl(th.path)}")`;
    const sx = (idx % th.cols) * th.w;
    const sy = Math.floor(idx / th.cols) * th.h;
    thumb.style.backgroundSize = `${(th.cols * th.w * 100) / th.w}% auto`;
    thumb.style.backgroundPosition = `${(sx / Math.max(1, th.cols * th.w - th.w)) * 100}% ${(sy / Math.max(1, th.rows * th.h - th.h)) * 100}%`;
  } else thumb.append(icon(m.kind === 'audio' ? 'music' : 'film', 26));
  const status = m.status === 'processing' ? h('div', { class: 'm-status' }, `Preparing ${Math.round((m.progress || 0) * 100)}%`) : m.status === 'error' ? h('div', { class: 'm-status err', title: m.error }, 'Failed') : m.status === 'missing' ? h('div', { class: 'm-status err', title: m.error }, 'Missing') : null;
  const used = Object.values(store.project.items).some((it) => it.mediaId === m.id);
  const el = h(
    'div',
    { class: `m-card ${store.selectedMedia === m.id ? 'active' : ''} ${used ? 'used' : ''}`, 'data-id': m.id, 'data-kind': m.kind, title: `${m.name}\n${m.width ? m.width + ' x ' + m.height + '  ' : ''}${m.duration ? formatDuration(m.duration) : ''}` },
    thumb,
    status,
    h('div', { class: 'm-name' }, m.name),
    m.duration ? h('div', { class: 'm-dur' }, formatDuration(m.duration)) : null,
    h('button', { class: 'm-add', title: 'Add at the playhead', type: 'button', onclick: (e) => {
      e.stopPropagation();
      app.addMedia([m]);
    } }, icon('plus', 16)),
  );
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.m-add')) return;
    store.selectedMedia = m.id;
    el.parentNode?.querySelectorAll('.m-card').forEach((c) => c.classList.remove('active'));
    el.classList.add('active');
    if (onClick) return onClick(m);
    app.startMediaDrag(e, [m]);
  });
  el.addEventListener('dblclick', () => app.addMedia([m]));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    app.contextMenu(e.clientX, e.clientY, [
      ['Add at the playhead', () => app.addMedia([m])],
      ['Show file', async () => (await import('../backend/index.js')).invoke('reveal_path', { path: m.path })],
      ['Try preparing again', async () => {
        const { processMedia } = await import('../media/library.js');
        m.status = 'processing';
        processMedia(m);
      }, m.status !== 'error'],
      ['Remove from project', async () => {
        const { removeMedia } = await import('../media/library.js');
        if (!(await removeMedia(m.id))) toast('That file is still used on the timeline.', { kind: 'warn' });
      }],
    ]);
  });
  return el;
}

function mediaPanel(app, opts) {
  const all = Object.values(store.project.media).filter((m) => !m.hidden);
  const list = all.filter((m) => mediaFilter === 'all' || m.kind === mediaFilter).sort((a, b) => (b.imported || 0) - (a.imported || 0));
  const chips = h('div', { class: 'chips' });
  for (const [k, l] of [
    ['all', 'All'],
    ['video', 'Videos'],
    ['image', 'Photos'],
    ['audio', 'Audio'],
  ])
    chips.append(h('button', { class: 'chip' + (mediaFilter === k ? ' active' : ''), type: 'button', onclick: () => {
      mediaFilter = k;
      app.renderPanel();
    } }, l));
  const replaceFor = opts.replaceFor && store.project.items[opts.replaceFor];
  const onClick = replaceFor
    ? (m) => {
        store.commit('Replace media', (p) => E.replaceClipMedia(p, replaceFor, m));
        app.openPanel('media');
      }
    : null;
  const grid = h('div', { class: 'm-grid' }, ...list.map((m) => mediaCard(app, m, { onClick })));
  const drop = h('div', { class: 'dropzone' }, icon('download', 28), h('div', {}, store.project.settings.audioOnly ? 'Drop sound files or videos here' : 'Drop videos, photos, music or PDF slides here'), h('div', { class: 'hint' }, 'or'), button('Import', () => app.cmd('importMedia'), { kind: 'primary', icon: 'folder' }));
  return h(
    'div',
    { class: 'panel-body' },
    replaceFor ? h('div', { class: 'notice' }, `Pick the file to use in place of ${replaceFor.name}.`, button('Cancel', () => app.openPanel('media'), { kind: 'link' })) : null,
    h('div', { class: 'btn-row' }, button('Import', () => app.cmd('importMedia'), { icon: 'folder', kind: 'primary' }), button('Record voice', () => app.openPanel('audio', { record: true }), { icon: 'mic' }), store.project.settings.audioOnly
      ? button('Join', () => app.cmd('stitch', { fromLibrary: Object.values(store.project.media).some((m) => m.kind !== 'image') }), { icon: 'music', title: 'Join several recordings end to end' })
      : button('Stitch', () => app.cmd('stitch', { fromLibrary: Object.values(store.project.media).some((m) => m.kind === 'video') }), { icon: 'film', title: 'Join several videos end to end' })),
    all.length ? chips : null,
    list.length ? grid : drop,
    h('div', { class: 'hint' }, store.project.settings.audioOnly ? 'Drag a file onto the timeline, or double-click it to add it at the playhead. A video brings only its sound. Photos stay in the library.' : 'Drag a clip onto the timeline, or double-click it to add it at the playhead. PDF files become one photo per page for lecture slides.'),
  );
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

function audioPanel(app, opts) {
  const body = h('div', { class: 'panel-body' });
  const audio = Object.values(store.project.media).filter((m) => m.kind === 'audio' && !m.hidden);
  body.append(section('Music and sound files', h('div', { class: 'btn-row' }, button('Import audio', () => app.cmd('importMedia'), { icon: 'folder' })), audio.length ? h('div', { class: 'm-grid list' }, ...audio.map((m) => mediaCard(app, m))) : h('div', { class: 'hint' }, 'MP3, WAV, M4A, OGG and FLAC files open here. Mark music as "Lower under voice" in the Audio tab so it drops when someone speaks.')));

  // voiceover
  const rec = h('div', { class: 'rec' });
  import('../ai/voiceover.js').then((mod) => rec.append(mod.recorderUi(app, { autoFocus: !!opts.record })));
  body.append(section('Voiceover', rec));

  // text to speech
  const ttsText = h('textarea', { rows: 5, placeholder: 'Type what the voice should say. Each paragraph becomes its own clip.' });
  const voiceSel = select('Voice', [...voiceList().map(([k, v]) => [k, v.label]), ...(store.settings.myVoiceSample && paidOn() ? [['mine', 'My own voice (Replicate, paid)']] : [])], resolveVoice(store.settings.piperVoice), (v) => app.saveSetting('piperVoice', v));
  let speed = 1;
  const sp = slider('Speed', { value: 1, min: 0.6, max: 1.6, step: 0.05, format: (v) => Number(v).toFixed(2) + 'x', onInput: (v) => (speed = v) });
  const ttsBtn = button('Create voice', async () => {
    const text = ttsText.value.trim();
    if (!text) return toast('Type some text first.', { timeout: 1500 });
    const { ttsToTimeline } = await import('../ai/tts.js');
    await ttsToTimeline(app, text, { voice: store.settings.piperVoice, speed });
  }, { kind: 'primary', icon: 'sparkles' });
  body.append(section('Text to speech', ttsText, voiceSel, sp, ttsBtn, h('div', { class: 'hint' }, isMac() ? 'The voices come with macOS. Add more in System Settings, Accessibility, Spoken Content, then open the editor again.' : 'Voices run on this computer. The first use downloads the voice engine and the chosen voice (about 60 MB).')));
  if (opts.tts) setTimeout(() => ttsText.focus(), 50);

  // sound effects
  const sfxWrap = h('div', { class: 'chips' });
  import('../ai/sfx.js').then((mod) => {
    for (const [k, v] of Object.entries(mod.SFX)) sfxWrap.append(h('button', { class: 'chip', type: 'button', title: 'Add at the playhead', onclick: () => mod.addSfx(app, k) }, v.name));
  });
  body.append(section('Sound effects', sfxWrap, h('div', { class: 'hint' }, 'Short effects made by the editor. Click one to add it at the playhead.')));
  return body;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function textPanel(app) {
  const body = h('div', { class: 'panel-body' });
  const presets = h('div', { class: 'preset-grid' });
  for (const p of TEXT_PRESETS) {
    const st = p.style || p.parts[0].style;
    const prev = h('div', { class: 'text-prev', style: { fontFamily: `"${st.font}"`, fontWeight: st.weight, color: st.color, textTransform: st.uppercase ? 'uppercase' : 'none', background: st.boxEnabled ? st.boxColor : 'transparent', WebkitTextStroke: st.outlineWidth ? `${Math.min(3, st.outlineWidth / 2)}px ${st.outlineColor}` : '', paintOrder: 'stroke fill' } }, p.sample || p.name);
    presets.append(card(p.name, { preview: prev, onClick: () => addTextPreset(app, p) }));
  }
  body.append(section('Add text', button('Add text', () => app.cmd('addText'), { kind: 'primary', icon: 'text' }), presets));
  const mine = store.settings.textStyles || [];
  if (mine.length) {
    const grid = h('div', { class: 'preset-grid' });
    for (const s of mine) grid.append(card(s.name, { preview: h('div', { class: 'text-prev', style: { fontFamily: `"${s.style.font}"`, color: s.style.color, fontWeight: s.style.weight } }, s.name), onClick: () => app.cmd('addText', store.playhead, 'Your text', clone(s.style), { reveal: s.reveal || 'none', anim: clone(s.anim) || { in: null, out: null, loop: null } }) }));
    body.append(section('My styles', grid));
  }
  const stickers = h('div', { class: 'chips stickers' });
  for (const e of ['\u2728', '\u2764\ufe0f', '\ud83d\udd25', '\u2705', '\u2b50', '\ud83d\udc4d', '\ud83d\ude0d', '\ud83c\udf6b', '\ud83c\udf81', '\ud83d\udcaf', '\ud83d\udc49', '\ud83d\udcf8']) {
    stickers.append(h('button', { class: 'chip sticker', type: 'button', title: 'Add at the playhead', onclick: () => app.cmd('addText', store.playhead, e, { size: 200, shadowBlur: 0, outlineWidth: 0, font: 'Inter', weight: 400 }, { name: 'Sticker', anim: { in: { type: 'pop', duration: 0.4 }, out: { type: 'fade', duration: 0.3 }, loop: null } }) }, e));
  }
  body.append(section('Stickers', stickers));
  body.append(
    section(
      'Shapes and callouts',
      h('div', { class: 'btn-row wrap' }, button('Box', () => app.cmd('addShape', 'rect'), { icon: 'shape' }), button('Circle', () => app.cmd('addShape', 'ellipse')), button('Arrow', () => app.cmd('addShape', 'arrow'), { icon: 'arrow' }), button('Line', () => app.cmd('addShape', 'line')), button('Label pill', () => app.cmd('addShape', 'callout'))),
      h('div', { class: 'hint' }, 'Arrows and circles point out details in procedure demos. Pair a label pill with text for step names.'),
    ),
    section('Layers', h('div', { class: 'btn-row wrap' }, button('Blur region', () => app.cmd('addBlur'), { icon: 'blur' }), button('Adjustment layer', () => app.cmd('addAdjustment'), { icon: 'adjust' }), button('Colour background', () => app.cmd('addSolid'), { icon: 'palette' }))),
  );
  return body;
}

export function addTextPreset(app, p) {
  const items = [];
  store.commit('Add ' + p.name.toLowerCase(), (proj) => {
    for (const part of p.parts || [p]) {
      const it = newText(null, store.playhead, part.text || p.text, { ...defaultTextStyle(), ...(part.style || p.style) });
      it.duration = p.duration || 4;
      Object.assign(it.props, part.props || p.props || {});
      const pr = part.props || p.props || {};
      if (pr.yFrac != null) it.props.y = pr.yFrac * proj.settings.height;
      if (pr.xFrac != null) it.props.x = pr.xFrac * proj.settings.width;
      delete it.props.yFrac;
      delete it.props.xFrac;
      it.anim = clone(part.anim || p.anim) || { in: null, out: null, loop: null };
      it.reveal = part.reveal || p.reveal || 'none';
      it.name = part.name || p.name;
      // later parts of a multi-line preset sit just under the previous part, left edges lined up
      const prev = items[items.length - 1];
      if (prev && p.parts) {
        const a = contentSize(proj, prev);
        const b = contentSize(proj, it);
        it.props.y = prev.props.y + a.h / 2 + b.h / 2 - 6;
        if (it.style.align === 'left') it.props.x = prev.props.x - a.w / 2 + b.w / 2;
      }
      E.placeOverlay(proj, it);
      items.push(it);
    }
  });
  store.select(items.map((i) => i.id));
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

function captionsPanel(app) {
  const body = h('div', { class: 'panel-body' });
  const p = store.project;
  const caps = Object.values(p.items).filter((i) => i.type === 'text' && i.caption);
  const speechClips = Object.values(p.items).filter((i) => i.type === 'clip' && p.media[i.mediaId]?.hasAudio && !i.muted);
  const lang = select('Language', [['auto', 'Detect automatically'], ['en', 'English'], ['tl', 'Filipino / Tagalog'], ['es', 'Spanish'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['th', 'Thai']], store.settings.whisperLanguage, (v) => app.saveSetting('whisperLanguage', v));
  const model = select('Accuracy', Object.entries(WHISPER_MODELS).map(([k, v]) => [k, `${v.label} (${v.size})`]), store.settings.whisperModel, (v) => app.saveSetting('whisperModel', v));
  const sel = store.selectedItems.filter((i) => speechClips.includes(i));
  const source = sel.length ? `the ${sel.length} selected clip${sel.length > 1 ? 's' : ''}` : `all ${speechClips.length} clip${speechClips.length === 1 ? '' : 's'} with sound`;
  body.append(
    section(
      'Auto captions',
      h('p', { class: 'hint' }, speechClips.length ? `Makes captions from the speech in ${source}.` : 'Add a clip with speech to the timeline first.'),
      lang,
      model,
      toggle('Translate to English', !!store.settings.whisperTranslate, (v) => app.saveSetting('whisperTranslate', v)),
      button('Create captions', () => app.cmd('captions'), { kind: 'primary', icon: 'captions', disabled: !speechClips.length }),
      h('div', { class: 'hint' }, 'Speech is turned into text on this computer. The first run downloads whisper.cpp and the speech model.'),
    ),
  );
  const cs = p.captionStyle;
  const grid = h('div', { class: 'preset-grid' });
  for (const pr of CAPTION_PRESETS) {
    const st = pr.style;
    const prev = h('div', { class: 'text-prev cap', style: { fontFamily: `"${st.font}"`, fontWeight: st.weight, color: st.color, textTransform: st.uppercase ? 'uppercase' : 'none', background: st.boxEnabled ? st.boxColor : 'transparent', WebkitTextStroke: st.outlineWidth ? `${Math.min(3, st.outlineWidth / 2)}px ${st.outlineColor}` : '', paintOrder: 'stroke fill' } }, 'Your ', h('span', { style: { color: st.highlightMode === 'box' ? st.color : st.highlightColor, background: st.highlightMode === 'box' ? st.highlightColor : 'transparent', borderRadius: '4px', padding: '0 2px' } }, 'words'), ' here');
    grid.append(card(pr.name, { preview: prev, active: cs.preset === pr.id, onClick: () => app.cmd('captionPreset', pr.id) }));
  }
  const ySl = slider('Height on screen', { value: cs.y ?? 0.72, min: 0.1, max: 0.95, step: 0.01, format: (v) => Math.round(v * 100) + '%', onInput: (v) => app.cmd('captionY', v, false), onCommit: (v) => app.cmd('captionY', v, true) });
  const words = select('Words per caption', [[2, '2'], [3, '3'], [4, '4'], [6, '6'], [8, '8'], [12, '12']], cs.maxWords, (v) => app.cmd('captionWords', Number(v)));
  body.append(section('Style', grid, ySl, words, h('div', { class: 'hint' }, 'Styles apply to every caption. Select one caption to change its font and colours in the Text tab.')));
  body.append(
    section(
      caps.length ? `${caps.length} captions` : 'Caption files',
      h('div', { class: 'btn-row wrap' }, button('Edit captions', () => app.cmd('editCaptions'), { disabled: !caps.length }), paidOn() ? button('Translate', () => app.cmd('translate'), { icon: 'globe', disabled: !caps.length }) : null, button('Import SRT', () => app.cmd('importSrt'), { icon: 'folder' }), button('Save as SRT', () => app.cmd('exportSrt'), { disabled: !caps.length }), button('Delete all', () => app.cmd('deleteCaptions'), { disabled: !caps.length, kind: 'danger' })),
    ),
  );
  return body;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function transitionsPanel(app, opts) {
  const p = store.project;
  const body = h('div', { class: 'panel-body' });
  const target = p.items[opts.cutItem] || store.selectedItems.find((i) => isVisualItem(p, i));
  const hasPrev = target && Object.values(p.items).some((o) => o.trackId === target.trackId && Math.abs(itemEnd(o) - target.start) < 0.02);
  const cur = target?.transitionIn;
  body.append(h('p', { class: 'hint' }, target ? (hasPrev ? `Between the clip before and ${target.name || 'the selected clip'}.` : `At the start of ${target.name || 'the selected clip'}, fading in from what is below it.`) : 'Select a clip, or click the small marker where two clips meet on the timeline.'));
  const grid = h('div', { class: 'trans-grid' });
  for (const [k, v] of Object.entries(TRANSITION_TYPES)) {
    grid.append(
      card(v.name, {
        preview: h('div', { class: 'trans-prev t-' + k }, h('span', { class: 'a' }), h('span', { class: 'b' })),
        active: cur?.type === k,
        onClick: () => {
          if (!target) return toast('Select a clip first.', { timeout: 1500 });
          store.commit('Transition', () => (target.transitionIn = { type: k, duration: cur?.duration || 0.5 }));
          app.renderPanel();
        },
      }),
    );
  }
  body.append(grid);
  if (cur) {
    body.append(
      slider('Length', {
        value: cur.duration,
        min: 0.1,
        max: 3,
        step: 0.05,
        format: (v) => Number(v).toFixed(2) + 's',
        onInput: (v) => store.mutate(() => (cur.duration = v)),
        onCommit: () => store.commit('Transition length', () => {}),
      }),
      h('div', { class: 'btn-row' }, button('Remove', () => {
        store.commit('Remove transition', () => (target.transitionIn = null));
        app.renderPanel();
      }), button('Use on every cut', () => {
        store.commit('Transitions on every cut', (pp) => {
          for (const it of Object.values(pp.items)) if (isVisualItem(pp, it) && Object.values(pp.items).some((o) => o.trackId === it.trackId && Math.abs(itemEnd(o) - it.start) < 0.02)) it.transitionIn = clone(cur);
        });
        toast('Added to every cut.');
      })),
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function effectsPanel(app) {
  const p = store.project;
  const body = h('div', { class: 'panel-body' });
  const clips = store.selectedItems.filter((i) => i.type === 'clip' && isVisualItem(p, i));
  const grid = h('div', { class: 'preset-grid' });
  for (const [k, f] of Object.entries(FILTERS)) {
    grid.append(
      card(f.name, {
        preview: h('div', { class: 'look-prev look-' + k }),
        active: clips.length === 1 && (clips[0].color?.filter || 'none') === k,
        onClick: () => {
          if (clips.length) store.commit('Look', () => clips.forEach((c) => applyFilter(c, k)));
          else {
            app.cmd('addAdjustment');
            const adj = store.primary;
            store.commit('Look', () => applyFilter(adj, k));
          }
          app.renderPanel();
        },
      }),
    );
  }
  body.append(section('Looks', h('p', { class: 'hint' }, clips.length ? `Applies to the ${clips.length} selected clip${clips.length > 1 ? 's' : ''}.` : 'Nothing is selected, so a look adds an adjustment layer over everything below it.'), grid));
  const fx = (label, fn) => button(label, fn);
  body.append(
    section(
      'Effects',
      h(
        'div',
        { class: 'btn-row wrap' },
        fx('Cinema bars', () => addAdjust(app, 'Cinema bars', (a) => (a.effects.letterbox = 0.24))),
        fx('Film grain', () => addAdjust(app, 'Film grain', (a) => (a.color.grain = 0.35))),
        fx('Vignette', () => addAdjust(app, 'Vignette', (a) => (a.color.vignette = 0.45))),
        fx('Dream glow', () => clips.length ? store.commit('Glow', () => clips.forEach((c) => (c.effects.glow = 0.45))) : toast('Select a clip first.')),
        fx('Blur the background', () => app.cmd('blurBackdrop')),
        fx('Blur region', () => app.cmd('addBlur')),
      ),
      h('div', { class: 'hint' }, 'Blur the background fills the empty space around a wide clip in a vertical frame with a blurred copy of itself.'),
    ),
  );
  const ov = h('div', { class: 'preset-grid' });
  for (const [k, f] of Object.entries(FX_PRESETS)) ov.append(card(f.name, { preview: h('div', { class: 'fx-prev fx-' + k }), onClick: () => app.cmd('addFx', k) }));
  body.append(section('Overlays', h('p', { class: 'hint' }, 'Added at the playhead on a track above, for 5 seconds. Drag the ends on the timeline to change how long they run.'), ov));
  const photo = clips.find((c) => p.media[c.mediaId]?.kind === 'image');
  body.append(
    section(
      'Moving photo',
      h('p', { class: 'hint' }, 'Turns a still product photo into a slow camera move with real depth: the front stays sharp and moves more than the back.'),
      button(photo ? 'Make it move' : 'Select a photo first', () => app.cmd('depthShot', photo), { icon: 'depth', disabled: !photo }),
    ),
  );
  return body;
}

function addAdjust(app, name, fn) {
  app.cmd('addAdjustment');
  const a = store.primary;
  if (!a) return;
  store.commit(name, () => {
    a.name = name;
    fn(a);
    // cover the whole project by default
    a.start = 0;
    a.duration = Math.max(1, store.duration);
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function templatesPanel(app) {
  const body = h('div', { class: 'panel-body' });
  const grid = h('div', { class: 'preset-grid' });
  for (const t of BUILTIN_TEMPLATES) grid.append(card(t.name, { preview: h('div', { class: 'tpl-prev' }, icon(t.icon || 'template', 26)), sub: t.sub, onClick: () => t.apply(app) }));
  body.append(section('Add to this project', grid, h('div', { class: 'hint' }, 'Templates add titles, shapes and steps at the playhead. Replace the words and drop your clips under them.')));
  const mine = store.settings.userTemplates || [];
  const list = h('div', { class: 'stack' });
  for (const t of mine) list.append(h('div', { class: 'tpl-row' }, h('span', {}, t.name), button('New project', async () => (await import('./templates.js')).newFromTemplate(app, t)), button('Delete', async () => (await import('./templates.js')).deleteTemplate(app, t), { kind: 'link' })));
  body.append(section('My templates', mine.length ? list : h('div', { class: 'hint' }, 'Save a finished project as a template from the File menu to reuse its layout, text and looks.'), button('Save this project as a template', () => app.cmd('saveTemplate'))));
  return body;
}

// ---------------------------------------------------------------------------
// Smart tools
// ---------------------------------------------------------------------------

function aiPanel(app) {
  const body = h('div', { class: 'panel-body' });
  const tool = (title, text, label, fn, ic = 'sparkles') => h('div', { class: 'tool' }, h('div', { class: 'tool-head' }, icon(ic, 18), h('strong', {}, title)), h('p', {}, text), button(label, fn));
  const needClip = (kind, fn) => () => {
    const it = store.selectedItems.find((i) => i.type === 'clip' && (kind === 'any' || (kind === 'audio' ? store.project.media[i.mediaId]?.hasAudio : isVisualItem(store.project, i))));
    if (!it) return toast(kind === 'audio' ? 'Select a clip with speech first.' : 'Select a video clip first.', { timeout: 2000 });
    fn(it);
  };
  if (store.project.settings.audioOnly) {
    body.append(
      section(
        'Voice',
        tool('Cut out silences', 'Removes the pauses from a recording, the fast way to tighten a talk or a podcast.', 'Cut silences', needClip('audio', (it) => app.cmd('silenceCut', it)), 'split'),
        tool('Remove filler words', 'Cuts "um", "uh" and similar sounds using the transcript.', 'Remove fillers', needClip('audio', (it) => app.cmd('fillerCut', it)), 'wand'),
        tool('Edit by text', 'Read the recording as text and delete words to cut them out.', 'Open', () => app.openPanel('transcript'), 'doc'),
        tool('Remove background noise', 'Cleans hum, hiss and aircon noise from a voice.', 'Clean', needClip('audio', (it) => app.cmd('denoise', it)), 'audioWave'),
        tool('Level out the voice', 'Brings quiet words up and loud ones down, so the voice sits at one steady level.', 'Level out', needClip('audio', (it) => app.cmd('compressClip', it)), 'volume'),
        tool('Even out loudness', 'Sets the clip to podcast loudness (-16 LUFS).', 'Even out', needClip('audio', (it) => app.cmd('normalizeClip', it)), 'audioWave'),
      ),
      section(
        'Recording',
        tool('Record a voice-over', 'Records your microphone onto the timeline at the playhead.', 'Record', () => app.openPanel('audio', { record: true }), 'mic'),
        tool('Teleprompter', 'Your script scrolls at reading speed while you record.', 'Open', () => app.cmd('teleprompter'), 'prompter'),
        tool('Text to speech', 'A voice reads your text, made on this computer.', 'Open', () => app.openPanel('audio', { tts: true }), 'robot'),
      ),
      section(
        'Music',
        tool('Lower music under voice', 'The selected music drops whenever someone speaks and comes back after.', 'Turn on', needClip('audio', (it) => store.commit('Ducking', (p) => p.items[it.id] && (p.items[it.id].duck = true))), 'volume'),
        tool('Mark the beats', 'Adds markers on the beat of the selected music clip.', 'Find beats', needClip('audio', (it) => app.cmd('beats', it)), 'music'),
      ),
    );
    return body;
  }
  body.append(
    section(
      'Speech',
      tool('Auto captions', 'Turns speech into timed captions with word highlights.', 'Create captions', () => app.cmd('captions'), 'captions'),
      tool('Cut out silences', 'Removes pauses from a talking clip, the fast way to tighten a lecture.', 'Cut silences', needClip('audio', (it) => app.cmd('silenceCut', it)), 'split'),
      tool('Remove filler words', 'Cuts "um", "uh" and similar sounds using the transcript.', 'Remove fillers', needClip('audio', (it) => app.cmd('fillerCut', it)), 'wand'),
      tool('Script to video', 'Paste a script: the editor reads it with a voice, adds captions and lays your clips or slides under it.', 'Open', () => app.cmd('scriptToVideo'), 'robot'),
      tool('Remove background noise', 'Cleans hum and hiss from a voice recording.', 'Clean audio', needClip('audio', (it) => app.cmd('denoise', it)), 'audioWave'),
    ),
    section(
      'Picture',
      tool('Remove background', 'Cuts out a person or product in every frame.', 'Remove', needClip('visual', (it) => app.cmd('removeBackground', it)), 'person'),
      tool('Auto reframe', 'Keeps a face centred when a wide clip goes into a vertical frame.', 'Reframe', needClip('visual', (it) => app.cmd('autoReframe', it)), 'crop'),
      tool('Blur faces', 'Finds and follows every face to protect patient privacy.', 'Blur faces', needClip('visual', (it) => app.cmd('faceBlur', it)), 'blur'),
      tool('Stabilise', 'Smooths shaky handheld footage.', 'Stabilise', needClip('visual', (it) => app.cmd('stabilize', it)), 'wand'),
      tool('Smooth slow motion', 'Creates in-between frames so slow product shots stay fluid.', 'Smooth', needClip('visual', (it) => app.cmd('smoothSlowmo', it)), 'speed'),
    ),
    section(
      'Music',
      tool('Mark the beats', 'Adds markers on the beat of the selected music clip.', 'Find beats', needClip('audio', (it) => app.cmd('beats', it)), 'music'),
      tool('Cut to the beat', 'Select several clips, then trim them so each cut lands on a beat.', 'Sync cuts', () => app.cmd('beatSync'), 'split'),
    ),
    section(
      'Lectures',
      tool('Edit by text', 'Delete words in the transcript to cut them from the video.', 'Open', () => app.openPanel('transcript'), 'doc'),
      paidOn() ? tool('Make shorts', 'Claude picks the moments of a long video that stand on their own and makes a 9:16 short of each. Needs your Claude key.', 'Find moments', () => app.cmd('shorts'), 'scissorsAi') : null,
      tool('Teleprompter', 'Your script scrolls over the preview at reading speed.', 'Open', () => app.cmd('teleprompter'), 'prompter'),
      tool('Record the screen', 'Screen or window with your webcam and microphone.', 'Record', () => app.cmd('recordScreen'), 'screen'),
    ),
    section(
      'Procedures',
      tool('Sync angles by sound', 'Select clips of the same moment from two or more phones. They line up by their sound, then 1, 2 and 3 switch between them.', 'Sync', () => app.cmd('syncAngles'), 'cameras'),
      tool('Line up the faces', 'Select a before and an after shot. The after one moves and scales so the faces match.', 'Line up', () => app.cmd('alignFaces'), 'align'),
      tool('Freehand mask', 'Click around any shape on the preview to keep only that area, and make it follow the movement.', 'Draw', () => app.cmd('freehandMask'), 'pen'),
    ),
    section(
      'Product shots',
      tool('Moving photo', 'Moves a camera through a still photo with real depth. Select a photo first.', 'Make it move', needClip('visual', (it) => app.cmd('depthShot', it)), 'depth'),
      tool('Upscale', 'A sharper copy of a video at twice the size, up to 4K.', 'Upscale', needClip('visual', (it) => app.cmd('upscale', it)), 'upscale'),
      tool('Overlays', 'Dust, sparkles, bokeh, cocoa, light leaks and a lens flare.', 'Open', () => app.openPanel('effects'), 'particles'),
    ),
    !paidOn() ? h('p', { class: 'hint' }, 'Shorts, translation, YouTube chapters, my voice, the talking presenter and Generate with AI use Claude or Replicate, which charge per use. They show up here after you turn on Paid services in Settings.') : null,
    !paidOn() ? null : section(
      'Publishing',
      tool('Translate captions', 'Into Filipino, Thai and 9 more, with dubbing where a voice exists. Needs your Claude key.', 'Translate', () => app.cmd('translate'), 'globe'),
      tool('YouTube chapters', 'Chapters, titles, a description and hashtags from what is said. Needs your Claude key.', 'Write them', () => app.cmd('chapters'), 'list'),
      tool('My voice', 'Record 30 seconds once and text to speech can speak in your voice through Replicate.', 'Set up', () => app.cmd('myVoice'), 'mic'),
      tool('Talking presenter', 'A face photo speaks a voice clip, through Replicate.', 'Open', () => app.cmd('avatar'), 'person'),
    ),
    !paidOn() ? null : section('Generate', tool('Generate with AI', 'Creates images, short videos or music from a description through Replicate (a paid service, needs your token in Settings).', 'Open', () => app.cmd('generate'), 'sparkles')),
  );
  return body;
}

// ---------------------------------------------------------------------------
// Brand kits
// ---------------------------------------------------------------------------

function brandPanel(app) {
  const body = h('div', { class: 'panel-body' });
  const kits = store.settings.brandKits || [];
  if (!kits.length) body.append(h('p', { class: 'hint' }, 'A brand kit keeps your colours, fonts and logos in one place, so every video for Sognare or the clinic looks the same.'));
  for (const kit of kits) {
    const sw = h('div', { class: 'swatches' });
    for (const c of kit.colors || []) {
      sw.append(h('button', { class: 'swatch', type: 'button', style: { background: c }, title: `Apply ${c} to the selected text or shape`, onclick: () => app.cmd('applyBrandColor', c) }));
    }
    const logos = h('div', { class: 'logo-row' });
    for (const l of kit.logos || []) logos.append(h('button', { class: 'logo-btn', type: 'button', title: 'Add this logo', onclick: () => app.cmd('addLogo', l.path) }, h('img', { src: fileUrl(l.path), alt: '' })));
    body.append(
      section(
        kit.name,
        sw,
        logos,
        h('div', { class: 'hint' }, `Fonts: ${(kit.fonts || []).map((f) => f.family).join(', ') || 'none added'}`),
        h(
          'div',
          { class: 'btn-row wrap' },
          button('Logo watermark', () => app.cmd('brandWatermark', kit)),
          button('End card', () => app.cmd('brandEndCard', kit)),
          button('Use brand fonts on all text', () => app.cmd('brandFonts', kit)),
          button('Edit', () => app.cmd('editBrandKit', kit), { kind: 'link' }),
        ),
      ),
    );
  }
  body.append(h('div', { class: 'btn-row' }, button('New brand kit', () => app.cmd('editBrandKit', null), { kind: 'primary', icon: 'plus' }), button('Import from Photo Editor', () => app.cmd('importPhotoEditorKits'))));
  return body;
}

export { uid, clear, colorInput, textInput };
