// "How do I..." guides. Picking a task lights up the button to press, one step
// at a time, and moves on by itself when the step is done. Each step has a
// done() check on the project or the screen, and the guide always shows the
// first step that is not done yet, so it follows along when someone jumps
// ahead or undoes.

import { h, icon, button, keyLabel } from './dom.js';
import { store } from '../core/store.js';
import { modal } from './notify.js';
import { isVisualItem, itemEnd } from '../core/model.js';

// ---------------------------------------------------------------------------
// Finding things on the screen
// ---------------------------------------------------------------------------

const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/** First visible element matching sel whose text is `text` (or starts with it). */
function byText(sel, text) {
  const all = [...document.querySelectorAll(sel)].filter(shown);
  const t = text.toLowerCase();
  const clean = (el) => el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
  return all.find((el) => clean(el) === t) || all.find((el) => clean(el).startsWith(t)) || null;
}
const q = (sel) => [...document.querySelectorAll(sel)].find(shown) || null;
const byTitle = (title) => q(`[title="${title}"]`);
const modalTitled = (title) => [...document.querySelectorAll('.modal')].find((m) => shown(m) && m.querySelector('.modal-head h2')?.textContent.trim() === title) || null;
const menuOpen = (item) => !!byText('.ctx .ctx-item span', item);

// ---------------------------------------------------------------------------
// Project checks
// ---------------------------------------------------------------------------

const P = () => store.project;
const audioProject = () => !!P().settings.audioOnly;
const media = (it) => (it?.mediaId ? P().media[it.mediaId] : null);

const KINDS = {
  video: (it) => it.type === 'clip' && isVisualItem(P(), it) && media(it)?.kind === 'video',
  visual: (it) => it.type === 'clip' && isVisualItem(P(), it),
  videoSound: (it) => it.type === 'clip' && isVisualItem(P(), it) && media(it)?.kind === 'video' && media(it)?.hasAudio !== false,
  sound: (it) => it.type === 'clip' && media(it)?.hasAudio !== false && media(it)?.kind !== 'image',
};
const MEDIA_KINDS = {
  video: (m) => m.kind === 'video',
  visual: (m) => m.kind === 'video' || m.kind === 'image',
  videoSound: (m) => m.kind === 'video' && m.hasAudio !== false,
  sound: (m) => m.kind === 'audio' || (m.kind === 'video' && m.hasAudio !== false),
};
const NOUN = { video: 'a video', visual: 'a video or photo', videoSound: 'a video with sound', sound: 'a video or sound file' };

const clipsOf = (kind) => Object.values(P().items).filter(KINDS[kind]);
const hasClip = (kind) => clipsOf(kind).length > 0;
const hasMedia = (kind) => Object.values(P().media).some((m) => m.status !== 'error' && MEDIA_KINDS[kind](m));
const selected = (kind) => !!store.primary && KINDS[kind](store.primary);
const clipEl = (kind) => {
  const it = clipsOf(kind)[0];
  return it ? q(`.tl-clip[data-id="${it.id}"]`) : null;
};
const tabOpen = (name) => !!byText('.inspector .tab.active', name);
const exporting = () => !!q('.export-progress .job-bar, .export-done');

// ---------------------------------------------------------------------------
// Step builders
// ---------------------------------------------------------------------------

function panelStep(id, name, extraDone = () => false) {
  return { text: `Open the ${name} panel on the left.`, target: () => q(`.rail-btn[data-panel="${id}"]`), done: () => window.__app?.panel === id || extraDone(), latch: true };
}

function tabStep(name) {
  return { text: `Open the ${name} tab on the right.`, target: () => byText('.inspector .tab', name), done: () => tabOpen(name), latch: true };
}

/** A button to press. It counts as done once clicked, or when `alsoDone` is true. */
function pressStep(text, find, alsoDone = () => false) {
  return { text, target: find, clicked: true, done: alsoDone };
}

