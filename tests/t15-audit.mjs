// Audit crawler: clicks every menu item, every left panel and its buttons,
// every inspector tab and its buttons for each kind of item, and every
// right-click menu entry, restoring the project after each click. Reports
// page errors, console errors, error toasts, panels that fail to render, and
// anything wider than its panel. Runs at 1536 x 864, a 1080p laptop at 125%.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import fs from 'node:fs';

const W = Number(process.env.AUDIT_W || 1536);
const H = Number(process.env.AUDIT_H || 864);
const only = process.argv[2] || 'all';
// AUDIT_MODE=audio crawls an audio project instead
const audioMode = process.env.AUDIT_MODE === 'audio';
const report = [];
const issue = (where, what) => report.push({ where, what });

await startServers();
try {
  const { browser, page, logs } = await openApp({ width: W, height: H });
  page.setDefaultTimeout(4000);
  // tools for the test machine, no real file dialogs
  await page.evaluate(async () => {
    window.prompt = () => null;
    window.confirm = () => false;
    window.alert = () => {};
    const { saveSettings } = await import('/src/core/settings.js');
    const be = await import('/src/backend/index.js');
    const { toolsDir, locateTools } = await import('/src/media/tools.js');
    saveSettings({ piperPath: '/tmp/tools/piper/piper', whisperPath: '/tmp/tools/whisper.cpp/build/bin/whisper-cli', whisperModel: 'small' });
    await be.mkdir(toolsDir('piper-voices'));
    await be.copy('/tmp/tools/voice/en-us-lessac-low.onnx', toolsDir('piper-voices', 'en_US-lessac-medium.onnx'));
    await be.copy('/tmp/tools/voice/en-us-lessac-low.onnx.json', toolsDir('piper-voices', 'en_US-lessac-medium.onnx.json'));
    await be.mkdir(toolsDir('whisper', 'models'));
    if (await be.exists('/tmp/tools/whisper.cpp/models/for-tests-ggml-tiny.bin')) await be.copy('/tmp/tools/whisper.cpp/models/for-tests-ggml-tiny.bin', toolsDir('whisper', 'models', 'ggml-small-q5_1.bin'));
    await locateTools();
    self.__ortProviders = ['wasm'];
    window.__audit = { toasts: [] };
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.classList?.contains('toast')) window.__audit.toasts.push({ kind: [...n.classList].find((c) => c.startsWith('toast-'))?.slice(6), text: n.textContent });
    }).observe(document.body, { childList: true, subtree: true });
  });
  if (audioMode) await page.evaluate(async () => (await import('/src/project-io.js')).createProject({ name: 'Audit audio', audioOnly: true }));
  const media = await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/photo.png`, `${FIX}/music.wav`, `${FIX}/speech.wav`, `${FIX}/talk.mp4`]);
  const setupAudio = async (media) => {
    const s = window.__store;
    const app = window.__app;
    const M = await import('/src/core/model.js');
    const [land, photo, music, speech, talk] = media.map((m) => s.project.media[m.id]);
    talk.transcript = { words: 'Welcome to the clinic um today we look at skin boosters'.split(' ').map((t, i) => ({ t, s: 0.3 + i * 0.4, e: 0.6 + i * 0.4 })) };
    app.addMedia([talk, speech, photo], 0);
    s.commit('music', (p) => {
      const second = p.tracks.filter((t) => t.kind === 'audio')[1];
      const mc = M.newClip(music, second.id, 0);
      p.items[mc.id] = mc;
    });
    s.seek(1);
    const items = Object.values(s.project.items);
    const out = { video: items.find((i) => i.mediaId === talk.id)?.id, speech: items.find((i) => i.mediaId === speech.id)?.id, music: items.find((i) => i.mediaId === music.id)?.id };
    void land;
    window.__snap = JSON.stringify(s.project);
    return out;
  };
  const ids = audioMode ? await page.evaluate(setupAudio, media) : await page.evaluate(async (media) => {
    const s = window.__store;
    const app = window.__app;
    const M = await import('/src/core/model.js');
    const E = await import('/src/core/edit.js');
    const C = await import('/src/ai/captions.js');
    const [land, photo, music, speech, talk] = media.map((m) => s.project.media[m.id]);
    app.addMedia([land, photo, talk], 0);
    s.commit('audio', (p) => {
      const mc = M.newClip(music, null, 0);
      mc.trackId = E.findFreeTrack(p, 'audio', 0, mc.duration);
      p.items[mc.id] = mc;
      const vc = M.newClip(speech, null, 2);
      vc.trackId = E.findFreeTrack(p, 'audio', 2, 2 + vc.duration);
      p.items[vc.id] = vc;
    });
    s.seek(1);
    await app.cmd('addText');
    await app.cmd('addShape', 'arrow');
    await app.cmd('addBlur');
    await app.cmd('addAdjustment');
    await app.cmd('addFx', 'sparkle');
    s.commit('caps', (p) => C.addCaptionItems(p, C.chunkWords(C.spreadWords('Welcome to the clinic today we look at skin boosters', 0.5, 5), { maxWords: 3 })));
    const items = Object.values(s.project.items);
    const pick = (f) => items.find(f)?.id;
    const out = {
      video: pick((i) => i.mediaId === land.id),
      photo: pick((i) => i.mediaId === photo.id),
      talk: pick((i) => i.mediaId === talk.id),
      music: pick((i) => i.mediaId === music.id),
      speech: pick((i) => i.mediaId === speech.id),
      text: pick((i) => i.type === 'text' && !i.caption),
      caption: pick((i) => i.caption),
      shape: pick((i) => i.type === 'shape'),
      blur: pick((i) => i.type === 'blur'),
      adjust: pick((i) => i.type === 'adjust'),
      fx: pick((i) => i.type === 'fx'),
    };
    await app.cmd('addSolid');
    out.solid = Object.values(s.project.items).find((i) => i.type === 'solid')?.id;
    window.__snap = JSON.stringify(s.project);
    return out;
  }, media);

  let errCursor = logs.length;
  let toastCursor = 0;
  let lastT = Date.now();
  const settle = async (label) => {
    if (process.env.AUDIT_LOG) console.log('..', label, Date.now() - lastT, 'ms since last');
    lastT = Date.now();
    await sleep(350);
    // stray "null", "undefined", "NaN" or "[object Object]" shown as text
    const stray = await page.evaluate(() => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.nodeValue.trim();
        if (!t || n.parentElement?.closest('textarea, script, style, .tr-doc')) continue;
        if (/^(null|undefined|NaN|\[object Object\])$|\b(undefined|NaN)\b|\[object Object\]/.test(t)) out.push(`${n.parentElement?.className || n.parentElement?.tagName}: "${t.slice(0, 60)}"`);
      }
      return out.slice(0, 5);
    });
    for (const x of stray) issue(label, 'stray text ' + x);

    // cancel background jobs a click started, then close anything left open
    await page.evaluate(() => document.querySelectorAll('.job .job-x').forEach((b) => b.click()));
    await sleep(150);
    for (let i = 0; i < 3; i++) {
      const open = await page.locator('.modal-overlay, .ctx, .prompter, .angle-bar, .rec-bar, .guide-card').count();
      if (!open) break;
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        window.__guide?.stop?.();
        document.querySelector('.ctx')?.remove();
        document.querySelectorAll('.angle-bar button').forEach((b) => /Close/.test(b.textContent) && b.click());
        document.querySelectorAll('.rec-bar button').forEach((b) => b.click());
      });
      await sleep(120);
    }
    const errs = logs.slice(errCursor).filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource|AbortError|Cancelled/.test(l));
    errCursor = logs.length;
    for (const e of errs) issue(label, e.slice(0, 300));
    const toasts = await page.evaluate((c) => window.__audit.toasts.slice(c), toastCursor);
    toastCursor += toasts.length;
    for (const t of toasts) if (t.kind === 'error') issue(label, 'error toast: ' + t.text.slice(0, 200));
    return toasts;
  };
  const restore = async () => {
    const t0 = Date.now();
    await page.evaluate(() => {
      const s = window.__store;
      window.__app.preview?.pause?.();
      window.__app.viewer?.setMode?.('transform');
      // reload only when the last click changed the project
      if (JSON.stringify(s.project) !== window.__snap) s.loadProject(JSON.parse(window.__snap), null);
      s.clearSelection();
      s.seek(1);
    });
    if (process.env.AUDIT_LOG) console.log('   restore', Date.now() - t0, 'ms');
  };
  const overflow = async (label, sel) => {
    const o = await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return [];
      const out = [];
      const rr = root.getBoundingClientRect();
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).position === 'fixed') continue;
        // skip anything inside a box that clips it
        let clipped = false;
        for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
          const ov = getComputedStyle(a);
          if (/hidden|auto|scroll|clip/.test(ov.overflowX + ov.overflow) && a.getBoundingClientRect().right <= rr.right + 2) {
            clipped = true;
            break;
          }
        }
        if (clipped) continue;
        if (r.right > rr.right + 2 && el.closest('.tl-wrap') == null) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || '').trim().slice(0, 30)}" sticks out ${Math.round(r.right - rr.right)}px`);
      }
      return [...new Set(out)].slice(0, 5);
    }, sel);
    for (const x of o) issue(label, 'layout: ' + x);
  };

  let clicks = 0;

  // ---- top menus -------------------------------------------------------------------
  if (only === 'all' || only === 'menus') {
    for (const menu of ['File', 'Edit', 'Add', 'Tools']) {
      await restore();
      await page.evaluate((id) => window.__store.select(id), ids.video);
      await page.click(`.menu-btn:has-text("${menu}")`);
      await sleep(150);
      const box = await page.locator('.ctx').boundingBox();
      if (box && (box.y < 0 || box.y + box.height > H)) issue(`${menu} menu`, `menu runs off the screen (${Math.round(box.y)} to ${Math.round(box.y + box.height)} of ${H})`);
      const labels = await page.locator('.ctx .ctx-item:not([disabled])').allTextContents();
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelector('.ctx')?.remove());
      for (let li = 0; li < labels.length; li++) {
        const label = labels[li];
        await restore();
        await page.evaluate((id) => window.__store.select(id), ids.video);
        const tc = Date.now();
        await page.click(`.menu-btn:has-text("${menu}")`).catch(async (e) => {
          const cover = await page.evaluate(() => { const el = document.elementFromPoint(100, 20); return el ? el.className + ' ' + (el.textContent || '').slice(0, 60) : 'none'; });
          issue(`${menu} > ${label}`, 'menu button blocked by ' + cover);
        });
        if (process.env.AUDIT_LOG) console.log('   menu click', Date.now() - tc, 'ms');
        await sleep(100);
        const item = page.locator('.ctx .ctx-item:not([disabled])').nth(li);
        await item.click({ timeout: 3000 }).catch((e) => issue(`${menu} > ${label}`, 'could not click: ' + e.message.slice(0, 100)));
        clicks++;
        await sleep(200);
        // a dialog that opened should have content and fit on screen
        const modal = (await page.locator('.modal').count()) ? await page.locator('.modal').first().boundingBox().catch(() => null) : null;
        if (modal && (modal.height > H || modal.y < 0)) issue(`${menu} > ${label}`, `dialog is taller than the screen (${Math.round(modal.height)}px)`);
        await settle(`${menu} > ${label}`);
      }
    }
  }

  // ---- left panels -----------------------------------------------------------------
  if (only === 'all' || only === 'panels') {
    const panels = await page.evaluate(() => window.__app.panels().map((p) => p.id));
    for (const id of panels) {
      await restore();
      await page.evaluate((id) => window.__store.select(id), ids.video);
      await page.evaluate((p) => window.__app.openPanel(p), id);
      await sleep(400);
      const failed = await page.evaluate(() => document.querySelector('.panel')?.textContent.includes('This panel failed to load'));
      if (failed) issue(`${id} panel`, 'failed to load');
      await overflow(`${id} panel`, '.panel');
      await settle(`${id} panel`);
      const n = await page.locator('.panel button:not([disabled]), .panel .card').count();
      for (let i = 0; i < n; i++) {
        await restore();
        await page.evaluate((id) => window.__store.select(id), ids.video);
        await page.evaluate((p) => window.__app.openPanel(p), id);
        await sleep(150);
        if (i >= (await page.locator('.panel button:not([disabled]), .panel .card').count())) continue;
        const b = page.locator('.panel button:not([disabled]), .panel .card').nth(i);
        const label = ((await b.getAttribute('title').catch(() => '')) || (await b.textContent().catch(() => '')) || '').trim().slice(0, 40);
        if (/Record|Import|Delete all/.test(label)) continue;
        await b.click({ timeout: 2000 }).catch(() => {});
        clicks++;
        await settle(`${id} panel > ${label || 'button ' + i}`);
      }
    }
  }

  // ---- inspector tabs and their buttons for every kind of item -----------------------
  if (only === 'all' || only === 'inspector') {
    for (const [kind, id] of Object.entries(ids)) {
      if (!id) {
        issue(`inspector ${kind}`, 'test item missing');
        continue;
      }
      await restore();
      await page.evaluate((id) => window.__store.select(id), id);
      await sleep(250);
      const tabs = await page.locator('.inspector .tabs button, .inspector .tab').allTextContents();
      for (const tab of tabs.length ? tabs : ['']) {
        await restore();
        await page.evaluate((id) => window.__store.select(id), id);
        await sleep(150);
        if (tab) await page.locator('.inspector .tabs button, .inspector .tab', { hasText: tab }).first().click();
        await sleep(200);
        await overflow(`inspector ${kind} > ${tab}`, '.inspector');
        await settle(`inspector ${kind} > ${tab}`);
        const n = await page.locator('.inspector .insp-body button:not([disabled])').count();
        for (let i = 0; i < n; i++) {
          await restore();
          await page.evaluate((id) => window.__store.select(id), id);
          await sleep(120);
          if (tab) await page.locator('.inspector .tabs button, .inspector .tab', { hasText: tab }).first().click();
          await sleep(120);
          if (i >= (await page.locator('.inspector .insp-body button:not([disabled])').count())) continue;
          const b = page.locator('.inspector .insp-body button:not([disabled])').nth(i);
          const label = ((await b.textContent().catch(() => '')) || (await b.getAttribute('title').catch(() => '')) || '').trim().slice(0, 40);
          await b.click({ timeout: 2000 }).catch(() => {});
          clicks++;
          await settle(`inspector ${kind} > ${tab} > ${label || 'button ' + i}`);
        }
        // sliders: drag each to its middle and back through the number box
        const sliders = await page.locator('.inspector .insp-body input[type=range]').count();
        for (let i = 0; i < sliders; i++) {
          await page.locator('.inspector .insp-body input[type=range]').nth(i).evaluate((el) => {
            el.value = (Number(el.min) + Number(el.max)) / 2;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }).catch(() => {});
        }
        if (sliders) await settle(`inspector ${kind} > ${tab} > sliders`);
        const selects = await page.locator('.inspector .insp-body select').count();
        for (let i = 0; i < selects; i++) {
          await page.locator('.inspector .insp-body select').nth(i).evaluate((el) => {
            for (const o of el.options) {
              el.value = o.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }).catch(() => {});
        }
        if (selects) await settle(`inspector ${kind} > ${tab} > selects`);
      }
    }
  }

  // ---- right-click menus --------------------------------------------------------------
  if (only === 'all' || only === 'context') {
    for (const [kind, id] of Object.entries(ids)) {
      if (!id) continue;
      await restore();
      const labels = await page.evaluate((id) => {
        const s = window.__store;
        s.select(id);
        window.__app.clipMenu(200, 200, s.project.items[id]);
        const l = [...document.querySelectorAll('.ctx .ctx-item:not([disabled])')].map((b) => b.textContent.replace(/(Ctrl|Shift|Del|[A-Z])+$/, '').trim());
        document.querySelector('.ctx')?.remove();
        return l;
      }, id);
      for (let li = 0; li < labels.length; li++) {
        const label = labels[li];
        await restore();
        await page.evaluate((id) => {
          const s = window.__store;
          s.select(id);
          s.seek(Math.min(s.project.items[id].start + 0.5, s.project.items[id].start + s.project.items[id].duration / 2));
          window.__app.clipMenu(200, 200, s.project.items[id]);
        }, id);
        await page.locator('.ctx .ctx-item:not([disabled])').nth(li).click({ timeout: 2000 }).catch((e) => issue(`right-click ${kind} > ${label}`, 'could not click: ' + e.message.slice(0, 80)));
        clicks++;
        await settle(`right-click ${kind} > ${label}`);
      }
    }
  }

  // ---- keyboard shortcuts -------------------------------------------------------------
  if (only === 'all' || only === 'keys') {
    const keys = ['Space', 's', 'Control+b', 'Delete', 'Shift+Delete', 'Control+d', 'Control+c', 'Control+x', 'Control+v', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowRight', 'ArrowUp', 'ArrowDown', 'j', 'l', 'i', 'o', 'm', 'k', 'f', 'c', 't', 'n', '+', '-', 'Shift+Z', 'Control+z', 'Control+y', 'Control+s', 'Control+e', 'Control+i', 'Escape'];
    for (const k of keys) {
      await restore();
      await page.evaluate((id) => {
        window.__store.select(id);
        document.activeElement?.blur?.();
      }, ids.video);
      await page.mouse.click(W / 2, 300).catch(() => {});
      await page.evaluate((id) => window.__store.select(id), ids.video);
      await page.keyboard.press(k);
      clicks++;
      await settle('key ' + k);
    }
    // a few keys whose effect is easy to check
    await restore();
    const split = await page.evaluate(async (id) => {
      const s = window.__store;
      s.select(id);
      s.seek(s.project.items[id].start + 1);
      const n0 = Object.keys(s.project.items).length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      return Object.keys(s.project.items).length - n0;
    }, ids.video);
    if (split !== 1) issue('key s', `split made ${split} new clips`);
  }

  await sleep(1500);
  await settle('after everything');
  fs.writeFileSync(audioMode ? '/tmp/ve-audit-audio.json' : '/tmp/ve-audit.json', JSON.stringify(report, null, 1));
  console.log(`clicked ${clicks} things`);
  for (const r of report) console.log(`ISSUE  ${r.where}: ${r.what}`);
  check(`audit found no problems (${clicks} clicks)`, report.length === 0, `${report.length} issues`);
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  check('no crash', false, e.message);
} finally {
  stopServers();
}
process.exit(summary());
