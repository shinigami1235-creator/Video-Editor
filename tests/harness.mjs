// Starts the test backend and Vite, then opens the editor in Chromium.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const procs = [];

async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout waiting for ' + url);
}

export async function startServers({ fresh = true } = {}) {
  if (fresh) fs.rmSync('/tmp/ve-test', { recursive: true, force: true });
  const out = process.env.VE_DEBUG ? 'inherit' : 'ignore';
  const be = spawn('node', ['tests/dev-server.mjs'], { cwd: root, env: { ...process.env, PORT: '5174' }, stdio: ['ignore', out, 'pipe'], detached: true });
  be.stderr.on('data', (d) => process.env.VE_DEBUG && process.stderr.write('[be] ' + d));
  procs.push(be);
  const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort'], { cwd: root, env: { ...process.env, VE_TEST: '1' }, stdio: ['ignore', out, 'pipe'], detached: true });
  vite.stderr.on('data', (d) => process.env.VE_DEBUG && process.stderr.write('[vite] ' + d));
  procs.push(vite);
  await waitFor('http://127.0.0.1:5174/api/events').catch(() => {});
  await waitFor('http://127.0.0.1:5173/');
}

export function stopServers() {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      try {
        p.kill('SIGTERM');
      } catch {}
    }
  }
}

export async function openApp({ query = '?test', width = 1600, height = 1000 } = {}) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-gpu-blocklist', '--disable-gpu-memory-buffer-video-frames'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const logs = [];
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    logs.push(line);
    if (process.env.VE_DEBUG || m.type() === 'error') console.log('   page:', line.slice(0, 400));
  });
  page.on('response', (r) => {
    if (r.status() >= 400) console.log('   HTTP', r.status(), r.url().slice(0, 200));
  });
  page.on('pageerror', (e) => {
    logs.push('[pageerror] ' + e.message);
    console.log('   PAGEERROR:', e.message);
  });
  await page.goto('http://127.0.0.1:5173/' + query);
  await page.waitForFunction(() => window.__ready || window.__bootError, null, { timeout: 60000 });
  const bootError = await page.evaluate(() => window.__bootError);
  if (bootError) throw new Error('boot failed: ' + bootError);
  return { browser, page, logs };
}

let pass = 0;
let fail = 0;
export function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  return ok;
}
export function summary() {
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

export const FIX = '/tmp/ve-fixtures';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Imports files and waits until they are ready. Returns media ids. */
export async function importAndWait(page, files, timeout = 120000) {
  return page.evaluate(
    async ({ files, timeout }) => {
      const { importFiles, whenReady } = await import('/src/media/library.js');
      const media = await importFiles(files);
      const t0 = Date.now();
      await Promise.race([Promise.all(media.map((m) => whenReady(m).catch((e) => e))), new Promise((r) => setTimeout(r, timeout))]);
      void t0;
      return media.map((m) => ({ id: m.id, status: m.status, kind: m.kind, duration: m.duration, error: m.error || null, name: m.name }));
    },
    { files, timeout },
  );
}
