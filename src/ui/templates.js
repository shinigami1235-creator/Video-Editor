// Built-in templates (added into the current project) and user templates
// (whole projects saved for reuse).

import { store } from '../core/store.js';
import * as E from '../core/edit.js';
import { newText, newShape, newSolid, newAdjustment, defaultTextStyle, itemEnd, isVisualItem, newTrack } from '../core/model.js';
import { uid, clone } from '../core/util.js';
import { toast, promptDialog, confirmDialog } from './notify.js';
import { paths, join, writeJson, readJson, remove, mkdir } from '../backend/index.js';
import { saveSettings } from '../core/settings.js';
import { applyFilter } from './inspector.js';
import { verifyMedia } from '../media/library.js';

const T = (o) => ({ ...defaultTextStyle(), ...o });

function addText(p, t, dur, text, style, { y = 0, x = 0, anim = null, reveal = 'none', name } = {}) {
  const it = newText(null, t, text, T(style));
  it.duration = dur;
  it.props.y = y * p.settings.height;
  it.props.x = x * p.settings.width;
  it.anim = anim || { in: { type: 'fade', duration: 0.4 }, out: { type: 'fade', duration: 0.3 }, loop: null };
  it.reveal = reveal;
  it.name = name || text;
  E.placeOverlay(p, it);
  return it;
}

