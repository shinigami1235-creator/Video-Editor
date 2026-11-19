// The tools Claude sees. The editor runs them (src/ai/claude-tools.js), so a
// tool added here needs a handler there with the same name.

export const INSTRUCTIONS = `This server controls Gid's Video Editor, a desktop video and audio editor running on his computer. Changes show in the editor straight away and Ctrl+Z (or the history tool) undoes them.

How to work:
- Start with get_project. It lists the tracks, every item with its id, start and end in seconds, the imported media and the angles setup. Ids change after splits and smart tools, so read get_project again after those.
- Times are seconds on the timeline. Positions (x, y) are pixels from the centre of the frame. Scale 1 is the clip's normal size.
- Video tracks are listed top layer first; the main track is the magnetic one at the bottom, where clips sit end to end with no gaps.
- Use get_frame to look at the result at a moment before telling Gid it is done.
- File paths are on Gid's computer (Windows paths such as C:\\Users\\User\\Videos\\clip.mov).
- Long work (captions, background removal, exports, noise clean-up) answers with a job_id while it runs. Call check_job with that id until it finishes.
- list_options gives the exact names of frames, presets, looks, transitions, animations and smart tools.
- Ask Gid before deleting things or replacing a project with unsaved changes.

Jobs you do yourself, on Gid's Claude plan (the editor's paid API features are off, so these replace them):
- A video from raw footage: transcript with source "footage" gives every imported file as timed sentences. Pick the best moments, offer Gid 2 or 3 ranked ideas with the moments each uses, then build the one he picks with build_video (segments in seconds of each file, captions, optional music and title). Check it with get_frame before saying it is done.
- Finding a moment: search_footage finds a word or phrase across every imported file; each hit has a sentence range ready for build_video.
- Shorts from a long video: read its transcript (source = its media_id), pick moments of whole sentences that make sense alone, then make_shorts.
- YouTube chapters: read transcript with source "timeline", write the chapters, add them with add_chapters, and write titles, description and hashtags in the chat.
- Translating captions: translate_captions with action "list", translate every line yourself, then action "apply" with the texts in the same order.
- Swear words: bleep puts a beep (or silence) over them; with no words it uses a list of English and Filipino swear words.
- Transcripts are made on Gid's computer by Whisper the first time a file is read, which takes about a quarter of its length; long ones answer with a job_id.`;

