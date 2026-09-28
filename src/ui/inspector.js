// Right-hand panel: properties of the selected item, or the project settings
// when nothing is selected.

import { h, icon, clear, slider, select, toggle, colorInput, section, tabs, textInput, button, iconButton, keyLabel } from './dom.js';
import { store } from '../core/store.js';
import { setProp, getProp, toggleKeyframe, keyframeAtPlayhead } from '../core/props.js';
import { ANIMATIONS_IN, ANIMATIONS_OUT, ANIMATIONS_LOOP, SPEED_RAMPS, hasKeyframes, CANVAS_PRESETS, defaultColor, isVisualItem, itemEnd, defaultCaptionStyle } from '../core/model.js';
import * as E from '../core/edit.js';
import { FILTERS, BUILTIN_LUTS, defaultCurves } from '../render/luts.js';
import { curveEditor } from './curves.js';
import { formatTime, throttle, clamp } from '../core/util.js';
import { requestFont } from '../render/text.js';
import { audioFx, EQ_BANDS, TONE_PRESETS } from '../media/audio-fx.js';
import { paidOn } from '../core/settings.js';

export class Inspector {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.tab = {};
    this.editing = false;
    root.classList.add('inspector');
    store.on('selection', () => this.render());
    store.on('change', () => {
      if (!this.editing) this.render();
    });
    store.on('project', () => this.render());
    store.on('viewer-mode', () => this.render());
    store.on('seek', throttle(() => {
      if (!this.editing && !store.playing) this.refreshKeyed();
    }, 150));
    this.render();
  }

  begin() {
    if (!this.editing) {
      this.editing = true;
      store.beginGesture();
    }
  }

  end(label) {
    if (!this.editing) return;
    this.editing = false;
    store.endGesture(label);
    this.render();
  }

  /** Commit a one-shot change as its own undo step. */
  set(label, fn) {
    store.commit(label, fn);
  }

  kfButton(it, prop) {
    const has = hasKeyframes(it, prop);
    const on = keyframeAtPlayhead(it, prop);
    const b = h('button', { class: `kfbtn ${has ? 'has' : ''} ${on ? 'on' : ''}`, type: 'button', title: on ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead' }, icon('keyframe', 12));
    b.dataset.prop = prop;
    b.addEventListener('click', () => {
      const inside = store.playhead >= it.start && store.playhead <= itemEnd(it);
      if (!inside) store.seek(it.start);
      this.set('Keyframe', () => toggleKeyframe(it, prop));
    });
    return b;
  }

  /** Slider bound to a keyframable property. */
  propSlider(it, label, prop, opts = {}) {
    const row = slider(label, {
      value: getProp(it, prop),
      ...opts,
      keyframe: opts.noKf ? null : this.kfButton(it, prop),
      onInput: (v) => {
        this.begin();
        store.mutate(() => setProp(it, prop, opts.map ? opts.map(v) : v));
      },
      onCommit: () => this.end(label),
    });
    row.dataset.prop = prop;
    row.dataset.default = opts.def ?? '';
    return row;
  }

  /** Slider bound to obj[key] (not keyframable). */
  valSlider(label, obj, key, opts = {}) {
    const row = slider(label, {
      value: obj[key] ?? opts.def ?? 0,
      ...opts,
      onInput: (v) => {
        this.begin();
        store.mutate(() => {
          obj[key] = v;
          opts.after?.(v);
        });
      },
      onCommit: () => this.end(label),
    });
    if (opts.def != null) row.dataset.default = opts.def;
    return row;
  }

  refreshKeyed() {
    const it = store.primary;
    if (!it) return;
    this.root.querySelectorAll('[data-prop]').forEach((row) => {
      if (row.classList.contains('slider-row') && row.set) row.set(getProp(it, row.dataset.prop));
    });
    this.root.querySelectorAll('.kfbtn').forEach((b) => {
      b.classList.toggle('on', keyframeAtPlayhead(it, b.dataset.prop));
      b.classList.toggle('has', hasKeyframes(it, b.dataset.prop));
    });
  }

  render() {
    const r = this.root;
    const scroll = r.scrollTop;
    clear(r);
    const items = store.selectedItems;
    if (!items.length) r.append(this.projectPanel());
    else if (items.length > 1) r.append(this.multiPanel(items));
    else r.append(this.itemPanel(items[0]));
    r.scrollTop = scroll;
  }

  // ---- nothing selected ---------------------------------------------------------

  projectPanel() {
    const p = store.project;
    const s = p.settings;
    const wrap = h('div', { class: 'insp' }, h('div', { class: 'insp-head' }, h('h3', {}, 'Project')));
    const name = textInput('Name', p.name, null, { onCommit: (v) => this.set('Rename project', () => (p.name = v || 'Untitled project')) });
    const presetVal = CANVAS_PRESETS.find((c) => c.width === s.width && c.height === s.height)?.id || 'custom';
    const presetSel = select(
      'Canvas',
      [...CANVAS_PRESETS.map((c) => [c.id, c.name]), ['custom', 'Custom size']],
      presetVal,
      (v) => {
        const c = CANVAS_PRESETS.find((x) => x.id === v);
        if (c) this.set('Canvas size', () => Object.assign(s, { width: c.width, height: c.height }));
      },
    );
    const wIn = h('input', { type: 'number', value: s.width, min: 64, max: 7680, step: 2 });
    const hIn = h('input', { type: 'number', value: s.height, min: 64, max: 7680, step: 2 });
    const applySize = () => this.set('Canvas size', () => Object.assign(s, { width: Math.round(Number(wIn.value) / 2) * 2, height: Math.round(Number(hIn.value) / 2) * 2 }));
    wIn.addEventListener('change', applySize);
    hIn.addEventListener('change', applySize);
    const fps = select('Frame rate', [24, 25, 30, 50, 60].map((f) => [f, f + ' fps']), s.fps, (v) => this.set('Frame rate', () => (s.fps = Number(v))));
    const bg = colorInput('Background', s.background, (v, done) => {
      if (done) this.set('Background', () => (s.background = v));
      else store.mutate(() => (s.background = v));
    });
    const mag = toggle('Magnetic main track', s.magnetic !== false, (v) => this.set('Main track mode', (pp) => {
      pp.settings.magnetic = v;
      E.compactMagnetic(pp);
    }), { title: 'Clips on the bottom video track stay together with no gaps' });
    const duck = this.valSlider('Music under voice', s, 'duckLevel', { min: 0, max: 1, step: 0.05, def: 0.25, format: (v) => Math.round(v * 100) + '%' });
    const type = select('Project type', [['video', 'Video'], ['audio', 'Audio only']], s.audioOnly ? 'audio' : 'video', (v) => this.app.cmd('projectType', v === 'audio'));
    if (s.audioOnly) mag.title = 'Clips on the first audio track stay together with no gaps';
    wrap.append(
      s.audioOnly
        ? section('Project', name, type, mag, h('div', { class: 'hint' }, 'The first audio track is the main one: with magnetic on, cutting a piece out closes the gap. Put music and sound effects on the tracks below it.'))
        : section('Project', name, type, presetSel, h('div', { class: 'row' }, h('label', {}, 'Size'), wIn, h('span', { class: 'unit' }, 'x'), hIn), fps, bg, mag),
      section('Audio', duck, h('div', { class: 'hint' }, 'Music clips marked "Lower under voice" drop to this level while someone speaks.')),
      section('Shortcuts', this.shortcutList()),
    );
    return wrap;
  }

  shortcutList() {
    const rows = [
      ['Space', 'Play or pause'],
      ['S or Ctrl+B', 'Split at the playhead'],
      ['Delete', 'Delete'],
      ['Shift+Delete', 'Delete and close the gap'],
      ['Ctrl+D', 'Duplicate'],
      ['Ctrl+C / Ctrl+V', 'Copy and paste'],
      ['Left / Right', 'One frame back or forward'],
      ['Up / Down', 'Previous or next cut'],
      ['I / O', 'Set in and out points'],
      ['M', 'Add a marker'],
      ['K', 'Keyframe at the playhead'],
      ['F', 'Freeze frame'],
      ['C', 'Crop on the preview'],
      ['T', 'Add text'],
      ['Ctrl+Z / Ctrl+Y', 'Undo and redo'],
      ['Ctrl+S', 'Save'],
      ['Ctrl+E', 'Export'],
      ['+ / -', 'Zoom the timeline'],
    ];
    return h('div', { class: 'keys' }, ...rows.map(([k, v]) => h('div', { class: 'key-row' }, h('kbd', {}, keyLabel(k)), h('span', {}, v))));
  }

  multiPanel(items) {
    const wrap = h('div', { class: 'insp' }, h('div', { class: 'insp-head' }, h('h3', {}, `${items.length} items selected`)));
    const clips = items.filter((i) => i.type === 'clip' && isVisualItem(store.project, i));
    const body = h('div', { class: 'stack' });
    body.append(
      button('Delete', () => this.app.cmd('delete'), { icon: 'trash' }),
      button('Duplicate', () => this.app.cmd('duplicate'), { icon: 'copy' }),
    );
    if (clips.length) {
      const f = select('Apply a look', Object.entries(FILTERS).map(([k, v]) => [k, v.name]), '', (v) =>
        this.set('Apply look', () => clips.forEach((c) => applyFilter(c, v))),
      );
      const tr = select('Transition between them', [['', 'Choose'], ['dissolve', 'Dissolve'], ['dipBlack', 'Dip to black'], ['pushLeft', 'Push left'], ['zoomIn', 'Zoom in'], ['blur', 'Blur'], ['whip', 'Whip pan']], '', (v) => {
        if (!v) return;
        this.set('Add transitions', (p) => clips.forEach((c) => {
          if (E.mainTrack(p) && Object.values(p.items).some((o) => o.trackId === c.trackId && Math.abs(itemEnd(o) - c.start) < 0.02)) c.transitionIn = { type: v, duration: 0.5 };
        }));
      });
      body.append(f, tr, button('Sync cuts to the beat of the music', () => this.app.cmd('beatSync'), { icon: 'music' }));
      if (clips.length === 2) body.append(button('Split screen', () => this.app.cmd('splitScreen'), { icon: 'grid' }), button('Before and after', async () => (await import('./templates.js')).BUILTIN_TEMPLATES.find((t) => t.name === 'Before and after').apply(this.app), { icon: 'mask' }), button('Line up the faces', () => this.app.cmd('alignFaces'), { icon: 'align', title: 'Moves and scales the after shot so the faces match' }));
      const withSound = clips.filter((c) => store.project.media[c.mediaId]?.kind === 'video' && store.project.media[c.mediaId]?.hasAudio);
      if (withSound.length >= 2) body.append(button('Sync angles by sound', () => this.app.cmd('syncAngles'), { icon: 'cameras', title: 'Lines up clips of the same moment filmed on different cameras' }));
    }
    wrap.append(section('Selection', body));
    return wrap;
  }

  // ---- single item ---------------------------------------------------------------

  itemPanel(it) {
    const p = store.project;
    const m = it.mediaId ? p.media[it.mediaId] : null;
    const visual = isVisualItem(p, it);
    const wrap = h('div', { class: 'insp' });
    const nameIn = h('input', { type: 'text', class: 'insp-name', value: it.name || '' });
    nameIn.addEventListener('change', () => this.set('Rename', () => (it.name = nameIn.value)));
    const typeLabel = it.type === 'clip' ? (m?.kind === 'image' ? 'Photo' : visual ? 'Video' : 'Audio') : { text: it.caption ? 'Caption' : 'Text', shape: 'Shape', blur: 'Blur region', adjust: 'Adjustment layer', solid: 'Colour', fx: 'Overlay' }[it.type];
    wrap.append(h('div', { class: 'insp-head' }, h('span', { class: 'type-chip' }, typeLabel), nameIn), h('div', { class: 'insp-time' }, `${formatTime(it.start)} to ${formatTime(itemEnd(it))} (${it.duration.toFixed(2)}s)`));

    let list;
    if (it.type === 'clip' && visual) {
      list = [['basic', 'Video'], ['color', 'Colour'], ['speed', 'Speed'], ['anim', 'Animation'], ['mask', 'Mask'], ['fx', 'Effects']];
      if (m?.hasAudio) list.push(['audio', 'Audio']);
      list.push(['ai', 'Smart tools']);
    } else if (it.type === 'clip') list = [['audio', 'Audio'], ['speed', 'Speed'], ['ai', 'Smart tools']];
    else if (it.type === 'text') list = [['text', 'Text'], ['basic', 'Position'], ['anim', 'Animation'], ['fx', 'Effects']];
    else if (it.type === 'shape') list = [['shape', 'Shape'], ['basic', 'Position'], ['anim', 'Animation']];
    else if (it.type === 'blur') list = [['blur', 'Region'], ['anim', 'Animation']];
    else if (it.type === 'adjust') list = [['color', 'Colour'], ['fx', 'Effects'], ['anim', 'Animation']];
    else if (it.type === 'solid') list = [['solid', 'Colour'], ['basic', 'Position'], ['anim', 'Animation'], ['mask', 'Mask']];
    else if (it.type === 'fx') list = [['overlay', 'Overlay'], ['anim', 'Animation']];
    else list = [['basic', 'Position']];
    let tab = this.tab[it.type + (visual ? 'v' : 'a')] || list[0][0];
    if (!list.some(([id]) => id === tab)) tab = list[0][0];
    wrap.append(
      tabs(list, tab, (id) => {
        this.tab[it.type + (visual ? 'v' : 'a')] = id;
        this.render();
      }),
    );
    const body = h('div', { class: 'insp-body' });
    const fn = {
      basic: () => this.basicTab(it, m),
      color: () => this.colorTab(it),
      speed: () => this.speedTab(it, m),
      anim: () => this.animTab(it),
      mask: () => this.maskTab(it),
      fx: () => this.fxTab(it),
      audio: () => this.audioTab(it, m),
      ai: () => this.aiTab(it, m, visual),
      text: () => this.textTab(it),
      shape: () => this.shapeTab(it),
      blur: () => this.blurTab(it),
      solid: () => this.solidTab(it),
      overlay: () => this.overlayTab(it),
    }[tab];
    body.append(fn());
    wrap.append(body);
    return wrap;
  }

  /** Opens a tab for the selected item, like the Mask tab when drawing a freehand mask. */
  setTab(id) {
    const it = store.primary;
    if (!it) return;
    this.tab[it.type + (isVisualItem(store.project, it) ? 'v' : 'a')] = id;
    this.render();
  }

  basicTab(it, m) {
    const p = store.project;
    const out = h('div', {});
    const tr = section(
      'Transform',
      this.propSlider(it, 'Scale', 'scale', { min: 0.05, max: 5, step: 0.01, def: 1, format: (v) => Math.round(v * 100) + '%' }),
      this.propSlider(it, 'Position X', 'x', { min: -p.settings.width, max: p.settings.width, step: 1, def: 0 }),
      this.propSlider(it, 'Position Y', 'y', { min: -p.settings.height, max: p.settings.height, step: 1, def: 0 }),
      this.propSlider(it, 'Rotation', 'rotation', { min: -180, max: 180, step: 0.5, def: 0, unit: 'deg' }),
      this.propSlider(it, 'Opacity', 'opacity', { min: 0, max: 1, step: 0.01, def: 1, format: (v) => Math.round(v * 100) + '%' }),
      h(
        'div',
        { class: 'btn-row' },
        button('Centre', () => this.set('Centre', () => {
          setProp(it, 'x', 0);
          setProp(it, 'y', 0);
        })),
        button('Reset', () => this.set('Reset transform', () => {
          for (const k of ['x', 'y', 'rotation']) {
            delete it.kf[k];
            it.props[k] = 0;
          }
          delete it.kf.scale;
          delete it.kf.opacity;
          it.props.scale = 1;
          it.props.opacity = 1;
        })),
        it.type === 'clip' ? button('Fill frame', () => this.set('Fill frame', () => (it.fit = 'cover'))) : null,
        it.type === 'clip' ? button('Fit inside', () => this.set('Fit inside', () => (it.fit = 'contain'))) : null,
      ),
    );
    out.append(tr);
    if (it.type === 'clip' || it.type === 'solid') {
      out.append(
        section(
          'Crop and flip',
          this.propSlider(it, 'Crop left', 'cropL', { min: 0, max: 0.9, step: 0.005, def: 0 }),
          this.propSlider(it, 'Crop right', 'cropR', { min: 0, max: 0.9, step: 0.005, def: 0 }),
          this.propSlider(it, 'Crop top', 'cropT', { min: 0, max: 0.9, step: 0.005, def: 0 }),
          this.propSlider(it, 'Crop bottom', 'cropB', { min: 0, max: 0.9, step: 0.005, def: 0 }),
          h(
            'div',
            { class: 'btn-row' },
            button('Crop on preview', () => this.app.cmd('crop'), { icon: 'crop' }),
            button('Flip left-right', () => this.set('Flip', () => (it.flipX = !it.flipX))),
            button('Flip upside down', () => this.set('Flip', () => (it.flipY = !it.flipY))),
          ),
        ),
      );
    }
    out.append(
      section(
        'Blend',
        select(
          'Mode',
          [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['softlight', 'Soft light'], ['add', 'Add'], ['darken', 'Darken'], ['lighten', 'Lighten']],
          it.blend,
          (v) => this.set('Blend mode', () => (it.blend = v)),
        ),
      ),
    );
    if (it.type === 'clip' && m) {
      out.append(
        section(
          'Picture in picture',
          h('div', { class: 'btn-row wrap' }, button('Top left', () => this.app.cmd('pip', 'tl')), button('Top right', () => this.app.cmd('pip', 'tr')), button('Bottom left', () => this.app.cmd('pip', 'bl')), button('Bottom right', () => this.app.cmd('pip', 'br'))),
          h('div', { class: 'hint' }, 'Shrinks the clip into a corner with rounded edges and moves it above the main track.'),
        ),
      );
      out.append(this.zoomPresets(it));
    }
    if (it.type === 'text' || it.type === 'shape') {
      out.append(section('Follow', button('Follow what is under it in the video', () => this.app.cmd('trackRegion', it), { icon: 'blur' }), h('div', { class: 'hint' }, 'Place it over something in the video at the playhead, then press the button. It moves with that thing through the clip, like a label that follows a product.')));
    }
    return out;
  }

  zoomPresets(it) {
    const add = (label, from, to) =>
      button(label, () =>
        this.set(label, () => {
          it.kf.scale = [
            { t: 0, v: from, e: 'easeInOut' },
            { t: it.duration, v: to, e: 'easeInOut' },
          ];
        }),
      );
    return section(
      'Quick zoom',
      h('div', { class: 'btn-row wrap' }, add('Slow zoom in', 1, 1.15), add('Slow zoom out', 1.15, 1), add('Punch in', 1, 1.35), button('Zoom to a spot', () => this.app.cmd('zoomToSpot', it)), button('Remove zoom', () => this.set('Remove zoom', () => delete it.kf.scale))),
      h('div', { class: 'hint' }, 'Zoom to a spot adds a smooth zoom toward the point you click on the preview, for showing detail in a screen recording or a procedure.'),
    );
  }

  colorTab(it) {
    const c = (it.color ||= defaultColor());
    const out = h('div', {});
    const filterGrid = h('div', { class: 'chips' });
    for (const [k, f] of Object.entries(FILTERS)) {
      filterGrid.append(h('button', { class: 'chip' + ((c.filter || 'none') === k ? ' active' : ''), type: 'button', onclick: () => this.set('Look', () => applyFilter(it, k)) }, f.name));
    }
    out.append(
      section(
        'Looks',
        filterGrid,
        c.lut ? this.valSlider('Look strength', c, 'lutIntensity', { min: 0, max: 1, step: 0.01, def: 1, format: (v) => Math.round(v * 100) + '%' }) : null,
        h(
          'div',
          { class: 'btn-row' },
          button('Import LUT (.cube)', () => this.app.cmd('importLut', it), { icon: 'folder' }),
          this.userLutSelect(it),
        ),
      ),
    );
    const s = (label, key, min = -1, max = 1, step = 0.01) => this.valSlider(label, c, key, { min, max, step, def: 0 });
    out.append(
      section('Light', s('Exposure', 'exposure', -2, 2), s('Contrast', 'contrast'), s('Highlights', 'highlights'), s('Shadows', 'shadows'), s('Whites', 'whites'), s('Blacks', 'blacks')),
      section('Colour', s('Temperature', 'temperature'), s('Tint', 'tint'), s('Saturation', 'saturation'), s('Vibrance', 'vibrance'), s('Hue', 'hue')),
      section('Finish', s('Sharpen', 'sharpen', 0, 1), s('Fade', 'fade', 0, 1), s('Vignette', 'vignette', -1, 1), s('Grain', 'grain', 0, 1)),
      section(
        'Curves',
        curveEditor(
          c.curves || defaultCurves(),
          (d) => {
            this.begin();
            store.mutate(() => (c.curves = JSON.parse(JSON.stringify(d))));
          },
          () => this.end('Curves'),
        ),
      ),
      h('div', { class: 'btn-row' }, button('Reset colour', () => this.set('Reset colour', () => (it.color = defaultColor()))), button('Copy to all clips', () => this.app.cmd('colorToAll', it))),
    );
    return out;
  }

  userLutSelect(it) {
    const luts = store.settings.userLuts || [];
    if (!luts.length) return null;
    return select(null, [['', 'Saved LUTs'], ...luts.map((l) => [l.path, l.name])], '', (v) => {
      if (v) this.app.cmd('applyLut', it, v);
    });
  }

  speedTab(it, m) {
    const out = h('div', {});
    if (it.freeze) {
      out.append(section('Freeze frame', h('p', { class: 'hint' }, 'This clip holds a single frame.'), this.durationRow(it)));
      return out;
    }
    const sp = slider('Speed', {
      value: it.speed || 1,
      min: 0.1,
      max: 10,
      step: 0.05,
      format: (v) => Number(v).toFixed(2) + 'x',
      onInput: (v) => {
        this.begin();
        store.mutate((pp) => E.setSpeed(pp, it, v));
      },
      onCommit: () => this.end('Speed'),
    });
    sp.dataset.default = 1;
    const presets = h('div', { class: 'chips' });
    for (const v of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4]) presets.append(h('button', { class: 'chip' + (it.speed === v && !it.speedCurve ? ' active' : ''), type: 'button', onclick: () => this.set('Speed', (pp) => E.setSpeed(pp, it, v)) }, v + 'x'));
    const fxNow = audioFx(it);
    out.append(
      section(
        'Constant speed',
        sp,
        presets,
        m?.hasAudio ? toggle('Keep the voice pitch', fxNow.keepPitch, (v) => this.set('Keep pitch', () => ((it.audioFx ||= {}).keepPitch = v)), { title: 'Off makes sped up voices high and slowed voices low, like a tape' }) : null,
      ),
    );
    const ramps = h('div', { class: 'chips' });
    const names = { montage: 'Montage', hero: 'Hero moment', bullet: 'Bullet time', flashIn: 'Flash in', flashOut: 'Flash out', jumpCut: 'Jump cut' };
    ramps.append(h('button', { class: 'chip' + (!it.speedCurve ? ' active' : ''), type: 'button', onclick: () => this.set('Speed ramp', (pp) => E.setSpeedCurve(pp, it, null)) }, 'None'));
    for (const [k, curve] of Object.entries(SPEED_RAMPS)) ramps.append(h('button', { class: 'chip' + (JSON.stringify(it.speedCurve) === JSON.stringify(curve) ? ' active' : ''), type: 'button', onclick: () => this.set('Speed ramp', (pp) => E.setSpeedCurve(pp, it, curve)) }, names[k]));
    out.append(section('Speed ramp', ramps, it.speedCurve ? this.rampEditor(it) : null, h('div', { class: 'hint' }, 'Ramps speed up and slow down inside one clip, the usual way to make a product reveal feel cinematic. The sound speeds up and slows down with the picture.')));
    if (m && m.kind === 'video') {
      out.append(
        section(
          'More',
          h(
            'div',
            { class: 'btn-row wrap' },
            button('Freeze frame here', () => this.app.cmd('freeze'), { icon: 'freeze' }),
            button(it.origMediaId && it.derivations?.includes('reverse') ? 'Undo reverse' : 'Reverse clip', () => this.app.cmd('reverse', it), { icon: 'reverse' }),
            button('Smooth slow motion', () => this.app.cmd('smoothSlowmo', it), { icon: 'sparkles' }),
          ),
          h('div', { class: 'hint' }, 'Smooth slow motion creates in-between frames, so 0.25x looks fluid instead of choppy. It takes a while on long clips.'),
        ),
      );
    }
    return out;
  }

  durationRow(it) {
    const inp = h('input', { type: 'number', min: 0.1, step: 0.1, value: it.duration.toFixed(2) });
    inp.addEventListener('change', () => this.set('Duration', (p) => {
      E.trimTailTo(p, it, it.start + Math.max(0.1, Number(inp.value)));
      E.compactMagnetic(p);
    }));
    return h('div', { class: 'row' }, h('label', {}, 'Duration (s)'), inp);
  }

  rampEditor(it) {
    const size = { w: 260, h: 90 };
    const cv = h('canvas', { width: size.w * 2, height: size.h * 2, class: 'ramp-canvas', style: { width: size.w + 'px', height: size.h + 'px' } });
    const ctx = cv.getContext('2d');
    const maxY = 5;
    const draw = () => {
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      ctx.fillStyle = '#16181c';
      ctx.fillRect(0, 0, size.w, size.h);
      const yOf = (v) => size.h - (Math.log(v / 0.1) / Math.log(maxY / 0.1)) * size.h;
      ctx.strokeStyle = '#333';
      ctx.beginPath();
      ctx.moveTo(0, yOf(1));
      ctx.lineTo(size.w, yOf(1));
      ctx.stroke();
      ctx.strokeStyle = '#c9a45c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      it.speedCurve.forEach((pt, i) => (i ? ctx.lineTo(pt.x * size.w, yOf(pt.y)) : ctx.moveTo(pt.x * size.w, yOf(pt.y))));
      ctx.stroke();
      ctx.fillStyle = '#e8c16a';
      for (const pt of it.speedCurve) {
        ctx.beginPath();
        ctx.arc(pt.x * size.w, yOf(pt.y), 4, 0, 7);
        ctx.fill();
      }
    };
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect();
      const toPt = (ev) => ({ x: clamp((ev.clientX - r.left) / r.width, 0, 1), y: clamp(0.1 * Math.pow(maxY / 0.1, 1 - (ev.clientY - r.top) / r.height), 0.1, maxY) });
      const p0 = toPt(e);
      let idx = it.speedCurve.findIndex((q) => Math.abs(q.x - p0.x) < 0.04);
      this.begin();
      if (idx < 0) {
        store.mutate(() => {
          it.speedCurve.push(p0);
          it.speedCurve.sort((a, b) => a.x - b.x);
        });
        idx = it.speedCurve.indexOf(p0);
      }
      cv.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const q = toPt(ev);
        store.mutate((pp) => {
          const c = it.speedCurve;
          const lo = idx > 0 ? c[idx - 1].x + 0.02 : 0;
          const hi = idx < c.length - 1 ? c[idx + 1].x - 0.02 : 1;
          c[idx] = { x: idx === 0 ? 0 : idx === c.length - 1 ? 1 : clamp(q.x, lo, hi), y: Math.round(q.y * 100) / 100 };
          it.duration = Math.min(it.duration, (pp.media[it.mediaId]?.duration - it.in) / Math.max(0.05, integ(c)));
        });
        draw();
      };
      const up = () => {
        cv.removeEventListener('pointermove', move);
        cv.removeEventListener('pointerup', up);
        this.end('Edit speed ramp');
      };
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
    });
    draw();
    return h('div', { class: 'ramp' }, cv, h('div', { class: 'hint' }, 'Drag points to change the speed. Click to add a point.'));
  }

  animTab(it) {
    const a = (it.anim ||= { in: null, out: null, loop: null });
    const grp = (title, key, dict) => {
      const cur = a[key];
      const chips = h('div', { class: 'chips' });
      chips.append(h('button', { class: 'chip' + (!cur ? ' active' : ''), type: 'button', onclick: () => this.set('Animation', () => (a[key] = null)) }, 'None'));
      for (const [k, label] of Object.entries(dict))
        chips.append(
          h(
            'button',
            {
              class: 'chip' + (cur?.type === k ? ' active' : ''),
              type: 'button',
              onclick: () => this.set('Animation', () => (a[key] = key === 'loop' ? { type: k, period: 2, amount: 1 } : { type: k, duration: Math.min(0.6, it.duration / 3) })),
            },
            label,
          ),
        );
      const extra = [];
      if (cur && key !== 'loop') extra.push(this.valSlider('Length', cur, 'duration', { min: 0.1, max: Math.max(0.2, it.duration / 2), step: 0.05, unit: 's' }));
      if (cur && key === 'loop') extra.push(this.valSlider('Speed', cur, 'period', { min: 0.3, max: 8, step: 0.1, unit: 's per cycle' }), this.valSlider('Amount', cur, 'amount', { min: 0.1, max: 3, step: 0.1 }));
      return section(title, chips, ...extra);
    };
    return h('div', {}, grp('In', 'in', ANIMATIONS_IN), grp('Out', 'out', ANIMATIONS_OUT), grp('Loop', 'loop', ANIMATIONS_LOOP));
  }

  maskTab(it) {
    const mk = it.mask;
    const out = h('div', {});
    const types = h('div', { class: 'chips' });
    for (const [k, label] of [
      ['none', 'None'],
      ['rect', 'Rectangle'],
      ['ellipse', 'Circle'],
      ['wipe', 'Split line'],
      ['path', 'Freehand'],
    ])
      types.append(h('button', { class: 'chip' + (mk.type === k ? ' active' : ''), type: 'button', onclick: () => {
        this.set('Mask', () => (mk.type = k));
        if (k === 'path' && !(mk.points?.length >= 3)) this.app.viewer.setMode('pen');
      } }, label));
    out.append(section('Shape', types));
    if (mk.type === 'path') {
      const n = mk.points?.length || 0;
      out.append(
        section(
          'Freehand mask',
          h('p', { class: 'hint' }, n < 3 ? 'Click around the area on the preview to outline it.' : `${n} points. The area inside stays visible.`),
          h(
            'div',
            { class: 'btn-row wrap' },
            button('Draw on the preview', () => this.app.viewer.setMode('pen'), { icon: 'pen' }),
            n ? button('Clear the points', () => this.set('Clear mask', () => {
              mk.points = [];
              delete it.kf.maskDX;
              delete it.kf.maskDY;
            }), { kind: 'link' }) : null,
          ),
          toggle('Smooth curve', !!mk.smooth, (v) => this.set('Smooth mask', () => (mk.smooth = v))),
          this.valSlider('Feather', mk, 'feather', { min: 0, max: 0.15, step: 0.002, def: 0.02 }),
          toggle('Invert', mk.invert, (v) => this.set('Invert mask', () => (mk.invert = v))),
          n >= 3 && store.project.media[it.mediaId]?.kind === 'video' ? button('Follow the movement', () => this.app.cmd('trackMask', it), { icon: 'person', title: 'Moves the mask with what it outlines through the clip' }) : null,
          it.kf?.maskDX ? button('Stop following', () => this.set('Stop following', () => {
            delete it.kf.maskDX;
            delete it.kf.maskDY;
          }), { kind: 'link' }) : null,
        ),
      );
    }
    if (mk.type === 'rect' || mk.type === 'ellipse') {
      out.append(
        section(
          'Size and position',
          this.valSlider('Centre X', mk, 'x', { min: 0, max: 1, step: 0.005, def: 0.5 }),
          this.valSlider('Centre Y', mk, 'y', { min: 0, max: 1, step: 0.005, def: 0.5 }),
          this.valSlider('Width', mk, 'w', { min: 0.02, max: 1.5, step: 0.005, def: 0.6 }),
          this.valSlider('Height', mk, 'h', { min: 0.02, max: 1.5, step: 0.005, def: 0.6 }),
          mk.type === 'rect' ? this.valSlider('Round corners', mk, 'radius', { min: 0, max: 0.5, step: 0.005, def: 0 }) : null,
          this.valSlider('Angle', mk, 'angle', { min: -180, max: 180, step: 1, def: 0, unit: 'deg' }),
          this.valSlider('Feather', mk, 'feather', { min: 0.0005, max: 0.3, step: 0.0005, def: 0.02 }),
          toggle('Invert', mk.invert, (v) => this.set('Invert mask', () => (mk.invert = v))),
        ),
      );
    }
    if (mk.type === 'wipe') {
      out.append(
        section(
          'Split line',
          this.propSlider(it, 'Position', 'maskPos', { min: 0, max: 1, step: 0.005, def: 0.5, format: (v) => Math.round(v * 100) + '%' }),
          this.valSlider('Angle', mk, 'angle', { min: -180, max: 180, step: 1, def: 0, unit: 'deg' }),
          this.valSlider('Feather', mk, 'feather', { min: 0.0005, max: 0.2, step: 0.0005, def: 0.002 }),
          toggle('Show the dividing line', mk.line !== false, (v) => this.set('Line', () => (mk.line = v))),
          colorInput('Line colour', mk.lineColor, (v, done) => (done ? this.set('Line colour', () => (mk.lineColor = v)) : store.mutate(() => (mk.lineColor = v)))),
          this.valSlider('Line width', mk, 'lineWidth', { min: 0, max: 20, step: 1, def: 4 }),
          toggle('Invert', mk.invert, (v) => this.set('Invert mask', () => (mk.invert = v))),
          button('Animate a before/after sweep', () => this.set('Before and after sweep', () => {
            it.kf.maskPos = [
              { t: 0, v: 1, e: 'easeInOut' },
              { t: Math.min(it.duration, 1.5), v: 0.5, e: 'easeInOut' },
              { t: Math.max(0, it.duration - 1.2), v: 0.5, e: 'easeInOut' },
              { t: it.duration, v: 0, e: 'easeInOut' },
            ];
          })),
        ),
      );
    }
    return out;
  }

  fxTab(it) {
    const fx = it.effects;
    const out = h('div', {});
    if (it.type === 'clip') {
      const ch = fx.chroma;
      out.append(
        section(
          'Green screen',
          toggle('Remove a colour', ch.enabled, (v) => this.set('Green screen', () => (ch.enabled = v))),
          ch.enabled ? colorInput('Colour to remove', ch.color, (v, done) => (done ? this.set('Key colour', () => (ch.color = v)) : store.mutate(() => (ch.color = v)))) : null,
          ch.enabled ? this.valSlider('Strength', ch, 'similarity', { min: 0, max: 1, step: 0.01, def: 0.35 }) : null,
          ch.enabled ? this.valSlider('Edge softness', ch, 'smoothness', { min: 0, max: 0.5, step: 0.01, def: 0.08 }) : null,
          ch.enabled ? this.valSlider('Spill removal', ch, 'spill', { min: 0, max: 1, step: 0.01, def: 0.3 }) : null,
        ),
      );
    }
    out.append(
      section(
        'Effects',
        this.propSlider(it, 'Blur', 'blur', { min: 0, max: 1, step: 0.01, def: 0 }),
        it.type !== 'adjust' ? this.valSlider('Glow', fx, 'glow', { min: 0, max: 1, step: 0.01, def: 0 }) : null,
        it.type !== 'adjust' ? this.valSlider('Colour split', fx, 'chromatic', { min: 0, max: 1, step: 0.01, def: 0 }) : null,
        it.type !== 'adjust' ? this.valSlider('Pixelate', fx, 'pixelate', { min: 0, max: 1, step: 0.01, def: 0 }) : null,
        this.valSlider('Cinema bars', fx, 'letterbox', { min: 0, max: 0.5, step: 0.005, def: 0 }),
        it.type === 'clip' ? toggle('Mirror', fx.mirror, (v) => this.set('Mirror', () => (fx.mirror = v))) : null,
      ),
    );
    return out;
  }

  overlayTab(it) {
    const f = it.fx;
    const out = h('div', {});
    const kinds = select('Kind', [['dust', 'Floating dust'], ['sparkle', 'Sparkles'], ['bokeh', 'Bokeh'], ['leak', 'Light leak'], ['flare', 'Lens flare']], f.kind, (v) => this.set('Overlay kind', () => (f.kind = v)));
    const flare = f.kind === 'flare';
    out.append(
      section(
        'Overlay',
        kinds,
        colorInput('Colour', f.color, (v, done) => (done ? this.set('Overlay colour', () => (f.color = v)) : store.mutate(() => (f.color = v)))),
        this.valSlider(f.kind === 'leak' || flare ? 'Strength' : 'Amount', f, 'density', { min: 0.02, max: 1, step: 0.01, def: 0.5, format: (v) => Math.round(v * 100) + '%' }),
        this.valSlider('Size', f, 'size', { min: 2, max: flare || f.kind === 'leak' ? 300 : 120, step: 1, def: 12 }),
        this.valSlider('Speed', f, 'speed', { min: 0, max: 3, step: 0.01, def: 0.5 }),
        f.kind !== 'leak' && !flare ? this.valSlider('Direction', f, 'angle', { min: -180, max: 180, step: 1, def: -90, unit: 'deg' }) : null,
        f.kind !== 'leak' && !flare ? this.valSlider('Colour variety', f, 'variety', { min: 0, max: 1, step: 0.01, def: 0 }) : null,
        this.propSlider(it, 'Opacity', 'opacity', { min: 0, max: 1, step: 0.01, def: 1, format: (v) => Math.round(v * 100) + '%' }),
        flare ? this.propSlider(it, 'Position X', 'x', { min: -store.project.settings.width / 2, max: store.project.settings.width / 2, step: 1, def: 0 }) : null,
        flare ? this.propSlider(it, 'Position Y', 'y', { min: -store.project.settings.height / 2, max: store.project.settings.height / 2, step: 1, def: 0 }) : null,
        select('Blend', [['screen', 'Screen (light)'], ['add', 'Add (brighter)'], ['normal', 'Normal'], ['overlay', 'Overlay'], ['softlight', 'Soft light']], it.blend || 'screen', (v) => this.set('Blend', () => (it.blend = v))),
        button('Shuffle', () => this.set('Shuffle overlay', () => (f.seed = Math.round(Math.random() * 1000) / 10)), { kind: 'link', title: 'Places the particles differently' }),
        flare ? h('div', { class: 'hint' }, 'Drag the flare on the preview to move it. Keyframe Position X to sweep it across a product.') : null,
      ),
    );
    return out;
  }

  pitchToneSection(it) {
    const fx = audioFx(it);
    const pitch = slider('Pitch', {
      value: fx.pitch,
      min: -12,
      max: 12,
      step: 0.5,
      format: (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1),
      onInput: (v) => {
        this.begin();
        store.mutate(() => ((it.audioFx ||= {}).pitch = v));
      },
      onCommit: (v) => {
        this.end('Pitch');
        if (v) this.app.cmd('preparePitch', it);
      },
    });
    pitch.dataset.default = 0;
    const tones = h('div', { class: 'chips' });
    for (const [k, t] of Object.entries(TONE_PRESETS))
      tones.append(h('button', { class: 'chip' + (fx.tone === k ? ' active' : ''), type: 'button', onclick: () => this.set('Tone', () => Object.assign((it.audioFx ||= {}), { tone: k, eq: { ...t.eq } })) }, t.name));
    const bands = EQ_BANDS.map((b) =>
      slider(b.label, {
        value: fx.eq[b.key],
        min: -18,
        max: 18,
        step: 0.5,
        format: (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' dB',
        onInput: (v) => {
          this.begin();
          store.mutate(() => {
            const a = (it.audioFx ||= {});
            a.eq = { ...fx.eq, ...(a.eq || {}), [b.key]: v };
            a.tone = 'custom';
          });
        },
        onCommit: () => this.end('Tone'),
      }),
    );
    bands.forEach((r) => (r.dataset.default = 0));
    return section('Pitch and tone', pitch, h('div', { class: 'hint' }, 'Semitones. +12 is one octave higher.'), tones, ...bands);
  }

  trackVolumeSlider(it) {
    const tr = store.project.tracks.find((t) => t.id === it.trackId);
    if (!tr) return null;
    const row = this.valSlider('Whole track', tr, 'volume', { min: 0, max: 2, step: 0.01, def: 1, format: (v) => Math.round(v * 100) + '%' });
    row.title = `Volume of every clip on ${tr.name}`;
    return row;
  }

  audioTab(it, m) {
    const out = h('div', {});
    out.append(
      section(
        'Volume',
        this.propSlider(it, 'Volume', 'volume', { min: 0, max: 3, step: 0.01, def: 1, format: (v) => Math.round(v * 100) + '%' }),
        this.valSlider('Fade in', it, 'fadeIn', { min: 0, max: Math.min(10, it.duration / 2), step: 0.05, def: 0, unit: 's' }),
        this.valSlider('Fade out', it, 'fadeOut', { min: 0, max: Math.min(10, it.duration / 2), step: 0.05, def: 0, unit: 's' }),
        this.valSlider('Left / right', it, 'pan', { min: -1, max: 1, step: 0.05, def: 0, format: (v) => (Math.abs(v) < 0.025 ? 'Centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`) }),
        toggle('Mute this clip', it.muted, (v) => this.set('Mute', () => (it.muted = v))),
        toggle('Lower under voice (music)', it.duck, (v) => this.set('Ducking', () => (it.duck = v)), { title: 'This clip drops in volume whenever another clip has speech' }),
      ),
      this.pitchToneSection(it),
      section(
        'Layers',
        this.trackVolumeSlider(it),
        h(
          'div',
          { class: 'btn-row wrap' },
          button('Lower other sounds here', () => this.app.cmd('duckOthers', it), { icon: 'volume', title: 'Dips every other sound while this clip plays and brings it back after' }),
          it.kf?.volume ? button('Clear volume points', () => this.set('Clear volume points', () => delete it.kf.volume), { kind: 'link' }) : null,
        ),
        h('div', { class: 'hint' }, 'The yellow line on the clip is its volume. Drag it up or down, click it to add a point, and double-click a point to remove it.'),
      ),
      section(
        'Clean up',
        h(
          'div',
          { class: 'btn-row wrap' },
          button(it.derivations?.includes('denoise') ? 'Noise removed' : 'Remove background noise', () => this.app.cmd('denoise', it), { icon: 'wand', disabled: it.derivations?.includes('denoise') }),
          button('Even out loudness', () => this.app.cmd('normalizeClip', it), { icon: 'audioWave' }),
          button(it.derivations?.includes('comp') ? 'Voice levelled' : 'Level out the voice', () => this.app.cmd('compressClip', it), { icon: 'volume', disabled: it.derivations?.includes('comp'), title: 'Brings quiet words up and loud ones down so the voice stays at one level' }),
          isVisualItem(store.project, it) ? button('Separate audio', () => this.app.cmd('detachAudio'), { icon: 'detach' }) : null,
        ),
      ),
      section(
        'Voice effects',
        h('div', { class: 'chips' }, ...[['deeper', 'Deeper'], ['higher', 'Higher'], ['echo', 'Echo'], ['radio', 'Radio'], ['robot', 'Robot']].map(([k, l]) => h('button', { class: 'chip' + (it.derivations?.includes('fx-' + k) ? ' active' : ''), type: 'button', onclick: () => this.app.cmd('voiceEffect', it, k) }, l))),
        it.derivations?.some((d) => d.startsWith('fx-')) ? button('Remove the effect', () => this.app.cmd('revertMedia', it), { kind: 'link' }) : null,
      ),
      section(
        'For speech',
        h(
          'div',
          { class: 'btn-row wrap' },
          store.project.settings.audioOnly ? null : button('Auto captions', () => this.app.cmd('captions', it), { icon: 'captions' }),
          button('Cut out silences', () => this.app.cmd('silenceCut', it), { icon: 'split' }),
          button('Remove filler words', () => this.app.cmd('fillerCut', it), { icon: 'wand' }),
        ),
      ),
      !isVisualItem(store.project, it) ? section('For music', button('Mark the beats', () => this.app.cmd('beats', it), { icon: 'music' }), h('div', { class: 'hint' }, 'Adds markers on the beat. Select several clips and use "Sync cuts to the beat" to cut them to the music.')) : null,
    );
    return out;
  }

  aiTab(it, m, visual) {
    const out = h('div', {});
    if (visual && m?.kind !== 'audio') {
      const bgDone = it.derivations?.includes('bg');
      out.append(
        section(
          'Background',
          h('div', { class: 'btn-row wrap' }, button(bgDone ? 'Put the background back' : 'Remove background', () => this.app.cmd('removeBackground', it), { icon: 'person' }), button('Green screen', () => {
            this.tab[it.type + 'v'] = 'fx';
            this.set('Green screen', () => (it.effects.chroma.enabled = true));
          })),
          h('div', { class: 'hint' }, 'Remove background cuts out a person or product in every frame. It runs on this computer and takes about as long as the clip, longer for the product model.'),
        ),
      );
      if (m?.kind === 'image') {
        out.append(
          section(
            'Photo',
            h(
              'div',
              { class: 'btn-row wrap' },
              button(it.effects.depth3d ? 'Change the camera move' : 'Moving photo', () => this.app.cmd('depthShot', it), { icon: 'depth' }),
              paidOn() ? button('AI upscale 4x', () => this.app.cmd('aiUpscale', it), { icon: 'upscale', title: 'Real-ESRGAN through Replicate, billed to your token' }) : null,
            ),
            h('div', { class: 'hint' }, 'Moving photo works out the depth in the photo and moves a camera through it, so the product stands out from the background.'),
          ),
        );
      }
      if (m?.kind === 'video') {
        out.append(
          section(
            'Sharper',
            button(it.derivations?.includes('upscale') ? 'Back to the normal size' : 'Upscale to twice the size', () => this.app.cmd('upscale', it), { icon: 'upscale' }),
            h('div', { class: 'hint' }, 'Makes a bigger, sharpened copy from the original file, up to 4K. Useful for old 720p clips in a 1080p or 4K export.'),
          ),
          section(
            'Camera',
            h('div', { class: 'btn-row wrap' }, button(it.derivations?.includes('stab') ? 'Stabilised' : 'Stabilise shaky footage', () => this.app.cmd('stabilize', it), { icon: 'wand', disabled: it.derivations?.includes('stab') }), button('Auto reframe for vertical', () => this.app.cmd('autoReframe', it), { icon: 'crop' })),
            h('div', { class: 'hint' }, 'Auto reframe follows the face in a wide clip so it stays centred in a 9:16 or 4:5 frame.'),
          ),
          section(
            'Privacy',
            h('div', { class: 'btn-row wrap' }, button('Blur faces automatically', () => this.app.cmd('faceBlur', it), { icon: 'blur' }), button('Blur and follow an area', () => this.app.cmd('trackBlur', it), { icon: 'blur' })),
            h('div', { class: 'hint' }, 'Face blur finds and follows every face in the clip. Blur and follow tracks the area you draw, for tattoos, name tags or screens.'),
          ),
        );
      }
    }
    if (m?.hasAudio) {
      out.append(section('Speech', h('div', { class: 'btn-row wrap' }, button('Auto captions', () => this.app.cmd('captions', it), { icon: 'captions' }), button('Cut out silences', () => this.app.cmd('silenceCut', it), { icon: 'split' }), button('Remove filler words', () => this.app.cmd('fillerCut', it), { icon: 'wand' }))));
    }
    if (it.origMediaId) out.append(section('Original', button('Go back to the original clip', () => this.app.cmd('revertMedia', it), { icon: 'undo' })));
    return out;
  }

  textTab(it) {
    const st = it.style;
    const out = h('div', {});
    const ta = h('textarea', { rows: 3, class: 'text-edit' });
    ta.value = it.text;
    ta.addEventListener('input', () => {
      this.begin();
      store.mutate(() => {
        it.text = ta.value;
        if (it.words) it.words = null;
      });
    });
    ta.addEventListener('change', () => this.end('Edit text'));
    const fonts = this.app.fontList();
    const fontSel = select('Font', fonts.map((f) => [f, f]), st.font, (v) => {
      requestFont({ ...st, font: v });
      this.set('Font', () => (st.font = v));
    });
    const s = (label, key, opts) => this.valSlider(label, st, key, opts);
    const col = (label, key, alpha) => colorInput(label, st[key], (v, done) => (done ? this.set(label, () => (st[key] = v)) : store.mutate(() => (st[key] = v))), { alpha });
    const align = h('div', { class: 'seg' });
    for (const a of ['left', 'center', 'right']) align.append(h('button', { class: 'seg-btn' + (st.align === a ? ' active' : ''), type: 'button', onclick: () => this.set('Align', () => (st.align = a)) }, a[0].toUpperCase() + a.slice(1)));
    const weights = select('Weight', [[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']], st.weight, (v) => this.set('Weight', () => (st.weight = Number(v))));
    const reveal = select(
      'Reveal',
      [['none', 'All at once'], ['typewriter', 'Typewriter'], ['word', 'Word by word'], ...(it.words ? [['karaoke', 'Highlight each word']] : [])],
      it.reveal,
      (v) => this.set('Reveal', () => (it.reveal = v)),
    );
    out.append(
      section('Text', ta, fontSel, weights, s('Size', 'size', { min: 12, max: 400, step: 1, def: 96 }), col('Colour', 'color'), h('div', { class: 'row' }, h('label', {}, 'Align'), align), toggle('Capitals', st.uppercase, (v) => this.set('Capitals', () => (st.uppercase = v))), toggle('Italic', st.italic, (v) => this.set('Italic', () => (st.italic = v))), reveal),
      section('Spacing', s('Letter spacing', 'letterSpacing', { min: -10, max: 40, step: 0.5, def: 0 }), s('Line height', 'lineHeight', { min: 0.7, max: 2.5, step: 0.05, def: 1.15 }), s('Max width', 'maxWidth', { min: 0.2, max: 1, step: 0.01, def: 0.86, format: (v) => Math.round(v * 100) + '%' })),
      section('Outline', s('Width', 'outlineWidth', { min: 0, max: 30, step: 0.5, def: 0 }), col('Colour', 'outlineColor')),
      section('Shadow', s('Blur', 'shadowBlur', { min: 0, max: 60, step: 1, def: 12 }), s('Offset X', 'shadowX', { min: -40, max: 40, step: 1, def: 0 }), s('Offset Y', 'shadowY', { min: -40, max: 40, step: 1, def: 4 }), col('Colour', 'shadowColor', true)),
      section('Background box', toggle('Show a box behind the text', st.boxEnabled, (v) => this.set('Text box', () => (st.boxEnabled = v))), st.boxEnabled ? col('Box colour', 'boxColor', true) : null, st.boxEnabled ? s('Padding', 'boxPadding', { min: 0, max: 80, step: 1, def: 24 }) : null, st.boxEnabled ? s('Round corners', 'boxRadius', { min: 0, max: 80, step: 1, def: 16 }) : null),
    );
    if (it.words) {
      out.append(section('Word highlight', col('Highlight colour', 'highlightColor'), select('Style', [['color', 'Colour the word'], ['box', 'Box behind the word'], ['scale', 'Colour and enlarge']], st.highlightMode, (v) => this.set('Highlight style', () => (st.highlightMode = v)))));
    }
    if (it.caption) out.append(section('Captions', button('Apply this style to all captions', () => this.app.cmd('captionStyleFrom', it)), button('Edit all captions as text', () => this.app.cmd('editCaptions'))));
    out.append(section('Save', button('Save as a text style', () => this.app.cmd('saveTextStyle', it))));
    return out;
  }

  shapeTab(it) {
    const out = h('div', {});
    const col = (label, key) => colorInput(label, it[key], (v, done) => (done ? this.set(label, () => (it[key] = v)) : store.mutate(() => (it[key] = v))), { alpha: true });
    out.append(
      section(
        'Shape',
        select('Type', [['rect', 'Box'], ['ellipse', 'Circle'], ['arrow', 'Arrow'], ['line', 'Line'], ['callout', 'Label pill']], it.shape, (v) => this.set('Shape', () => (it.shape = v))),
        this.valSlider('Width', it, 'w', { min: 10, max: store.project.settings.width * 1.5, step: 1 }),
        this.valSlider('Height', it, 'h', { min: 4, max: store.project.settings.height * 1.5, step: 1 }),
        col('Fill', 'fill'),
        col('Outline', 'stroke'),
        this.valSlider('Outline width', it, 'strokeWidth', { min: 0, max: 60, step: 1 }),
        it.shape === 'rect' ? this.valSlider('Round corners', it, 'radius', { min: 0, max: 200, step: 1 }) : null,
      ),
    );
    return out;
  }

  blurTab(it) {
    const out = h('div', {});
    out.append(
      section(
        'Region',
        select('Effect', [['blur', 'Blur'], ['pixelate', 'Pixelate'], ['solid', 'Solid colour']], it.mode, (v) => this.set('Region effect', () => (it.mode = v))),
        select('Shape', [['ellipse', 'Oval'], ['rect', 'Rectangle']], it.shape, (v) => this.set('Region shape', () => (it.shape = v))),
        this.valSlider('Strength', it, 'amount', { min: 0.05, max: 1, step: 0.01, def: 0.6 }),
        this.valSlider('Soft edge', it, 'feather', { min: 0.01, max: 1, step: 0.01, def: 0.25 }),
        it.mode === 'solid' ? colorInput('Colour', it.fillColor, (v, done) => (done ? this.set('Colour', () => (it.fillColor = v)) : store.mutate(() => (it.fillColor = v)))) : null,
        this.valSlider('Width', it, 'w', { min: 10, max: store.project.settings.width * 1.5, step: 1 }),
        this.valSlider('Height', it, 'h', { min: 10, max: store.project.settings.height * 1.5, step: 1 }),
        this.propSlider(it, 'Position X', 'x', { min: -store.project.settings.width, max: store.project.settings.width, step: 1, def: 0 }),
        this.propSlider(it, 'Position Y', 'y', { min: -store.project.settings.height, max: store.project.settings.height, step: 1, def: 0 }),
      ),
      section('Follow', button('Track what is under this region', () => this.app.cmd('trackRegion', it), { icon: 'blur' }), h('div', { class: 'hint' }, 'Place the region over the area at the playhead, then track. The region follows it through the clip below.')),
    );
    return out;
  }

  solidTab(it) {
    return section(
      'Colour',
      colorInput('Colour', it.fillColor, (v, done) => (done ? this.set('Colour', () => (it.fillColor = v)) : store.mutate(() => (it.fillColor = v)))),
      toggle('Gradient', !!it.gradient, (v) => this.set('Gradient', () => (it.gradient = v ? { color2: '#000000', angle: 180 } : null))),
      it.gradient ? colorInput('Second colour', it.gradient.color2, (v, done) => (done ? this.set('Colour', () => (it.gradient.color2 = v)) : store.mutate(() => (it.gradient.color2 = v)))) : null,
      it.gradient ? this.valSlider('Angle', it.gradient, 'angle', { min: 0, max: 360, step: 1 }) : null,
    );
  }
}

function integ(c) {
  let acc = 0;
  for (let i = 0; i < c.length - 1; i++) acc += ((c[i + 1].x - c[i].x) * (c[i].y + c[i + 1].y)) / 2;
  return acc;
}

export function applyFilter(it, key) {
  const f = FILTERS[key];
  if (!f) return;
  const base = defaultColor();
  const keep = { curves: it.color?.curves || null };
  it.color = { ...base, ...keep, ...f.color, filter: key === 'none' ? null : key, lutName: f.color.lut ? BUILTIN_LUTS[f.color.lut.slice(8)]?.name : null };
}

export { defaultCaptionStyle };
