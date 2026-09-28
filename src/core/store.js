// Global editor state: the open project, selection, playhead, undo history.

import { Emitter, clone, debounce } from './util.js';
import { newProject, projectDuration } from './model.js';

const HISTORY_LIMIT = 150;

class Store extends Emitter {
  constructor() {
    super();
    this.project = newProject();
    this.projectPath = null;
    this.dirty = false;
    this.selection = new Set();
    this.selectedMedia = null;
    this.playhead = 0;
    this.playing = false;
    this.zoom = 60; // timeline pixels per second
    this.snapping = true;
    this.inPoint = null;
    this.outPoint = null;
    this.selectedKeyframe = null;
    this.undoStack = [];
    this.redoStack = [];
    this._gesture = null;
    this.settings = {};
    this._emitChange = debounce(() => this.emit('change'), 0);
  }

  // ---- history ----------------------------------------------------------

  _snapshot() {
    const p = this.project;
    return JSON.stringify({ tracks: p.tracks, items: p.items, markers: p.markers, settings: p.settings, captionStyle: p.captionStyle, name: p.name });
  }

  _restore(snap) {
    const s = JSON.parse(snap);
    Object.assign(this.project, s);
    for (const id of [...this.selection]) if (!this.project.items[id]) this.selection.delete(id);
  }

  /** Applies fn(project) as one undoable step. */
  commit(label, fn) {
    const before = this._gesture ? null : this._snapshot();
    const result = fn(this.project);
    if (before) this._push(label, before);
    this._changed();
    return result;
  }

  /** Applies fn without recording history (use inside a gesture, or for UI-only state). */
  mutate(fn) {
    const r = fn(this.project);
    this._changed();
    return r;
  }

  beginGesture() {
    if (!this._gesture) this._gesture = this._snapshot();
  }

  endGesture(label) {
    if (!this._gesture) return;
    const before = this._gesture;
    this._gesture = null;
    if (before !== this._snapshot()) this._push(label, before);
    this._changed();
  }

  cancelGesture() {
    if (!this._gesture) return;
    this._restore(this._gesture);
    this._gesture = null;
    this._changed();
  }

  _push(label, before) {
    this.undoStack.push({ label, snap: before });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dirty = true;
    this.emit('history');
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ label: step.label, snap: this._snapshot() });
    this._restore(step.snap);
    this.dirty = true;
    this._changed();
    this.emit('history');
    return step.label;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push({ label: step.label, snap: this._snapshot() });
    this._restore(step.snap);
    this.dirty = true;
    this._changed();
    this.emit('history');
    return step.label;
  }

  _changed() {
    this.project.modified = Date.now();
    this.dirty = true;
    this._emitChange();
  }

  /** Notify listeners without marking the project dirty (media status, UI state). */
  touch() {
    this._emitChange();
  }

  // ---- project ----------------------------------------------------------

  loadProject(project, path = null) {
    this.project = project;
    this.projectPath = path;
    this.selection.clear();
    this.selectedMedia = null;
    this.playhead = 0;
    this.inPoint = this.outPoint = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.emit('project');
    this.emit('history');
    this._emitChange();
  }

  get duration() {
    return projectDuration(this.project);
  }

  // ---- selection and playhead ------------------------------------------

  select(ids, { add = false } = {}) {
    if (!add) this.selection.clear();
    for (const id of [].concat(ids)) if (id) this.selection.add(id);
    this.selectedKeyframe = null;
    this.emit('selection');
  }

  toggleSelect(id) {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.emit('selection');
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.selectedKeyframe = null;
    this.emit('selection');
  }

  get selectedItems() {
    return [...this.selection].map((id) => this.project.items[id]).filter(Boolean);
  }

  get primary() {
    const items = this.selectedItems;
    return items.length ? items[items.length - 1] : null;
  }

  seek(t, { fromPlayer = false } = {}) {
    const max = Math.max(this.duration, 0);
    this.playhead = Math.max(0, Math.min(t, max + 30));
    this.emit('seek', { fromPlayer });
  }

  frameDuration() {
    return 1 / (this.project.settings.fps || 30);
  }

  snapTime(t) {
    const f = this.project.settings.fps || 30;
    return Math.round(t * f) / f;
  }
}

export const store = new Store();
if (typeof window !== 'undefined') window.__store = store;

export function cloneProject(p) {
  return clone(p);
}
