import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';

await startServers();
try {
  const { browser, page, logs } = await openApp({ query: '' });
  // start screen
  await page.waitForSelector('.welcome-modal', { timeout: 15000 });
  await page.screenshot({ path: '/tmp/ve-ui-welcome.png' });
  await page.click('.preset-card:has-text("YouTube 16:9, 1080p")');
  await page.fill('.welcome-modal .big-input', 'UI test');
  await page.click('.modal-foot .btn-primary');
  const s1 = await page.evaluate(() => ({ w: window.__store.project.settings.width, name: window.__store.project.name }));
  check('new project from the start screen', s1.w === 1920 && s1.name === 'UI test', JSON.stringify(s1));

  await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/music.wav`, `${FIX}/photo.png`]);
  await page.evaluate(() => window.__app.openPanel('media'));
  await sleep(300);
  // drag the first video card onto the timeline
  const card = await page.locator('.m-card:has-text("landscape.mp4")').boundingBox();
  const tl = await page.locator('.tl-track.main').boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + 60, card.y + 60, { steps: 5 });
  await page.mouse.move(tl.x + 100, tl.y + tl.height / 2, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const n1 = await page.evaluate(() => Object.keys(window.__store.project.items).length);
  check('drag a clip from the media panel onto the timeline', n1 === 1, String(n1));
  // double-click adds the photo at the playhead
  await page.dblclick('.m-card:has-text("photo.png")');
  const n2 = await page.evaluate(() => Object.keys(window.__store.project.items).length);
  check('double-click adds media', n2 === 2);

  // select the clip and try every inspector tab
  const clipEl = page.locator('.tl-clip').first();
  await clipEl.click({ position: { x: 30, y: 20 } });
  await sleep(200);
  const tabs = await page.locator('.inspector .tab').allTextContents();
  check('video clip inspector tabs', tabs.length >= 7, tabs.join(', '));
  for (const t of tabs) {
    await page.click(`.inspector .tab:has-text("${t}")`);
    await sleep(120);
  }
  await page.click('.inspector .tab:has-text("Colour")');
  await page.click('.inspector .chip:has-text("Cinematic")');
  const look = await page.evaluate(() => window.__store.primary?.color?.filter);
  check('apply a look from the inspector', look === 'cinematic', look);
  await page.screenshot({ path: '/tmp/ve-ui-colour.png' });

  // keyframe button in the Video tab
  await page.click('.inspector .tab:has-text("Video")');
  await page.evaluate(() => window.__app.seek(window.__store.primary.start + 1));
  await page.click('.inspector .slider-row[data-prop="scale"] .kfbtn');
  const kf = await page.evaluate(() => window.__store.primary.kf.scale?.length || 0);
  check('keyframe button adds a keyframe', kf === 1);

  // drag the box on the preview to move the clip
  await page.evaluate(() => window.__app.seek(window.__store.primary.start + 1.5));
  await sleep(300);
  console.log('overlay debug', await page.evaluate(() => {
    const v = window.__app.viewer;
    const it = window.__store.primary;
    return { sel: !!v.selectedVisual(), prim: it?.type, start: it?.start, dur: it?.duration, ph: window.__store.playhead, kids: v.overlay.children.length, playing: window.__store.playing, mode: v.mode, html: v.overlay.innerHTML.slice(0, 200) };
  }));
  const box = await page.locator('.viewer-overlay .box').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
  }
  const pos = await page.evaluate(() => ({ x: window.__store.primary.props.x, y: window.__store.primary.props.y }));
  check('drag on the preview moves the clip', Math.abs(pos.x) > 20, JSON.stringify(pos));

  // split with the keyboard, then undo
  await page.evaluate(() => window.__app.seek(window.__store.primary.start + 2));
  await page.locator('.tl-scroll').click({ position: { x: 5, y: 150 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('s');
  const n3 = await page.evaluate(() => Object.keys(window.__store.project.items).length);
  check('S splits at the playhead', n3 === 3, String(n3));
  await page.keyboard.press('Control+z');
  const n4 = await page.evaluate(() => Object.keys(window.__store.project.items).length);
  check('Ctrl+Z undoes the split', n4 === 2, String(n4));

  // trim the end of the first clip by dragging its handle
  const firstId = await page.evaluate(() => Object.values(window.__store.project.items).sort((a, b) => a.start - b.start)[0].id);
  const first = page.locator(`.tl-clip[data-id="${firstId}"]`);
  const fb = await first.boundingBox();
  const d0 = await page.evaluate(() => Object.values(window.__store.project.items).sort((a, b) => a.start - b.start)[0].duration);
  await page.mouse.move(fb.x + fb.width - 3, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width - 80, fb.y + fb.height / 2, { steps: 8 });
  await page.mouse.up();
  const d1 = await page.evaluate(() => Object.values(window.__store.project.items).sort((a, b) => a.start - b.start)[0].duration);
  check('dragging the right edge trims the clip', d1 < d0 - 0.1, `${d0} -> ${d1}`);
  const gaps = await page.evaluate(() => {
    const it = Object.values(window.__store.project.items).sort((a, b) => a.start - b.start);
    return Math.abs(it[1].start - (it[0].start + it[0].duration));
  });
  check('magnetic track closes the gap after a trim', gaps < 0.01, String(gaps));

  // context menu
  await first.click({ button: 'right', position: { x: 20, y: 20 } });
  await page.waitForSelector('.ctx');
  await page.click('.ctx-item:has-text("Duplicate")');
  const n5 = await page.evaluate(() => Object.keys(window.__store.project.items).length);
  check('right-click menu duplicates', n5 === 3, String(n5));

  // every panel opens without errors, and a few cards work
  for (const id of ['media', 'audio', 'text', 'captions', 'transitions', 'effects', 'templates', 'ai', 'brand']) {
    await page.click(`.rail-btn[data-panel="${id}"]`);
    await sleep(250);
    await page.screenshot({ path: `/tmp/ve-ui-panel-${id}.png` });
  }
  await page.click('.rail-btn[data-panel="text"]');
  await page.click('.card:has-text("Lower third")');
  const texts = await page.evaluate(() => Object.values(window.__store.project.items).filter((i) => i.type === 'text').length);
  check('lower third preset adds two text items', texts === 2, String(texts));
  // select a text item and check its tabs render
  await page.evaluate(() => {
    const t = Object.values(window.__store.project.items).find((i) => i.type === 'text');
    window.__store.select(t.id);
    window.__app.seek(t.start + 0.8);
  });
  await sleep(200);
  const ttabs = await page.locator('.inspector .tab').allTextContents();
  for (const t of ttabs) {
    await page.click(`.inspector .tab:has-text("${t}")`);
    await sleep(100);
  }
  check('text inspector tabs', ttabs.includes('Text') && ttabs.includes('Animation'), ttabs.join(', '));
  await page.click('.inspector .tab:has-text("Text")');
  await page.fill('.inspector textarea.text-edit', 'Dr. Gid');
  await page.locator('.inspector textarea.text-edit').blur();
  const tt = await page.evaluate(() => window.__store.primary.text);
  check('editing text in the inspector', tt === 'Dr. Gid', tt);
  await page.screenshot({ path: '/tmp/ve-ui-text.png' });

  // transition via the panel
  await page.evaluate(() => {
    const clips = Object.values(window.__store.project.items).filter((i) => i.type === 'clip').sort((a, b) => a.start - b.start);
    window.__store.select(clips[1].id);
    window.__app.openPanel('transitions');
  });
  await sleep(200);
  await page.click('.trans-grid .card:has-text("Whip pan")');
  const tr = await page.evaluate(() => window.__store.primary.transitionIn?.type);
  check('transition from the panel', tr === 'whip', tr);

  // shapes, blur, adjustment, solid
  for (const c of ['addShape', 'addBlur', 'addAdjustment', 'addSolid']) await page.evaluate((c) => window.__app.cmd(c, c === 'addShape' ? 'arrow' : undefined), c);
  const kinds = await page.evaluate(() => [...new Set(Object.values(window.__store.project.items).map((i) => i.type))].sort());
  check('shape, blur, adjustment and colour items', ['adjust', 'blur', 'clip', 'shape', 'solid', 'text'].every((k) => kinds.includes(k)), kinds.join(','));
  for (const type of ['shape', 'blur', 'adjust', 'solid']) {
    await page.evaluate((type) => {
      const it = Object.values(window.__store.project.items).find((i) => i.type === type);
      window.__store.select(it.id);
    }, type);
    await sleep(100);
    const tb = await page.locator('.inspector .tab').allTextContents();
    for (const t of tb) {
      await page.click(`.inspector .tab:has-text("${t}")`);
      await sleep(80);
    }
  }
  // audio clip inspector
  await page.evaluate(() => {
    const s = window.__store;
    const m = Object.values(s.project.media).find((x) => x.kind === 'audio');
    window.__app.addMedia([m], 0);
  });
  await sleep(200);
  const atabs = await page.locator('.inspector .tab').allTextContents();
  check('audio clip inspector tabs', atabs.includes('Audio'), atabs.join(', '));

  // dialogs
  await page.click('.export-btn');
  await page.waitForSelector('.export');
  await page.click('.seg-btn:has-text("GIF")');
  await page.click('.seg-btn:has-text("Audio only")');
  await page.click('.seg-btn:has-text("Video")');
  await page.screenshot({ path: '/tmp/ve-ui-export.png' });
  await page.keyboard.press('Escape');
  await page.click('.topbar .ibtn[title="Settings"]');
  await page.waitForSelector('.settings');
  await page.screenshot({ path: '/tmp/ve-ui-settings.png' });
  await page.keyboard.press('Escape');
  check('export and settings dialogs open and close', !(await page.locator('.modal').count()));

  // menus
  await page.click('.menu-btn:has-text("Edit")');
  await page.waitForSelector('.ctx');
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 300);

  // save with Ctrl+S
  await page.evaluate(() => (window.__testDialogs = ['/tmp/ve-test/documents/UI test.vproj']));
  await page.keyboard.press('Control+s');
  await sleep(500);
  const saved = await page.evaluate(() => window.__store.projectPath);
  check('Ctrl+S saves', saved === '/tmp/ve-test/documents/UI test.vproj', saved);

  // play for a moment
  await page.keyboard.press(' ');
  await sleep(1200);
  await page.keyboard.press(' ');
  const ph = await page.evaluate(() => window.__store.playhead);
  check('space plays and pauses', ph > 0.5, String(ph));
  await page.screenshot({ path: '/tmp/ve-ui-final.png' });

  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 6).join(' | ').slice(0, 1000));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
