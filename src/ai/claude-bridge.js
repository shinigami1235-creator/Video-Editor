// Claude control: the Video Editor MCP server (mcp/server.mjs) runs inside the
// Claude desktop app and listens on 127.0.0.1. It writes its port and a
// random key to ~/.cygnus-video-editor/bridge.json. The editor reads that file,
// asks the server for Claude's next request, runs it and sends the answer back.
// Requests go through the Rust side (http_request), so no web page can join in.

import { store } from '../core/store.js';
import { invoke, readText, join, paths } from '../backend/index.js';
import { notifyHooks } from '../ui/notify.js';

const POLL_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app = null;
let status = 'off'; // off | waiting | connected
const listeners = new Set();
const jobs = new Map(); // job id -> { promise, ctx, done, result, error }
let jobSeq = 0;

export function claudeStatus() {
  return status;
}

export function onClaudeStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setStatus(s) {
  if (status === s) return;
  status = s;
  for (const fn of listeners) fn(s);
}

async function bridgeConfig() {
  try {
    const cfg = JSON.parse(await readText(join(paths.home, '.cygnus-video-editor', 'bridge.json')));
    return cfg?.port && cfg?.key ? cfg : null;
  } catch {
    return null;
  }
}

async function call(cfg, method, path, body) {
  return invoke('http_request', {
    method,
    url: `http://127.0.0.1:${cfg.port}${path}`,
    headers: { 'x-bridge-key': cfg.key, 'content-type': 'application/json' },
    body: body == null ? null : JSON.stringify(body),
  });
}

export function startClaudeBridge(theApp) {
  if (app) return;
  app = theApp;
  loop();
}

async function loop() {
  for (;;) {
    try {
      await step();
    } catch (e) {
      console.warn('Claude control', e);
      setStatus('waiting');
      await sleep(3000);
    }
  }
}

async function step() {
  if (!store.settings || !paths) return sleep(1000);
  if (store.settings.claudeControl === false) {
    setStatus('off');
    await sleep(2000);
    return;
  }
  const cfg = await bridgeConfig();
  if (!cfg) {
    setStatus('waiting');
    await sleep(3000);
    return;
  }
  try {
    // a short first poll shows "connected" straight away; after that, wait for work
    const res = await call(cfg, 'GET', `/poll?wait=${status === 'connected' ? POLL_MS : 300}`);
    if (res.status === 401) {
      // an old file from a server that has stopped
      setStatus('waiting');
      await sleep(3000);
      return;
    }
    setStatus('connected');
    if (res.status !== 200 || !res.body) return;
    const req = JSON.parse(res.body);
    const answer = await handle(req);
    await call(cfg, 'POST', '/result', { id: req.id, ...answer }).catch(() => {});
  } catch {
    setStatus('waiting');
    await sleep(3000);
  }
}

/** Runs one request. Long ones keep going as a job and answer with its id after wait_seconds. */
async function handle(req) {
  const { tool, args = {} } = req;
  if (tool === 'check_job') return checkJob(args);
  const { TOOLS, ToolError } = await import('./claude-tools.js');
  const fn = TOOLS[tool];
  if (!fn) return { ok: false, error: `The editor has no tool "${tool}". Update the editor and the MCP server to the same version.` };
  const ctx = { app, toasts: [], jobs: [], answers: {}, job: null, dialogs: [] };
  const id = 'job' + ++jobSeq;
  const entry = { ctx, done: false };
  entry.promise = (async () => {
    // watch what the command shows, and answer its dialogs without showing them
    notifyHooks.owner = entry;
    notifyHooks.onToast = (kind, message) => ctx.toasts.push({ kind, message });
    notifyHooks.onJob = (info) => ctx.jobs.push(info);
    // only the command's own dialogs, which come before its job starts; one Gid opens meanwhile shows as usual
    notifyHooks.autoModal = (title, { kind }) => {
      if (entry.done || ctx.jobs.some((j) => j.state === 'running')) return undefined;
      ctx.dialogs.push(title);
      if (title in ctx.answers) return { value: ctx.answers[title] };
      // confirm and text prompts answer No; other dialogs take their main button
      if (kind) return { value: kind === 'confirm' ? false : null };
      return { primary: true };
    };
    try {
      entry.result = await fn(args, ctx);
      // a command may hand its work to a background job: wait for those too
      while (ctx.jobs.some((j) => j.state === 'running')) await sleep(250);
    } catch (e) {
      entry.error = e instanceof ToolError ? e.message : e?.message || String(e);
    } finally {
      entry.done = true;
      if (notifyHooks.owner === entry) {
        notifyHooks.onToast = null;
        notifyHooks.onJob = null;
        notifyHooks.autoModal = null;
        notifyHooks.owner = null;
      }
    }
  })();
  jobs.set(id, entry);
  const wait = Math.max(1, Math.min(100, Number(args.wait_seconds) || 50)) * 1000;
  await Promise.race([entry.promise, sleep(wait)]);
  return report(id, entry);
}

async function checkJob(args) {
  const entry = jobs.get(args.job_id);
  if (!entry) return { ok: false, error: `There is no job ${args.job_id}. It may be from before the editor restarted.` };
  const wait = Math.max(1, Math.min(100, Number(args.wait_seconds) || 50)) * 1000;
  await Promise.race([entry.promise, sleep(wait)]);
  return report(args.job_id, entry);
}

function report(id, entry) {
  const { ctx } = entry;
  const errors = ctx.toasts.filter((t) => t.kind === 'error' || t.kind === 'warn').map((t) => t.message);
  const messages = ctx.toasts.filter((t) => t.kind !== 'error' && t.kind !== 'warn').map((t) => t.message);
  if (!entry.done) {
    const running = ctx.job || ctx.jobs.find((j) => j.state === 'running');
    return { ok: true, result: { status: 'running', job_id: id, task: running?.title || null, progress: running?.fraction != null ? Math.round(running.fraction * 100) + '%' : null, step: running?.label || null, next: 'Call check_job with this job_id to wait for it.' } };
  }
  jobs.delete(id);
  const failed = ctx.jobs.filter((j) => j.state === 'failed' || j.state === 'cancelled');
  if (entry.error || failed.length) return { ok: false, error: entry.error || failed.map((j) => `${j.title} ${j.state}: ${j.error || ''}`).join('; '), messages, warnings: errors };
  const r = entry.result;
  if (r && Array.isArray(r.content)) return { ok: true, content: r.content, messages, warnings: errors };
  return { ok: true, result: r ?? { done: true }, messages, warnings: errors, dialogs_answered: ctx.dialogs.length ? ctx.dialogs : undefined };
}
