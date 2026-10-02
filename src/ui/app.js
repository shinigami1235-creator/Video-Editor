// The editor shell: layout, commands, menus, shortcuts and drag and drop.

import { h, icon, iconButton, clear, button, select, keyLabel } from './dom.js';
import { store } from '../core/store.js';
import * as E from '../core/edit.js';
import { newText, newShape, newBlurRegion, newAdjustment, newSolid, itemEnd, trackItems, visualTracks, isVisualItem, sourceTime, projectDuration, cloneItem, CANVAS_PRESETS, keyframeTimes, canvasForMedia, frameShape } from '../core/model.js';
import { setProp, getProp, localTime } from '../core/props.js';
import { uid, clone, formatTime } from '../core/util.js';
import { Timeline, dragSession } from './timeline.js';
import { Viewer } from './viewer.js';
import { Inspector, applyFilter } from './inspector.js';
import { initNotify, toast, errorToast, startJob, modal, confirmDialog, promptDialog } from './notify.js';
import { saveSettings, paidOn, PAID_OFF_MESSAGE } from '../core/settings.js';
import { importFiles, kindForPath, whenReady } from '../media/library.js';
import { openDialog, readText, setWindowTitle, onFileDrop, isDesktop, basename } from '../backend/index.js';
import { saveProject, openProject, openProjectPath, createProject, confirmDiscard } from '../project-io.js';
import { parseCube } from '../render/luts.js';
import { PANELS } from './panels.js';

const BUNDLED_FONTS = ['Montserrat', 'Inter', 'Poppins', 'Bebas Neue', 'Playfair Display', 'Oswald', 'DM Serif Display', 'Roboto Mono'];

// names for the Help menu; the guides themselves load when first used
const GUIDE_TITLES = {
  separate: 'Separate the sound from a video',
  cut: 'Cut out a part of a clip',
  captions: 'Add captions',
  volume: 'Change the volume of a clip',
  export: 'Export a video',
  audioProject: 'Start an audio project',
  transcript: 'Cut words out using the transcript',
  noise: 'Clean up a voice recording',
  exportAudio: 'Export an MP3',
};

// commands that only make sense with a picture; audio projects skip them
const VIDEO_ONLY = new Set(['addText', 'addShape', 'addBlur', 'addAdjustment', 'addSolid', 'crop', 'freeze', 'splitScreen', 'pip', 'freehandMask', 'depthShot', 'addFx', 'alignFaces', 'upscale', 'aiUpscale', 'removeBackground', 'autoReframe', 'faceBlur', 'stabilize', 'smoothSlowmo', 'syncAngles', 'switchAngles', 'trackMask', 'recordScreen', 'shorts', 'avatar', 'saveTemplate', 'scriptToVideo', 'captions', 'translate', 'chapters', 'detachAudio']);

export class App {
  constructor(root) {
    this.root = root;
    this.clipboard = null;
    this.panel = 'media';
    this.panelOpts = {};
    this.localFonts = [];
    this.userFonts = [];
    window.__app = this;
  }

