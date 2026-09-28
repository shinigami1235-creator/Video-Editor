import './styles.css';
import { preloadFonts } from './fonts.js';
import { initBackend, isDesktop } from './backend/index.js';
import { loadSettings } from './core/settings.js';
import { store } from './core/store.js';
import { ensureFfmpeg, locateTools } from './media/tools.js';
import { detectEditCodec } from './media/library.js';
import { App } from './ui/app.js';
import { startAutosave } from './project-io.js';
import { h } from './ui/dom.js';
import { formatBytes } from './core/util.js';

async function setupTools() {
  await locateTools();
  const overlay = h('div', { class: 'setup' });
  const label = h('p', {}, 'Getting the video engine ready');
  const bar = h('div', { class: 'job-bar big' }, h('div', { class: 'job-fill' }));
  overlay.append(h('div', { class: 'setup-box' }, h('h2', {}, 'Setting up'), label, bar, h('p', { class: 'hint' }, 'The first start downloads FFmpeg, which reads and writes every video format. This happens once.')));
  let shown = false;
  const timer = setTimeout(() => {
    document.body.append(overlay);
    shown = true;
  }, 400);
  try {
    await ensureFfmpeg((p) => {
      label.textContent = p.total ? `${p.label}: ${formatBytes(p.received)} of ${formatBytes(p.total)}` : p.label;
      if (p.total) bar.firstChild.style.width = Math.round((p.received / p.total) * 100) + '%';
    });
  } catch (e) {
    clearTimeout(timer);
    if (!shown) document.body.append(overlay);
    label.textContent = 'FFmpeg could not be set up: ' + (e.message || e);
    overlay.querySelector('.setup-box').append(h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Try again'));
    throw e;
  }
  clearTimeout(timer);
  overlay.remove();
}

async function boot() {
  const root = document.getElementById('app');
  await initBackend();
  await loadSettings();
  preloadFonts();
  await setupTools();
  await detectEditCodec();
  // a Mac reads its built-in voices once for text to speech
  import('./media/voices.js').then((v) => v.loadVoices()).catch(() => {});
  const app = new App(root);
  app.build();
  store.on('project', async () => {
    const keys = new Set(Object.values(store.project.items).map((it) => it.color?.lut).filter((k) => k?.startsWith('file:')));
    for (const k of keys) await app.ensureLut(k).catch(() => {});
  });
  startAutosave();
  const params = new URLSearchParams(location.search);
  if (!params.has('test')) {
    const { showWelcome } = await import('./ui/welcome.js');
    showWelcome(app);
  }
  window.__ready = true;
  if (!isDesktop) console.info('Video Editor running in browser test mode');
}

window.addEventListener('error', (e) => console.error('Uncaught', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled', e.reason));
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea')) e.preventDefault();
});
boot().catch((e) => {
  console.error('Startup failed', e);
  window.__bootError = String(e?.stack || e);
});
