// Teleprompter: the script scrolls over the preview at reading speed while a
// voiceover or a screen recording runs.

import { h, button, slider, toggle, iconButton } from './dom.js';
import { store } from '../core/store.js';

let current = null;

export function teleprompterOpen() {
  return current;
}

export function closeTeleprompter() {
  current?.close();
}

/**
 * Opens the teleprompter over `host` (the preview area by default).
 * Returns { play(), pause(), close() }.
 */
export function openTeleprompter(app, { script = store.settings.prompterScript || '', autoPlay = false, host = null } = {}) {
  current?.close();
  const s = store.settings;
  let wpm = s.prompterWpm || 140;
  let size = s.prompterSize || 34;
  let mirror = !!s.prompterMirror;
  let playing = false;
  let pos = 0;
  let last = 0;
  let raf = 0;
  const text = h('div', { class: 'prompter-text' });
  const scroller = h('div', { class: 'prompter-scroll' }, h('div', { class: 'prompter-pad' }), text, h('div', { class: 'prompter-pad' }));
  const edit = h('textarea', { class: 'prompter-edit', placeholder: 'Paste or type the script here.' });
  edit.value = script;
  const playBtn = button('Start', () => (playing ? pause() : play()), { kind: 'primary', icon: 'play' });
  const bar = h(
    'div',
    { class: 'prompter-bar' },
    playBtn,
    button('Edit script', () => toggleEdit(), { kind: 'link' }),
    slider('Speed', { value: wpm, min: 60, max: 240, step: 5, format: (v) => Math.round(v) + ' wpm', onInput: (v) => (wpm = v), onCommit: (v) => app.saveSetting('prompterWpm', v) }),
    slider('Size', { value: size, min: 18, max: 72, step: 1, format: (v) => Math.round(v) + ' px', onInput: (v) => { size = v; layout(); }, onCommit: (v) => app.saveSetting('prompterSize', v) }),
    toggle('Mirror', mirror, (v) => { mirror = v; layout(); app.saveSetting('prompterMirror', v); }, { title: 'Flips the text for a mirror-glass teleprompter' }),
    iconButton('x', () => close(), 'Close the teleprompter'),
  );
  const guide = h('div', { class: 'prompter-guide' });
  const el = h('div', { class: 'prompter', tabindex: '0' }, scroller, guide, edit, bar);
  (host || app.viewerEl).append(el);

  function render() {
    text.replaceChildren(...edit.value.split(/\n\s*\n/).map((para) => h('p', {}, para.trim())));
    layout();
  }
  function layout() {
    text.style.fontSize = size + 'px';
    scroller.style.transform = mirror ? 'scaleX(-1)' : '';
  }
  function words() {
    return Math.max(1, (edit.value.match(/\S+/g) || []).length);
  }
  function tick(ts) {
    raf = requestAnimationFrame(tick);
    if (!playing) return;
    const dt = last ? (ts - last) / 1000 : 0;
    last = ts;
    const pxPerWord = text.offsetHeight / words();
    pos += (wpm / 60) * pxPerWord * dt;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (pos >= max) {
      pos = max;
      pause();
    }
    scroller.scrollTop = pos;
  }
  function play() {
    if (el.classList.contains('editing')) toggleEdit();
    playing = true;
    last = 0;
    pos = scroller.scrollTop;
    playBtn.querySelector('span').textContent = 'Pause';
  }
  function pause() {
    playing = false;
    playBtn.querySelector('span').textContent = 'Start';
  }
  function toggleEdit() {
    const on = !el.classList.contains('editing');
    el.classList.toggle('editing', on);
    if (on) {
      pause();
      edit.focus();
    } else {
      app.saveSetting('prompterScript', edit.value);
      render();
    }
  }
  function close() {
    cancelAnimationFrame(raf);
    app.saveSetting('prompterScript', edit.value);
    el.remove();
    if (current === api) current = null;
  }
  el.addEventListener('keydown', (e) => {
    if (e.target === edit) return;
    e.stopPropagation();
    if (e.key === ' ') {
      e.preventDefault();
      playing ? pause() : play();
    } else if (e.key === 'ArrowUp') pos = Math.max(0, (scroller.scrollTop -= size * 2));
    else if (e.key === 'ArrowDown') pos = scroller.scrollTop += size * 2;
    else if (e.key === 'Escape') close();
  });
  scroller.addEventListener('wheel', () => (pos = scroller.scrollTop), { passive: true });
  render();
  if (!edit.value.trim()) toggleEdit();
  raf = requestAnimationFrame(tick);
  const api = { play, pause, close, el, get playing() { return playing; }, get position() { return pos; } };
  current = api;
  if (autoPlay && edit.value.trim()) play();
  else el.focus();
  return api;
}