  build() {
    const r = this.root;
    clear(r);
    initNotify(document.body);
    this.titleEl = h('div', { class: 'proj-title', title: 'Project name' });
    this.undoBtn = iconButton('undo', () => this.cmd('undo'), 'Undo (Ctrl+Z)');
    this.redoBtn = iconButton('redo', () => this.cmd('redo'), 'Redo (Ctrl+Y)');
    const menuBtn = (label, items) => {
      const b = h('button', { class: 'menu-btn', type: 'button' }, label);
      b.addEventListener('click', () => {
        const rc = b.getBoundingClientRect();
        this.contextMenu(rc.left, rc.bottom + 2, items());
      });
      return b;
    };
    const top = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, icon('film', 18), h('span', {}, 'Video Editor')),
      menuBtn('File', () => [
        ['New project', () => this.cmd('newProject'), false, 'Ctrl+N'],
        ['Open project', () => this.cmd('open'), false, 'Ctrl+O'],
        ...this.recentMenu(),
        null,
        ['Save', () => this.cmd('save'), false, 'Ctrl+S'],
        ['Save as', () => this.cmd('saveAs'), false, 'Ctrl+Shift+S'],
        store.project.settings.audioOnly ? null : ['Save as template', () => this.cmd('saveTemplate')],
        null,
        ['Import media', () => this.cmd('importMedia'), false, 'Ctrl+I'],
        ['Export', () => this.cmd('export'), false, 'Ctrl+E'],
        null,
        ['Settings', () => this.cmd('settings')],
      ]),
      menuBtn('Edit', () => [
        ['Undo', () => this.cmd('undo'), !store.undoStack.length, 'Ctrl+Z'],
        ['Redo', () => this.cmd('redo'), !store.redoStack.length, 'Ctrl+Y'],
        null,
        ['Cut', () => this.cmd('cut'), !store.selection.size, 'Ctrl+X'],
        ['Copy', () => this.cmd('copy'), !store.selection.size, 'Ctrl+C'],
        ['Paste', () => this.cmd('paste'), !this.clipboard, 'Ctrl+V'],
        ['Duplicate', () => this.cmd('duplicate'), !store.selection.size, 'Ctrl+D'],
        ['Delete', () => this.cmd('delete'), !store.selection.size, 'Del'],
        ['Delete and close gap', () => this.cmd('rippleDelete'), !store.selection.size, 'Shift+Del'],
        null,
        ['Select all', () => this.cmd('selectAll'), false, 'Ctrl+A'],
        ['Split at playhead', () => this.cmd('split'), false, 'S'],
        ['Set in point', () => this.cmd('setIn'), false, 'I'],
        ['Set out point', () => this.cmd('setOut'), false, 'O'],
        ['Clear in and out', () => this.cmd('clearInOut')],
        ['Cut out the in to out range', () => this.cmd('rippleCutRange'), store.inPoint == null || store.outPoint == null],
      ]),
      menuBtn('Add', () => (store.project.settings.audioOnly ? this.addMenuAudio() : [
        ['Stitch videos', () => this.cmd('stitch')],
        null,
        ['Text', () => this.cmd('addText'), false, 'T'],
        ['Box', () => this.cmd('addShape', 'rect')],
        ['Circle', () => this.cmd('addShape', 'ellipse')],
        ['Arrow', () => this.cmd('addShape', 'arrow')],
        ['Label pill', () => this.cmd('addShape', 'callout')],
        ['Blur region', () => this.cmd('addBlur')],
        ['Adjustment layer', () => this.cmd('addAdjustment')],
        ['Colour background', () => this.cmd('addSolid')],
        null,
        ['Voiceover recording', () => this.openPanel('audio', { record: true })],
        ['Text to speech', () => this.openPanel('audio', { tts: true })],
        ['Auto captions', () => this.cmd('captions')],
      ])),
      menuBtn('Tools', () => this.toolsMenu()),
      menuBtn('Help', () => this.helpMenu()),
      this.titleEl,
      h('div', { class: 'spacer' }),
      this.undoBtn,
      this.redoBtn,
      iconButton('save', () => this.cmd('save'), 'Save (Ctrl+S)'),
      iconButton('help', () => this.cmd('guides'), 'How do I... (F1)'),
      iconButton('settings', () => this.cmd('settings'), 'Settings'),
      button('Export', () => this.cmd('export'), { icon: 'download', kind: 'primary', cls: 'export-btn' }),
    );
    this.rail = h('nav', { class: 'rail' });
    this.panelEl = h('div', { class: 'panel' });
    const left = h('aside', { class: 'left' }, this.rail, this.panelEl);
    this.viewerEl = h('section', { class: 'viewer-wrap' });
    this.inspectorEl = h('aside', { class: 'right' });
    const mid = h('div', { class: 'mid' }, left, this.viewerEl, this.inspectorEl);
    this.splitter = h('div', { class: 'hsplit', title: 'Drag to resize' });
    this.timelineEl = h('section', { class: 'tl-wrap' });
    r.append(top, mid, this.splitter, this.timelineEl);
    this.viewer = new Viewer(this.viewerEl, this);
    this.preview = this.viewer.preview;
    this.timeline = new Timeline(this.timelineEl, this);
    this.inspector = new Inspector(this.inspectorEl, this);
    this.applyMode();
    this.buildRail();
    this.openPanel('media');
    this.bindSplitter();
    this.bindKeys();
    this.bindDrops();
    store.on('history', () => this.updateTitle());
    store.on('change', () => this.updateTitle());
    store.on('saved', () => this.updateTitle());
    store.on('change', () => this.applyMode());
    store.on('project', () => {
      this.applyMode();
      this.updateTitle();
      this.renderPanel();
      setTimeout(() => this.timeline.zoomToFit(), 50);
    });
    store.on('media', () => {
      if (this.panel === 'media' || this.panel === 'audio' || this.panel === 'transcript') this.renderPanelSoon();
    });
    store.on('change', () => {
      if (this.panel === 'transcript') this.renderPanelSoon();
    });
    store.on('selection', () => {
      if (['transitions', 'effects', 'captions', 'transcript'].includes(this.panel)) this.renderPanelSoon();
    });
    this.updateTitle();
    this.loadLocalFonts();
  }

  recentMenu() {
    const list = (store.settings.recentProjects || []).slice(0, 6);
    return list.map((r) => ['Open ' + r.name, async () => (await confirmDiscard()) && openProjectPath(r.path)]);
  }

  updateTitle() {
    const name = store.project.name + (store.dirty ? ' (unsaved)' : '');
    this.titleEl.textContent = name;
    setWindowTitle(store.project.name + (store.dirty ? ' *' : '') + ' - Video Editor');
    this.undoBtn.disabled = !store.undoStack.length;
    this.redoBtn.disabled = !store.redoStack.length;
    this.undoBtn.title = store.undoStack.length ? `Undo ${store.undoStack[store.undoStack.length - 1].label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    this.redoBtn.title = store.redoStack.length ? `Redo ${store.redoStack[store.redoStack.length - 1].label} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
  }

  /** Panels that make sense for this project: audio projects keep only the sound ones. */
  panels() {
    return store.project?.settings.audioOnly ? PANELS.filter((p) => p.audio) : PANELS;
  }

  /** Switches the rail, menus and viewer between video and audio projects. */
  applyMode() {
    const audio = !!store.project?.settings.audioOnly;
    document.body.classList.toggle('audio-mode', audio);
    if (this._audio === audio) return;
    this._audio = audio;
    this.buildRail();
    if (!this.panels().some((p) => p.id === this.panel)) this.openPanel('media');
  }

  buildRail() {
    clear(this.rail);
    for (const p of this.panels()) {
      const b = h('button', { class: 'rail-btn' + (p.id === this.panel ? ' active' : ''), type: 'button', title: p.title, onclick: () => this.openPanel(p.id) }, icon(p.icon, 20), h('span', {}, p.label));
      b.dataset.panel = p.id;
      this.rail.append(b);
    }
  }

  openPanel(id, opts = {}) {
    this.panel = id;
    this.panelOpts = opts;
    this.rail.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === id));
    this.renderPanel();
  }

  renderPanel() {
    const p = PANELS.find((x) => x.id === this.panel);
    if (!p) return;
    const scroll = this.panelEl.scrollTop;
    clear(this.panelEl);
    try {
      this.panelEl.append(h('div', { class: 'panel-head' }, h('h3', {}, p.title)), p.render(this, this.panelOpts));
    } catch (e) {
      console.error(e);
      this.panelEl.append(h('p', { class: 'hint' }, 'This panel failed to load: ' + e.message));
    }
    this.panelEl.scrollTop = scroll;
  }

  renderPanelSoon() {
    clearTimeout(this._panelT);
    this._panelT = setTimeout(() => {
      if (document.activeElement && this.panelEl.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      this.renderPanel();
    }, 120);
  }

  focusInspector() {
    this.inspectorEl.scrollTop = 0;
  }

  /** Double-clicking text on the preview jumps to its text box in the inspector. */
  editTextInline(it) {
    this.inspector.tab.textv = 'text';
    this.inspector.render();
    const ta = this.inspectorEl.querySelector('textarea.text-edit');
    if (ta) {
      ta.focus();
      ta.select();
    }
  }

  saveSetting(k, v) {
    saveSettings({ [k]: v });
  }

  bindSplitter() {
    let startY = 0;
    let startH = 0;
    const saved = Number(localStorage.getItem('ve-tl-h') || 0);
    if (saved) this.timelineEl.style.height = saved + 'px';
    this.splitter.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startH = this.timelineEl.offsetHeight;
      this.splitter.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const nh = Math.max(160, Math.min(window.innerHeight - 260, startH - (ev.clientY - startY)));
        this.timelineEl.style.height = nh + 'px';
      };
      const up = () => {
        this.splitter.removeEventListener('pointermove', move);
        this.splitter.removeEventListener('pointerup', up);
        try {
          localStorage.setItem('ve-tl-h', String(this.timelineEl.offsetHeight));
        } catch {}
      };
      this.splitter.addEventListener('pointermove', move);
      this.splitter.addEventListener('pointerup', up);
    });
  }

  // ---- fonts -------------------------------------------------------------------

  async loadLocalFonts() {
    try {
      if ('queryLocalFonts' in window) {
        const fonts = await window.queryLocalFonts();
        this.localFonts = [...new Set(fonts.map((f) => f.family))].sort();
      }
    } catch {}
    for (const kit of store.settings.brandKits || []) for (const f of kit.fonts || []) await this.registerFontFile(f.path, f.family).catch(() => {});
  }

  async registerFontFile(path, family) {
    const { fileUrl } = await import('../backend/index.js');
    const ff = new FontFace(family, `url("${fileUrl(path)}")`);
    await ff.load();
    document.fonts.add(ff);
    if (!this.userFonts.includes(family)) this.userFonts.push(family);
  }

  fontList() {
    return [...new Set([...this.userFonts, ...BUNDLED_FONTS, ...this.localFonts])];
  }

  // ---- menus -------------------------------------------------------------------

  helpMenu() {
    const audio = store.project.settings.audioOnly;
    const quick = audio ? ['audioProject', 'transcript', 'noise', 'volume', 'exportAudio'] : ['separate', 'cut', 'captions', 'volume', 'export'];
    return [
      ['How do I...', () => this.cmd('guides'), false, 'F1'],
      null,
      ...quick.map((id) => [GUIDE_TITLES[id], () => this.cmd('guide', id)]),
    ];
  }

  async c_guides() {
    const { showGuides } = await import('./guide.js');
    return showGuides(this);
  }

  async c_guide(id) {
    const { startGuide } = await import('./guide.js');
    return startGuide(this, id);
  }

  addMenuAudio() {
    return [
      ['Join audio files', () => this.cmd('stitch')],
      null,
      ['Voiceover recording', () => this.openPanel('audio', { record: true })],
      ['Text to speech', () => this.openPanel('audio', { tts: true })],
      ['Sound effects and music', () => this.openPanel('audio')],
      null,
      ['Marker', () => this.cmd('marker'), false, 'M'],
    ];
  }

  toolsMenu() {
    const paid = paidOn();
    if (store.project.settings.audioOnly)
      return [
        ['Edit by text', () => this.openPanel('transcript')],
        ['Teleprompter', () => this.cmd('teleprompter')],
        ['Join audio files', () => this.cmd('stitch')],
        null,
        ['Cut out silences', () => this.cmd('silenceCut')],
        ['Remove filler words', () => this.cmd('fillerCut')],
        ['Remove background noise', () => this.cmd('denoise')],
        ['Level out the voice', () => this.cmd('compressClip')],
        ['Even out loudness', () => this.cmd('normalizeClip')],
        null,
        ['Mark the beats', () => this.cmd('beats')],
        null,
        ['Switch to a video project', () => this.cmd('projectType', false)],
      ];
    return [
      ['Edit by text', () => this.openPanel('transcript')],
      ['Teleprompter', () => this.cmd('teleprompter')],
      ['Record the screen', () => this.cmd('recordScreen')],
      ['Stitch videos', () => this.cmd('stitch')],
      ...(paid ? [null, ['Make shorts from a long video', () => this.cmd('shorts')]] : []),
      null,
      ['Sync angles by sound', () => this.cmd('syncAngles')],
      ['Switch angles', () => this.cmd('switchAngles'), !store.project.multicam],
      ['Line up before and after faces', () => this.cmd('alignFaces')],
      ['Freehand mask', () => this.cmd('freehandMask')],
      null,
      ['Moving photo', () => this.cmd('depthShot')],
      ['Overlays: dust, sparkles, light', () => this.openPanel('effects')],
      ['Upscale the selected video', () => this.cmd('upscale')],
      null,
      ['Switch to an audio project', () => this.cmd('projectType', true)],
      ...(paid
        ? [null, ['Translate captions', () => this.cmd('translate')], ['YouTube chapters and description', () => this.cmd('chapters')], ['My voice', () => this.cmd('myVoice')], ['Talking presenter', () => this.cmd('avatar')]]
        : []),
    ];
  }

  contextMenu(x, y, items) {
    document.querySelector('.ctx')?.remove();
    const menu = h('div', { class: 'ctx', role: 'menu' });
    for (const item of items) {
      if (!item) {
        menu.append(h('div', { class: 'ctx-sep' }));
        continue;
      }
      const [label, fn, disabled, keys] = item;
      const b = h('button', { class: 'ctx-item', type: 'button', disabled: !!disabled }, h('span', {}, label), keys ? h('kbd', {}, keyLabel(keys)) : null);
      b.addEventListener('click', () => {
        menu.remove();
        fn();
      });
      menu.append(b);
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  clipMenu(x, y, it) {
    const p = store.project;
    const m = it.mediaId ? p.media[it.mediaId] : null;
    const visual = isVisualItem(p, it);
    const items = [
      ['Split at playhead', () => this.cmd('split'), false, 'S'],
      ['Cut', () => this.cmd('cut'), false, 'Ctrl+X'],
      ['Copy', () => this.cmd('copy'), false, 'Ctrl+C'],
      ['Duplicate', () => this.cmd('duplicate'), false, 'Ctrl+D'],
      ['Delete', () => this.cmd('delete'), false, 'Del'],
      ['Delete and close gap', () => this.cmd('rippleDelete'), false, 'Shift+Del'],
      null,
    ];
    if (it.type === 'clip' && visual && m?.kind === 'video') {
      items.push(['Freeze frame', () => this.cmd('freeze'), false, 'F'], ['Reverse', () => this.cmd('reverse', it)]);
      if (m.hasAudio) items.push(['Separate audio', () => this.cmd('detachAudio')]);
      items.push(['Remove background', () => this.cmd('removeBackground', it)], ['Stabilise', () => this.cmd('stabilize', it)], ['Blur faces', () => this.cmd('faceBlur', it)]);
    }
    if (it.type === 'clip' && visual && m?.kind === 'image') items.push(['Remove background', () => this.cmd('removeBackground', it)]);
    if (it.type === 'clip' && m?.hasAudio) items.push(['Lower other sounds here', () => this.cmd('duckOthers', it)]);
    if (it.type === 'clip' && m?.hasAudio) items.push(...(p.settings.audioOnly ? [] : [['Auto captions', () => this.cmd('captions', it)]]), ['Cut out silences', () => this.cmd('silenceCut', it)], ['Remove background noise', () => this.cmd('denoise', it)]);
    if (it.type === 'clip') items.push(['Replace media', () => this.cmd('replaceMedia', it)], ['Show file', () => this.cmd('revealMedia', it)]);
    if (it.type === 'text' && it.caption) items.push(['Edit all captions', () => this.cmd('editCaptions')]);
    items.push(null, ['Add transition', () => this.openPanel('transitions', { cutItem: it.id }), !visual]);
    this.contextMenu(x, y, items);
  }

  // ---- keyboard ------------------------------------------------------------------

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (k === 'F1') {
        e.preventDefault();
        return this.cmd('guides');
      }
      if (document.querySelector('.modal-overlay')) return;
      if (ctrl && k.toLowerCase() === 's') {
        e.preventDefault();
        return this.cmd(e.shiftKey ? 'saveAs' : 'save');
      }
      if (typing) return;
      const map = {
        ' ': () => this.preview.toggle(),
        s: () => this.cmd('split'),
        Delete: () => this.cmd(e.shiftKey ? 'rippleDelete' : 'delete'),
        Backspace: () => this.cmd(e.shiftKey ? 'rippleDelete' : 'delete'),
        ArrowLeft: () => this.cmd('stepFrame', e.shiftKey ? -10 : -1),
        ArrowRight: () => this.cmd('stepFrame', e.shiftKey ? 10 : 1),
        ArrowUp: () => this.cmd('prevEdit'),
        ArrowDown: () => this.cmd('nextEdit'),
        Home: () => this.cmd('goStart'),
        End: () => this.cmd('goEnd'),
        i: () => this.cmd('setIn'),
        o: () => this.cmd('setOut'),
        m: () => this.cmd('marker'),
        k: () => this.cmd('keyframe'),
        f: () => this.cmd('freeze'),
        c: () => this.cmd('crop'),
        t: () => this.cmd('addText'),
        n: () => this.timeline.snapBtn.click(),
        '+': () => this.timeline.setZoom(store.zoom * 1.4),
        '=': () => this.timeline.setZoom(store.zoom * 1.4),
        '-': () => this.timeline.setZoom(store.zoom / 1.4),
        j: () => this.cmd('stepFrame', -Math.round(store.project.settings.fps)),
        l: () => this.cmd('stepFrame', Math.round(store.project.settings.fps)),
        Escape: () => {
          if (this.viewer.mode !== 'transform') this.viewer.setMode('transform');
          else store.clearSelection();
        },
        Z: () => e.shiftKey && this.timeline.zoomToFit(),
      };
      const cmap = {
        z: () => this.cmd(e.shiftKey ? 'redo' : 'undo'),
        y: () => this.cmd('redo'),
        c: () => this.cmd('copy'),
        x: () => this.cmd('cut'),
        v: () => this.cmd('paste'),
        d: () => this.cmd('duplicate'),
        a: () => this.cmd('selectAll'),
        b: () => this.cmd('split'),
        k: () => this.cmd('split'),
        e: () => this.cmd('export'),
        i: () => this.cmd('importMedia'),
        o: () => this.cmd('open'),
        n: () => this.cmd('newProject'),
      };
      const fn = ctrl ? cmap[k.toLowerCase()] : map[k] || map[k.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    });
  }

  seek(t) {
    store.seek(t);
    this.preview.seeked();
  }

  // ---- drag and drop -------------------------------------------------------------

  bindDrops() {
    onFileDrop(async (paths, pos) => {
      const projects = paths.filter((p) => p.toLowerCase().endsWith('.vproj'));
      if (projects.length) {
        if (await confirmDiscard()) openProjectPath(projects[0]);
        return;
      }
      const media = await importFiles(paths);
      if (!media.length) return toast('Those files are not a video, audio, photo or PDF format the editor opens.', { kind: 'warn' });
      // dropped over the timeline: place them there
      const tlRect = this.timelineEl.getBoundingClientRect();
      const y = pos?.y != null ? pos.y / (window.devicePixelRatio || 1) : -1;
      if (y >= tlRect.top) {
        const drop = this.timeline.dragOver((pos.x || 0) / (window.devicePixelRatio || 1), y, media[0].kind);
        this.timeline.dragEnd();
        this.addMedia(media, drop?.t ?? store.playhead, drop?.trackId);
      }
    });
  }

  /** Starts a drag of media items from the library panel. */
  startMediaDrag(e, mediaList) {
    const ghost = h('div', { class: 'drag-ghost' }, mediaList.length > 1 ? `${mediaList.length} items` : mediaList[0].name);
    document.body.append(ghost);
    const kind = store.project.settings.audioOnly ? 'audio' : mediaList[0].kind;
    let over = null;
    let moved = false;
    const sx = e.clientX;
    const sy = e.clientY;
    dragSession.active = mediaList;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      moved = true;
      ghost.style.display = 'block';
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 8 + 'px';
      over = this.timeline.dragOver(ev.clientX, ev.clientY, kind);
      // dropping on a clip in the preview replaces it only when shift is held
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      this.timeline.dragEnd();
      dragSession.active = null;
      if (moved && over) this.addMedia(mediaList, over.t, over.trackId);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  addMedia(mediaList, t = store.playhead, trackId = null) {
    const list = mediaList.filter((m) => m.status !== 'error');
    if (!list.length) return;
    const p0 = store.project;
    const firstPicture = !p0.settings.audioOnly && !Object.values(p0.items).some((it) => it.type === 'clip' && isVisualItem(p0, it) && p0.media[it.mediaId]?.kind === 'video');
    const video = list.find((m) => m.kind === 'video');
    if (firstPicture && video) {
      if (video.status === 'ready') setTimeout(() => this.fitCanvasTo(video), 0);
      else whenReady(video).then((mm) => this.fitCanvasTo(mm)).catch(() => {});
    }
    let added = [];
    store.commit('Add to timeline', (p) => {
      added = E.addMediaToTimeline(p, list, t, { trackId });
    });
    store.select(added.map((a) => a.id));
    // clips added before processing finished get their real length when ready
    for (const m of list) {
      if (m.status === 'ready') continue;
      whenReady(m)
        .then((mm) => {
          store.mutate((p) => {
            for (const it of Object.values(p.items)) {
              if (it.mediaId !== mm.id || mm.kind === 'image') continue;
              if (!it._sized) {
                it.duration = Math.max(0.1, (mm.duration || it.duration) - it.in);
                it._sized = true;
              }
            }
            E.compactMagnetic(p);
          });
        })
        .catch(() => {});
    }
  }

  /**
   * The first video on the timeline: a "Match my video" project takes its
   * shape right away, any other project offers to when the shapes differ.
   */
  fitCanvasTo(m) {
    const p = store.project;
    if (!m?.width || !m?.height || p.settings.audioOnly) return;
    const c = canvasForMedia(m);
    if (p.settings.matchFirst) {
      store.commit('Match the video', (pp) => {
        Object.assign(pp.settings, c);
        delete pp.settings.matchFirst;
      });
      return toast(`The frame is ${c.width} x ${c.height} now to match ${m.name}.`, { timeout: 4000 });
    }
    const s = p.settings;
    if (Math.abs(m.width / m.height / (s.width / s.height) - 1) < 0.03) return;
    toast(`${m.name} is ${frameShape(m.width, m.height)} while the frame is ${frameShape(s.width, s.height)}, so it shows small with bars around it.`, {
      timeout: 12000,
      action: { label: 'Match the video', run: () => this.cmd('matchCanvas', m) },
    });
  }

  /** Sets the frame to the shape and size of a video (the selected clip's, or the first on the timeline). */
  c_matchCanvas(m = null) {
    const p = store.project;
    if (!m) {
      const sel = store.primary && p.media[store.primary.mediaId];
      const first = Object.values(p.items).filter((it) => it.type === 'clip' && isVisualItem(p, it) && p.media[it.mediaId]?.kind === 'video').sort((a, b) => a.start - b.start)[0];
      m = sel?.kind === 'video' ? sel : first ? p.media[first.mediaId] : null;
    }
    if (!m?.width) return toast('Put a video on the timeline first.', { timeout: 2500 });
    const c = canvasForMedia(m);
    store.commit('Match the video', (pp) => {
      Object.assign(pp.settings, c);
      delete pp.settings.matchFirst;
    });
    toast(`The frame is ${c.width} x ${c.height} now to match ${m.name}.`, { timeout: 4000 });
  }

  // ---- commands ------------------------------------------------------------------

  async cmd(name, ...args) {
    // commands that call Claude or Replicate stop here while paid services are off
    if (['shorts', 'translate', 'chapters', 'myVoice', 'avatar', 'aiUpscale', 'generate'].includes(name) && !paidOn()) return toast(PAID_OFF_MESSAGE, { timeout: 4000 });
    if (store.project.settings.audioOnly && VIDEO_ONLY.has(name)) return toast('That is for video. Switch this project to video with Tools, then "Switch to a video project".', { timeout: 4000 });
    try {
      const fn = this['c_' + name];
      if (fn) return await fn.apply(this, args);
      const ai = await import('../ai/commands.js');
      if (ai.COMMANDS[name]) return await ai.COMMANDS[name](this, ...args);
      console.warn('unknown command', name);
    } catch (e) {
      errorToast(e);
    }
  }

  selectedOrAtPlayhead() {
    const sel = store.selectedItems;
    if (sel.length) return sel;
    const t = store.playhead;
    return Object.values(store.project.items).filter((it) => it.start < t && itemEnd(it) > t && !store.project.tracks.find((tr) => tr.id === it.trackId)?.locked);
  }

  c_undo() {
    const l = store.undo();
    if (l) toast('Undid ' + l, { timeout: 1500 });
  }
  c_redo() {
    const l = store.redo();
    if (l) toast('Redid ' + l, { timeout: 1500 });
  }
  c_save() {
    return saveProject();
  }
  c_saveAs() {
    return saveProject({ as: true });
  }
  c_open() {
    return openProject();
  }
  /** Turns this project into an audio project (true) or back into a video project (false). */
  c_projectType(audio) {
    const p = store.project;
    if (!!p.settings.audioOnly === !!audio) return;
    store.commit(audio ? 'Audio project' : 'Video project', (pp) => {
      if (audio) {
        pp.settings.audioOnly = true;
        if (!pp.tracks.some((t) => t.kind === 'audio')) E.addTrack(pp, 'audio');
        const spine = E.spineTrack(pp);
        // an audio track with gaps stays where it is instead of snapping together
        const items = trackItems(pp, spine.id);
        let t = 0;
        const gaps = items.some((it) => {
          const gap = Math.abs(it.start - t) > 0.01;
          t = itemEnd(it);
          return gap;
        });
        if (gaps) pp.settings.magnetic = false;
        for (const tr of pp.tracks) if (tr.kind === 'audio' && (tr.height || 56) < 80) tr.height = tr === spine ? 110 : 80;
      } else {
        delete pp.settings.audioOnly;
      }
    });
    store.select([]);
    toast(audio ? 'This is now an audio project. The picture tools are hidden until you switch back.' : 'This is now a video project.', { timeout: 3500 });
  }

  /** New audio project from one or more sound files, placed end to end. */
  async c_editAudioFile() {
    if (!(await confirmDiscard())) return;
    const { AUDIO_EXT, VIDEO_EXT } = await import('../media/library.js');
    const paths = await openDialog({ multiple: true, title: 'Choose the audio to edit', filters: [{ name: 'Audio, or video to take the sound from', extensions: [...AUDIO_EXT, ...VIDEO_EXT] }] });
    if (!paths?.length) return;
    createProject({ name: basename(paths[0]).replace(/\.[^.]+$/, ''), audioOnly: true });
    const media = await importFiles(paths);
    await Promise.all(media.map((m) => whenReady(m).catch(() => null)));
    this.addMedia(media.filter((m) => m.status === 'ready'), 0);
    this.timeline?.zoomToFit();
    return media;
  }

  async c_newProject() {
    if (!(await confirmDiscard())) return;
    const { showWelcome } = await import('./welcome.js');
    showWelcome(this, { newOnly: true });
  }
  async c_importMedia() {
    const paths = await openDialog({
      multiple: true,
      title: 'Import media',
      filters: [
        { name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'tif', 'tiff', 'bmp', 'pdf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!paths?.length) return [];
    const media = await importFiles(paths);
    this.openPanel('media');
    return media;
  }
  async c_stitch(opts = {}) {
    const { showStitch } = await import('./stitch.js');
    const audio = store.project.settings.audioOnly;
    const vids = opts.mediaIds || (opts.fromLibrary ? Object.values(store.project.media).filter((m) => (audio ? m.kind === 'audio' || (m.kind === 'video' && m.hasAudio) : m.kind === 'video' || m.kind === 'image')).map((m) => m.id) : null);
    return showStitch(this, { ...opts, mediaIds: vids });
  }
  async c_syncAngles() {
    const { syncSelected } = await import('../ai/multicam.js');
    return syncSelected(this);
  }
  async c_switchAngles() {
    const { showAngleSwitcher } = await import('../ai/multicam.js');
    return showAngleSwitcher(this);
  }
  async c_alignFaces() {
    const { alignBeforeAfter } = await import('../ai/align.js');
    return alignBeforeAfter(this);
  }
  c_freehandMask() {
    const it = store.primary;
    if (!it || !isVisualItem(store.project, it) || it.type === 'adjust') return toast('Select a clip or photo first.', { timeout: 2000 });
    if (store.playhead < it.start || store.playhead >= itemEnd(it)) this.seek(it.start + 0.01);
    if (it.mask?.type !== 'path') store.commit('Freehand mask', () => (it.mask = { ...it.mask, type: 'path', points: it.mask?.points || [] }));
    this.inspector?.setTab?.('mask');
    this.viewer.setMode('pen');
  }
  async c_trackMask(it = store.primary) {
    const { trackMask } = await import('../ai/tracker.js');
    return trackMask(it);
  }
  async c_shorts() {
    const { showShorts } = await import('../ai/shorts.js');
    showShorts(this);
  }
  async c_teleprompter() {
    const { openTeleprompter, teleprompterOpen, closeTeleprompter } = await import('./teleprompter.js');
    if (teleprompterOpen()) return closeTeleprompter();
    openTeleprompter(this);
  }
  async c_recordScreen() {
    const { showScreenRecorder } = await import('../ai/screen-record.js');
    showScreenRecorder(this);
  }
  async c_export() {
    const { showExport } = await import('./export-dialog.js');
    showExport(this);
  }
  async c_settings() {
    const { showSettings } = await import('./settings-dialog.js');
    showSettings(this);
  }

  c_split() {
    const t = store.playhead;
    const targets = this.selectedOrAtPlayhead().filter((it) => it.start < t - 0.02 && itemEnd(it) > t + 0.02);
    if (!targets.length) return toast('Move the playhead over a clip to split it.', { timeout: 2000 });
    let created = [];
    store.commit('Split', (p) => (created = E.splitAt(p, targets, t)));
    store.select(created.map((c) => c.id));
  }

  c_delete() {
    const ids = [...store.selection];
    if (!ids.length) return;
    store.commit('Delete', (p) => {
      for (const id of ids) {
        // deleting a video clip also removes its separated sound
        for (const o of Object.values(p.items)) if (o.linkedTo === id) o.linkedTo = null;
      }
      E.deleteItems(p, ids);
      E.pruneEmptyTracks(p);
    });
    store.clearSelection();
  }

  c_rippleDelete() {
    const ids = [...store.selection];
    if (!ids.length) return;
    store.commit('Delete and close gap', (p) => E.deleteItems(p, ids, { ripple: true }));
    store.clearSelection();
  }

  c_duplicate() {
    const ids = [...store.selection];
    if (!ids.length) return;
    let out = [];
    store.commit('Duplicate', (p) => (out = E.duplicateItems(p, ids)));
    store.select(out.map((o) => o.id));
  }

  c_copy() {
    const items = store.selectedItems;
    if (!items.length) return;
    const t0 = Math.min(...items.map((i) => i.start));
    this.clipboard = items.map((i) => ({ ...clone(i), _offset: i.start - t0 }));
    toast(`Copied ${items.length} item${items.length > 1 ? 's' : ''}.`, { timeout: 1200 });
  }

  c_cut() {
    this.c_copy();
    this.c_delete();
  }

  c_paste(t = store.playhead) {
    if (!this.clipboard) return;
    const out = [];
    store.commit('Paste', (p) => {
      for (const src of this.clipboard) {
        const c = clone(src);
        c.id = uid('c');
        c.start = t + (src._offset || 0);
        delete c._offset;
        if (!p.media[c.mediaId] && c.type === 'clip') continue;
        const kind = p.tracks.find((tr) => tr.id === c.trackId)?.kind || (c.type === 'clip' && p.media[c.mediaId]?.kind === 'audio' ? 'audio' : 'video');
        if (E.isMagnetic(p, c.trackId)) {
          p.items[c.id] = c;
          E.insertIntoMain(p, [c], t);
        } else {
          c.trackId = E.findFreeTrack(p, kind, c.start, c.start + c.duration, { prefer: c.trackId, skipMain: kind === 'video' });
          p.items[c.id] = c;
        }
        out.push(c);
      }
    });
    store.select(out.map((o) => o.id));
  }

  c_selectAll() {
    store.select(Object.keys(store.project.items));
  }

  c_freeze() {
    const t = store.playhead;
    const it = this.selectedOrAtPlayhead().find((i) => i.type === 'clip' && isVisualItem(store.project, i) && store.project.media[i.mediaId]?.kind === 'video' && i.start <= t && itemEnd(i) >= t);
    if (!it) return toast('Put the playhead over a video clip to freeze a frame.', { timeout: 2200 });
    let fr = null;
    store.commit('Freeze frame', (p) => (fr = E.freezeFrame(p, it, t, 2)));
    if (fr) store.select(fr.id);
  }

  c_detachAudio() {
    const it = store.selectedItems.find((i) => i.type === 'clip' && isVisualItem(store.project, i) && store.project.media[i.mediaId]?.hasAudio);
    if (!it) return toast('Select a video clip that has sound.', { timeout: 2000 });
    let a = null;
    store.commit('Separate audio', (p) => (a = E.detachAudio(p, it)));
    if (a) store.select(a.id);
  }

  c_duckOthers(it = store.primary) {
    if (!it || it.type !== 'clip') return toast('Select the clip that should be heard on top, like a voiceover.', { timeout: 2400 });
    const level = store.settings.duckOthersLevel ?? 0.2;
    let ids = [];
    store.commit('Lower other sounds', (p) => (ids = E.duckOthers(p, it, level)));
    toast(ids.length ? `Lowered ${ids.length} other ${ids.length === 1 ? 'clip' : 'clips'} to ${Math.round(level * 100)}% under ${it.name || 'this clip'}.` : 'No other sound plays under this clip.', { timeout: 3000 });
  }

  async c_preparePitch(it = store.primary) {
    const m = it && store.project.media[it.mediaId];
    const semis = it?.audioFx?.pitch;
    if (!m?.hasAudio || !semis) return;
    const { ensurePitched, pitchedSync } = await import('../media/audio-fx.js');
    if (pitchedSync(m, semis)) return;
    const job = startJob('Changing pitch');
    job.update(null, (semis > 0 ? '+' : '') + semis + ' semitones');
    try {
      await ensurePitched(m, semis, { signal: job.signal, retry: true });
      store.emit('media');
      this.preview?.invalidate();
      job.done();
    } catch (e) {
      job.fail(e);
    }
  }

  c_crop() {
    const it = store.primary;
    if (!it || it.type !== 'clip' || !isVisualItem(store.project, it)) return toast('Select a video or photo clip to crop.', { timeout: 2000 });
    if (store.playhead < it.start || store.playhead >= itemEnd(it)) this.seek(it.start + 0.01);
    this.viewer.setMode(this.viewer.mode === 'crop' ? 'transform' : 'crop');
    if (this.viewer.mode === 'crop') toast('Drag the edges on the preview to crop. Press Esc when done.', { timeout: 3000 });
  }

  c_marker(t = store.playhead) {
    store.commit('Add marker', (p) => p.markers.push({ id: uid('k'), t, label: '', color: '#e0b84a' }));
  }

  async c_renameMarker(id) {
    const mk = store.project.markers.find((m) => m.id === id);
    if (!mk) return;
    const v = await promptDialog('Marker', 'Label', mk.label || '');
    if (v != null) store.commit('Rename marker', () => (mk.label = v));
  }

  c_keyframe() {
    const it = store.primary;
    if (!it) return toast('Select a clip first.', { timeout: 1500 });
    if (store.playhead < it.start || store.playhead > itemEnd(it)) return toast('Move the playhead over the selected clip.', { timeout: 2000 });
    const props = it.type === 'blur' ? ['x', 'y', 'scale'] : isVisualItem(store.project, it) ? ['x', 'y', 'scale', 'rotation', 'opacity'] : ['volume'];
    store.commit('Add keyframe', () => {
      const lt = localTime(it);
      for (const pr of props) {
        const v = getProp(it, pr);
        it.kf[pr] ||= [];
        if (!it.kf[pr].some((k) => Math.abs(k.t - lt) < 1 / 60)) {
          it.kf[pr].push({ t: lt, v, e: 'easeInOut' });
          it.kf[pr].sort((a, b) => a.t - b.t);
        }
      }
    });
    toast(props[0] === 'volume' ? 'Volume point added. Drag the yellow line on the clip to change the volume from here.' : 'Keyframe added. Change position, size, rotation or opacity at another time to animate.', { timeout: 3000 });
  }

  c_goStart() {
    if (this.preview.playing) this.preview.pause();
    this.seek(0);
    this.timeline?.revealPlayhead();
  }

  c_goEnd() {
    if (this.preview.playing) this.preview.pause();
    this.seek(projectDuration(store.project));
    this.timeline?.revealPlayhead();
  }

  c_stepFrame(n = 1) {
    if (this.preview.playing) this.preview.pause();
    const f = 1 / store.project.settings.fps;
    this.seek(Math.max(0, store.snapTime(store.playhead + n * f)));
  }

  editPoints() {
    const pts = new Set([0]);
    for (const it of Object.values(store.project.items)) {
      pts.add(Math.round(it.start * 1000) / 1000);
      pts.add(Math.round(itemEnd(it) * 1000) / 1000);
    }
    for (const m of store.project.markers) pts.add(m.t);
    return [...pts].sort((a, b) => a - b);
  }

  c_prevEdit() {
    const t = store.playhead - 0.001;
    const p = this.editPoints().filter((x) => x < t);
    this.seek(p.length ? p[p.length - 1] : 0);
  }

  c_nextEdit() {
    const t = store.playhead + 0.001;
    const p = this.editPoints().find((x) => x > t);
    if (p != null) this.seek(p);
  }

  c_setIn() {
    store.inPoint = store.playhead;
    if (store.outPoint != null && store.outPoint <= store.inPoint) store.outPoint = null;
    store.touch();
  }
  c_setOut() {
    store.outPoint = store.playhead;
    if (store.inPoint != null && store.inPoint >= store.outPoint) store.inPoint = null;
    store.touch();
  }
  c_clearInOut() {
    store.inPoint = store.outPoint = null;
    store.touch();
  }
  c_rippleCutRange() {
    if (store.inPoint == null || store.outPoint == null) return;
    const a = store.inPoint;
    const b = store.outPoint;
    store.commit('Cut out range', (p) => E.rippleCutRange(p, a, b));
    store.inPoint = store.outPoint = null;
    this.seek(a);
  }

  overlayStart(duration) {
    const t = store.playhead;
    return { start: t, duration };
  }

  c_addText(t = store.playhead, text = 'Your text', style = {}, extra = {}) {
    let it = null;
    store.commit('Add text', (p) => {
      it = newText(null, t, text, style);
      Object.assign(it, extra);
      E.placeOverlay(p, it);
    });
    store.select(it.id);
    return it;
  }

  c_addShape(shape = 'rect') {
    let it = null;
    store.commit('Add shape', (p) => {
      it = newShape(null, store.playhead, shape);
      E.placeOverlay(p, it);
    });
    store.select(it.id);
  }

  c_addBlur() {
    let it = null;
    const under = this.selectedOrAtPlayhead().find((i) => i.type === 'clip' && isVisualItem(store.project, i));
    const dur = under ? itemEnd(under) - store.playhead : 4;
    store.commit('Add blur region', (p) => {
      it = newBlurRegion(null, store.playhead, Math.max(0.5, dur));
      E.placeOverlay(p, it);
    });
    store.select(it.id);
    toast('Drag the region over what you want hidden. Use "Track what is under this region" to make it follow.', { timeout: 4000 });
  }

  c_addAdjustment() {
    let it = null;
    store.commit('Add adjustment layer', (p) => {
      it = newAdjustment(null, store.playhead, 5);
      E.placeOverlay(p, it);
    });
    store.select(it.id);
  }

  async c_addFx(key = 'dust') {
    const { newFx } = await import('../core/model.js');
    let it = null;
    store.commit('Add overlay', (p) => {
      it = newFx(null, store.playhead, 5, key, p);
      E.placeOverlay(p, it);
    });
    store.select(it.id);
  }
  async c_translate() {
    const { translateDialog } = await import('../ai/translate.js');
    return translateDialog(this);
  }
  async c_chapters() {
    const { showChapters } = await import('../ai/chapters.js');
    return showChapters(this);
  }
  async c_myVoice() {
    const { myVoiceDialog } = await import('../ai/voice-clone.js');
    return myVoiceDialog(this);
  }
  async c_avatar() {
    const { avatarDialog } = await import('../ai/voice-clone.js');
    return avatarDialog(this);
  }
  async c_upscale(it = store.primary) {
    const { upscaleClip } = await import('../ai/processing.js');
    return upscaleClip(it);
  }
  async c_aiUpscale(it = store.primary) {
    const { aiUpscalePhoto } = await import('../ai/processing.js');
    return aiUpscalePhoto(it);
  }
  async c_depthShot(it = store.primary) {
    const { depthShotDialog } = await import('../ai/depth.js');
    return depthShotDialog(this, it);
  }
  c_addSolid() {
    let it = null;
    store.commit('Add colour', (p) => {
      it = newSolid(null, store.playhead, 5, '#111111');
      const main = E.mainTrack(p);
      it.trackId = main.id;
      p.items[it.id] = it;
      E.insertIntoMain(p, [it], store.playhead);
    });
    store.select(it.id);
  }

  async c_importLut(it) {
    const path = await openDialog({ title: 'Import a LUT', filters: [{ name: 'Cube LUT', extensions: ['cube'] }] });
    if (!path) return;
    const lut = parseCube(await readText(path));
    const key = 'file:' + path;
    this.preview.comp.setUserLut(key, lut);
    const list = (store.settings.userLuts || []).filter((l) => l.path !== path);
    list.push({ path, name: basename(path).replace(/\.cube$/i, '') });
    saveSettings({ userLuts: list });
    if (it) store.commit('Apply LUT', () => Object.assign(it.color, { lut: key, lutName: basename(path), lutIntensity: 1, filter: null }));
    toast('LUT imported.');
  }

  async c_applyLut(it, path) {
    await this.ensureLut('file:' + path);
    store.commit('Apply LUT', () => Object.assign(it.color, { lut: 'file:' + path, lutName: basename(path), lutIntensity: 1, filter: null }));
  }

  /** Loads a .cube referenced by a project into the compositors. */
  async ensureLut(key) {
    if (!key?.startsWith('file:')) return;
    if (this.preview.comp.userLuts.has(key)) return;
    const lut = parseCube(await readText(key.slice(5)));
    this.preview.comp.setUserLut(key, lut);
    const { registerLut } = await import('../render/lut-registry.js');
    registerLut(key, lut);
  }

  c_colorToAll(it) {
    const c = clone(it.color);
    store.commit('Copy colour to all clips', (p) => {
      for (const o of Object.values(p.items)) if (o.type === 'clip' && o.id !== it.id && isVisualItem(p, o)) o.color = clone(c);
    });
    toast('Colour copied to every video and photo clip.');
  }

  c_replaceMedia(it) {
    this.openPanel('media', { replaceFor: it.id });
    toast('Click a clip in the media panel to use it in place of the selected one.', { timeout: 3500 });
  }

  async c_revealMedia(it) {
    const m = store.project.media[it.origMediaId || it.mediaId];
    if (m) {
      const { invoke } = await import('../backend/index.js');
      invoke('reveal_path', { path: m.path });
    }
  }

  async c_saveTextStyle(it) {
    const name = await promptDialog('Save text style', 'Style name', 'My style');
    if (!name) return;
    const styles = store.settings.textStyles || [];
    styles.push({ id: uid('s'), name, style: clone(it.style), reveal: it.reveal, anim: clone(it.anim) });
    saveSettings({ textStyles: styles });
    toast('Saved. It is in the Text panel under My styles.');
  }

  /** Puts two selected clips side by side (wide canvas) or one above the other. */
  c_splitScreen() {
    const p = store.project;
    const clips = store.selectedItems.filter((i) => i.type === 'clip' && isVisualItem(p, i)).sort((a, b) => a.start - b.start);
    if (clips.length !== 2) return toast('Select two clips for a split screen.', { kind: 'warn' });
    const [a, b] = clips;
    store.commit('Split screen', (pp) => {
      const W = pp.settings.width;
      const H = pp.settings.height;
      const vertical = H >= W;
      const dur = Math.min(a.duration, b.duration);
      // the second clip goes on a free track above, starting with the first
      b.trackId = E.findFreeTrack(pp, 'video', a.start, a.start + dur, { skipMain: true });
      b.start = a.start;
      a.duration = Math.max(a.duration, dur);
      b.duration = dur;
      const cellW = vertical ? W : W / 2;
      const cellH = vertical ? H / 2 : H;
      [a, b].forEach((c, i) => {
        const m = pp.media[c.mediaId];
        const mw = m?.width || W;
        const mh = m?.height || H;
        const cover = Math.max(W / mw, H / mh);
        const need = Math.max(cellW / mw, cellH / mh);
        c.fit = 'cover';
        c.kf = {};
        c.props.scale = need / cover;
        c.props.x = vertical ? 0 : (i === 0 ? -W / 4 : W / 4);
        c.props.y = vertical ? (i === 0 ? -H / 4 : H / 4) : 0;
        const shownW = cellW / (mw * need);
        const shownH = cellH / (mh * need);
        c.mask = { ...c.mask, type: 'rect', x: 0.5, y: 0.5, w: shownW, h: shownH, radius: 0, angle: 0, feather: 0.0005, invert: false };
      });
      E.compactMagnetic(pp);
    });
    toast('Split screen made. Drag each clip on the preview to change what shows in its half.', { timeout: 4000 });
  }

  /** Shrinks the selected clip into a corner with rounded edges. */
  c_pip(corner = 'tr') {
    const it = store.primary;
    if (!it || !isVisualItem(store.project, it)) return toast('Select a clip that sits on a track above another clip.', { kind: 'warn' });
    store.commit('Picture in picture', (pp) => {
      const W = pp.settings.width;
      const H = pp.settings.height;
      const s = 0.36;
      const m = pp.media[it.mediaId];
      const mw = m?.width || W;
      const mh = m?.height || H;
      const fit = Math.min(W / mw, H / mh);
      const w = mw * fit * s;
      const hh = mh * fit * s;
      const margin = Math.min(W, H) * 0.04;
      delete it.kf.x;
      delete it.kf.y;
      delete it.kf.scale;
      it.fit = 'contain';
      it.props.scale = s;
      it.props.x = (corner.includes('r') ? 1 : -1) * (W / 2 - w / 2 - margin);
      it.props.y = (corner.includes('b') ? 1 : -1) * (H / 2 - hh / 2 - margin);
      it.mask = { ...it.mask, type: 'rect', x: 0.5, y: 0.5, w: 1, h: 1, radius: 0.06, feather: 0.002, invert: false };
      if (E.isMagnetic(pp, it.trackId)) {
        it.trackId = E.findFreeTrack(pp, 'video', it.start, it.start + it.duration, { skipMain: true });
        E.compactMagnetic(pp);
      }
    });
  }

  async c_saveTemplate() {
    const { saveTemplate } = await import('./templates.js');
    return saveTemplate(this);
  }
}

export { CANVAS_PRESETS, select, sourceTime, trackItems, visualTracks, cloneItem, keyframeTimes, setProp, formatTime, confirmDialog, modal, startJob, isDesktop, kindForPath, applyFilter };
