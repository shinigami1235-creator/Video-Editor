// Getting around the timeline: the go-to-start and go-to-end buttons, Home
// and End, and the mouse wheel zooming around the pointer, scrolling sideways
// with Shift, and scrolling the tracks over the track names.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

await startServers();
try {
  const { browser, page, logs } = await openApp({ width: 1536, height: 864 });
  const [lec] = (await importAndWait(page, [`${FIX}/lecture90.mp4`])).map((m) => m.id);
  await page.evaluate((id) => {
    window.__app.addMedia([window.__store.project.media[id]], 0);
    window.__app.timeline.setZoom(60);
    window.__app.seek(80);
    window.__app.timeline.revealPlayhead();
  }, lec);
  await sleep(300);
  const st = () => page.evaluate(() => ({ t: window.__store.playhead, zoom: window.__store.zoom, left: document.querySelector('.tl-scroll').scrollLeft }));
  const s0 = await st();
  check('timeline scrolled away from the start', s0.left > 1000, JSON.stringify(s0));

  await page.click('.transport [title="Go to the start (Home)"]');
  await sleep(200);
  const s1 = await st();
  check('go to start moves the playhead and the view to 0', s1.t === 0 && s1.left === 0, JSON.stringify(s1));
  await page.click('.transport [title="Go to the end (End)"]');
  await sleep(200);
  const s2 = await st();
  const dur = await page.evaluate(() => window.__store.duration);
  check('go to end shows the end', Math.abs(s2.t - dur) < 0.05 && s2.left > 1000, JSON.stringify({ ...s2, dur }));
  await page.mouse.click(400, 300);
  await page.keyboard.press('Home');
  await sleep(200);
  const s3 = await st();
  check('Home goes to the start', s3.t === 0 && s3.left === 0, JSON.stringify(s3));

  // wheel over the clips zooms around the pointer
  const box = await page.locator('.tl-scroll').boundingBox();
  const x = box.x + 600;
  const y = box.y + 60;
  const tBefore = await page.evaluate((x) => window.__app.timeline.timeAt(x), x);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -300);
  await sleep(300);
  const z1 = await st();
  const tAfter = await page.evaluate((x) => window.__app.timeline.timeAt(x), x);
  check('wheel up zooms in', z1.zoom > s3.zoom * 1.3, `${s3.zoom} -> ${z1.zoom}`);
  check('the second under the pointer stays put', Math.abs(tAfter - tBefore) < 0.2, `${tBefore.toFixed(2)} -> ${tAfter.toFixed(2)}`);
  await page.mouse.wheel(0, 600);
  await sleep(300);
  const z2 = await st();
  check('wheel down zooms out', z2.zoom < z1.zoom / 1.5, `${z1.zoom} -> ${z2.zoom}`);

  await page.evaluate(() => window.__app.timeline.setZoom(80));
  await sleep(200);
  const before = await st();
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 400);
  await page.keyboard.up('Shift');
  await sleep(200);
  const side = await st();
  check('Shift+wheel scrolls sideways', side.left > before.left + 200 && side.zoom === before.zoom, JSON.stringify({ before, side }));

  // over the track names the page scrolls the tracks instead of zooming
  const zHead0 = (await st()).zoom;
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.wheel(0, 200);
  await sleep(200);
  check('wheel over the track names leaves the zoom alone', (await st()).zoom === zHead0, '');

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
