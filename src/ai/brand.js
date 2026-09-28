// Brand kits: colours, fonts and logos reused across videos.

import { store } from '../core/store.js';
import { h, button, colorInput, textInput } from '../ui/dom.js';
import { modal, toast, confirmDialog } from '../ui/notify.js';
import { saveSettings } from '../core/settings.js';
import { openDialog, join, paths, dirname, readJson, exists, copy, mkdir, basename, list, fileUrl } from '../backend/index.js';
import { importFiles, whenReady } from '../media/library.js';
import { newClip, newText, newSolid, isVisualItem, itemEnd, projectDuration } from '../core/model.js';
import * as E from '../core/edit.js';
import { uid, clone } from '../core/util.js';

const saveKits = (kits) => saveSettings({ brandKits: kits });

export function editBrandKit(app, kit) {
  const k = kit ? clone(kit) : { id: uid('b'), name: 'New brand', colors: ['#15171c', '#c9a45c', '#ffffff'], fonts: [], logos: [] };
  const colorsWrap = h('div', { class: 'swatch-edit' });
  const drawColors = () => {
    colorsWrap.replaceChildren(
      ...k.colors.map((c, i) =>
        h(
          'div',
          { class: 'swatch-cell' },
          colorInput('', c, (v) => (k.colors[i] = v)),
          h('button', { class: 'ibtn', type: 'button', title: 'Remove colour', onclick: () => {
            k.colors.splice(i, 1);
            drawColors();
          } }, 'x'),
        ),
      ),
      button('Add colour', () => {
        k.colors.push('#888888');
        drawColors();
      }),
    );
  };
  drawColors();
  const fontsWrap = h('div', {});
  const drawFonts = () =>
    fontsWrap.replaceChildren(
      ...k.fonts.map((f, i) => h('div', { class: 'row' }, h('span', {}, `${f.family} (${f.role || 'font'})`), h('button', { class: 'btn btn-link', type: 'button', onclick: () => {
        k.fonts.splice(i, 1);
        drawFonts();
      } }, 'Remove'))),
      button('Add font file', async () => {
        const path = await openDialog({ title: 'Font file', filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] });
        if (!path) return;
        const family = basename(path).replace(/\.[^.]+$/, '').replace(/[-_](regular|bold|medium|light|semibold|black|italic)$/i, '');
        const dest = join(paths.appData, 'fonts', basename(path));
        await mkdir(join(paths.appData, 'fonts'));
        await copy(path, dest);
        await app.registerFontFile(dest, family);
        k.fonts.push({ family, path: dest, role: k.fonts.length ? 'body' : 'heading' });
        drawFonts();
      }),
    );
  drawFonts();
  const logosWrap = h('div', { class: 'logo-row' });
  const drawLogos = () =>
    logosWrap.replaceChildren(
      ...k.logos.map((l, i) => h('div', { class: 'logo-cell' }, h('img', { src: fileUrlSafe(l.path), alt: l.name }), h('button', { class: 'btn btn-link', type: 'button', onclick: () => {
        k.logos.splice(i, 1);
        drawLogos();
      } }, 'Remove'))),
      button('Add logo', async () => {
        const paths2 = await openDialog({ title: 'Logo', multiple: true, filters: [{ name: 'Images', extensions: ['png', 'svg', 'webp', 'jpg', 'jpeg'] }] });
        for (const pth of paths2 || []) {
          const dest = join(paths.appData, 'brand', basename(pth));
          await mkdir(join(paths.appData, 'brand'));
          await copy(pth, dest);
          k.logos.push({ name: basename(pth), path: dest });
        }
        drawLogos();
      }),
    );
  drawLogos();
  const name = textInput('Name', k.name, (v) => (k.name = v));
  const actions = [
    { label: 'Cancel', run: (c) => c(null) },
    {
      label: 'Save',
      primary: true,
      run: (c) => {
        const kits = (store.settings.brandKits || []).filter((x) => x.id !== k.id);
        kits.push(k);
        saveKits(kits);
        c(true);
        app.renderPanel();
      },
    },
  ];
  if (kit)
    actions.unshift({
      label: 'Delete',
      kind: 'danger',
      run: async (c) => {
        if (!(await confirmDialog('Delete brand kit', `Delete ${kit.name}?`, { ok: 'Delete', danger: true }))) return;
        saveKits((store.settings.brandKits || []).filter((x) => x.id !== kit.id));
        c(true);
        app.renderPanel();
      },
    });
  modal(kit ? 'Edit brand kit' : 'New brand kit', h('div', { class: 'stack' }, name, h('h4', {}, 'Colours'), colorsWrap, h('h4', {}, 'Fonts'), fontsWrap, h('h4', {}, 'Logos'), logosWrap), { width: 560, actions });
}

function fileUrlSafe(p) {
  return p ? fileUrl(p) : '';
}

export function applyBrandColor(c) {
  const items = store.selectedItems;
  if (!items.length) return toast('Select text or a shape first.', { timeout: 1500 });
  store.commit('Brand colour', () => {
    for (const it of items) {
      if (it.type === 'text') it.style.color = c;
      else if (it.type === 'shape') {
        if (it.shape === 'line' || it.shape === 'arrow') it.fill = c;
        else it.stroke = c;
      } else if (it.type === 'solid') it.fillColor = c;
    }
  });
}

async function logoMedia(path) {
  let m = Object.values(store.project.media).find((x) => x.path === path);
  if (!m) [m] = await importFiles([path]);
  await whenReady(m);
  return m;
}

