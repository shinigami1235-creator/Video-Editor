# Video Editor

This is my own video editor for clinic and Sognare marketing: cinematic product shots, lecture videos and procedure demos. It runs on this laptop, and the smart tools (captions, voices, background removal, face blur) run offline once their files have downloaded. To open it, double-click `Start Video Editor.bat`. To make an app I can pin to the taskbar, double-click `Build Video Editor.bat`.

## Starting it

Node.js and Rust are needed, the same setup the PDF reader and the Photo Editor use.

1. Double-click `Start Video Editor.bat`.
2. The first start installs the editor's parts into this folder and compiles the app, which takes several minutes. Later starts take seconds.
3. On its first run the editor downloads FFmpeg (about 190 MB), the engine that reads and writes every video format. A setup screen shows the progress.

`Build Video Editor.bat` makes `video-editor.exe` in `src-tauri\target\release` and an installer in `src-tauri\target\release\bundle\nsis`. The exe opens straight away without installing. It keeps the version it was built from, so run the build again after new files arrive in this folder. `Start Video Editor.bat` always runs the newest files and reloads by itself when they change.

## The Mac version

GitHub builds the Mac version since it can only be made on a Mac. The code lives in the private repository shinigami1235-creator/Video-Editor, and the workflow in `.github/workflows/build.yml` makes three files: the Windows installer, a Mac app for Apple Silicon (M1 and newer) and a Mac app for older Intel Macs. To make new ones, open the repository on github.com, click Actions, click Build, then Run workflow. The files are under Artifacts at the bottom of the run's page after about 20 minutes.

The Mac app carries its own FFmpeg and whisper.cpp, and text to speech uses the voices built into macOS since Piper has no working Mac build. It needs macOS 13.3 or newer. The app is not signed with an Apple developer account ($99 a year), so the first open needs Open Anyway in System Settings, under Privacy & Security. Screen recording doesn't work inside the app on a Mac, so Shift+Command+5 is the way to record the screen there.

## Where things are kept

| What | Where |
| --- | --- |
| Build files | `node_modules` and `src-tauri\target` in this folder, about 3 GB together. Delete them any time since the next start rebuilds them. |
| Edit copies, waveforms, thumbnails and downloaded tools | `%LOCALAPPDATA%\com.cygnussolutions.videoeditor`. Settings > Delete edit copies clears the edit copies. |
| Settings, brand kits, templates, autosaves and my voice sample | `%APPDATA%\com.cygnussolutions.videoeditor` |
| Voice and screen recordings | `Documents\Video Editor Recordings` |
| Shorts made from long videos | `Documents\Video Editor Shorts`, a project and an MP4 for each |
| AI generated images, videos and music | `Documents\Video Editor Generated` |
| Projects | wherever I save them, as `.vproj` files |

The editor reads my original videos and never changes them. Every imported video gets an edit copy (H.264, keyframe every half second) so scrubbing and playback stay smooth, and the export is rendered from those copies.

## Version 1

- **Timeline:** video tracks and audio tracks, split, trim, move with snapping, ripple delete, duplicate, copy and paste, markers, in and out points, undo history, and a magnetic main track that keeps clips together with no gaps.
- **Speed and fades:** constant speed from 0.1x to 10x with the voice keeping its pitch, freeze frames, audio fades by dragging the dots on a clip.
- **Text:** 10 presets (title, lower third, call to action, price tag, step label and more), 8 bundled fonts plus the fonts installed on Windows, outline, shadow, background box, typewriter and word-by-word reveals, in, out and loop animations.
- **Auto captions:** whisper.cpp turns speech into captions with a highlight on each spoken word, in English, Filipino and other languages, with 7 caption styles, SRT import and export, and a list for fixing words.
- **Text to speech:** Piper voices in English, one clip per paragraph.
- **Colour:** 12 looks (Cinematic, Clean clinic, Rich chocolate, Warm gold and more), exposure, contrast, highlights, shadows, temperature, saturation, curves, vignette, grain, and .cube LUT import.
- **Zoom and pan:** keyframes on position, scale, rotation and opacity, quick zoom presets, and Zoom to a spot, which zooms toward the point I click on the preview and back.
- **Blur:** blur, pixelate or cover a region, with tracking that makes it follow a tattoo, a name tag or a screen through the clip.
- **Export:** presets for Reels and TikTok, Instagram and Facebook feed, square, YouTube 1080p and 4K, plus GIF, audio only, a still frame and caption files.

