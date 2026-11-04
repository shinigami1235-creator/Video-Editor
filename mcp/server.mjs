#!/usr/bin/env node
// Video Editor MCP server: lets Claude control Gid's Video Editor.
//
// Claude talks to this server over stdio (the Model Context Protocol). The
// editor talks to it over http://127.0.0.1:<port>, asking for the next request
// and posting the answer. The port and a random key go into
// ~/.cygnus-video-editor/bridge.json, which only programs on this computer can
// read. Every request must carry that key and must not come from a web page.
//
// No packages needed: plain Node 18 or newer.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { TOOLS, INSTRUCTIONS } from './tools.mjs';

const VERSION = '1.0.0';
const BASE_PORT = Number(process.env.VE_MCP_PORT) || 47811;
const BRIDGE_DIR = process.env.VE_BRIDGE_DIR || path.join(os.homedir(), '.cygnus-video-editor');
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json');
const KEY = crypto.randomBytes(24).toString('hex');
const log = (...a) => process.stderr.write('[video-editor-mcp] ' + a.join(' ') + '\n');

// ---------------------------------------------------------------------------
// The editor side: a long-poll queue on 127.0.0.1
// ---------------------------------------------------------------------------

const queue = []; // requests waiting for the editor
const waiters = []; // editor polls waiting for a request
const pending = new Map(); // request id -> { resolve, timer }
let lastSeen = 0;
let seq = 0;

function editorConnected() {
  return waiters.length > 0 || Date.now() - lastSeen < 6000;
}

function deliver() {
  while (queue.length && waiters.length) {
    const w = waiters.shift();
    clearTimeout(w.timer);
    w.send(200, queue.shift());
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
    pending.set(id, { resolve, timer });
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
    if (queue.length) return reply(200, queue.shift());
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

function listen(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 20) listen(port + 1, tries + 1);
    else log('could not listen:', e.message);
  });
  server.listen(port, '127.0.0.1', () => {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ port, key: KEY, pid: process.pid, version: VERSION }), { mode: 0o600 });
    log('waiting for the editor on port', port);
  });
}
listen(BASE_PORT);

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
    const ok = editorConnected();
    const text = ok
      ? 'The Video Editor is open and connected.'
      : 'The Video Editor is not connected. Ask Gid to open the Video Editor on this computer and check that Settings > Claude control is on. The editor connects within a few seconds.';
    if (!ok) return { content: [{ type: 'text', text }] };
    const r = await sendToEditor('get_project', {}, 15000);
    return { content: [{ type: 'text', text: text + (r.ok ? '\n\n' + JSON.stringify(r.result) : '') }] };
  }
  if (!editorConnected()) {
    // the editor polls every few seconds; give it a moment
    for (let i = 0; i < 8 && !editorConnected(); i++) await new Promise((r) => setTimeout(r, 500));
    if (!editorConnected()) return { content: [{ type: 'text', text: 'The Video Editor is not open, or Claude control is off in its Settings. Ask Gid to open it, then try again.' }], isError: true };
  }
  const wait = Math.max(1, Math.min(100, Number(args.wait_seconds) || 50));
  const r = await sendToEditor(name, args, (wait + 30) * 1000);
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