export async function addLogo(app, path) {
  const m = await logoMedia(path);
  let c = null;
  store.commit('Add logo', (p) => {
    c = newClip(m, null, store.playhead, { duration: 4 });
    c.props.scale = 0.35;
    E.placeOverlay(p, c);
  });
  store.select(c.id);
}

export async function brandWatermark(app, kit) {
  const logo = kit.logos?.[0];
  if (!logo) return toast('Add a logo to the brand kit first.', { kind: 'warn' });
  const m = await logoMedia(logo.path);
  let c = null;
  store.commit('Logo watermark', (p) => {
    const W = p.settings.width;
    const H = p.settings.height;
    c = newClip(m, null, 0, { duration: Math.max(1, projectDuration(p)) });
    const fit = Math.min(W / m.width, H / m.height);
    const target = Math.min(W, H) * 0.16;
    c.props.scale = target / (Math.max(m.width, m.height) * fit);
    c.props.x = W / 2 - target * 0.75;
    c.props.y = -H / 2 + target * 0.75;
    c.props.opacity = 0.85;
    c.name = 'Logo watermark';
    E.placeOverlay(p, c);
  });
  store.select(c.id);
  toast('Logo added in the top right for the whole video.');
}

export async function brandEndCard(app, kit) {
  const logo = kit.logos?.[0];
  const heading = kit.fonts?.find((f) => f.role === 'heading')?.family || 'Montserrat';
  const body = kit.fonts?.find((f) => f.role === 'body')?.family || 'Inter';
  const bg = kit.colors?.[0] || '#15171c';
  const accent = kit.colors?.[1] || '#c9a45c';
  const m = logo ? await logoMedia(logo.path) : null;
  const ids = [];
  store.commit('Brand end card', (p) => {
    const main = E.mainTrack(p);
    const end = Math.max(0, ...Object.values(p.items).filter((i) => i.trackId === main.id).map(itemEnd));
    const s = newSolid(main.id, end, 4, bg);
    p.items[s.id] = s;
    ids.push(s.id);
    if (m) {
      const c = newClip(m, null, end + 0.2, { duration: 3.8 });
      c.props.scale = 0.45;
      c.props.y = -p.settings.height * 0.1;
      c.anim = { in: { type: 'zoomOut', duration: 0.6 }, out: null, loop: null };
      E.placeOverlay(p, c);
      ids.push(c.id);
    }
    const t = newText(null, end + 0.6, 'Book your visit', { font: heading, size: 80, weight: 800, color: '#ffffff' });
    t.duration = 3.4;
    t.props.y = p.settings.height * 0.12;
    t.anim = { in: { type: 'slideUp', duration: 0.5 }, out: null, loop: null };
    E.placeOverlay(p, t);
    const t2 = newText(null, end + 0.9, 'Message us today', { font: body, size: 42, weight: 500, color: accent });
    t2.duration = 3.1;
    t2.props.y = p.settings.height * 0.19;
    E.placeOverlay(p, t2);
    ids.push(t.id, t2.id);
    E.compactMagnetic(p);
  });
  store.select(ids);
}

export function brandFonts(kit) {
  const heading = kit.fonts?.find((f) => f.role === 'heading')?.family;
  const body = kit.fonts?.find((f) => f.role === 'body')?.family || heading;
  if (!heading) return toast('Add a font file to the brand kit first.', { kind: 'warn' });
  store.commit('Brand fonts', (p) => {
    for (const it of Object.values(p.items)) {
      if (it.type !== 'text') continue;
      it.style.font = it.style.size >= 70 && !it.caption ? heading : body;
    }
  });
  toast('Titles use the heading font and smaller text the body font.');
}

/** Copies brand kits from the Photo Editor app's data folder. */
export async function importPhotoEditorKits(app) {
  const root = join(dirname(paths.appData), 'com.cygnussolutions.photoeditor');
  let base = null;
  for (const cand of [root, join(root, 'data')]) if (await exists(join(cand, 'brand', 'kits.json'))) base = cand;
  if (!base) return toast('No Photo Editor brand kits were found on this computer.', { kind: 'warn' });
  const saved = await readJson(join(base, 'brand', 'kits.json'), { kits: [] });
  const fontIndex = await readJson(join(base, 'fonts', 'index.json'), []);
  const kits = store.settings.brandKits || [];
  let added = 0;
  for (const pk of saved.kits || []) {
    if (kits.some((k) => k.name === pk.name)) continue;
    const kit = { id: uid('b'), name: pk.name, colors: [...(pk.colors || [])], fonts: [], logos: [] };
    for (const role of ['heading', 'body']) {
      const fam = pk.fonts?.[role];
      if (!fam) continue;
      const entry = fontIndex.find((f) => f.family === fam);
      if (entry) {
        const path = join(base, 'fonts', entry.file);
        await app.registerFontFile(path, fam).catch(() => {});
        kit.fonts.push({ family: fam, path, role });
      } else kit.fonts.push({ family: fam, path: null, role });
    }
    for (const l of pk.logos || []) kit.logos.push({ name: l.name, path: join(base, 'brand', 'logos', l.file) });
    kits.push(kit);
    added++;
  }
  saveKits(kits);
  app.renderPanel();
  toast(added ? `Imported ${added} brand kit${added > 1 ? 's' : ''} from the Photo Editor.` : 'Those brand kits are already here.');
}

export { isVisualItem, list };
