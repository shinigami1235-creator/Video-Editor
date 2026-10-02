// Start screen: new project, recent projects and crash recovery.

import { h, icon, button, clear } from './dom.js';
import { modal, toast } from './notify.js';
import { store } from '../core/store.js';
import { CANVAS_PRESETS } from '../core/model.js';
import { createProject, openProject, openProjectPath, findRecoverable, restoreAutosave } from '../project-io.js';
import { basename } from '../backend/index.js';

export async function showWelcome(app, { newOnly = false } = {}) {
  const recover = newOnly ? [] : await findRecoverable().catch(() => []);
  // "Match my video" takes the shape of the first video put on the timeline
  const MATCH = { id: 'match', name: 'Match my video', width: 1920, height: 1080, match: true };
  const PRESETS = [MATCH, ...CANVAS_PRESETS];
  // Match my video is picked until a shape is chosen on this version of the start screen
  let preset = (store.settings.presetPicked && PRESETS.find((c) => c.id === store.settings.lastPreset)) || MATCH;
  let fps = 30;
  const name = h('input', { type: 'text', value: 'Untitled project', class: 'big-input' });
  const grid = h('div', { class: 'preset-cards' });
  const drawGrid = () => {
    clear(grid);
    for (const c of PRESETS) {
      const ratio = c.width / c.height;
      const box = c.match ? h('div', { class: 'aspect match' }) : h('div', { class: 'aspect', style: { width: (ratio >= 1 ? 54 : 54 * ratio) + 'px', height: (ratio >= 1 ? 54 / ratio : 54) + 'px' } });
      const b = h('button', { class: 'preset-card' + (c.id === preset.id ? ' active' : ''), type: 'button', onclick: () => {
        preset = c;
        drawGrid();
      } }, h('div', { class: 'aspect-wrap' }, box), h('div', { class: 'pc-name' }, c.name), h('div', { class: 'pc-sub' }, c.match ? 'Same shape as the video' : `${c.width} x ${c.height}`));
      grid.append(b);
    }
  };
  drawGrid();
  const fpsSel = h('select', { onchange: () => (fps = Number(fpsSel.value)) }, ...[24, 25, 30, 60].map((f) => h('option', { value: f, selected: f === 30 }, f + ' fps')));
  const recent = (store.settings.recentProjects || []).slice(0, 6);
  // video or audio project
  let audio = store.settings.lastProjectType === 'audio';
  const videoOpts = h('div', { class: 'stack' }, h('div', { class: 'row col' }, h('label', {}, 'Where it will be posted'), grid), h('div', { class: 'row' }, h('label', {}, 'Frame rate'), fpsSel));
  const audioOpts = h('div', { class: 'stack' }, h('p', { class: 'hint' }, 'For podcasts, voice-overs, lecture audio and music edits. The preview shows the sound wave and levels instead of a picture, and the export makes MP3, M4A or WAV.'));
  const typeSeg = h('div', { class: 'seg wide' });
  const drawType = () => {
    typeSeg.replaceChildren(
      ...[
        [false, 'Video', 'film'],
        [true, 'Audio', 'music'],
      ].map(([a, l, ic]) =>
        h('button', { class: 'seg-btn' + (audio === a ? ' active' : ''), type: 'button', onclick: () => {
          audio = a;
          drawType();
        } }, icon(ic, 14), h('span', {}, l)),
      ),
    );
    videoOpts.style.display = audio ? 'none' : '';
    audioOpts.style.display = audio ? '' : 'none';
    quick.replaceChildren(
      audio
        ? button('Edit an audio file', async () => {
            m.close();
            app.cmd('editAudioFile');
          }, { icon: 'music', title: 'Open a recording or song and start cutting it' })
        : null,
      button(audio ? 'Join audio files' : 'Stitch videos together', async () => {
        m.close();
        const { showStitch } = await import('./stitch.js');
        showStitch(app, { fresh: true, audio });
      }, { icon: audio ? 'music' : 'film', title: audio ? 'Pick several recordings and join them into a new audio project' : 'Pick several videos and join them into a new project' }),
    );
  };
  const quick = h('div', { class: 'welcome-quick' });
  const left = h(
    'div',
    { class: 'welcome-new' },
    h('h3', {}, 'New project'),
    typeSeg,
    h('div', { class: 'row col' }, h('label', {}, 'Name'), name),
    videoOpts,
    audioOpts,
    quick,
    button('New here? Open the how-to guides', () => {
      m.close();
      app.cmd('guides');
    }, { kind: 'link', icon: 'help' }),
  );
  drawType();
  const right = h('div', { class: 'welcome-side' });
  if (recover.length) {
    right.append(h('h3', {}, 'Recover unsaved work'));
    for (const r of recover.slice(0, 3))
      right.append(
        h('button', { class: 'recent recover', type: 'button', onclick: async () => {
          m.close();
          await restoreAutosave(r);
          toast('Restored ' + r.name + '. Save it to keep it.');
        } }, icon('undo', 16), h('span', {}, r.name), h('span', { class: 'dim' }, new Date(r.modified).toLocaleString())),
      );
  }
  if (!newOnly) {
    right.append(h('h3', {}, 'Recent'));
    if (!recent.length) right.append(h('p', { class: 'hint' }, 'Projects you save show up here.'));
    for (const r of recent) right.append(h('button', { class: 'recent', type: 'button', title: r.path, onclick: async () => {
      m.close();
      await openProjectPath(r.path);
    } }, icon('film', 16), h('span', {}, r.name), h('span', { class: 'dim' }, basename(r.path))));
    right.append(button('Open a project file', async () => {
      m.close();
      await openProject();
    }, { icon: 'folder' }));
  }
  const body = h('div', { class: 'welcome' }, left, newOnly ? null : right);
  const m = modal(newOnly ? 'New project' : 'Video Editor', body, {
    width: newOnly ? 640 : 900,
    cls: 'welcome-modal',
    actions: [
      {
        label: 'Create project',
        primary: true,
        run: (close) => {
          createProject({ name: name.value.trim() || 'Untitled project', width: preset.width, height: preset.height, fps, audioOnly: audio, matchFirst: !!preset.match });
          if (!audio) {
            app.saveSetting('lastPreset', preset.id);
            app.saveSetting('presetPicked', true);
          }
          app.saveSetting('lastProjectType', audio ? 'audio' : 'video');
          close(true);
        },
      },
    ],
  });
  setTimeout(() => name.select(), 50);
}