## Version 2

- **Background removal:** cuts out a person or a product in every frame of a video or in a photo, and can be switched back to the original.
- **Before and after:** select the before and the after clip and use the Before and after template, which stacks them with a sweeping split line and labels.
- **Layers:** as many video tracks as needed for overlays, blend modes, masks (rectangle, circle, split line), green screen.
- **Picture in picture and split screen:** one click puts the selected clip in a corner, and the corner buttons in the Inspector move it. Split screen puts two or more selected clips side by side or stacked.
- **Follow an object:** text, arrows and shapes can track a point in the video, so a label stays on the product or the treatment area as the camera moves.
- **Speed ramps:** Montage, Hero moment, Bullet time, Flash in, Flash out and Jump cut, editable by dragging points.
- **Smooth slow motion:** creates in-between frames so a 0.25x product shot stays fluid.
- **Stabilise, reverse, noise removal and loudness levelling.**
- **Voice effects:** deeper, higher, echo, radio and robot.
- **Speech clean-up:** cut out silences and remove filler words ("um", "uh") from lectures.
- **Music:** mark the beats of a music clip, cut selected clips to the beat, and lower music automatically while someone speaks.
- **Faces:** blur every face automatically for patient privacy, and auto reframe a wide clip so the face stays centred in a vertical frame.
- **Script to video:** a voice reads my script, captions follow it and my clips or PDF slides are laid under each paragraph.
- **Lecture tools:** PDF slides import as one photo per page, voiceover recording while the video plays, safe zones for Reels buttons.
- **Transitions:** 16, including dissolve, dip to black, push, wipe, zoom, blur, circle reveal, whip pan and glitch.
- **Effects:** cinema bars, film grain, glow, colour split, pixelate, mirror, adjustment layers, and a blurred copy behind a wide clip in a vertical frame.
- **Templates:** Product reveal, Before and after, Lecture opener, Procedure steps, End card and Testimonial, plus my own projects saved as templates.
- **Brand kits:** colours, fonts and logos for each brand, a logo watermark, an end card, and one click to put the brand fonts on every title. Kits from the Photo Editor import in one click.
- **Stickers:** 12 emoji stickers (sparkles, heart, tick, star, pointing hand, chocolate, gift and more) that pop in at the playhead.
- **Sound effects:** whoosh, riser, impact, pop, click, ding, sparkle, camera shutter, notification and typing, made by the editor so nothing needs licensing.
- **Generate with AI:** images, short videos and music from a description through Replicate. It needs my Replicate token in Settings and each generation is billed to that account.
- **Autosave and recovery:** the project saves itself every 30 seconds, closing the window with unsaved changes asks to save first, and the start screen offers to restore unsaved work after a crash.

## Version 3

- **Sound editing:** Separate audio puts a video's sound on its own track with its wave. Every clip with sound has a yellow volume line: drag it down or up, click it to add a point, double-click a point to remove it. "Lower other sounds here" on a voiceover dips the music and the clip sound under it and brings them back after, and pressing it twice never dips twice. Each track has its own volume, and the wave button on a track makes it taller.
- **Pitch, tone and speed:** pitch in semitones up to an octave either way, tone presets (Clear voice, Warm, More bass, Bright, Phone call, Next room) with bass, middle and treble sliders, and speed with or without keeping the voice pitch. The preview and the export sound the same.
- **Stitch videos:** pick several videos, put them in order, and they join end to end with the same transition and framing. It's on the start screen, in the Media panel and under Add.
- **Edit by text:** the Transcript panel shows every word said on the main track. Drag across words and press Delete to cut them from the video, click a word to jump there, and cut every filler word in one go.
- **Teleprompter:** the script scrolls over the preview at the reading speed I set, on its own or while recording a voiceover or the screen.
- **Screen recording:** records a screen or a window with the webcam and microphone. The webcam lands as a picture in picture that can still be moved or cut away.
- **Shorts from a long video:** Claude reads the transcript of a lecture and picks up to 10 moments that stand on their own. Each becomes a 9:16 project with captions and a title, and an MP4.
- **Multi-camera:** select two or more clips of the same moment and "Sync angles by sound" lines them up. "Switch angles" then plays it and cuts to camera 1, 2 or 3 as I press the number keys.
- **Line up the faces:** select a before and an after shot and the after one moves and scales so the faces sit exactly on top of each other, with a 50% view to check it.
- **Freehand mask:** click around any shape on the preview to keep only that area, with a soft edge, and "Follow the movement" makes it track what it outlines.
- **Moving photo:** a depth model works out what is near and far in a still product photo, then moves a camera through it (push in, pull out, slide, rise) so the product stands out from the background.
- **Overlays:** floating dust, gold sparkles, bokeh lights, falling cocoa, snow, light leaks and a lens flare, each with its own colour, amount, size, speed and direction.
- **Upscale:** a sharper copy of a video at twice the size up to 4K, made from the original file. Photos can go 4 times bigger with AI through Replicate.
- **Every shape at once:** the export can also make 9:16, 4:5, 1:1 and 16:9 copies in one go. Clips refit with a blurred copy behind, black bars or a crop, and titles and captions move with the frame.
- **Translate captions:** Claude translates the captions into Filipino, Thai, Spanish, Chinese and 7 more, as a second line or in place of the original. Dubbing reads the translation with a voice in each caption's slot and turns the original speech down to 15%.
- **YouTube chapters:** Claude writes chapters, title ideas, a description and hashtags from what is said, and the chapters can go on the timeline as markers.
- **My voice:** I read a 30-second script once, and text to speech, dubbing and script to video can then speak in my voice through Replicate.
- **Talking presenter:** a front-facing photo is animated to speak a voice clip through Replicate, for videos where I don't want to be on camera.

