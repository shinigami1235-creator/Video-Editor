// The frame and the video: "Match my video" takes the first video's shape,
// any other project offers to match when the shapes differ, and Project
// settings can match a video at any time.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

await startServers();
try {
  const { browser, page, logs } = await openApp();

  // start screen: Match my video is first and picked by default
  await page.evaluate(() => window.__app.cmd('newProject'));
  await page.waitForSelector('.welcome-modal .preset-card');
  const cards = await page.evaluate(() => [...document.querySelectorAll('.welcome-modal .preset-card')].map((c) => ({ name: c.querySelector('.pc-name').textContent, active: c.classList.contains('active') })));
  check('start screen offers Match my video first', cards[0].name === 'Match my video' && cards[0].active, JSON.stringify(cards.slice(0, 2)));
  await page.locator('.welcome-modal .modal-foot button', { hasText: 'Create project' }).click();
  await sleep(200);
  const before = await page.evaluate(() => ({ ...window.__store.project.settings }));
  check('new project waits for a video', before.matchFirst === true, JSON.stringify(before));

  const [land, vert] = (await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/vertical.mp4`])).map((m) => m.id);
  const sizes = await page.evaluate(([land, vert]) => {
    const p = window.__store.project;
    return { land: [p.media[land].width, p.media[land].height], vert: [p.media[vert].width, p.media[vert].height] };
  }, [land, vert]);
  await page.evaluate((land) => window.__app.addMedia([window.__store.project.media[land]], 0), land);
  await sleep(400);
  const matched = await page.evaluate(() => ({ ...window.__store.project.settings }));
  const expect = (w, h) => {
    const k = Math.max(720 / Math.min(w, h), 1) * Math.min(1, 3840 / Math.max(w, h));
    return [Math.round((w * k) / 2) * 2, Math.round((h * k) / 2) * 2];
  };
  const e1 = expect(...sizes.land);
  check('the first video sets the frame', matched.width === e1[0] && matched.height === e1[1] && !matched.matchFirst, `${matched.width}x${matched.height}, video ${sizes.land.join('x')}`);
  await page.evaluate(() => window.__store.undo());
  const undone = await page.evaluate(() => ({ ...window.__store.project.settings }));
  check('undo brings the old frame back', undone.width === 1920 && undone.height === 1080, `${undone.width}x${undone.height}`);

  // a Reels project offers to match a landscape video
  await page.evaluate(async () => (await import('/src/project-io.js')).createProject({ name: 'Reels', width: 1080, height: 1920 }));
  const [land2] = (await importAndWait(page, [`${FIX}/landscape.mp4`])).map((m) => m.id);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.evaluate((id) => window.__app.addMedia([window.__store.project.media[id]], 0), land2);
  await sleep(400);
  const offer = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / '));
  check('a different shape offers to match', /16:9 while the frame is 9:16/.test(offer) && /Match the video/.test(offer), offer);
  await page.locator('.toast button', { hasText: 'Match the video' }).click();
  await sleep(300);
  const after = await page.evaluate(() => ({ ...window.__store.project.settings }));
  const e2 = expect(...sizes.land);
  check('the button matches the frame', after.width === e2[0] && after.height === e2[1], `${after.width}x${after.height}`);

  // a vertical video in a vertical frame says nothing
  await page.evaluate(async () => (await import('/src/project-io.js')).createProject({ name: 'Reels 2', width: 1080, height: 1920 }));
  const [vert2] = (await importAndWait(page, [`${FIX}/vertical.mp4`])).map((m) => m.id);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.evaluate((id) => window.__app.addMedia([window.__store.project.media[id]], 0), vert2);
  await sleep(400);
  const quiet = await page.evaluate(() => document.querySelectorAll('.toast').length);
  check('the same shape stays quiet', quiet === 0, String(quiet));

  // Project settings: Match a video on the timeline
  await page.evaluate(async () => {
    (await import('/src/project-io.js')).createProject({ name: 'Square', width: 1080, height: 1080 });
  });
  const [land3] = (await importAndWait(page, [`${FIX}/landscape.mp4`])).map((m) => m.id);
  await page.evaluate((id) => {
    window.__app.addMedia([window.__store.project.media[id]], 0);
    window.__store.clearSelection();
  }, land3);
  await sleep(300);
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('.inspector select')].find((el) => [...el.options].some((o) => o.value === 'match'));
    sel.value = 'match';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  const viaSettings = await page.evaluate(() => ({ ...window.__store.project.settings }));
  check('Project settings can match a video', viaSettings.width === e2[0] && viaSettings.height === e2[1], `${viaSettings.width}x${viaSettings.height}`);
  await page.screenshot({ path: '/tmp/ve-canvas.png' });

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
