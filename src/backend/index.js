// One interface over the desktop backend (Tauri) and the browser test server.
// See docs/backend-api.md for the command list.

export const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

let impl = null;
export let paths = null;

export async function initBackend() {
  impl = isDesktop ? await import('./tauri.js') : await import('./web.js');
  await impl.init();
  paths = await impl.invoke('app_paths', {});
  return paths;
}

export function invoke(cmd, args = {}) {
  return impl.invoke(cmd, args);
}

/** Subscribe to a backend event. Returns an unsubscribe function. */
export function on(event, cb) {
  return impl.on(event, cb);
}

export function fileUrl(path) {
  return impl.fileUrl(path);
}

export async function readBytes(path, offset = 0, length = -1) {
  const buf = await impl.readBytes(path, offset, length);
  return new Uint8Array(buf);
}

/** Writes bytes at an offset. offset -1 appends. truncate empties the file first. */
export function writeBytes(path, bytes, { offset = -1, truncate = false } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return impl.writeBytes(path, data, offset, truncate);
}

export function procWrite(jobId, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return impl.procWrite(jobId, data);
}

export function openDialog(opts) {
  return impl.openDialog(opts);
}

export function saveDialog(opts) {
  return impl.saveDialog(opts);
}

/** Calls cb(paths) when files are dropped onto the window from the file manager. */
export function onFileDrop(cb) {
  return impl.onFileDrop(cb);
}

export function setWindowTitle(title) {
  document.title = title;
  impl.setWindowTitle?.(title);
}

// ---- small fs helpers --------------------------------------------------

export const exists = (path) => invoke('fs_exists', { path });
export const stat = (path) => invoke('fs_stat', { path });
export const mkdir = (path) => invoke('fs_mkdir', { path });
export const list = (path) => invoke('fs_list', { path });
export const readText = (path) => invoke('fs_read_text', { path });
export const writeText = (path, contents) => invoke('fs_write_text', { path, contents });
export const remove = (path) => invoke('fs_remove', { path });
export const rename = (from, to) => invoke('fs_rename', { from, to });
export const copy = (from, to) => invoke('fs_copy', { from, to });

export async function readJson(path, fallback = null) {
  try {
    if (!(await exists(path))) return fallback;
    return JSON.parse(await readText(path));
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  return writeText(path, JSON.stringify(value, null, 1));
}

export function sep() {
  return paths?.sep || '/';
}

export function join(...parts) {
  const s = sep();
  const out = [];
  parts.forEach((p, i) => {
    if (p == null || p === '') return;
    let q = String(p);
    if (i > 0) q = q.replace(/^[\\/]+/, '');
    if (i < parts.length - 1) q = q.replace(/[\\/]+$/, '');
    out.push(q);
  });
  return out.join(s);
}

export function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

export function dirname(p) {
  const parts = String(p).split(/[\\/]/);
  parts.pop();
  return parts.join(sep());
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