## Version 4

- **Audio projects:** the start screen asks Video or Audio. An audio project is for podcasts, voice-overs, lecture audio and music edits. The preview becomes a big sound wave of the whole mix scrolling past the playhead, with the names of what's playing and left and right level meters that go red above 0 dB. Click or drag on the wave to move around, scroll to zoom.
- **Only sound:** in an audio project a video brings just its sound, photos stay in the library, the timeline shows audio tracks only, and the picture tools (text, shapes, crop, masks and so on) are hidden. The first audio track is the main one: with Magnetic on, cutting a piece out closes the gap, the same as the main video track.
- **Edit an audio file:** on the start screen, opens a recording or a song straight into a new audio project. "Join audio files" puts several recordings end to end with a short fade at each join.
- **Left and right:** every clip with sound has a Left / right slider, and the export places it the same way the preview does.
- **Level out the voice:** a compressor that brings quiet words up and loud ones down so a voice sits at one steady level. It's next to Remove background noise and Even out loudness.
- **Audio export:** MP3, M4A or WAV with an optional podcast loudness of -16 LUFS and a size estimate, plus the transcript as text with times or as SRT subtitles.
- **Switching:** Tools, then "Switch to an audio project" (or back to video), or Project type in the panel on the right when nothing is selected. Nothing on the timeline is lost, and if the first audio track has gaps, Magnetic turns off so nothing moves.
- **Match my video:** a new project can take the shape and size of the first video put on the timeline, which is the default on the start screen. Putting a 16:9 video into a 9:16 project offers a Match the video button, and Canvas in the project settings has Match a video on the timeline.
- **How-to guides:** press F1, click the ? at the top right, or open Help. Picking a task such as "Separate the sound from a video" lights up each button to press in turn and moves on by itself once the step is done. There are 27 guides, and audio projects show only the ones that apply.
- **Paid services off:** Claude and Replicate stay switched off and hidden until I turn on Paid services in Settings. Everything else runs free on this computer.

## Speech to text (Whisper)

Captions, the transcript, filler word removal and dubbing timing all use whisper.cpp, which runs on this computer for free and sends nothing anywhere. It sets itself up the first time I use one of those, or ahead of time from Settings, under Speech to text, with Download now. That page also shows whether the engine and the model are ready.

- **Engine:** 4 MB, or 457 MB for the NVIDIA GPU version, which is about 5 times faster. The GPU switch is on the same page.
- **Accuracy:** Base (148 MB, fastest), Small (190 MB, the default) or Large turbo (574 MB, best for Filipino and mixed English and Tagalog).
- **Language:** Detect automatically, or pick English, Filipino, Thai, Spanish, Chinese, Japanese or Korean when detection gets it wrong.

Everything goes into the tools folder in AppData, which "Open the tools folder" in Settings opens. Deleting that folder just means it downloads again next time.