export const BUILTIN_TEMPLATES = [
  {
    name: 'Product reveal',
    sub: 'Title, price and call to action',
    icon: 'sparkles',
    apply(app) {
      const t = store.playhead;
      const ids = [];
      store.commit('Product reveal template', (p) => {
        ids.push(addText(p, t + 0.3, 2.6, 'New flavour', { font: 'Playfair Display', size: 120, weight: 700, shadowBlur: 22 }, { y: -0.08, anim: { in: { type: 'blurIn', duration: 0.8 }, out: { type: 'fade', duration: 0.4 }, loop: null } }).id);
        ids.push(addText(p, t + 0.9, 2.0, 'Single-origin dark chocolate', { font: 'Inter', size: 50, weight: 500 }, { y: 0.02, anim: { in: { type: 'slideUp', duration: 0.5 }, out: { type: 'fade', duration: 0.3 }, loop: null } }).id);
        ids.push(addText(p, t + 3.2, 2.2, 'P 349', { font: 'Bebas Neue', size: 170, weight: 400, shadowBlur: 24 }, { y: 0, anim: { in: { type: 'zoomOut', duration: 0.5 }, out: { type: 'fade', duration: 0.3 }, loop: null } }).id);
        ids.push(addText(p, t + 5.4, 2.6, 'Order now', { font: 'Poppins', size: 66, weight: 700, color: '#15171c', boxEnabled: true, boxColor: 'rgba(232,193,106,1)', boxPadding: 28, boxRadius: 40, shadowBlur: 0 }, { y: 0.3, anim: { in: { type: 'pop', duration: 0.45 }, out: { type: 'fade', duration: 0.3 }, loop: { type: 'pulse', period: 1.6, amount: 1 } } }).id);
        const adj = newAdjustment(null, t, 8);
        adj.name = 'Cinematic look';
        applyFilter(adj, 'chocolate');
        E.placeOverlay(p, adj);
        ids.push(adj.id);
      });
      store.select(ids);
      import('../ai/sfx.js').then((m) => m.addSfx(app, 'whoosh', t + 0.2)).catch(() => {});
      toast('Template added. Put your product shots on the main track under it and change the words.', { timeout: 4500 });
    },
  },
  {
    name: 'Before and after',
    sub: 'Split line sweep with labels',
    icon: 'mask',
    apply(app) {
      const p = store.project;
      const clips = store.selectedItems.filter((i) => i.type === 'clip' && isVisualItem(p, i)).sort((a, b) => a.start - b.start);
      if (clips.length !== 2) return toast('Select two clips first: the before clip and the after clip.', { kind: 'warn', timeout: 4000 });
      const [before, after] = clips;
      store.commit('Before and after', (pp) => {
        const dur = Math.min(before.duration, after.duration, 8);
        // the after clip goes on a track above, starting with the before clip
        let above = null;
        const vt = pp.tracks.filter((t) => t.kind === 'video');
        const idx = vt.findIndex((t) => t.id === before.trackId);
        for (let i = idx - 1; i >= 0; i--) if (E.isFree(pp, vt[i].id, before.start, before.start + dur, new Set([after.id]))) {
          above = vt[i];
          break;
        }
        if (!above) {
          above = newTrack('video', `Video ${vt.length + 1}`);
          pp.tracks.splice(pp.tracks.indexOf(vt[idx]), 0, above);
        }
        after.trackId = above.id;
        after.start = before.start;
        after.duration = Math.min(after.duration, dur);
        before.duration = Math.max(before.duration, dur);
        after.mask = { ...after.mask, type: 'wipe', angle: 0, feather: 0.002, line: true, lineColor: '#ffffff', lineWidth: 5, invert: true };
        after.kf.maskPos = [
          { t: 0, v: 1, e: 'easeInOut' },
          { t: Math.min(1.4, dur * 0.3), v: 0.5, e: 'easeInOut' },
          { t: Math.max(0.2, dur - 1.4), v: 0.5, e: 'easeInOut' },
          { t: dur, v: 0, e: 'easeInOut' },
        ];
        E.compactMagnetic(pp);
        const lab = { font: 'Montserrat', size: 46, weight: 800, uppercase: true, boxEnabled: true, boxColor: 'rgba(0,0,0,0.55)', boxPadding: 16, boxRadius: 10, shadowBlur: 0 };
        addText(pp, before.start, dur, 'Before', lab, { y: -0.4, x: -0.28, name: 'Before label' });
        addText(pp, before.start, dur, 'After', lab, { y: -0.4, x: 0.28, name: 'After label' });
      });
      toast('The after clip now sweeps over the before clip. Adjust the sweep in its Mask tab.', { timeout: 4500 });
    },
  },
  {
    name: 'Lecture opener',
    sub: 'Title card and speaker name',
    icon: 'text',
    apply() {
      const t = store.playhead;
      const ids = [];
      store.commit('Lecture opener', (p) => {
        const bg = newSolid(null, t, 4, '#101318');
        bg.gradient = { color2: '#1d2430', angle: 160 };
        bg.trackId = E.mainTrack(p).id;
        p.items[bg.id] = bg;
        E.insertIntoMain(p, [bg], t);
        ids.push(bg.id);
        ids.push(addText(p, bg.start + 0.3, 3.5, 'Lecture title', { font: 'Montserrat', size: 96, weight: 800, shadowBlur: 0 }, { y: -0.04, anim: { in: { type: 'slideUp', duration: 0.6 }, out: { type: 'fade', duration: 0.4 }, loop: null } }).id);
        ids.push(addText(p, bg.start + 0.7, 3.1, 'Speaker name, credentials', { font: 'Inter', size: 44, weight: 500, color: '#e8c16a', shadowBlur: 0 }, { y: 0.05, anim: { in: { type: 'fade', duration: 0.6 }, out: { type: 'fade', duration: 0.4 }, loop: null } }).id);
        ids.push(addText(p, bg.start + 4.5, 5, 'Dr. Your Name', { font: 'Montserrat', size: 56, weight: 800, align: 'left', boxEnabled: true, boxColor: 'rgba(15,17,22,0.85)', boxPadding: 20, boxRadius: 8, shadowBlur: 0, maxWidth: 0.6 }, { y: 0.33, x: -0.2, anim: { in: { type: 'slideRight', duration: 0.5 }, out: { type: 'slideLeft', duration: 0.4 }, loop: null } }).id);
      });
      store.select(ids);
    },
  },
  {
    name: 'Procedure steps',
    sub: 'Numbered step labels and a pointer',
    icon: 'arrow',
    async apply() {
      const n = Number(await promptDialog('Procedure steps', 'How many steps?', '4'));
      if (!n || n < 1) return;
      const p = store.project;
      const base = store.selectedItems.find((i) => i.type === 'clip' && isVisualItem(p, i));
      const t0 = base ? base.start : store.playhead;
      const total = base ? base.duration : n * 4;
      const each = total / n;
      const ids = [];
      store.commit('Procedure steps', (pp) => {
        for (let i = 0; i < n; i++) {
          ids.push(addText(pp, t0 + i * each, Math.max(0.5, each - 0.1), `Step ${i + 1}: Describe it`, { font: 'Montserrat', size: 54, weight: 700, color: '#15171c', boxEnabled: true, boxColor: 'rgba(255,255,255,0.92)', boxPadding: 20, boxRadius: 12, shadowBlur: 0 }, { y: -0.36, anim: { in: { type: 'slideDown', duration: 0.4 }, out: { type: 'fade', duration: 0.3 }, loop: null } }).id);
        }
        const arrow = newShape(null, t0, 'arrow', { w: 260, h: 24, fill: '#e8c16a', stroke: '#e8c16a', strokeWidth: 12 });
        arrow.duration = Math.min(total, each);
        arrow.props.rotation = 35;
        arrow.anim = { in: { type: 'pop', duration: 0.4 }, out: null, loop: { type: 'float', period: 1.4, amount: 1.5 } };
        E.placeOverlay(pp, arrow);
        ids.push(arrow.id);
      });
      store.select(ids);
      toast('Change each step\'s words in the Text tab. Drag the arrow onto the detail you want to show.', { timeout: 4500 });
    },
  },
  {
    name: 'End card',
    sub: 'Call to action and contact line',
    icon: 'brand',
    apply() {
      const ids = [];
      store.commit('End card', (p) => {
        const main = E.mainTrack(p);
        const end = Math.max(...Object.values(p.items).filter((i) => i.trackId === main.id).map(itemEnd), 0);
        const bg = newSolid(main.id, end, 3.5, '#15171c');
        p.items[bg.id] = bg;
        E.compactMagnetic(p);
        ids.push(bg.id);
        ids.push(addText(p, bg.start + 0.2, 3.3, 'Book your visit', { font: 'Montserrat', size: 90, weight: 800 }, { y: -0.06, anim: { in: { type: 'pop', duration: 0.5 }, out: null, loop: null } }).id);
        ids.push(addText(p, bg.start + 0.5, 3.0, 'Message us on Facebook or call 0917 000 0000', { font: 'Inter', size: 40, weight: 500, color: '#e8c16a' }, { y: 0.05 }).id);
      });
      store.select(ids);
      toast('Add your logo from the Brand panel and change the contact line.', { timeout: 4000 });
    },
  },
  {
    name: 'Testimonial',
    sub: 'Quote with the client name',
    icon: 'text',
    apply() {
      const t = store.playhead;
      const ids = [];
      store.commit('Testimonial', (p) => {
        ids.push(addText(p, t, 5, '"I finally feel confident without makeup."', { font: 'DM Serif Display', size: 72, weight: 400, italic: true, shadowBlur: 16 }, { y: -0.04, reveal: 'word', anim: { in: null, out: { type: 'fade', duration: 0.5 }, loop: null } }).id);
        ids.push(addText(p, t + 1.2, 3.8, 'Client name, 3 sessions', { font: 'Inter', size: 40, weight: 600, color: '#e8c16a' }, { y: 0.1 }).id);
      });
      store.select(ids);
    },
  },
];

