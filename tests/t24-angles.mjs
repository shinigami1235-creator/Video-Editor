// Multi-angle editing: two videos of the same song line up by their sound,
// one sound plays all the way through, and the Angles row switches the
// picture between them with a cut, a fade or another transition.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const DIR = '/tmp/ve-angles';
fs.mkdirSync(DIR, { recursive: true });
// the camera fixtures' sound (camB's is camA's from 3.2 s on) under a plain red and a plain blue picture
const make = (src, color, out) => {
  if (!fs.existsSync(out)) spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:s=640x360:r=30`, '-i', src, '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
};
make(`${FIX}/camA.mp4`, 'red', `${DIR}/red.mp4`);
make(`${FIX}/camB.mp4`, 'blue', `${DIR}/blue.mp4`);

function pixel(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  return [...r.stdout.subarray(0, 3)];
}
const near = (a, b, tol = 30) => a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

await startServers();
try {
  const { browser, page, logs } = await openApp();
  await page.evaluate(async () => (await import('/src/project-io.js')).createProject({ name: 'Choir' }));
  const [red, blue] = (await importAndWait(page, [`${DIR}/red.mp4`, `${DIR}/blue.mp4`])).map((m) => m.id);

  // nothing selected and nothing on the timeline: Sync angles takes both videos from the Media panel
  await page.evaluate(() => window.__app.cmd('syncAngles'));
  await page.waitForFunction(() => window.__store.project.multicam, null, { timeout: 30000 });
  const sync = await page.evaluate(([red, blue]) => {
    const p = window.__store.project;
    const a = Object.values(p.items).find((i) => i.mediaId === red);
    const b = Object.values(p.items).find((i) => i.mediaId === blue);
    return { ahead: b.start - b.in - (a.start - a.in), angles: p.multicam.angles.length, sound: p.multicam.sound === p.multicam.angles[0], muted: p.items[p.multicam.angles[1]].muted, first: p.multicam.angles[0] === a.id, bStart: b.start };
  }, [red, blue]);
  check('Sync angles puts both videos on the timeline and lines them up by sound', Math.abs(sync.ahead - 3.2) < 0.05 && sync.angles === 2 && sync.first, JSON.stringify(sync));
  check('one sound plays: angle 1 is heard, angle 2 is muted', sync.sound && sync.muted, JSON.stringify(sync));

  const ui = await page.evaluate(() => ({ lane: !!document.querySelector('.tl-angle-lane'), head: [...document.querySelectorAll('.tl-head')].some((h) => /Angles/.test(h.textContent)), hint: document.querySelector('.tl-angle-hint')?.textContent || '', nums: document.querySelectorAll('.tl-angle-num').length }));
  check('the Angles row sits above the angle tracks, each numbered', ui.lane && ui.head && /press 1, 2/.test(ui.hint) && ui.nums === 2, JSON.stringify(ui));

  const frame = async (t, name) => {
    const out = `${DIR}/f-${name}.png`;
    await page.evaluate(
      async ([t, out]) => {
        const { exportFrame } = await import('/src/export/export.js');
        await exportFrame(window.__store.project, t, out);
      },
      [t, out],
    );
    return pixel(out);
  };
  const T = sync.bStart + 3; // both angles have picture here
  check('before any switch only angle 1 shows', near(await frame(T, 'before'), RED), '');

  // press 2 at the playhead: a fade into angle 2 there
  await page.evaluate((t) => window.__app.seek(t), T);
  await page.keyboard.press('2');
  await sleep(200);
  const sw = await page.evaluate(() => window.__store.project.multicam.switches.map((s) => ({ ...s })));
  check('pressing 2 adds a fade into angle 2 at the playhead', sw.length === 1 && sw[0].a === 1 && sw[0].type === 'dissolve' && Math.abs(sw[0].t - T) < 0.05 && sw[0].d === 0.6, JSON.stringify(sw));
  const mid = await frame(T, 'mid');
  check('halfway through the fade both angles mix', mid[0] > 70 && mid[0] < 190 && mid[2] > 70 && mid[2] < 190, JSON.stringify(mid));
  check('after the fade angle 2 shows', near(await frame(T + 1, 'after'), BLUE), '');
  check('before the fade angle 1 still shows', near(await frame(T - 1, 'pre'), RED), '');

  // the row shows the switch and darkens each angle where the other one is on screen
  await page.evaluate(() => window.__app.timeline.zoomToFit());
  await sleep(200);
  const row = await page.evaluate(() => ({ sw: document.querySelectorAll('.tl-angle-sw').length, segs: document.querySelectorAll('.tl-angle-seg').length, off: document.querySelectorAll('.tl-angle-off').length }));
  check('the row shows two stretches and the switch, and the hidden parts are darkened', row.sw === 1 && row.segs === 2 && row.off >= 2, JSON.stringify(row));

  // click the switch: change it to Dip to black, then to a Cut
  await page.click('.tl-angle-sw');
  await page.waitForSelector('.tl-pop');
  await page.locator('.tl-pop .chip', { hasText: 'Dip to black' }).click();
  await sleep(150);
  const dip = await frame(T, 'dip');
  check('Dip to black goes through black at the switch', dip.every((v) => v < 40), JSON.stringify(dip));
  await page.locator('.tl-pop .chip', { hasText: /^Cut$/ }).click();
  await sleep(150);
  const cutType = await page.evaluate(() => window.__store.project.multicam.switches[0].type);
  check('Cut swaps the picture straight away', cutType === 'cut' && near(await frame(T + 0.04, 'cut'), BLUE) && near(await frame(T - 0.04, 'cut0'), RED), cutType);

  // drag the switch 60 px to the right
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await sleep(150);
  const box = await page.locator('.tl-angle-sw').boundingBox();
  const z = await page.evaluate(() => window.__store.zoom);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await sleep(150);
  const moved = await page.evaluate(() => window.__store.project.multicam.switches[0].t);
  check('dragging the switch moves it', Math.abs(moved - (T + 60 / z)) < 8 / z + 0.05, `${moved} vs ${T + 60 / z}`);

  // Delete removes the picked switch, undo brings it back
  await page.evaluate(() => document.querySelector('.tl-pop') && document.body.click());
  await page.keyboard.press('Delete');
  await sleep(150);
  const afterDel = await page.evaluate(() => window.__store.project.multicam.switches.length);
  await page.evaluate(() => window.__app.cmd('undo'));
  await sleep(150);
  const afterUndo = await page.evaluate(() => window.__store.project.multicam.switches.length);
  check('Delete removes the switch and undo brings it back', afterDel === 0 && afterUndo === 1, `${afterDel} ${afterUndo}`);

  // click a stretch to change which angle shows there
  const seg0 = await page.locator('.tl-angle-seg').first().boundingBox();
  await page.mouse.click(seg0.x + 20, seg0.y + seg0.height / 2);
  await page.waitForSelector('.tl-pop');
  const popText = await page.evaluate(() => document.querySelector('.tl-pop').textContent);
  await page.locator('.tl-pop .tl-pop-angles .chip').nth(1).click();
  await sleep(150);
  const startSw = await page.evaluate(() => window.__store.project.multicam.switches.map((s) => [+s.t.toFixed(2), s.a, s.type]));
  check('clicking the first stretch picks the angle shown at the start', /At the start show/.test(popText) && startSw.length === 2 && startSw[0][1] === 1 && startSw[0][2] === 'cut', JSON.stringify(startSw));
  await page.mouse.click(5, 5);
  await page.evaluate(() => window.__app.cmd('undo'));

  // settings: the sound comes from angle 2 instead
  await page.locator('.tl-angle-head button').click();
  await page.waitForSelector('.tl-pop');
  await page.locator('.tl-pop .tl-pop-angles .chip').nth(1).click();
  await sleep(150);
  const snd = await page.evaluate(() => {
    const p = window.__store.project;
    return { a: p.items[p.multicam.angles[0]].muted, b: p.items[p.multicam.angles[1]].muted };
  });
  check('Sound for the whole video switches which angle is heard', snd.a === true && snd.b === false, JSON.stringify(snd));
  await page.mouse.click(5, 5);

  // the export follows the switches
  const out = `${DIR}/angles.mp4`;
  const switchT = await page.evaluate(() => window.__store.project.multicam.switches[0].t);
  await page.evaluate(
    async ([out, t0, t1]) => {
      const { exportVideo } = await import('/src/export/export.js');
      await exportVideo(window.__store.project, { out, width: 640, height: 360, fps: 30, t0, t1 });
    },
    [out, switchT - 1, switchT + 1],
  );
  const grab = (ss) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', out, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
    return [...r.stdout.subarray(0, 3)];
  };
  const e0 = grab(0.4);
  const e1 = grab(1.6);
  check('the exported video changes angle at the switch', near(e0, RED) && near(e1, BLUE), JSON.stringify([e0, e1]));
  const vol = (ss) => {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(ss), '-t', '0.5', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    return Number((r.stderr.match(/mean_volume: (-?[\d.]+)/) || [])[1]);
  };
  check('the sound carries on through the switch', [0.2, 0.8, 1.3].every((ss) => vol(ss) > -45), JSON.stringify([0.2, 0.8, 1.3].map(vol)));
  await page.screenshot({ path: '/tmp/ve-angles.png' });

  // stop editing angles: ordinary clips again
  await page.evaluate(() => window.__app.cmd('stopAngles'));
  await sleep(200);
  const stopped = await page.evaluate(() => ({ mc: !!window.__store.project.multicam, lane: !!document.querySelector('.tl-angle-lane') }));
  check('Stop editing angles turns them back into ordinary clips', !stopped.mc && !stopped.lane, JSON.stringify(stopped));

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