## Claude and Replicate (paid, off by default)

These charge per use, so they're switched off until I tick "Allow paid services" in Settings. While off, shorts, translation, chapters, my voice, the talking presenter, AI photo upscale and Generate with AI are hidden from the menus and panels. Shorts, translation and chapters need a Claude API key from console.anthropic.com, pasted in Settings. Picking shorts from a 30-minute lecture costs a few US cents. My voice, the talking presenter, AI photo upscale and Generate with AI need a Replicate token and are billed per use on that account. The Replicate model names are in Settings: my voice uses `lucataco/xtts-v2`, the presenter `cjwbw/sadtalker` and the upscale `nightmareai/real-esrgan`. If Replicate retires one of them, the error names the model, and swapping in a newer one in Settings fixes it.

Dubbing voices on this computer cover English, Spanish, Chinese, Vietnamese and French. Piper has no Filipino or Thai voice yet, so those translations come out as captions only, and XTTS (my voice) doesn't speak Filipino either.

## Downloads on first use

| Tool | Size | Downloaded when |
| --- | --- | --- |
| FFmpeg | about 190 MB | the first start |
| whisper.cpp and the Small speech model | about 194 MB (650 MB with the GPU engine) | the first captions or transcript, or Download now in Settings |
| Piper and one voice | about 80 MB | the first text to speech |
| Background removal model | 5 to 170 MB depending on the choice | the first background removal |
| Depth model | 99 MB | the first moving photo |

The face finder is only 1.2 MB and comes with the editor. The speech model can be switched to Large turbo in Settings, under Speech to text, for better accuracy on Filipino.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| F1 | How-to guides |
| Space | Play or pause |
| S or Ctrl+B | Split at the playhead |
| Delete | Delete |
| Shift+Delete | Delete and close the gap |
| Ctrl+D | Duplicate |
| Ctrl+C, Ctrl+X, Ctrl+V | Copy, cut and paste |
| Left, Right | One frame back or forward (Shift for 10) |
| Up, Down | Previous or next cut |
| J, L | One second back or forward |
| I, O | Set in and out points |
| M | Add a marker |
| K | Keyframe at the playhead |
| F | Freeze frame |
| C | Crop on the preview |
| T | Add text |
| N | Snapping on or off |
| + and -, or the mouse wheel | Zoom the timeline around the pointer |
| Shift+wheel | Scroll the timeline sideways |
| Home, End | Go to the start or the end (also the buttons beside the play controls) |
| Shift+Z | Fit the whole project |
| Ctrl+Z, Ctrl+Y | Undo and redo |
| Ctrl+S | Save |
| Ctrl+E | Export |
| Ctrl+I | Import media |
| 1, 2, 3 | Switch angles while "Switch angles" is open |
| Delete | In the Transcript panel, cuts the selected words |
| Esc | Leaves crop or freehand mask drawing |

## How it is built

A Tauri 2 app like the PDF reader and the Photo Editor. The window is a web page that draws the preview with WebGL2, and the export decodes and encodes every frame with WebCodecs through Mediabunny, so the preview and the export come from the same renderer. FFmpeg makes the edit copies and adds the final audio, which is mixed from 48 kHz audio files kept next to each edit copy. The Rust side (`src-tauri`) reads and writes files, runs FFmpeg, whisper.cpp and Piper, and downloads the tools. `docs/backend-api.md` lists every command it offers.

The browser tests in `tests` run the whole editor in Chromium against `tests/dev-server.mjs`, a small Node server with the same commands as the Rust side.

## What has been tested

Everything above ran in Chromium on Linux: 14 test files with 192 checks, all passing. An audit script (`tests/t15-audit.mjs`) also clicks every menu item, panel button, inspector tab, button, slider and right-click entry at a 1080p laptop size, 975 clicks in a video project and 340 in an audio project (`AUDIT_MODE=audio`), and fails on any error, error message, stray "null" text or layout spilling out of its panel. The edit copies there are VP9 since that browser has no H.264. Speech to text was tested with timed words put in by hand, since the test machine can't download a real Whisper model, and the Claude and Replicate answers were stood in by test replies. On Windows the editor switches to H.264, which WebView2 plays and encodes on the graphics card. The Windows build and the H.264 path have not run yet, so the first run on the laptop is the real test. If anything fails, send Claude a screenshot of the black window or the error message in the editor.