/** Steps that end with a clip of `kind` on the timeline (skipped when there is one). */
function haveClip(kind) {
  const noun = NOUN[kind];
  return [
    panelStep('media', 'Media', () => hasClip(kind) || hasMedia(kind)),
    { text: `Click Import and pick ${noun} from your computer.`, target: () => byText('.panel button', 'Import'), done: () => hasClip(kind) || hasMedia(kind) },
    {
      text: `Drag ${noun} from the Media panel onto the timeline, or click the + on its card.`,
      target: () => {
        const m = Object.values(P().media).find((x) => x.status !== 'error' && MEDIA_KINDS[kind](x));
        return (m && q(`.m-card[data-id="${m.id}"]`)) || q('.m-card');
      },
      done: () => hasClip(kind),
    },
  ];
}

/** haveClip, then select it. */
function selectClip(kind) {
  return [...haveClip(kind), { text: `Click the ${kind === 'sound' ? 'clip' : kind === 'visual' ? 'clip' : 'video'} on the timeline to select it.`, target: () => (store.primary && KINDS[kind](store.primary) ? null : clipEl(kind)), done: () => selected(kind) }];
}

const waitJob = (text, goal) => ({ text, target: () => q('.jobs .job') || q('.jobs'), done: goal });

// ---------------------------------------------------------------------------
// The guides
// ---------------------------------------------------------------------------

