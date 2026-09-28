import { invoke as tauriInvoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

const listeners = new Map();

export async function init() {}

export function invoke(cmd, args) {
  return tauriInvoke(cmd, args);
}

export function on(event, cb) {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
    listen(event, (e) => {
      for (const fn of listeners.get(event) || []) fn(e.payload);
    });
  }
  set.add(cb);
  return () => set.delete(cb);
}

export function fileUrl(path) {
  return convertFileSrc(path, 'media');
}

export function readBytes(path, offset, length) {
  return tauriInvoke('fs_read_bytes', { path, offset, length });
}

export function writeBytes(path, data, offset, truncate) {
  return tauriInvoke('fs_write_bytes', data, {
    headers: {
      'x-path': encodeURIComponent(path),
      'x-offset': String(offset),
      'x-truncate': truncate ? '1' : '0',
    },
  });
}

export function procWrite(jobId, data) {
  return tauriInvoke('proc_write', data, { headers: { 'x-job': jobId } });
}

export async function openDialog({ multiple = false, filters, directory = false, title } = {}) {
  const r = await open({ multiple, filters, directory, title });
  if (r == null) return multiple ? [] : null;
  return r;
}

export async function saveDialog({ defaultPath, filters, title } = {}) {
  return (await save({ defaultPath, filters, title })) || null;
}

export function onFileDrop(cb) {
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop' && event.payload.paths?.length) {
      cb(event.payload.paths, event.payload.position);
    }
  });
}

export function setWindowTitle(title) {
  getCurrentWindow().setTitle(title).catch(() => {});
}
