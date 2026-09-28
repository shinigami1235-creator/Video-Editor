import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

await startServers();
let code = 1;
try {
  const { browser, page, logs } = await openApp();
  check('app boots', await page.evaluate(() => !!window.__app));
  check('edit codec chosen', true, await page.evaluate(async () => (await import('/src/media/library.js')).runtime.codec));
  const media = await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/vertical.mp4`, `${FIX}/music.wav`, `${FIX}/photo.png`, `${FIX}/slides.pdf`, `${FIX}/faces.mp4`]);
  console.log(JSON.stringify(media, null, 1));
  check('all media ready', media.every((m) => m.status === 'ready'), media.filter((m) => m.status !== 'ready').map((m) => m.name + ':' + m.error).join('; '));
  check('pdf became 3 pages', media.filter((m) => m.name.startsWith('slides')).length === 3);
  await page.screenshot({ path: '/tmp/ve-shot-01.png' });
  code = 0;
  await browser.close();
  console.log(logs.filter((l) => /error/i.test(l)).slice(0, 20).join('\n'));
} catch (e) {
  console.error('TEST CRASH', e);
} finally {
  stopServers();
}
process.exit(summary() || code);
