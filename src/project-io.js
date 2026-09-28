// Saving, opening, autosave and crash recovery.

import { store } from './core/store.js';
import { newProject, PROJECT_VERSION } from './core/model.js';
import { paths, join, readText, writeText, exists, list, remove, mkdir, saveDialog, openDialog, basename, stripExt, stat, isDesktop } from './backend/index.js';
import { addRecent } from './core/settings.js';
import { verifyMedia } from './media/library.js';
import { toast, errorToast, confirmDialog } from './ui/notify.js';

export const PROJECT_EXT = 'vproj';
const autosaveDir = () => join(paths.appData, 'autosave');

function serialise(project) {
  const p = JSON.parse(JSON.stringify(project));
  for (const m of Object.values(p.media)) {
    delete m.progress;
    if (m.status === 'processing') m.status = 'pending';
  }
  return JSON.stringify(p);
}

export function migrate(p) {
  p.version ||= 1;
  p.markers ||= [];
  p.settings.sampleRate ||= 48000;
  for (const it of Object.values(p.items)) {
    it.kf ||= {};
    it.anim ||= { in: null, out: null, loop: null };
  }
  if (p.version > PROJECT_VERSION) toast('This project was saved by a newer version of the editor. Some parts may not open correctly.', { kind: 'warn' });
  return p;
}

export async function saveProject({ as = false } = {}) {
  let path = store.projectPath;
  if (!path || as) {
    path = await saveDialog({
      title: 'Save project',
      defaultPath: join(paths.documents, (store.project.name || 'Untitled project') + '.' + PROJECT_EXT),
      filters: [{ name: 'Video project', extensions: [PROJECT_EXT] }],
    });
    if (!path) return false;
    if (!path.toLowerCase().endsWith('.' + PROJECT_EXT)) path += '.' + PROJECT_EXT;
    if (as || !store.projectPath) store.project.name = stripExt(basename(path));
  }
  try {
    await writeText(path, serialise(store.project));
    store.projectPath = path;
    store.dirty = false;
    addRecent(path, store.project.name);
    await remove(join(autosaveDir(), store.project.id + '.' + PROJECT_EXT)).catch(() => {});
    store.emit('saved');
    toast('Saved ' + basename(path));
    return true;
  } catch (e) {
    errorToast(e, 'Saving failed.');
    return false;
  }
}

export async function openProjectPath(path) {
  try {
    const p = migrate(JSON.parse(await readText(path)));
    store.loadProject(p, path);
    addRecent(path, p.name);
    await verifyMedia();
    return true;
  } catch (e) {
    errorToast(e, 'Could not open ' + basename(path) + '.');
    return false;
  }
}

export async function openProject() {
  if (!(await confirmDiscard())) return false;
  const path = await openDialog({ title: 'Open project', filters: [{ name: 'Video project', extensions: [PROJECT_EXT] }] });
  if (!path) return false;
  return openProjectPath(path);
}

export async function confirmDiscard() {
  if (!store.dirty || !Object.keys(store.project.items).length) return true;
  return confirmDialog('Unsaved changes', `${store.project.name} has changes that are not saved. Open another project anyway? The autosave copy stays in the app folder.`, {
    ok: 'Open anyway',
  });
}

export function createProject(opts) {
  const p = newProject(opts);
  p.settings.magnetic = store.settings.magneticDefault !== false;
  store.loadProject(p, null);
  return p;
}

let timer = null;
export function startAutosave() {
  clearInterval(timer);
  const secs = Math.max(10, store.settings.autosaveSeconds || 30);
  timer = setInterval(autosaveNow, secs * 1000);
  if (isDesktop) watchWindowClose();
  else
    window.addEventListener('beforeunload', () => {
      if (store.dirty) autosaveNow();
    });
}

/** Asks to save unsaved changes when the window closes. */
async function watchWindowClose() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  win.onCloseRequested(async (e) => {
    if (!store.dirty || !Object.keys(store.project.items).length) return;
    e.preventDefault();
    const choice = await new Promise((resolve) => {
      const { modal } = window.__notify;
      modal('Unsaved changes', document.createTextNode(`Save ${store.project.name} before closing?`), {
        width: 440,
        onClose: (v) => resolve(v),
        actions: [
          { label: 'Cancel', run: (close) => close(null) },
          { label: 'Close without saving', kind: 'danger', run: (close) => close('discard') },
          { label: 'Save', primary: true, run: (close) => close('save') },
        ],
      });
    });
    if (!choice) return;
    if (choice === 'save' && !(await saveProject())) return;
    if (choice === 'discard') await remove(join(autosaveDir(), store.project.id + '.' + PROJECT_EXT)).catch(() => {});
    await win.destroy();
  });
}

export async function autosaveNow() {
  if (!store.dirty || !Object.keys(store.project.items).length) return;
  try {
    await mkdir(autosaveDir());
    const p = JSON.parse(serialise(store.project));
    p.savedPath = store.projectPath;
    await writeText(join(autosaveDir(), store.project.id + '.' + PROJECT_EXT), JSON.stringify(p));
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

/** Autosaved projects that are newer than their saved file (or never saved). */
export async function findRecoverable() {
  const dir = autosaveDir();
  if (!(await exists(dir))) return [];
  const out = [];
  for (const e of await list(dir)) {
    if (!e.name.endsWith('.' + PROJECT_EXT)) continue;
    const path = join(dir, e.name);
    try {
      const p = JSON.parse(await readText(path));
      let newer = true;
      if (p.savedPath) {
        const st = await stat(p.savedPath);
        if (st && st.mtimeMs >= e.mtimeMs - 1000) newer = false;
      }
      if (newer) out.push({ path, name: p.name, modified: e.mtimeMs, project: p });
      else await remove(path);
    } catch {
      await remove(path).catch(() => {});
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

export async function restoreAutosave(entry) {
  const p = migrate(entry.project);
  const savedPath = p.savedPath || null;
  delete p.savedPath;
  store.loadProject(p, savedPath);
  store.dirty = true;
  await verifyMedia();
  await remove(entry.path).catch(() => {});
}
