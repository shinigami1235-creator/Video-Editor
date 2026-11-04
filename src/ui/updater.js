// Updates without visiting GitHub. A while after the editor opens, and every
// few hours, it asks the newest release whether there is a newer version. If
// there is, it downloads it quietly and shows "Update ready" in the top bar.
// Clicking that installs it and reopens the editor; otherwise it installs
// when the editor closes. Every update is checked against the signing key
// in tauri.conf.json before it runs.

import { store } from '../core/store.js';
import { isDesktop } from '../backend/index.js';
import { toast, modal } from './notify.js';
import { h } from './dom.js';
import { closeHooks, saveProject, autosaveNow } from '../project-io.js';

let pending = null; // a downloaded update waiting to install
let checking = null;
let badge = null;

/** This editor's version, such as 0.5.42. */
export async function appVersion() {
  if (!isDesktop) return 'dev';
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '?';
  }
}

export function startUpdater(app, badgeEl) {
  badge = badgeEl;
  badge.addEventListener('click', () => offerInstall());
  if (!isDesktop) return;
  setTimeout(() => checkForUpdate({ quiet: true }), 20000);
  setInterval(() => checkForUpdate({ quiet: true }), 4 * 3600 * 1000);
  closeHooks.push(installOnClose);
}

/** Looks for a newer version and downloads it. quiet: say nothing unless one is ready. */
export async function checkForUpdate({ quiet = false } = {}) {
  if (!isDesktop) return !quiet && toast('Updates only work in the installed editor.', { timeout: 3000 });
  if (pending) return quiet ? null : offerInstall();
  if (checking) return checking;
  checking = (async () => {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const upd = await check({ timeout: 30000 });
      if (!upd) {
        if (!quiet) toast(`This is the newest version (${await appVersion()}).`, { timeout: 3500 });
        return;
      }
      if (!quiet) toast(`Downloading version ${upd.version}`, { timeout: 4000 });
      await upd.download();
      pending = upd;
      badge.hidden = false;
      badge.title = `Version ${upd.version} is downloaded. Click to install it now, or it installs when you close the editor.`;
      if (!quiet) offerInstall();
    } catch (e) {
      if (!quiet) toast(`Could not check for updates: ${e?.message || e}`, { kind: 'warn', timeout: 6000 });
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** Saves what can be saved, so nothing is lost while the editor restarts. */
async function keepWork() {
  if (!store.dirty || !Object.keys(store.project.items).length) return true;
  if (store.projectPath) return saveProject();
  await autosaveNow();
  return true;
}

function offerInstall() {
  if (!pending) return;
  const v = pending.version;
  modal('Update ready', h('p', {}, `Version ${v} is downloaded. Installing closes the editor for a few seconds and opens it again with your project.`), {
    width: 440,
    actions: [
      { label: 'Later', run: (close) => close() },
      {
        label: 'Install now',
        primary: true,
        run: async (close) => {
          close();
          if (!(await keepWork())) return;
          toast(`Installing version ${v}`, { timeout: 10000 });
          try {
            await pending.install();
            // Windows closes the editor here and opens the new one; a Mac needs a restart
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
          } catch (e) {
            toast(`The update did not install: ${e?.message || e}`, { kind: 'error', timeout: 8000 });
          }
        },
      },
    ],
  });
}

/** Runs as the editor closes: installs a downloaded update without opening the editor again. */
async function installOnClose() {
  if (!pending || store.settings.updateOnClose === false) return;
  try {
    await pending.install({ restartAfterInstall: false });
  } catch {}
}
