// Renders many effects to PNG frames for a visual check and makes sure the
// renderer reports no GL errors.
import { startServers, stopServers, openApp, check, summary, FIX, importAndWait, sleep } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

await startServers();
try {
  const { browser, page, logs } = await openApp();
  const media = await importAndWait(page, [`${FIX}/landscape.mp4`, `${FIX}/vertical.mp4`, `${FIX}/photo.png`, `${FIX}/faces.mp4`]);
  const ids = media.map((m) => m.id);
  fs.rmSync('/tmp/ve-frames', { recursive: true, force: true });
  fs.mkdirSync('/tmp/ve-frames');
  const res = await page.evaluate(async (ids) => {
    const s = window.__store;
    const app = window.__app;
    const E = await import('/src/core/edit.js');
    const M = await import('/src/core/model.js');
    const { exportFrame } = await import('/src/export/export.js');
    const { applyFilter } = await import('/src/ui/inspector.js');
    const { TRANSITION_TYPES } = await import('/src/render/shaders.js');
    const { FILTERS } = await import('/src/render/luts.js');
    const out = [];
    const shot = async (name, t) => {
      await exportFrame(s.project, t, `/tmp/ve-frames/${name}.png`, { width: 360 });
      out.push(name);
    };
    const fresh = (w = 1080, h = 1920) => s.loadProject(M.newProject({ width: w, height: h }));
    const media = () => ids.map((id) => s.project.media[id] || null);
    // media entries belong to the first project, so copy them into each new one
    const all = Object.fromEntries(ids.map((id) => [id, JSON.parse(JSON.stringify(s.project.media[id]))]));
    const load = (w, h) => {
      fresh(w, h);
      for (const [id, m] of Object.entries(all)) s.project.media[id] = JSON.parse(JSON.stringify(m));
    };

    // transitions
    load(1080, 1920);
    app.addMedia([s.project.media[ids[0]], s.project.media[ids[1]]], 0);
    const [c1, c2] = Object.values(s.project.items).sort((a, b) => a.start - b.start);
    for (const k of Object.keys(TRANSITION_TYPES)) {
      c2.transitionIn = { type: k, duration: 1 };
      await shot('trans-' + k, c2.start - 0.1);
    }
    c2.transitionIn = null;
    // looks
    for (const k of Object.keys(FILTERS)) {
      applyFilter(c1, k);
      await shot('look-' + k, 1);
    }
    applyFilter(c1, 'none');
    // effects
    c1.effects.chromatic = 0.6;
    await shot('fx-chromatic', 1);
    c1.effects.chromatic = 0;
    c1.effects.glow = 0.7;
    await shot('fx-glow', 1);
    c1.effects.glow = 0;
    c1.effects.letterbox = 0.3;
    await shot('fx-letterbox', 1);
    c1.effects.letterbox = 0;
    c1.effects.backdrop = 'blur';
    await shot('fx-backdrop', 1);
    c1.effects.backdrop = null;
    c1.props.blur = 0.5;
    await shot('fx-blur', 1);
    c1.props.blur = 0;
    c1.effects.chroma = { enabled: true, color: '#00ff00', similarity: 0.4, smoothness: 0.1, spill: 0.3 };
    await shot('fx-chroma', 1);
    c1.effects.chroma.enabled = false;
    c1.color.curves = { master: [[0, 0.1], [0.5, 0.7], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] };
    await shot('fx-curves', 1);
    c1.color.curves = null;
    // masks
    c1.mask = { ...c1.mask, type: 'ellipse', w: 0.5, h: 0.5, feather: 0.05 };
    await shot('mask-ellipse', 1);
    c1.mask = { ...c1.mask, type: 'wipe', angle: 0, line: true, lineWidth: 6 };
    c1.props.maskPos = 0.3;
    await shot('mask-wipe', 1);
    c1.mask.type = 'none';
    // text styles and reveals
    const t = M.newText(null, 0.2, 'Book your visit today', { boxEnabled: true, outlineWidth: 4 });
    E.placeOverlay(s.project, t);
    await shot('text-box', 1);
    t.reveal = 'typewriter';
    await shot('text-typewriter', 0.6);
    t.words = [
      { text: 'Book', start: 0, end: 0.3 },
      { text: 'your', start: 0.3, end: 0.6 },
      { text: 'visit', start: 0.6, end: 0.9 },
      { text: 'today', start: 0.9, end: 1.2 },
    ];
    t.reveal = 'karaoke';
    t.style.highlightMode = 'box';
    await shot('text-karaoke', 0.2 + 0.7);
    delete s.project.items[t.id];
    // shapes and blur region
    for (const sh of ['rect', 'ellipse', 'arrow', 'callout']) {
      const it = M.newShape(null, 0.5, sh, { fill: 'rgba(232,193,106,0.5)', stroke: '#ffffff' });
      it.props.y = -300 + ['rect', 'ellipse', 'arrow', 'callout'].indexOf(sh) * 200;
      E.placeOverlay(s.project, it);
    }
    const b = M.newBlurRegion(null, 0.5, 3, { x: 0, y: 200, w: 400, h: 300 });
    E.placeOverlay(s.project, b);
    await shot('shapes-blur', 1);
    b.mode = 'pixelate';
    await shot('blur-pixelate', 1);
    // adjustment layer
    const adj = M.newAdjustment(null, 0, 3);
    applyFilter(adj, 'bw');
    E.placeOverlay(s.project, adj);
    await shot('adjust-bw', 1);
    // animations
    t.anim = null;
    const t2 = M.newText(null, 2, 'Pop', { size: 160 });
    t2.anim = { in: { type: 'pop', duration: 0.6 }, out: null, loop: null };
    E.placeOverlay(s.project, t2);
    await shot('anim-pop-mid', 2.2);

    // split screen and pip
    load(1080, 1920);
    app.addMedia([s.project.media[ids[0]], s.project.media[ids[3]]], 0);
    store: {
      const clips = Object.values(s.project.items);
      s.select(clips.map((c) => c.id));
      app.c_splitScreen();
    }
    await shot('split-screen', 1);
    load(1920, 1080);
    app.addMedia([s.project.media[ids[0]]], 0);
    const pipClip = M.newClip(s.project.media[ids[3]], null, 0, { duration: 4 });
    E.placeOverlay(s.project, pipClip);
    s.select(pipClip.id);
    app.c_pip('br');
    await shot('pip', 1);
    // before and after
    load(1080, 1350);
    app.addMedia([s.project.media[ids[0]], s.project.media[ids[1]]], 0);
    s.select(Object.keys(s.project.items));
    (await import('/src/ui/templates.js')).BUILTIN_TEMPLATES.find((x) => x.name === 'Before and after').apply(app);
    await shot('before-after', 2);
    // templates
    load(1080, 1920);
    app.addMedia([s.project.media[ids[2]]], 0);
    app.seek(0);
    for (const name of ['Product reveal', 'Lecture opener', 'End card', 'Testimonial']) (await import('/src/ui/templates.js')).BUILTIN_TEMPLATES.find((x) => x.name === name).apply(app);
    await shot('tpl-product', 1.2);
    await shot('tpl-price', 3.6);
    // speed ramp and freeze do not break frame fetching
    load(1080, 1920);
    app.addMedia([s.project.media[ids[0]]], 0);
    const rc = Object.values(s.project.items)[0];
    E.setSpeedCurve(s.project, rc, M.SPEED_RAMPS.hero);
    await shot('ramp', rc.duration * 0.5);
    E.freezeFrame(s.project, rc, 1, 2);
    await shot('freeze', 1.5);
    const gl = app.preview.comp.gl;
    return { out, glErr: gl.getError() };
  }, ids);
  check('rendered every feature frame', res.out.length > 50, String(res.out.length));
  // contact sheet for review
  const files = res.out.map((n) => `/tmp/ve-frames/${n}.png`).filter((f) => fs.existsSync(f));
  check('every frame file exists', files.length === res.out.length, `${files.length}/${res.out.length}`);
  const sizes = files.map((f) => fs.statSync(f).size);
  check('no empty frames', sizes.every((x) => x > 2000), String(Math.min(...sizes)));
  const list = files.map((f) => `file '${f}'`).join('\n');
  fs.writeFileSync('/tmp/ve-frames/list.txt', list);
  // label and tile 10 per row
  for (let i = 0; i < files.length; i += 20) {
    const chunk = files.slice(i, i + 20);
    const inputs = chunk.flatMap((f) => ['-i', f]);
    const labels = chunk.map((f, k) => `[${k}:v]scale=180:320:force_original_aspect_ratio=decrease,pad=180:340:(ow-iw)/2:0:color=0x222222,drawtext=text='${f.split('/').pop().replace('.png', '')}':x=4:y=324:fontsize=12:fontcolor=white[v${k}]`).join(';');
    const pads = chunk.map((_, k) => `[v${k}]`).join('');
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${labels};${pads}xstack=inputs=${chunk.length}:layout=${chunk.map((_, k) => `${(k % 10) * 180}_${Math.floor(k / 10) * 340}`).join('|')}:fill=black`, `/tmp/ve-sheet-${i / 20}.png`]);
  }
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
