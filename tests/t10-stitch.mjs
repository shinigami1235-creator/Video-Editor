// Stitching videos end to end.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

await startServers();
try {
  const { browser, page, logs } = await openApp();
  // from the start screen, as a new project
  await page.evaluate((files) => (window.__testDialogs = [files]), [`${FIX}/vertical.mp4`, `${FIX}/landscape.mp4`, `${FIX}/photo.png`]);
  await page.evaluate(async () => {
    const { showWelcome } = await import('/src/ui/welcome.js');
    showWelcome(window.__app);
  });
  await page.click('button:has-text("Stitch videos together")');
  await page.waitForSelector('.stitch-row');
  const n = await page.locator('.stitch-row').count();
  check('stitch dialog lists the picked files', n === 3, String(n));
  // files come in sorted by name (landscape, photo, vertical); move vertical to the front
  await page.locator('.stitch-row').nth(2).locator('button[title="Earlier"]').click();
  await page.locator('.stitch-row').nth(1).locator('button[title="Earlier"]').click();
  const first = await page.locator('.stitch-row').first().locator('.stitch-name').textContent();
  check('reordering works', first === 'vertical.mp4', first);
  await page.screenshot({ path: '/tmp/ve-stitch-1.png' });
  await page.click('.modal-foot button:has-text("Stitch")');
  await page.waitForFunction(() => Object.values(window.__store.project.items).length >= 3, null, { timeout: 120000 });
  await sleep(500);
  const r = await page.evaluate(async () => {
    const s = window.__store;
    const E = await import('/src/core/edit.js');
    const main = E.mainTrack(s.project);
    const clips = Object.values(s.project.items).filter((i) => i.trackId === main.id).sort((a, b) => a.start - b.start);
    return {
      w: s.project.settings.width,
      h: s.project.settings.height,
      names: clips.map((c) => s.project.media[c.mediaId].name),
      gaps: clips.slice(1).map((c, i) => +(c.start - (clips[i].start + clips[i].duration)).toFixed(3)),
      trans: clips.map((c) => c.transitionIn?.type || null),
      backdrop: clips.map((c) => c.effects.backdrop),
    };
  });
  check('new project takes the first video shape', r.w === 1080 && r.h === 1920, `${r.w}x${r.h}`);
  check('clips join in the chosen order', r.names.join() === 'vertical.mp4,landscape.mp4,photo.png', r.names.join());
  check('no gaps between clips', r.gaps.every((g) => g === 0), JSON.stringify(r.gaps));
  check('transition between each pair, none on the first', r.trans[0] === null && r.trans[1] === 'dissolve' && r.trans[2] === 'dissolve', JSON.stringify(r.trans));
  check('wide clip gets the blurred copy behind', r.backdrop.every((b) => b === 'blur'), JSON.stringify(r.backdrop));
  await page.evaluate(() => window.__store.seek(9));
  await sleep(800);
  await page.screenshot({ path: '/tmp/ve-stitch-2.png' });

  // from the media panel, appended after what is there
  await page.evaluate(() => window.__app.cmd('stitch', { fromLibrary: true }));
  await page.waitForSelector('.stitch-row');
  await page.selectOption('.modal select >> nth=0', '');
  await page.click('.modal-foot button:has-text("Stitch")');
  await sleep(800);
  const r2 = await page.evaluate(async () => {
    const s = window.__store;
    const E = await import('/src/core/edit.js');
    const main = E.mainTrack(s.project);
    const clips = Object.values(s.project.items).filter((i) => i.trackId === main.id).sort((a, b) => a.start - b.start);
    return { n: clips.length, last: clips.slice(3).map((c) => c.transitionIn) };
  });
  check('stitching again appends with straight cuts', r2.n === 6 && r2.last.every((t) => !t), JSON.stringify(r2));

  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | ').slice(0, 800));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
