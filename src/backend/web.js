// Browser backend used by the automated tests. It talks to tests/dev-server.mjs.
// Dialogs read answers from window.__testDialogs, which the tests fill in.

const listeners = new Map();
let source = null;

export async function init() {
  source = new EventSource('/api/events');
  await new Promise((resolve) => {
    source.onopen = resolve;
    setTimeout(resolve, 1500);
  });
}

async function post(cmd, body, headers = {}) {
  const res = await fetch('/api/invoke/' + cmd, { method: 'POST', body, headers });
  if (cmd === 'fs_read_bytes' && res.ok) return res.arrayBuffer();
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || cmd + ' failed');
  return json.result;
}

export function invoke(cmd, args) {
  return post(cmd, JSON.stringify(args || {}), { 'content-type': 'application/json' });
}

export function on(event, cb) {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
    source.addEventListener(event, (e) => {
      const payload = JSON.parse(e.data);
      for (const fn of listeners.get(event) || []) fn(payload);
    });
  }
  set.add(cb);
  return () => set.delete(cb);
}

// Served from a different origin on purpose, the same way the desktop app reads
// media from media.localhost, so CORS problems show up in tests too.
const FILE_ORIGIN = `http://127.0.0.1:${globalThis.__fileServerPort || 5174}`;

export function fileUrl(path) {
  return FILE_ORIGIN + '/file?path=' + encodeURIComponent(path);
}

export function readBytes(path, offset, length) {
  return post('fs_read_bytes', JSON.stringify({ path, offset, length }), { 'content-type': 'application/json' });
}

export function writeBytes(path, data, offset, truncate) {
  return post('fs_write_bytes', data, {
    'x-path': encodeURIComponent(path),
    'x-offset': String(offset),
    'x-truncate': truncate ? '1' : '0',
    'content-type': 'application/octet-stream',
  });
}

export function procWrite(jobId, data) {
  return post('proc_write', data, { 'x-job': jobId, 'content-type': 'application/octet-stream' });
}

function nextDialogAnswer(kind) {
  const q = (window.__testDialogs ||= []);
  if (q.length) return q.shift();
  const answer = window.prompt(kind + ' path');
  return answer || null;
}

export async function openDialog({ multiple = false } = {}) {
  const a = nextDialogAnswer('Open');
  if (multiple) return a == null ? [] : Array.isArray(a) ? a : [a];
  return Array.isArray(a) ? a[0] : a;
}

export async function saveDialog() {
  return nextDialogAnswer('Save');
}

export function onFileDrop() {}