export const GUIDES = [
  // ---- basics ----
  {
    id: 'add',
    group: 'Basics',
    title: 'Add a video to the timeline',
    steps: () => haveClip('visual'),
    finish: 'The video is on the timeline. Double-click a card in the Media panel to add it at the playhead.',
  },
  {
    id: 'cut',
    group: 'Basics',
    title: 'Cut out a part of a clip',
    steps: () => [
      ...selectClip('visual'),
      {
        text: 'Click the ruler above the tracks to move the playhead to where the cut goes.',
        target: () => q('.tl-ruler'),
        done: () => {
          const it = store.primary;
          return !!it && store.playhead > it.start + 0.05 && store.playhead < itemEnd(it) - 0.05;
        },
      },
      pressStep('Press S, or click the scissors above the timeline, to split the clip.', () => byTitle('Split at playhead (S)')),
      { text: 'Click the piece you don\'t want and press Delete.', target: () => q('.tl-clip.selected') || q('.tl-tracks'), goal: (did) => did('Delete') || did('Delete and close gap') },
    ],
    finish: 'The part is gone. Shift+Delete deletes a clip and closes the gap it leaves.',
  },
  {
    id: 'trim',
    group: 'Basics',
    title: 'Trim the start or end of a clip',
    steps: () => [
      ...selectClip('visual'),
      {
        text: 'Drag the left or right edge of the clip.',
        target: () => {
          if (!store.primary) return null;
          const view = q('.tl-scroll')?.getBoundingClientRect();
          const inView = (el) => el && view && el.getBoundingClientRect().left > view.left + 150 && el.getBoundingClientRect().right < view.right;
          const right = q(`.tl-clip[data-id="${store.primary.id}"] .tl-handle.right`);
          const left = q(`.tl-clip[data-id="${store.primary.id}"] .tl-handle.left`);
          return inView(right) ? right : inView(left) ? left : right;
        },
        goal: (did) => did('Trim start') || did('Trim end'),
      },
    ],
    finish: 'The clip is shorter. Drag the edge back out to get the rest back.',
  },
  {
    id: 'stitch',
    group: 'Basics',
    title: 'Stitch several videos together',
    video: true,
    steps: () => [
      { text: 'Click Add at the top.', target: () => byText('.menu-btn', 'Add'), done: () => menuOpen('Stitch videos') || !!modalTitled('Stitch videos') },
      { text: 'Click Stitch videos, then pick the videos.', target: () => byText('.ctx .ctx-item', 'Stitch videos'), done: () => !!modalTitled('Stitch videos') },
      { text: 'Put the clips in order with the arrows, pick a transition and click Stitch.', target: () => byText('.modal-foot button', 'Stitch'), goal: (did) => did('Stitch videos') },
    ],
    finish: 'The videos are joined end to end on the main track.',
  },

  // ---- sound ----
  {
    id: 'separate',
    group: 'Sound',
    title: 'Separate the sound from a video',
    video: true,
    steps: () => [...selectClip('videoSound'), tabStep('Audio'), { text: 'Click Separate audio.', target: () => byText('.inspector button', 'Separate audio'), goal: (did) => did('Separate audio') }],
    finish: 'The sound is its own clip on an audio track now. Cut, move or change it without touching the video.',
  },
  {
    id: 'volume',
    group: 'Sound',
    title: 'Change the volume of a clip',
    steps: () => [
      ...selectClip('sound'),
      { text: 'Drag the yellow line on the clip up or down. Click the line to add a point where the volume changes.', target: () => (store.primary ? q(`.tl-clip[data-id="${store.primary.id}"] .tl-vol-hit`) : null), goal: (did) => did('Volume') || did('Volume point') },
    ],
    finish: 'The volume changed. Double-click a point on the line to remove it.',
  },
  {
    id: 'voiceover',
    group: 'Sound',
    title: 'Record a voice-over',
    steps: () => [
      panelStep('audio', 'Audio'),
      { text: 'Click the ruler above the tracks where the voice-over should start, then click Record.', target: () => byText('.panel button', 'Record'), goal: (did) => did('Voiceover') },
    ],
    finish: 'The recording is on an audio track. The files are kept in Documents\\Video Editor Recordings.',
  },
  {
    id: 'duck',
    group: 'Sound',
    title: 'Lower the music under a voice-over',
    steps: () => [
      ...haveClip('sound'),
      { text: 'Click the voice-over clip on the timeline to select it.', target: () => clipEl('sound'), done: () => selected('sound') },
      tabStep('Audio'),
      { text: 'Click Lower other sounds here.', target: () => byText('.inspector button', 'Lower other sounds here'), goal: (did) => did('Lower other sounds') },
    ],
    finish: 'Every other sound dips while the voice-over plays and comes back after it.',
  },
  {
    id: 'pitch',
    group: 'Sound',
    title: 'Change the pitch, tone or speed of a voice',
    steps: () => [
      ...selectClip('sound'),
      tabStep('Audio'),
      { text: 'Drag the Pitch slider, or pick a tone such as Clear voice or Warm. Click Next when it sounds right.', target: () => byText('.inspector .slider-row', 'Pitch')?.closest('.section') || byText('.inspector .slider-row', 'Pitch'), next: true },
      tabStep('Speed'),
      { text: 'Drag the Speed slider. Click Next when you are done.', target: () => byText('.inspector .slider-row', 'Speed'), next: true },
    ],
    finish: 'Play the clip to hear it. The export sounds the same as the preview.',
  },
  {
    id: 'pan',
    group: 'Sound',
    title: 'Move a sound to the left or right',
    steps: () => [...selectClip('sound'), tabStep('Audio'), { text: 'Drag the Left / right slider. Click Next when you are done.', target: () => byText('.inspector .slider-row', 'Left / right'), next: true }],
    finish: 'Listen with headphones to hear where the sound sits.',
  },
  {
    id: 'noise',
    group: 'Sound',
    title: 'Clean up a voice recording',
    steps: () => {
      const press = pressStep('Click Remove background noise. Level out the voice and Even out loudness are next to it.', () => byText('.inspector button', 'Remove background noise'));
      return [...selectClip('sound'), tabStep('Audio'), press, waitJob('Wait for the bar at the bottom right to finish.', () => !!press._clicked && !q('.jobs .job'))];
    },
    finish: 'The clip now plays the cleaned copy. Go back to the original clip in the Smart tools tab to undo it.',
  },

  // ---- text and captions ----
  {
    id: 'title',
    group: 'Text and captions',
    title: 'Add a title',
    video: true,
    steps: () => [
      panelStep('text', 'Text'),
      { text: 'Click a style, or click Add text.', target: () => q('.panel .preset-grid .card') || byText('.panel button', 'Add text'), goal: (did) => did('Add text') || did('Add ') },
    ],
    after: () => ({ text: 'Type your words in the box under the Text tab on the right. Drag the text on the preview to move it.', target: () => q('.inspector textarea') }),
    finish: 'The title is on the timeline above your clips. Drag its ends to change how long it shows.',
  },
  {
    id: 'captions',
    group: 'Text and captions',
    title: 'Add captions',
    video: true,
    steps: () => {
      const has = () => Object.values(P().items).some((i) => i.caption);
      const press = pressStep('Click Create captions. The first time downloads the speech engine.', () => byText('.panel button', 'Create captions'), has);
      return [...haveClip('sound'), panelStep('captions', 'Captions'), press, waitJob('Wait for the bar at the bottom right to finish.', () => has() || (!!press._clicked && !q('.jobs .job')))];
    },
    finish: 'The captions are on the timeline. Pick a style in the Captions panel, or click Edit captions to fix words.',
  },
  {
    id: 'transcript',
    group: 'Text and captions',
    title: 'Cut words out using the transcript',
    steps: () => {
      const words = () => !!q('.tr-doc .tw');
      const press = pressStep('Click Make the transcript.', () => byText('.panel button', 'Make the transcript'), words);
      return [
        ...haveClip('sound'),
        panelStep('transcript', 'Transcript'),
        press,
        waitJob('Wait for the bar at the bottom right to finish.', () => words() || (!!press._clicked && !q('.jobs .job'))),
        { text: 'Drag across the words you want gone, then press Delete.', target: () => q('.tr-doc'), goal: (did) => did('Cut words') },
      ];
    },
    finish: 'Those words are cut from the video. Cut filler words removes every "um" and "uh" at once.',
  },
  {
    id: 'whisper',
    group: 'Text and captions',
    title: 'Set up speech to text',
    steps: () => {
      const press = pressStep('Click Download now.', () => byText('.modal button', 'Download now'));
      return [
        { text: 'Click the gear icon at the top right.', target: () => byTitle('Settings'), done: () => !!modalTitled('Settings') || press._clicked },
        { text: 'Pick the accuracy and language under Speech to text. Large turbo is best for Tagalog. Click Next when they are set.', target: () => byText('.modal .section-head', 'Speech to text')?.parentElement || null, next: true },
        press,
        waitJob('Wait for the bar at the bottom right to finish.', () => !!press._clicked && !q('.jobs .job')),
      ];
    },
    finish: 'Speech to text is ready for captions, the transcript and filler word removal.',
  },

  // ---- look ----
  {
    id: 'colour',
    group: 'Look',
    title: 'Change the colour of a clip',
    video: true,
    steps: () => [...selectClip('visual'), tabStep('Colour'), { text: 'Click a look such as Cinematic, Clean clinic or Rich chocolate. The sliders below fine-tune it.', target: () => q('.inspector .chips .chip:not(.active)'), goal: (did) => did('Look') }],
    finish: 'The look is on the clip. Select several clips first to give them all the same look.',
  },
  {
    id: 'transition',
    group: 'Look',
    title: 'Add a transition between two clips',
    video: true,
    steps: () => [
      ...haveClip('visual'),
      {
        text: 'Add a second clip right after the first one.',
        target: () => {
          const m = Object.values(P().media).find((x) => x.status !== 'error' && MEDIA_KINDS.visual(x));
          return (m && q(`.m-card[data-id="${m.id}"]`)) || q('.m-card');
        },
        done: () => clipsOf('visual').length >= 2,
      },
      {
        text: 'Click the small square where the two clips meet on the timeline.',
        target: () => {
          const items = clipsOf('visual');
          const join = items.find((b) => items.some((a) => a !== b && a.trackId === b.trackId && Math.abs(itemEnd(a) - b.start) < 0.02));
          return (join && q(`.tl-clip[data-id="${join.id}"] .tl-trans`)) || q('.tl-trans');
        },
        done: () => window.__app?.panel === 'transitions',
      },
      { text: 'Click a transition, such as Dissolve.', target: () => q('.panel .card'), goal: (did) => did('Transition') },
    ],
    finish: 'Play across the cut to see it. The slider in the Transitions panel changes how long it takes.',
  },
  {
    id: 'zoom',
    group: 'Look',
    title: 'Zoom in on a detail',
    video: true,
    steps: () => [...selectClip('visual'), tabStep('Video'), pressStep('Click Zoom to a spot.', () => byText('.inspector button', 'Zoom to a spot')), { text: 'Click the spot on the preview to zoom toward.', target: () => q('.viewer-stage'), goal: (did) => did('Zoom to a spot') }],
    finish: 'The clip zooms toward that spot and back out.',
  },
  {
    id: 'overlay',
    group: 'Look',
    title: 'Add sparkles, dust or a light leak',
    video: true,
    steps: () => [panelStep('effects', 'Effects'), { text: 'Click an overlay such as Gold sparkles. It lands at the playhead.', target: () => byText('.panel .card', 'Gold sparkles'), goal: (did) => did('Add overlay') }],
    finish: 'The overlay runs for 5 seconds. Its colour, amount and speed are in the Overlay tab on the right.',
  },
  {
    id: 'pip',
    group: 'Look',
    title: 'Put a clip in a corner',
    video: true,
    steps: () => [...selectClip('visual'), tabStep('Video'), { text: 'Click a corner under Picture in picture.', target: () => byText('.inspector button', 'Bottom right'), goal: (did) => did('Picture in picture') }],
    finish: 'The clip is small in the corner. Drag it on the preview to move it.',
  },

  // ---- smart tools ----
  {
    id: 'removebg',
    group: 'Smart tools',
    title: 'Remove the background',
    video: true,
    steps: () => {
      const press = pressStep('Click Remove background.', () => byText('.inspector button', 'Remove background'));
      return [...selectClip('visual'), tabStep('Smart tools'), press, waitJob('Wait for the bar at the bottom right to finish. It takes about as long as the clip.', () => !!press._clicked && !q('.jobs .job'))];
    },
    goalLabel: 'Remove background',
    finish: 'The person or product is cut out. Put the background back is in the same place.',
  },
  {
    id: 'faces',
    group: 'Smart tools',
    title: 'Blur faces for privacy',
    video: true,
    steps: () => {
      const press = pressStep('Click Blur faces automatically.', () => byText('.inspector button', 'Blur faces automatically'));
      return [...selectClip('video'), tabStep('Smart tools'), press, waitJob('Wait for the bar at the bottom right to finish.', () => !!press._clicked && !q('.jobs .job'))];
    },
    goalLabel: 'Blur faces',
    finish: 'Every face in the clip is blurred and followed.',
  },
  {
    id: 'silences',
    group: 'Smart tools',
    title: 'Cut out the pauses in a talk',
    steps: () => {
      const press = pressStep('Click Cut silences.', () => byText('.panel button', 'Cut silences'), () => !!modalTitled('Cut out silences'));
      return [...selectClip('sound'), panelStep('ai', 'Smart'), press, pressStep('Set the shortest pause to cut, then click Cut silences.', () => byText('.modal-foot button', 'Cut silences'))];
    },
    goalLabel: 'Cut out silences',
    finish: 'The pauses are gone. Ctrl+Z brings them back.',
  },

  // ---- export and save ----
  {
    id: 'export',
    group: 'Export and save',
    title: 'Export a video',
    video: true,
    steps: () => [
      ...haveClip('visual'),
      { text: 'Click Export at the top right.', target: () => q('.export-btn'), done: () => !!modalTitled('Export') },
      { text: 'Click Video.', target: () => byText('.modal .seg-btn', 'Video'), done: () => !!byText('.modal .seg-btn.active', 'Video') || exporting() },
      { text: 'Pick a preset such as Instagram Reels, TikTok, Stories, or pick the size yourself. Click Next when it is set.', target: () => q('.modal .export-opts .chips') || q('.modal .export-opts select'), next: true, done: exporting },
      { text: 'Click Export and choose where to save the file.', target: () => byText('.modal-foot button', 'Export'), done: () => !!q('.export-progress .job-bar, .export-done') },
      { text: 'Wait for the export to finish.', target: () => q('.export-progress'), done: () => !!q('.export-done') },
    ],
    finish: 'The video is saved. Show in folder opens where it went.',
  },
  {
    id: 'shapes',
    group: 'Export and save',
    title: 'Export for Reels, feed and YouTube at once',
    video: true,
    steps: () => [
      ...haveClip('visual'),
      { text: 'Click Export at the top right.', target: () => q('.export-btn'), done: () => !!modalTitled('Export') },
      { text: 'Click Video.', target: () => byText('.modal .seg-btn', 'Video'), done: () => !!byText('.modal .seg-btn.active', 'Video') || exporting() },
      { text: 'Click the other shapes you want under Also export in these shapes.', target: () => byText('.modal .row', 'Also export in these shapes')?.querySelector('.chip') || null, done: () => !!q('.modal .export-opts .chip.active') || exporting() },
      { text: 'Click Export and choose where to save the file. Each shape is saved next to it.', target: () => byText('.modal-foot button', 'Export'), done: () => !!q('.export-progress .job-bar, .export-done') },
      { text: 'Wait for the export to finish.', target: () => q('.export-progress'), done: () => !!q('.export-done') },
    ],
    finish: 'Every shape is saved, each with the shape in its file name.',
  },
  {
    id: 'save',
    group: 'Export and save',
    title: 'Save the project',
    steps: () => [{ text: `Click the save icon at the top right, or press ${keyLabel('Ctrl+S')}.`, target: () => byTitle(keyLabel('Save (Ctrl+S)')), goal: (did, g) => g.saved }],
    finish: 'The project is saved as a .vproj file. The editor also saves every 30 seconds in case of a crash.',
  },

  // ---- audio projects ----
  {
    id: 'audioProject',
    group: 'Audio projects',
    title: 'Start an audio project',
    steps: () => [
      { text: 'Click File at the top.', target: () => byText('.menu-btn', 'File'), done: () => menuOpen('New project') || !!q('.welcome-modal') },
      { text: 'Click New project.', target: () => byText('.ctx .ctx-item', 'New project'), done: () => !!q('.welcome-modal') },
      { text: 'Click Audio.', target: () => byText('.welcome-modal .seg-btn', 'Audio'), done: () => !!byText('.welcome-modal .seg-btn.active', 'Audio') },
      { text: 'Type a name and click Create project.', target: () => byText('.welcome-modal .modal-foot button', 'Create project'), goal: () => audioProject() && !q('.welcome-modal') },
    ],
    finish: 'The preview now shows the sound wave. Drop sound files or videos into the Media panel to start.',
  },
  {
    id: 'join',
    group: 'Audio projects',
    title: 'Join several recordings',
    audio: true,
    steps: () => [
      { text: 'Click Add at the top.', target: () => byText('.menu-btn', 'Add'), done: () => menuOpen('Join audio files') || !!modalTitled('Join audio files') },
      { text: 'Click Join audio files, then pick the recordings.', target: () => byText('.ctx .ctx-item', 'Join audio files'), done: () => !!modalTitled('Join audio files') },
      { text: 'Put them in order with the arrows and click Join.', target: () => byText('.modal-foot button', 'Join'), goal: (did) => did('Join audio') },
    ],
    finish: 'The recordings are end to end on the first audio track.',
  },
  {
    id: 'exportAudio',
    group: 'Audio projects',
    title: 'Export an MP3',
    audio: true,
    steps: () => [
      ...haveClip('sound'),
      { text: 'Click Export at the top right.', target: () => q('.export-btn'), done: () => !!modalTitled('Export') },
      { text: 'Pick MP3 under Format. Tick the loudness box for a podcast. Click Next when it is set.', target: () => q('.modal .export-opts select'), next: true, done: exporting },
      { text: 'Click Export and choose where to save the file.', target: () => byText('.modal-foot button', 'Export'), done: () => !!q('.export-progress .job-bar, .export-done') },
      { text: 'Wait for the export to finish.', target: () => q('.export-progress'), done: () => !!q('.export-done') },
    ],
    finish: 'The MP3 is saved. Show in folder opens where it went.',
  },
];

