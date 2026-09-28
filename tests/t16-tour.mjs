// Screenshots of every main screen at laptop size, for a visual check.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

const W = Number(process.env.TOUR_W || 1536);
const H = Number(process.env.TOUR_H || 864);
await startServers();
try {
  const { browser, page, logs } = await openApp({ width: W, height: H, query: '' });
  const shot = async (name) => {
    await sleep(500);
    await page.screenshot({ path: `/tmp/ve-tour-${name}.png` });
  };
  await page.waitForSelector('.welcome-modal', { timeout: 10000 }).catch(() => {});
  await shot('01-welcome');
  await page.keyboard.press('Escape');
  const media = await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/photo.png`, `${FIX}/music.wav`, `${FIX}/vertical.mp4`]);
  await page.evaluate(async (media) => {
    const s = window.__store;
    const app = window.__app;
    const [land, photo, music, vert] = media.map((m) => s.project.media[m.id]);
    app.addMedia([vert, land, photo], 0);
    app.addMedia([music], 0);
    s.seek(1.5);
    await app.cmd('addText');
    await app.cmd('addFx', 'sparkle');
    const v = Object.values(s.project.items).find((i) => i.mediaId === vert.id);
    s.select(v.id);
  }, media);
  await shot('02-main');
  for (const p of ['media', 'audio', 'text', 'captions', 'transcript', 'transitions', 'effects', 'templates', 'ai', 'brand']) {
    await page.evaluate((p) => window.__app.openPanel(p), p);
    await shot('10-panel-' + p);
  }
  for (const tab of ['Video', 'Colour', 'Speed', 'Animation', 'Mask', 'Effects', 'Audio', 'Smart tools']) {
    await page.locator('.inspector .tab', { hasText: tab }).first().click().catch(() => {});
    await shot('20-insp-' + tab.replace(' ', ''));
  }
  for (const menu of ['File', 'Edit', 'Add', 'Tools']) {
    await page.click(`.menu-btn:has-text("${menu}")`);
    await shot('30-menu-' + menu);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelector('.ctx')?.remove());
  }
  for (const [name, cmd] of [['export', 'export'], ['settings', 'settings'], ['stitch', 'stitch'], ['shorts', 'shorts'], ['translate', 'translate'], ['myvoice', 'myVoice'], ['record', 'recordScreen']]) {
    await page.evaluate((c) => window.__app.cmd(c, c === 'stitch' ? { fromLibrary: true } : undefined), cmd);
    await shot('40-dialog-' + name);
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  await page.evaluate(() => window.__app.cmd('teleprompter'));
  await shot('50-teleprompter');
  await page.keyboard.press('Escape');
  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource/.test(l));
  check('tour ran without errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