const time = { description: 'Seconds from the start of the timeline. Also "playhead" or "end".', anyOf: [{ type: 'number', minimum: 0 }, { type: 'string', enum: ['playhead', 'end'] }] };
const ids = { type: 'array', items: { type: 'string' }, description: 'Item ids from get_project.' };
const wait = { type: 'number', minimum: 1, maximum: 40, description: 'How long to wait for the result before answering with a job_id (default 35, at most 40, since the Claude app stops waiting after about a minute).' };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const ro = { readOnlyHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'editor_status',
    title: 'Is the editor open?',
    description: 'Checks that the Video Editor is open and connected, and returns the project summary if it is.',
    inputSchema: obj({}),
    annotations: ro,
  },
  {
    name: 'get_project',
    title: 'Read the project',
    description: 'The open project: name, file, frame size and shape, duration, playhead, tracks with every item (id, type, name, start, end, in point, speed, volume, transform, effects, look, animation, transition), imported media (id, name, kind, path, duration, status), markers and the angles setup.',
    inputSchema: obj({}),
    annotations: ro,
  },
  {
    name: 'get_frame',
    title: 'Look at a frame',
    description: 'Renders the edited video at one moment and returns it as an image, exactly as it will export.',
    inputSchema: obj({ time, width: { type: 'number', minimum: 160, maximum: 1280, description: 'Image width in pixels (default 640).' } }),
    annotations: ro,
  },
  {
    name: 'list_options',
    title: 'List the options',
    description: 'Names to use with the other tools: frames, export presets, text presets, caption styles, transitions, angle transitions, looks, animations, blend modes, smart tools, voice effects, background models and text style keys.',
    inputSchema: obj({}),
    annotations: ro,
  },
  {
    name: 'new_project',
    title: 'New project',
    description: 'Starts a new empty project. A video project with frame "match" (the default) takes the shape of the first video added.',
    inputSchema: obj({
      name: { type: 'string' },
      type: { type: 'string', enum: ['video', 'audio'], description: 'Default video.' },
      frame: { type: 'string', description: 'match, reels (9:16), feed45 (4:5), square, yt1080 (16:9), yt4k or cinema.' },
      fps: { type: 'number', enum: [24, 25, 30, 50, 60] },
      discard_unsaved: { type: 'boolean', description: 'Throw away unsaved changes in the open project. Ask Gid first.' },
    }),
    annotations: { destructiveHint: true },
  },
  {
    name: 'open_project',
    title: 'Open a project',
    description: 'Opens a .vproj project file.',
    inputSchema: obj({ path: { type: 'string' }, discard_unsaved: { type: 'boolean' } }, ['path']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'save_project',
    title: 'Save the project',
    description: 'Saves the project to its file, to path if given, or to Documents\\Video Editor Projects when it has never been saved.',
    inputSchema: obj({ path: { type: 'string', description: 'Full path ending in .vproj.' } }),
  },
  {
    name: 'set_frame',
    title: 'Set the frame',
    description: 'Changes the frame shape and size, frame rate or background colour. frame "match" takes the shape of a video on the timeline (media_id, or the first video).',
    inputSchema: obj({
      frame: { type: 'string', description: 'match, reels, feed45, square, yt1080, yt4k or cinema.' },
      media_id: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
      fps: { type: 'number' },
      background: { type: 'string', description: 'Hex colour such as #000000.' },
    }),
  },
  {
    name: 'import_media',
    title: 'Import files',
    description: 'Imports videos (MP4, MOV including iPhone HDR, MKV, WebM and more), audio, photos or PDFs (one photo per page) into the Media panel and waits until they are prepared. Returns their media ids.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Full file paths on Gid\'s computer.' }, wait_seconds: wait }, ['paths']),
  },
  {
    name: 'add_clips',
    title: 'Put media on the timeline',
    description: 'Places imported media on the timeline. Videos and photos go on the main track (end to end) unless track is "new" or a track id; audio goes on a free audio track.',
    inputSchema: obj({ media_ids: { type: 'array', items: { type: 'string' } }, at: { ...time, description: 'Where to place them. Default: the end of the timeline.' }, track: { type: 'string', description: '"main", "new" or a track id.' } }, ['media_ids']),
  },
  {
    name: 'edit_items',
    title: 'Change items',
    description: 'Changes one or more items, all as one undo step. Keys in changes: start, duration, in (source in point), track ("new" or id), speed (0.1-10), volume (1 = normal, up to 3), muted, pan (-1 left to 1 right), fade_in, fade_out (audio fades in seconds), lower_under_voice, opacity (0-1), scale, scale_x, scale_y, x, y, rotation (degrees), blur (0-1), crop_left/right/top/bottom (0-0.9), fit (contain, cover, stretch), blend, flip_x, flip_y, shape_from_below ("inside", "outside" or null: show only inside the cut-out on the layer below), name, text, style (text style object, see list_options), look (a colour look name), color ({ exposure, contrast, saturation, temperature, highlights, shadows, vignette, grain, sharpen } roughly -1..1), effects ({ glow, chromatic, pixelate, letterbox 0-0.5, mirror, backdrop: "blur" or null, chroma: { enabled, color, similarity }, silhouette: { on, style: fill|shaded|outline, color, width } }), anim_in, anim_out, anim_loop ({ type, duration } or null), transition_in ({ type, duration } into this clip from the clip before it on the same track, or null), keyframes ({ scale: [{ at: seconds on the timeline, value, ease }], x: [...], ... } an empty list removes them).',
    inputSchema: obj({ item_ids: ids, changes: { type: 'object' }, label: { type: 'string', description: 'Name of the undo step.' } }, ['item_ids', 'changes']),
  },
  {
    name: 'split_at',
    title: 'Split',
    description: 'Splits items at a time (all items under that time, or only item_ids).',
    inputSchema: obj({ time, item_ids: ids }, ['time']),
  },
  {
    name: 'delete_items',
    title: 'Delete items',
    description: 'Deletes items. ripple closes the gap they leave.',
    inputSchema: obj({ item_ids: ids, ripple: { type: 'boolean' } }, ['item_ids']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'duplicate_items',
    title: 'Duplicate items',
    description: 'Copies items to right after themselves.',
    inputSchema: obj({ item_ids: ids }, ['item_ids']),
  },
  {
    name: 'add_text',
    title: 'Add text',
    description: 'Adds text over the video on its own layer. A preset (Title, Elegant title, Subtitle, Lower third, Call to action, Price tag, Step label and more; see list_options) sets the style and animation; style overrides it. Lower third takes two lines as a list.',
    inputSchema: obj({
      text: { description: 'The words, or a list of lines for two-part presets.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      at: time,
      duration: { type: 'number', description: 'Seconds (default 4).' },
      preset: { type: 'string' },
      style: { type: 'object', description: 'font, size, weight, color, uppercase, outlineWidth, outlineColor, shadowBlur, boxEnabled, boxColor, align...' },
      x: { type: 'number' },
      y: { type: 'number', description: 'Pixels from the centre, positive is down.' },
      reveal: { type: 'string', enum: ['none', 'typewriter', 'words'] },
      anim_in: { type: 'object' },
      anim_out: { type: 'object' },
    }, ['text']),
  },
  {
    name: 'run_tool',
    title: 'Run a smart tool',
    description: `Runs one of the editor's tools on item_id (or item_ids). Free and on this computer:
captions (all speech, or item_id), remove_background (options.model: person, object or fast), make_silhouette (options.color, options.style fill|shaded|outline), silhouette_shadow, fill_silhouette (the clip on the layer above shows inside the shape), fill_subject_below (run on the top clip), blur_faces, auto_reframe, stabilize, reverse, smooth_slowmo (slow the clip first), upscale, revert (back to the original file), clear_voice (one-click voice clean-up for speech), remove_noise, level_voice, even_loudness, voice_effect (options.kind deeper|higher|echo|radio|robot), cut_silences (options.min_pause, keep_around_speech, sensitivity), remove_fillers, mark_beats, sync_to_beat (item_ids of clips), separate_audio, lower_others (run on a voiceover), freeze_frame (options.at), picture_in_picture (options.corner tl|tr|bl|br), split_screen (two item_ids), blurred_background (toggles), line_up_faces (before and after item_ids), match_frame, moving_photo (photo; options.motion push|pull|orbit|rise, amount, focus front|middle|back).`,
    inputSchema: obj({ tool: { type: 'string' }, item_id: { type: 'string' }, item_ids: ids, options: { type: 'object' }, wait_seconds: wait }, ['tool']),
  },
  {
    name: 'angles',
    title: 'Several angles of one moment',
    description: 'Videos of the same moment from different phones. action sync lines them up by sound (item_ids, or every video on the timeline, or every video in the Media panel) with one sound playing throughout. Then: switch (at, angle number from 1, transition, duration), set_switches (the whole list: [{ at, angle, transition, duration }]), remove_switch (at), sound (angle whose sound plays), defaults (transition, duration for new switches), stop. Transitions: cut, dissolve (fade), dipBlack, dipWhite, blur, zoomIn, zoomOut, wipeLeft, wipeRight, pushLeft, pushRight, slideOver, circle, whip, glitch.',
    inputSchema: obj({
      action: { type: 'string', enum: ['sync', 'switch', 'set_switches', 'remove_switch', 'sound', 'defaults', 'stop'] },
      item_ids: ids,
      at: time,
      angle: { type: 'number', minimum: 1 },
      transition: { type: 'string' },
      duration: { type: 'number', minimum: 0, maximum: 3 },
      switches: { type: 'array', items: { type: 'object' } },
      wait_seconds: wait,
    }, ['action']),
  },
  {
    name: 'add_marker',
    title: 'Add a marker',
    description: 'Adds a marker on the timeline, useful to note beats or moments for Gid.',
    inputSchema: obj({ time, label: { type: 'string' }, color: { type: 'string' } }, ['time']),
  },
  {
    name: 'playback',
    title: 'Play, pause or move the playhead',
    description: 'Moves the playhead or plays the preview so Gid can watch.',
    inputSchema: obj({ action: { type: 'string', enum: ['play', 'pause', 'seek'] }, time }, ['action']),
  },
  {
    name: 'select_items',
    title: 'Select items',
    description: 'Selects items in the editor so Gid sees them in the Inspector. An empty list clears the selection.',
    inputSchema: obj({ item_ids: ids }),
  },
  {
    name: 'history',
    title: 'Undo or redo',
    description: 'Undoes or redoes the last steps, Gid\'s or Claude\'s.',
    inputSchema: obj({ action: { type: 'string', enum: ['undo', 'redo'] }, steps: { type: 'number', minimum: 1, maximum: 50 } }, ['action']),
  },
  {
    name: 'export',
    title: 'Export',
    description: 'Exports the project. kind video (H.264 and AAC .mp4; preset reels, feed45, square, yt1080, yt4k or lecture, or width and height; a different shape refits clips with framing blur|contain|cover; social_loudness evens loudness to -14 LUFS), audio (format mp3|m4a|wav, podcast_loudness), frame (time, format png|jpg), gif, or captions (format srt|vtt). start and end limit the range. Without path it saves to Documents\\Video Editor Exports. Usually answers with a job_id; then use check_job.',
    inputSchema: obj({
      kind: { type: 'string', enum: ['video', 'audio', 'frame', 'gif', 'captions'] },
      path: { type: 'string' },
      preset: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
      fps: { type: 'number' },
      quality_mbps: { type: 'number' },
      framing: { type: 'string', enum: ['blur', 'contain', 'cover'] },
      social_loudness: { type: 'boolean' },
      podcast_loudness: { type: 'boolean' },
      format: { type: 'string' },
      start: { type: 'number' },
      end: { type: 'number' },
      time,
      wait_seconds: wait,
    }),
  },
  {
    name: 'transcript',
    title: 'Read what is said',
    description: 'Timed transcript as sentences (or words with detail "words"). source "timeline" (default): every clip with sound on the timeline, in timeline seconds, with its item_id. source "footage": every imported video and recording (or just media_ids), in seconds of each file, whether on the timeline or not. A media id as source reads that one file. Files without a transcript get one first (Whisper on Gid\'s computer).',
    inputSchema: obj({ source: { type: 'string', description: 'timeline, footage, or a media id.' }, media_ids: { type: 'array', items: { type: 'string' } }, detail: { type: 'string', enum: ['sentences', 'words'] }, wait_seconds: wait }),
    annotations: ro,
  },
  {
    name: 'search_footage',
    title: 'Search footage by what was said',
    description: 'Finds a word or phrase in every imported video and recording. Each query word matches the start of a spoken word, in order ("lip fill" finds "lip filler"). Returns each hit with its file, times in the file, the words around it, the whole sentence range (ready for build_video) and where it already sits on the timeline.',
    inputSchema: obj({ query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 }, make_missing: { type: 'boolean', description: 'Make missing transcripts first (default true).' }, wait_seconds: wait }, ['query']),
    annotations: ro,
  },
  {
    name: 'bleep',
    title: 'Bleep words',
    description: 'Puts a beep (sound "beep") or silence (sound "silence") over words in clips with sound, using their transcripts. With no words, it bleeps common English and Filipino swear words. A * at the end of a word matches any ending ("fuck*"). item_ids limits it to those clips; otherwise the selected clips, else every clip with sound. remove: true takes the bleeps off again.',
    inputSchema: obj({ words: { type: 'array', items: { type: 'string' } }, item_ids: ids, sound: { type: 'string', enum: ['beep', 'silence'] }, remove: { type: 'boolean' }, wait_seconds: wait }),
  },
  {
    name: 'build_video',
    title: 'Build a video from moments',
    description: 'Puts parts of imported files on the timeline in order, as one video. segments are { media_id, start, end } in seconds of each file (from transcript or search_footage). Video goes on the main track, sound-only files on an audio track. Adds captions from the transcripts (unless captions: false, caption_style from list_options), an optional title at the start, an optional transition between the segments, and optional music under it that lowers while someone speaks. at is where it goes on the timeline (default the end); replace: true clears the timeline first (ask Gid before using it). framing: contain (default), cover or blur for clips that do not fill the frame.',
    inputSchema: obj({
      segments: { type: 'array', items: obj({ media_id: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, ['media_id', 'start', 'end']) },
      at: time,
      replace: { type: 'boolean' },
      captions: { type: 'boolean' },
      caption_style: { type: 'string' },
      title: { type: 'string' },
      title_duration: { type: 'number' },
      transition: { type: 'string', description: 'cut (default) or a transition name from list_options.' },
      transition_duration: { type: 'number' },
      framing: { type: 'string', enum: ['contain', 'cover', 'blur'] },
      music: obj({ media_id: { type: 'string' }, start: { type: 'number', description: 'Where in the song to start, in seconds.' }, volume: { type: 'number', minimum: 0, maximum: 2 }, lower_under_voice: { type: 'boolean' } }, ['media_id']),
      label: { type: 'string' },
      wait_seconds: wait,
    }, ['segments']),
  },
  {
    name: 'make_shorts',
    title: 'Make shorts',
    description: 'Makes a 9:16 short from each moment of one long video: a new project with the moment, captions and its title at the top, saved as a .vproj and exported as an .mp4 (unless export: false) in Documents\\Video Editor Shorts or folder. moments are { start, end, title } in seconds of the file, whole sentences, 15 to 90 s each. Give media_id of the file or item_id of its clip. framing blur (default, the whole picture with a blurred copy behind) or cover (fills the frame, crops the sides). The open project is not changed.',
    inputSchema: obj({
      media_id: { type: 'string' },
      item_id: { type: 'string' },
      moments: { type: 'array', items: obj({ start: { type: 'number' }, end: { type: 'number' }, title: { type: 'string' } }, ['start', 'end', 'title']) },
      framing: { type: 'string', enum: ['blur', 'cover'] },
      captions: { type: 'boolean' },
      titles: { type: 'boolean' },
      export: { type: 'boolean' },
      folder: { type: 'string' },
      wait_seconds: wait,
    }, ['moments']),
  },
  {
    name: 'add_chapters',
    title: 'Add YouTube chapters',
    description: 'Adds chapter markers ({ at, title } in timeline seconds; the first moves to 0) and returns them as YouTube chapter lines to put in the description. Replaces earlier chapter markers unless replace: false.',
    inputSchema: obj({ chapters: { type: 'array', items: obj({ at: { type: 'number' }, title: { type: 'string' } }, ['at', 'title']) }, replace: { type: 'boolean' } }, ['chapters']),
  },
  {
    name: 'translate_captions',
    title: 'Translate the captions',
    description: 'action "list" returns the captions in order. Translate each line yourself (keep product, brand and medical names), then call action "apply" with texts in the same order and count, the language (Filipino, Thai, Spanish, Chinese, Japanese, Korean, Vietnamese, Indonesian, French, Arabic, or a code like tl; any other name works for captions only), and mode add (a second, smaller line under the original, the default) or replace. dub: true also has a voice read it where the editor has one for that language (not Filipino or Thai yet).',
    inputSchema: obj({ action: { type: 'string', enum: ['list', 'apply'] }, texts: { type: 'array', items: { type: 'string' } }, language: { type: 'string' }, mode: { type: 'string', enum: ['add', 'replace'] }, dub: { type: 'boolean' }, voice: { type: 'string' }, wait_seconds: wait }),
  },
  {
    name: 'check_job',
    title: 'Check a running job',
    description: 'Waits for a job a tool started (captions, background removal, export and so on) and returns its result, or its progress if it is still running.',
    inputSchema: obj({ job_id: { type: 'string' }, wait_seconds: wait }, ['job_id']),
    annotations: ro,
  },
];