/** Guides that fit the open project. */
export function guidesFor(project = P()) {
  const audio = !!project.settings.audioOnly;
  return GUIDES.filter((g) => (audio ? !g.video : !g.audio));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let active = null;

export function guideRunning() {
  return !!active;
}

export function stopGuide() {
  active?.stop();
}

export function startGuide(app, id) {
  stopGuide();
  const g = GUIDES.find((x) => x.id === id);
  if (!g) return;
  const steps = g.steps();
  if (g.after) steps.push({ ...g.after(), next: true });
  // the finishing check: the last step's goal, or an undo label
  const seen = new Set(store.undoStack);
  const labels = new Set();
  const state = { saved: false };
  const offHistory = store.on('history', () => {
    for (const e of store.undoStack) if (!seen.has(e)) {
      seen.add(e);
      labels.add(e.label);
    }
  });
  const offSaved = store.on('saved', () => (state.saved = true));
  const did = (label) => labels.has(label) || [...labels].some((l) => label.endsWith(' ') && l.startsWith(label));
  const goalIdx = steps.findIndex((s) => s.goal);
  const finished = () => {
    if (g.goalLabel && did(g.goalLabel)) return true;
    if (goalIdx >= 0) return steps[goalIdx].goal(did, state) && steps.slice(goalIdx + 1).every((s) => s.manual);
    return stepDone(steps[steps.length - 1]);
  };
  // navigation steps (open a panel or a tab) stay done once done, so opening
  // another tab later does not send the guide back
  const stepDone = (s) => {
    if (s.manual || s._latched) return true;
    if (s.goal) return s.goal(did, state);
    const ok = !!(s.done?.() || (s.clicked && s._clicked));
    if (ok && s.latch) s._latched = true;
    return ok;
  };

  const spot = h('div', { class: 'guide-spot' });
  // four dark panels around the lit-up spot
  const dims = [0, 1, 2, 3].map(() => h('div', { class: 'guide-dim' }));
  const card = h('div', { class: 'guide-card', role: 'dialog', 'aria-label': g.title });
  const root = h('div', { class: 'guide' }, ...dims, spot, card);
  document.body.append(root);
  let idx = -1;
  let doneShown = false;
  let lastTarget = null;

  const close = () => stop();
  const drawCard = (s) => {
    const n = steps.length;
    card.replaceChildren(
      h('div', { class: 'guide-head' }, icon('help', 14), h('span', {}, g.title), h('button', { class: 'ibtn guide-x', type: 'button', title: 'Close the guide', onclick: close }, icon('x', 14))),
      h('div', { class: 'guide-count' }, `Step ${Math.min(idx + 1, n)} of ${n}`),
      h('p', { class: 'guide-text' }, s.text),
      h(
        'div',
        { class: 'guide-btns' },
        button('Close', close, { kind: 'link' }),
        s.next
          ? button(idx === n - 1 ? 'Done' : 'Next', () => {
              s.manual = true;
              tick();
            }, { kind: 'primary' })
          : null,
      ),
    );
  };
  const drawDone = () => {
    doneShown = true;
    card.classList.add('centered');
    card.replaceChildren(
      h('div', { class: 'guide-head' }, icon('check', 14), h('span', {}, g.title), h('button', { class: 'ibtn guide-x', type: 'button', title: 'Close the guide', onclick: close }, icon('x', 14))),
      h('p', { class: 'guide-text' }, 'Done. ' + g.finish),
      h('div', { class: 'guide-btns' }, button('More guides', () => {
        stop();
        showGuides(app);
      }, { kind: 'link' }), button('Close', close, { kind: 'primary' })),
    );
    place(null);
  };
  const place = (target) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth || 320;
    const ch = card.offsetHeight || 140;
    if (!target) {
      spot.style.display = 'none';
      for (const d of dims) d.style.display = 'none';
      card.style.left = Math.round((vw - cw) / 2) + 'px';
      card.style.top = Math.round(vh * 0.2) + 'px';
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 6;
    const L = r.left - pad;
    const T = r.top - pad;
    const R = r.right + pad;
    const B = r.bottom + pad;
    Object.assign(spot.style, { display: 'block', left: L + 'px', top: T + 'px', width: R - L + 'px', height: B - T + 'px' });
    const box = (d, x, y, w, hh) => Object.assign(d.style, { display: 'block', left: x + 'px', top: y + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, hh) + 'px' });
    box(dims[0], 0, 0, vw, T);
    box(dims[1], 0, B, vw, vh - B);
    box(dims[2], 0, T, L, B - T);
    box(dims[3], R, T, vw - R, B - T);
    const gap = 16;
    let x;
    let y;
    if (r.right + gap + cw < vw - 8) {
      x = r.right + gap;
      y = r.top + r.height / 2 - ch / 2;
    } else if (r.left - gap - cw > 8) {
      x = r.left - gap - cw;
      y = r.top + r.height / 2 - ch / 2;
    } else if (r.bottom + gap + ch < vh - 8) {
      x = r.left + r.width / 2 - cw / 2;
      y = r.bottom + gap;
    } else {
      x = r.left + r.width / 2 - cw / 2;
      y = r.top - gap - ch;
    }
    card.style.left = Math.round(Math.max(8, Math.min(vw - cw - 8, x))) + 'px';
    card.style.top = Math.round(Math.max(8, Math.min(vh - ch - 8, y))) + 'px';
  };
  const tick = () => {
    if (!active) return;
    if (finished()) {
      if (!doneShown) drawDone();
      return;
    }
    if (doneShown) {
      doneShown = false;
      card.classList.remove('centered');
    }
    let i = steps.findIndex((s) => !stepDone(s));
    if (i < 0) i = steps.length - 1;
    // later steps start again from scratch once an earlier one comes undone
    for (let j = i + 1; j < steps.length; j++) steps[j]._latched = false;
    // the button to press is not on screen: go back to the step that opens it
    if (i > 0 && steps[i - 1]._latched && !steps[i - 1].done() && !steps[i].target?.()) {
      steps[i - 1]._latched = false;
      i--;
    }
    const s = steps[i];
    if (i !== idx) {
      idx = i;
      drawCard(s);
      lastTarget = null;
    }
    let t = null;
    try {
      t = s.target?.() || null;
    } catch {
      t = null;
    }
    // bring a button in a scrolled panel into view; the timeline is left where it is
    if (t && t !== lastTarget && t.closest('.panel, .inspector, .modal-body')) t.scrollIntoView?.({ block: 'nearest' });
    // a small mark on the timeline that sits out of view is scrolled to
    if (t && t !== lastTarget && t.closest('.tl-scroll')) {
      const view = t.closest('.tl-scroll').getBoundingClientRect();
      const r = t.getBoundingClientRect();
      if (r.width < view.width / 2 && (r.left < view.left + 190 || r.right > view.right)) t.closest('.tl-scroll').scrollLeft += r.left - (view.left + view.width / 2);
    }
    lastTarget = t;
    s._target = t;
    place(t);
  };
  // a click on the lit-up button finishes a press step
  const onClick = (e) => {
    const s = steps[idx];
    if (!s || !s.clicked || card.contains(e.target)) return;
    if (s._target && s._target.contains(e.target)) {
      s._clicked = true;
      setTimeout(tick, 60);
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.modal-overlay, .ctx')) stop();
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  const timer = setInterval(tick, 150);
  const onResize = () => tick();
  window.addEventListener('resize', onResize);
  function stop() {
    if (!active) return;
    clearInterval(timer);
    offHistory();
    offSaved();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    root.remove();
    active = null;
  }
  active = { id, stop, steps, get index() { return idx; }, get finished() { return doneShown; } };
  window.__guide = active;
  tick();
  return active;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function showGuides(app) {
  const list = guidesFor();
  const search = h('input', { type: 'search', placeholder: 'What do you want to do?', class: 'guide-search' });
  const body = h('div', { class: 'guide-list' });
  const draw = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = list.filter((g) => words.every((w) => (g.title + ' ' + g.group).toLowerCase().includes(w)));
    body.replaceChildren();
    if (!hits.length) body.append(h('p', { class: 'hint' }, 'No guide matches that. Try a shorter word such as sound, text or export.'));
    let group = null;
    for (const g of hits) {
      if (g.group !== group) {
        group = g.group;
        body.append(h('div', { class: 'guide-group' }, group));
      }
      body.append(
        h('button', { class: 'guide-item', type: 'button', onclick: () => {
          dlg.close();
          startGuide(app, g.id);
        } }, h('span', {}, g.title), icon('next', 14)),
      );
    }
  };
  search.addEventListener('input', draw);
  draw();
  const dlg = modal('How do I...', h('div', { class: 'stack' }, h('p', { class: 'hint' }, 'Pick a task and the editor shows you what to press, one step at a time.'), search, body), { width: 520 });
  setTimeout(() => search.focus(), 50);
  return dlg;
}
