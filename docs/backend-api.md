# Backend API

The frontend talks to one backend interface (`src/backend/index.js`). In the
desktop app it is the Rust side of Tauri 2. In the test container it is
`tests/dev-server.mjs`, a Node server with the same commands, so the frontend
code runs unchanged in a plain browser.

All paths are absolute native paths (`C:\Users\...` on Windows).

## Commands

Arguments are camelCase in JavaScript. Tauri maps them to snake_case Rust
parameters.

| Command | Arguments | Returns |
| --- | --- | --- |
| `app_paths` | none | `{ appData, cache, documents, videos, music, pictures, temp, home, resource, platform, sep }` where `platform` is `windows`, `linux` or `macos` and `sep` is the path separator |
| `fs_exists` | `path` | `boolean` |
| `fs_stat` | `path` | `{ size, mtimeMs, isDir, isFile }` or `null` when missing |
| `fs_mkdir` | `path` | `null`, creates parents |
| `fs_list` | `path` | `[{ name, isDir, size, mtimeMs }]` |
| `fs_read_text` | `path` | `string` (UTF-8) |
| `fs_write_text` | `path, contents` | `null`, creates parent folders, writes a temp file then renames it over the target |
| `fs_read_bytes` | `path, offset, length` | raw bytes (`ArrayBuffer`). `length` of `-1` reads to the end |
| `fs_write_bytes` | raw body plus headers `x-path` (encodeURIComponent of the path), `x-offset` (byte offset, or `-1` to append), `x-truncate` (`1` to create or empty the file first) | number of bytes written |
| `fs_remove` | `path` | `null`, removes a file or a folder with its contents, no error if missing |
| `fs_rename` | `from, to` | `null` |
| `fs_copy` | `from, to` | `null`, file only, creates parent folders |
| `proc_spawn` | `jobId, program, args, cwd` (`cwd` may be null) | `pid`. Output arrives as events |
| `proc_write` | raw body plus header `x-job` | `null`, writes bytes to the process stdin |
| `proc_close_stdin` | `jobId` | `null` |
| `proc_kill` | `jobId` | `null`, no error if already finished |
| `download` | `jobId, url, dest` | `null` once finished. Follows redirects, writes `dest + ".part"` then renames. Progress arrives as events |
| `download_cancel` | `jobId` | `null`, stops a running download and deletes its `.part` file |
| `unzip` | `zipPath, destDir` | number of files extracted. Keeps folder structure |
| `http_request` | `method, url, headers` (object), `body` (string or null) | `{ status, headers, body }` with `body` as text |
| `reveal_path` | `path` | `null`, opens Explorer with the file selected (Windows), or the folder elsewhere |
| `open_path` | `path` | `null`, opens a file or folder with the default program |

## Events

| Event | Payload |
| --- | --- |
| `proc-output` | `{ jobId, stream, line }` where `stream` is `stdout` or `stderr`. Lines split on `\n` and `\r`, empty lines dropped |
| `proc-exit` | `{ jobId, code }` (`code` is `null` when killed) |
| `download-progress` | `{ jobId, received, total }` (`total` is `0` when unknown) |

## Media URLs

Local files reach the web view through the `media` URI scheme. The frontend
calls `convertFileSrc(path, 'media')`, which gives
`http://media.localhost/<encoded path>` on Windows and
`media://localhost/<encoded path>` on Linux and macOS.

The handler must:

- decode the percent-encoded path
- answer `Range: bytes=a-b` and `bytes=a-` with `206 Partial Content`,
  `Content-Range`, `Accept-Ranges: bytes`, and cap an open-ended range at 8 MiB
- answer requests without a range with the whole file and `200`
- set `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges`, since the page reads media from another origin and Mediabunny needs `Content-Range` to learn the file size
- set `Content-Type` from the extension (mp4, webm, mov, mkv, m4a, mp3, wav,
  ogg, png, jpg, jpeg, webp, gif, json, onnx, wasm, bin) and
  `Access-Control-Allow-Origin: *`
- answer a missing file with `404`

The test server serves the same thing at `/file?path=<encoded path>`.

## Processes on Windows

Spawned processes use the `CREATE_NO_WINDOW` creation flag so no console
window flashes. Every child is killed when the app window closes.