// ---------------------------------------------------------------------------
// User templates
// ---------------------------------------------------------------------------

const tplDir = () => join(paths.appData, 'templates');

export async function saveTemplate() {
  const name = await promptDialog('Save as template', 'Template name', store.project.name);
  if (!name) return;
  const id = uid('tpl');
  await mkdir(tplDir());
  const p = clone(store.project);
  await writeJson(join(tplDir(), id + '.json'), p);
  const list = [...(store.settings.userTemplates || []), { id, name, created: Date.now(), width: p.settings.width, height: p.settings.height }];
  saveSettings({ userTemplates: list });
  toast('Template saved. Find it in the Templates panel.');
}

export async function newFromTemplate(app, t) {
  const { confirmDiscard } = await import('../project-io.js');
  if (!(await confirmDiscard())) return;
  const p = await readJson(join(tplDir(), t.id + '.json'));
  if (!p) return toast('That template file is missing.', { kind: 'error' });
  p.id = uid('p');
  p.name = t.name + ' copy';
  p.created = p.modified = Date.now();
  store.loadProject(p, null);
  await verifyMedia();
}

export async function deleteTemplate(app, t) {
  if (!(await confirmDialog('Delete template', `Delete the template "${t.name}"?`, { ok: 'Delete', danger: true }))) return;
  await remove(join(tplDir(), t.id + '.json')).catch(() => {});
  saveSettings({ userTemplates: (store.settings.userTemplates || []).filter((x) => x.id !== t.id) });
  app.renderPanel();
}
