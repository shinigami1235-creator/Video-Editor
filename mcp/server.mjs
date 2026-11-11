#!/usr/bin/env node
// Video Editor MCP server: lets Claude control Gid's Video Editor.
//
// Claude talks to this server over stdio (the Model Context Protocol). The
// editor talks to it over http://127.0.0.1:<port>, asking for the next request
// and posting the answer. The port and a random key go into
// ~/.cygnus-video-editor/bridge.json, which only programs on this computer can
// read. Every request must carry that key and must not come from a web page.
//
// Only one copy talks to the editor. The Claude app can start several copies of
// this server (one per chat, the remote session, a reconnect). The first copy
// is the hub: it owns bridge.json and the editor polls it. Every later copy
// finds the hub through bridge.json and passes its calls to the hub over the
// same local channel, instead of taking the editor away from the others. If
// the hub goes away, the next copy that needs the editor becomes the hub.
//
// No packages needed: plain Node 18 or newer.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { TOOLS, INSTRUCTIONS } from './tools.mjs';

const VERSION = '1.0.1';
const BASE_PORT = Number(process.env.VE_MCP_PORT) || 47811;
const BRIDGE_DIR = process.env.VE_BRIDGE_DIR || path.join(os.homedir(), '.cygnus-video-editor');
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json');
const KEY = crypto.randomBytes(24).toString('hex');
// The Claude app gives up on a tool call after about 60 s, so every call
// answers well inside that: the editor answers with a job_id after WAIT_DEFAULT
// seconds and the server stops waiting WAIT_MARGIN seconds after that.
const WAIT_DEFAULT = 35;
const WAIT_MAX = 40;
const WAIT_MARGIN = 10;
const log = (...a) => process.stderr.write('[video-editor-mcp] ' + a.join(' ') + '\n');

// ---------------------------------------------------------------------------
// The editor side: a long-poll queue on 127.0.0.1
// ---------------------------------------------------------------------------

const queue = []; // requests waiting for the editor
const waiters = []; // editor polls waiting for a request
const pending = new Map(); // request id -> { resolve, timer, delivered }
let lastSeen = 0;
let seq = 0;

/** The tool the editor is working on right now, if any. */
function busyWith() {
  for (const p of pending.values()) if (p.delivered) return p.tool;
  return null;
}

// The editor handles one request at a time and does not poll while it works,
// so a request it is working on counts as connected.
function editorConnected() {
  if (waiters.length > 0 || Date.now() - lastSeen < 6000) return true;
  for (const p of pending.values()) if (p.delivered) return true;
  return false;
}

function deliver() {
  while (queue.length && waiters.length) {
    const w = waiters.shift();
    clearTimeout(w.timer);
    const q = queue.shift();
    const p = pending.get(q.id);
    if (p) p.delivered = true;
    w.send(200, q);
  }
}

function sendToEditor(tool, args, timeoutMs) {
  return new Promise((resolve) => {
    const id = 'r' + ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      const i = queue.findIndex((q) => q.id === id);
      if (i >= 0) queue.splice(i, 1);
      resolve({ ok: false, error: 'The editor did not answer in time. It may be busy or closed. Call editor_status to check.' });
    }, timeoutMs);
    pending.set(id, { resolve, timer, tool });
    queue.push({ id, tool, args });
    deliver();
  });
}

const server = http.createServer((req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(obj == null ? '' : JSON.stringify(obj));
  };
  // only the editor: no browser (they always send Origin on these requests), the right key, a local host name
  const host = (req.headers.host || '').split(':')[0];
  if (req.headers.origin || !['127.0.0.1', 'localhost'].includes(host) || req.headers['x-bridge-key'] !== KEY) return reply(401, { error: 'not allowed' });
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/poll') {
    lastSeen = Date.now();
    if (queue.length) {
      const q = queue.shift();
      const p = pending.get(q.id);
      if (p) p.delivered = true;
      return reply(200, q);
    }
    const wait = Math.min(30000, Number(url.searchParams.get('wait')) || 25000);
    const w = {
      send: (code, obj) => {
        lastSeen = Date.now();
        reply(code, obj);
      },
    };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      w.send(204, null);
    }, wait);
    req.on('close', () => {
      const i = waiters.indexOf(w);
      if (i >= 0) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
      }
    });
    waiters.push(w);
    return;
  }
  // the other copies of this server, passing their calls through the hub
  if (req.method === 'GET' && url.pathname === '/hello') return reply(200, { hub: true, pid: process.pid, version: VERSION });
  if (req.method === 'GET' && url.pathname === '/status') return reply(200, { connected: editorConnected(), busy: busyWith() });
  if (req.method === 'POST' && url.pathname === '/call') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      try {
        const { tool, args, timeoutMs } = JSON.parse(body);
        reply(200, await sendToEditor(tool, args || {}, Math.min(Number(timeoutMs) || 45000, (WAIT_MAX + WAIT_MARGIN) * 1000)));
      } catch {
        reply(400, { error: 'bad json' });
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 64 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      lastSeen = Date.now();
      try {
        const msg = JSON.parse(body);
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve(msg);
        }
        reply(200, { ok: true });
      } catch {
        reply(400, { error: 'bad json' });
      }
    });
    return;
  }
  reply(404, { error: 'not found' });
});

let role = 'starting'; // hub | spoke
let hub = null; // { port, key } of the hub when this copy is a spoke
let becoming = null;

function listen(port, tries = 0) {
  return new Promise((resolve) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries < 20) resolve(listen(port + 1, tries + 1));
      else {
        log('could not listen:', e.message);
        resolve(false);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ port, key: KEY, pid: process.pid, version: VERSION }), { mode: 0o600 });
      log('hub: waiting for the editor on port', port);
      resolve(true);
    });
  });
}

