// Toasts, the background jobs list, and modal dialogs.

import { h, icon, button, clear } from './dom.js';
import { formatBytes } from '../core/util.js';

let toastHost = null;
let jobHost = null;
const jobs = new Map();

export function initNotify(root) {
  toastHost = h('div', { class: 'toasts' });
  jobHost = h('div', { class: 'jobs' });
  root.append(toastHost, jobHost);
}

export function toast(message, { kind = 'info', timeout = 3500, action } = {}) {
  const t = h('div', { class: `toast toast-${kind}` }, h('span', {}, message));
  if (action) t.append(button(action.label, () => { action.run(); t.remove(); }, { kind: 'link' }));
  t.append(h('button', { class: 'toast-x', onclick: () => t.remove(), 'aria-label': 'Close' }, icon('x', 14)));
  toastHost.append(t);
  if (timeout) setTimeout(() => t.remove(), kind === 'error' ? Math.max(timeout, 8000) : timeout);
  return t;
}

export function errorToast(e, prefix = '') {
  if (e?.name === 'AbortError' || e?.shown) return;
  console.error(e);
  toast((prefix ? prefix + ' ' : '') + (e?.message || String(e)), { kind: 'error', timeout: 9000 });
}

/**
 * Shows a job with a progress bar. Returns { update(fraction, label), done(msg), fail(e), signal }.
 */
export function startJob(title, { cancellable = true } = {}) {
  const ctrl = new AbortController();
  const bar = h('div', { class: 'job-bar' }, h('div', { class: 'job-fill' }));
  const label = h('div', { class: 'job-label' }, 'Starting');
  const el = h('div', { class: 'job' }, h('div', { class: 'job-title' }, title), bar, label);
  if (cancellable) el.append(h('button', { class: 'job-x', title: 'Cancel', onclick: () => ctrl.abort() }, icon('x', 14)));
  jobHost.append(el);
  const id = Math.random().toString(36).slice(2);
  jobs.set(id, el);
  const fill = bar.firstChild;
  const api = {
    signal: ctrl.signal,
    update(fraction, text) {
      if (fraction == null) el.classList.add('indeterminate');
      else {
        el.classList.remove('indeterminate');
        fill.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
      }
      if (text) label.textContent = text;
    },
    download(p) {
      const txt = p.total ? `${p.label}: ${formatBytes(p.received)} of ${formatBytes(p.total)}` : p.received ? `${p.label}: ${formatBytes(p.received)}` : p.label;
      api.update(p.total ? p.received / p.total : null, txt);
    },
    done(msg) {
      jobs.delete(id);
      el.remove();
      if (msg) toast(msg, { kind: 'success' });
    },
    fail(e) {
      jobs.delete(id);
      el.remove();
      // callers that rethrow should not show the same error a second time
      if (e && typeof e === 'object') e.shown = true;
      if (e?.name === 'AbortError') toast(title + ' cancelled.');
      else errorToast(e, title + ' failed.');
    },
  };
  return api;
}

export function activeJobs() {
  return jobs.size;
}

// ---------------------------------------------------------------------------
// Modal dialogs
// ---------------------------------------------------------------------------

export function modal(title, body, { actions = [], width = 520, onClose, cls = '' } = {}) {
  const overlay = h('div', { class: 'modal-overlay' });
  const box = h('div', { class: `modal ${cls}`, style: { width: width + 'px' }, role: 'dialog', 'aria-label': title });
  const close = (v) => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.(v);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
    }
  };
  document.addEventListener('keydown', onKey, true);
  const head = h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'ibtn', onclick: () => close(null), 'aria-label': 'Close' }, icon('x')));
  const foot = h('div', { class: 'modal-foot' });
  for (const a of actions) foot.append(button(a.label, () => a.run(close), { kind: a.kind || (a.primary ? 'primary' : '') }));
  box.append(head, h('div', { class: 'modal-body' }, body));
  if (actions.length) box.append(foot);
  overlay.append(box);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close(null);
  });
  document.body.append(overlay);
  return { close, box, body: box.querySelector('.modal-body') };
}

export function confirmDialog(title, message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    modal(title, h('p', {}, message), {
      width: 440,
      onClose: (v) => resolve(!!v),
      actions: [
        { label: cancel, run: (close) => close(false) },
        { label: ok, kind: danger ? 'danger' : 'primary', run: (close) => close(true) },
      ],
    });
  });
}

export function promptDialog(title, label, value = '', { ok = 'OK', multiline = false } = {}) {
  return new Promise((resolve) => {
    const inp = multiline ? h('textarea', { rows: 6 }) : h('input', { type: 'text' });
    inp.value = value;
    const m = modal(title, h('div', { class: 'row col' }, h('label', {}, label), inp), {
      width: 460,
      onClose: (v) => resolve(v),
      actions: [
        { label: 'Cancel', run: (close) => close(null) },
        { label: ok, primary: true, run: (close) => close(inp.value) },
      ],
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) m.close(inp.value);
    });
    setTimeout(() => inp.focus(), 30);
  });
}

export function setContent(el, ...children) {
  clear(el);
  el.append(...children.flat().filter(Boolean));
}

if (typeof window !== 'undefined') window.__notify = { modal, toast, confirmDialog };
