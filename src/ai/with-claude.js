// Jobs Claude does from a chat in the Claude app through Claude control, on
// Gid's own Claude plan instead of a paid API key. The editor can't start the
// chat itself, so this hands over a ready prompt to paste there.

import { store } from '../core/store.js';
import { h, select } from '../ui/dom.js';
import { modal, toast } from '../ui/notify.js';
import { claudeStatus } from './claude-bridge.js';

const name = () => store.project.name || 'this project';

export const CLAUDE_TASKS = [
  {
    id: 'video',
    label: 'Make a video from my footage',
    prompt: () =>
      `Use the Video Editor. Read the transcripts of all the footage I imported into "${name()}", find the best moments, and give me 3 video ideas ranked best first, each with the moments it would use. When I pick one, build it on the timeline with build_video, with captions and music if I imported any, then show me a frame.`,
  },
  {
    id: 'shorts',
    label: 'Make shorts from a long video',
    prompt: () => {
      const sel = store.selectedItems.find((i) => i.type === 'clip');
      const what = sel ? `"${sel.name || store.project.media[sel.mediaId]?.name}"` : 'the longest video on the timeline';
      return `Use the Video Editor. Read the transcript of ${what} in "${name()}", pick up to 5 moments of 30 to 60 seconds that make sense to someone who hasn't seen the rest, and make each one a 9:16 short with captions and a title using make_shorts. Tell me where they were saved.`;
    },
  },
  {
    id: 'chapters',
    label: 'YouTube chapters, titles and hashtags',
    prompt: () => `Use the Video Editor. Read what is said on the timeline of "${name()}", add YouTube chapters as markers with add_chapters, then write me 3 title ideas under 70 characters, a 2-paragraph description in plain words, and up to 8 hashtags.`,
  },
  {
    id: 'translate',
    label: 'Translate the captions',
    prompt: () => `Use the Video Editor. Translate the captions of "${name()}" into Filipino with translate_captions, as a second line under the English. Keep product names, brand names and medical terms as they are.`,
  },
  {
    id: 'bleep',
    label: 'Bleep swear words',
    prompt: () => `Use the Video Editor. Read the transcript of "${name()}", tell me every swear word or word I might not want in a clinic video and where it is, then bleep the ones I agree to with the bleep tool.`,
  },
];

export function withClaudeDialog(app, taskId = 'video') {
  let task = CLAUDE_TASKS.find((t) => t.id === taskId) || CLAUDE_TASKS[0];
  const area = h('textarea', { rows: 6, class: 'claude-prompt' });
  area.value = task.prompt();
  const connected = claudeStatus() === 'connected';
  const state = h(
    'p',
    { class: connected ? 'hint' : 'notice' },
    connected
      ? 'Claude is connected. Paste this into a chat in the Claude app and it works in this editor, on your Claude plan, with no API key.'
      : store.settings.claudeControl === false
        ? 'Claude control is off. Turn it on in Settings > Claude control, then paste this into a chat in the Claude app.'
        : 'Claude is not connected yet. Open the Claude app and paste this into a chat. The top bar here shows "Claude connected" once it is linked.',
  );
  const pick = select('Job', CLAUDE_TASKS.map((t) => [t.id, t.label]), task.id, (v) => {
    task = CLAUDE_TASKS.find((t) => t.id === v);
    area.value = task.prompt();
  });
  modal('Do it with Claude', h('div', { class: 'stack' }, pick, area, state), {
    width: 600,
    actions: [
      { label: 'Close', run: (close) => close() },
      {
        label: 'Copy the prompt',
        primary: true,
        run: (close) => {
          navigator.clipboard?.writeText(area.value).then(
            () => toast('Copied. Paste it into a chat in the Claude app.', { timeout: 3500 }),
            () => toast('Could not copy. Select the text and press Ctrl+C.', { kind: 'warn' }),
          );
          close();
        },
      },
    ],
  });
}