/** Asks the server named in bridge.json whether it is alive. */
function hubFromFile() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return Promise.resolve(null);
  }
  if (!cfg?.port || !cfg?.key || cfg.key === KEY) return Promise.resolve(null);
  return hubRequest(cfg, 'GET', '/hello', null, 1500)
    .then((r) => (r.status === 200 && JSON.parse(r.body).hub ? cfg : null))
    .catch(() => null);
}

function hubRequest(cfg, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: cfg.port, path: p, method, headers: { 'x-bridge-key': cfg.key, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Becomes the hub, or a spoke of the hub that is already running. */
function settle() {
  if (becoming) return becoming;
  becoming = (async () => {
    const found = await hubFromFile();
    if (found) {
      role = 'spoke';
      hub = found;
      // end the editor's open polls here so it reads bridge.json again and moves to the hub
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.send(204, null);
      }
      log('another copy (pid ' + found.pid + ') talks to the editor; passing calls to it');
    } else {
      role = 'hub';
      hub = null;
      if (!server.listening) await listen(BASE_PORT);
      else fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ port: server.address().port, key: KEY, pid: process.pid, version: VERSION }), { mode: 0o600 });
    }
  })().finally(() => (becoming = null));
  return becoming;
}
await settle();

/** Runs a call on the editor, through the hub when this copy is a spoke. */
/** True when bridge.json still names this copy, so the editor is polling it. */
function ownsBridge() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8')).key === KEY;
  } catch {
    return false;
  }
}

async function toEditor(tool, args, timeoutMs) {
  // two copies that started together can both become the hub; the one whose file lost hands over
  if (role === 'hub' && !ownsBridge()) await settle();
  if (role === 'spoke') {
    try {
      const r = await hubRequest(hub, 'POST', '/call', { tool, args, timeoutMs }, timeoutMs + 5000);
      if (r.status === 200) return JSON.parse(r.body);
    } catch {}
    // the hub has gone: take over and try once more
    await settle();
    if (role === 'spoke') return { ok: false, error: 'Could not reach the copy of the Video Editor connector that talks to the editor. Try again.' };
  }
  return sendToEditor(tool, args, timeoutMs);
}

async function editorState() {
  if (role === 'hub' && !ownsBridge()) await settle();
  if (role === 'spoke') {
    try {
      const r = await hubRequest(hub, 'GET', '/status', null, 3000);
      if (r.status === 200) return JSON.parse(r.body);
    } catch {}
    await settle();
    if (role === 'spoke') return { connected: false, busy: null };
  }
  return { connected: editorConnected(), busy: busyWith() };
}
const connected = async () => (await editorState()).connected;

function cleanup() {
  try {
    const cur = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    if (cur.key === KEY) fs.unlinkSync(BRIDGE_FILE);
  } catch {}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// ---------------------------------------------------------------------------
// The Claude side: MCP over stdio
// ---------------------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: 'text', text: `There is no tool "${name}".` }], isError: true };
  if (name === 'editor_status') {
    const st = await editorState();
    const ok = st.connected;
    if (ok && st.busy) return { content: [{ type: 'text', text: `The Video Editor is open and connected. It is busy with ${st.busy}; that call answers when it finishes, or use check_job with its job_id.` }] };
    const text = ok
      ? 'The Video Editor is open and connected.'
      : 'The Video Editor is not connected. Ask Gid to open the Video Editor on this computer and check that Settings > Claude control is on. The editor connects within a few seconds.';
    if (!ok) return { content: [{ type: 'text', text }] };
    const r = await toEditor('get_project', {}, 15000);
    const busy = !r.ok && /did not answer in time/.test(r.error || '');
    return { content: [{ type: 'text', text: busy ? 'The Video Editor is open and connected, but busy with an earlier request (an export, an import or opening a project). Use check_job, or try again shortly.' : text + (r.ok ? '\n\n' + JSON.stringify(r.result) : '') }] };
  }
  if (!(await connected())) {
    // the editor polls every few seconds; give it a moment
    for (let i = 0; i < 16 && !(await connected()); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await connected())) return { content: [{ type: 'text', text: 'The Video Editor is not open, or Claude control is off in its Settings. Ask Gid to open it, then try again.' }], isError: true };
  }
  const wait = Math.max(1, Math.min(WAIT_MAX, Number(args.wait_seconds) || WAIT_DEFAULT));
  const r = await toEditor(name, { ...args, wait_seconds: wait }, (wait + WAIT_MARGIN) * 1000);
  const extra = [];
  if (r.messages?.length) extra.push('Editor messages: ' + r.messages.join(' | '));
  if (r.warnings?.length) extra.push('Editor warnings: ' + r.warnings.join(' | '));
  if (r.dialogs_answered?.length) extra.push('Dialogs answered automatically: ' + r.dialogs_answered.join(', '));
  if (!r.ok) return { content: [{ type: 'text', text: [r.error || 'The editor reported a problem.', ...extra].join('\n') }], isError: true };
  if (r.content) return { content: [...r.content, ...(extra.length ? [{ type: 'text', text: extra.join('\n') }] : [])] };
  return { content: [{ type: 'text', text: [JSON.stringify(r.result, null, 1), ...extra].join('\n') }] };
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'video-editor', title: 'Video Editor', version: VERSION }, instructions: INSTRUCTIONS } });
    }
    if (method === 'ping') return isRequest && send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) } });
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments || {});
      return send({ jsonrpc: '2.0', id, result });
    }
    if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
    if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    if (!isRequest) return; // notifications such as notifications/initialized
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: e?.message || String(e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(msg)) msg.forEach(onMessage);
  else onMessage(msg);
});
rl.on('close', () => process.exit(0));
