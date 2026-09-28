#!/usr/bin/env node
// Dependency-free ESM Node HTTP server implementing the backend-api.md
// contract for browser-based tests. See docs/backend-api.md.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = Number(process.env.PORT || 5174);
const TEST_ROOT = process.env.VE_TEST_ROOT || '/tmp/ve-test';

// ---------------------------------------------------------------------------
// app_paths test root
// ---------------------------------------------------------------------------

const APP_PATHS = {
  appData: path.join(TEST_ROOT, 'appdata'),
  cache: path.join(TEST_ROOT, 'cache'),
  documents: path.join(TEST_ROOT, 'documents'),
  videos: path.join(TEST_ROOT, 'videos'),
  music: path.join(TEST_ROOT, 'music'),
  pictures: path.join(TEST_ROOT, 'pictures'),
  temp: path.join(TEST_ROOT, 'temp'),
  home: TEST_ROOT,
  resource: path.join(TEST_ROOT, 'resource'),
  platform: 'linux',
  arch: 'x86_64',
  sep: '/',
};

async function ensureTestRoot() {
  await fsp.mkdir(TEST_ROOT, { recursive: true });
  for (const [key, dir] of Object.entries(APP_PATHS)) {
    if (key === 'platform' || key === 'sep') continue;
    await fsp.mkdir(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// SSE event broadcasting
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcastEvent(name, payload) {
  const chunk = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(chunk);
  }
}

setInterval(() => {
  for (const res of sseClients) {
    res.write(': ping\n\n');
  }
}, 15000);

// ---------------------------------------------------------------------------
// Content types (shared with the /file range handler)
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  json: 'application/json',
  onnx: 'application/octet-stream',
  wasm: 'application/wasm',
  bin: 'application/octet-stream',
};

function contentTypeFor(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

const OPEN_RANGE_CAP = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Process (job) management
// ---------------------------------------------------------------------------

/** @type {Map<string, { child: import('node:child_process').ChildProcess }>} */
const jobs = new Map();

function streamLines(readable, jobId, streamName) {
  let buf = Buffer.alloc(0);
  readable.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === 0x0a || b === 0x0d) {
        if (i > start) {
          const line = buf.toString('utf8', start, i);
          broadcastEvent('proc-output', { jobId, stream: streamName, line });
        }
        start = i + 1;
      }
    }
    buf = buf.subarray(start);
  });
  readable.on('end', () => {
    if (buf.length > 0) {
      const line = buf.toString('utf8');
      broadcastEvent('proc-output', { jobId, stream: streamName, line });
      buf = Buffer.alloc(0);
    }
  });
}

function procSpawn({ jobId, program, args, cwd }) {
  const child = spawn(program, args || [], {
    cwd: cwd || undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  jobs.set(jobId, { child });

  streamLines(child.stdout, jobId, 'stdout');
  streamLines(child.stderr, jobId, 'stderr');

  child.on('error', (err) => {
    jobs.delete(jobId);
    broadcastEvent('proc-output', { jobId, stream: 'stderr', line: String(err.message || err) });
    broadcastEvent('proc-exit', { jobId, code: null });
  });

  child.on('exit', (code, signal) => {
    jobs.delete(jobId);
    broadcastEvent('proc-exit', { jobId, code: signal ? null : code });
  });

  return child.pid;
}

function procWrite(jobId, bytes) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`no such job '${jobId}'`);
  if (!job.child.stdin || job.child.stdin.destroyed) {
    throw new Error(`job '${jobId}' stdin is closed`);
  }
  job.child.stdin.write(bytes);
  return null;
}

function procCloseStdin(jobId) {
  const job = jobs.get(jobId);
  if (job && job.child.stdin && !job.child.stdin.destroyed) {
    job.child.stdin.end();
  }
  return null;
}

function procKill(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    try {
      job.child.kill('SIGKILL');
    } catch {
      // already finished
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filesystem commands
// ---------------------------------------------------------------------------

async function fsExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fsStat(p) {
  try {
    const st = await fsp.stat(p);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      isDir: st.isDirectory(),
      isFile: st.isFile(),
    };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`failed to stat '${p}': ${e.message}`);
  }
}

async function fsMkdir(p) {
  await fsp.mkdir(p, { recursive: true });
  return null;
}

async function fsList(p) {
  const names = await fsp.readdir(p, { withFileTypes: true });
  const out = [];
  for (const entry of names) {
    const full = path.join(p, entry.name);
    const st = await fsp.stat(full);
    out.push({
      name: entry.name,
      isDir: st.isDirectory(),
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  return out;
}

async function fsReadText(p) {
  return fsp.readFile(p, 'utf8');
}

async function fsWriteText(p, contents) {
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, contents, 'utf8');
  await fsp.rename(tmp, p);
  return null;
}

async function fsReadBytes(p, offset, length) {
  const handle = await fsp.open(p, 'r');
  try {
    if (length < 0) {
      const st = await handle.stat();
      const start = offset > 0 ? offset : 0;
      const size = Math.max(0, st.size - start);
      const buf = Buffer.alloc(size);
      if (size > 0) await handle.read(buf, 0, size, start);
      return buf;
    }
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset > 0 ? offset : 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function fsWriteBytes(p, offset, truncate, bytes) {
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  const flags = truncate ? 'w+' : (await fsExists(p)) ? 'r+' : 'w+';
  const handle = await fsp.open(p, flags);
  try {
    const pos = offset < 0 ? (await handle.stat()).size : offset;
    await handle.write(bytes, 0, bytes.length, pos);
    return bytes.length;
  } finally {
    await handle.close();
  }
}

async function fsRemove(p) {
  try {
    const st = await fsp.lstat(p);
    if (st.isDirectory()) {
      await fsp.rm(p, { recursive: true, force: true });
    } else {
      await fsp.unlink(p);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`failed to remove '${p}': ${e.message}`);
  }
  return null;
}

async function fsRename(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return null;
}

async function fsCopy(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  return null;
}

// ---------------------------------------------------------------------------
// Network commands: download, unzip, http_request
// ---------------------------------------------------------------------------

function curlHeadContentLength(url) {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sIL', '--max-time', '10', url]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.on('close', () => {
      let total = 0;
      const matches = [...out.matchAll(/^content-length:\s*(\d+)/gim)];
      if (matches.length > 0) {
        total = Number(matches[matches.length - 1][1]) || 0;
      }
      resolve(total);
    });
    child.on('error', () => resolve(0));
  });
}

const DOWNLOADS = new Map();

function downloadCancel(jobId) {
  const child = DOWNLOADS.get(jobId);
  if (child) {
    child.__cancelled = true;
    child.kill('SIGTERM');
  }
  return null;
}

async function download(jobId, url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partPath = `${dest}.part`;

  const total = await curlHeadContentLength(url);
  broadcastEvent('download-progress', { jobId, received: 0, total });

  await new Promise((resolve, reject) => {
    const child = spawn('curl', ['-sSL', '--fail', '-o', partPath, url]);
    DOWNLOADS.set(jobId, child);
    let stderrText = '';
    child.stderr.on('data', (d) => (stderrText += d.toString('utf8')));

    const poll = setInterval(async () => {
      try {
        const st = await fsp.stat(partPath);
        broadcastEvent('download-progress', { jobId, received: st.size, total });
      } catch {
        // .part not created yet
      }
    }, 200);

    child.on('error', (err) => {
      clearInterval(poll);
      reject(new Error(`failed to download '${url}': ${err.message}`));
    });

    child.on('close', (code) => {
      clearInterval(poll);
      const cancelled = child.__cancelled;
      DOWNLOADS.delete(jobId);
      if (cancelled) {
        fsp.rm(partPath, { force: true }).finally(() => reject(new Error('download cancelled')));
        return;
      }
      if (code !== 0) {
        fsp.rm(partPath, { force: true }).catch(() => {});
        reject(new Error(`failed to download '${url}': curl exited with code ${code}${stderrText ? `: ${stderrText.trim()}` : ''}`));
        return;
      }
      resolve();
    });
  });

  const finalSize = await fsp.stat(partPath).then((s) => s.size).catch(() => 0);
  broadcastEvent('download-progress', { jobId, received: finalSize, total });

  await fsp.rename(partPath, dest);
  return null;
}

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const script = `
import sys, zipfile, os
zip_path, dest_dir = sys.argv[1], sys.argv[2]
os.makedirs(dest_dir, exist_ok=True)
count = 0
with zipfile.ZipFile(zip_path) as zf:
    for info in zf.infolist():
        name = info.filename
        # guard against path traversal / absolute paths
        norm = os.path.normpath(name)
        if norm.startswith('..') or os.path.isabs(norm):
            continue
        target = os.path.join(dest_dir, norm)
        if name.endswith('/'):
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(info) as src, open(target, 'wb') as out:
            out.write(src.read())
        count += 1
print(count)
`;
    const child = spawn('python3', ['-c', script, zipPath, destDir]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => reject(new Error(`failed to run python3: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`failed to unzip '${zipPath}': ${err.trim() || `exit code ${code}`}`));
        return;
      }
      resolve(Number(out.trim()) || 0);
    });
  });
}

async function httpRequest(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers: headers || undefined,
    body: body != null ? body : undefined,
  });
  const respHeaders = {};
  for (const [k, v] of res.headers.entries()) {
    respHeaders[k] = v;
  }
  const text = await res.text();
  return { status: res.status, headers: respHeaders, body: text };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

const JSON_COMMANDS = {
  app_paths: async () => APP_PATHS,
  fs_exists: async (a) => fsExists(a.path),
  fs_stat: async (a) => fsStat(a.path),
  fs_mkdir: async (a) => fsMkdir(a.path),
  fs_list: async (a) => fsList(a.path),
  fs_read_text: async (a) => fsReadText(a.path),
  fs_write_text: async (a) => fsWriteText(a.path, a.contents),
  fs_remove: async (a) => fsRemove(a.path),
  fs_rename: async (a) => fsRename(a.from, a.to),
  fs_copy: async (a) => fsCopy(a.from, a.to),
  proc_spawn: async (a) => procSpawn(a),
  proc_close_stdin: async (a) => procCloseStdin(a.jobId),
  proc_kill: async (a) => procKill(a.jobId),
  download: async (a) => download(a.jobId, a.url, a.dest),
  download_cancel: async (a) => downloadCancel(a.jobId),
  unzip: async (a) => unzip(a.zipPath, a.destDir),
  http_request: async (a) => httpRequest(a.method, a.url, a.headers, a.body),
  reveal_path: async (a) => {
    console.log('[reveal_path]', a.path);
    return null;
  },
  open_path: async (a) => {
    console.log('[open_path]', a.path);
    return null;
  },
};

// fs_read_bytes is JSON-in but raw-out; handled specially below.
// fs_write_bytes / proc_write are raw-in; handled specially below.
const RAW_BODY_COMMANDS = new Set(['fs_write_bytes', 'proc_write']);
const RAW_RESPONSE_COMMANDS = new Set(['fs_read_bytes']);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
}

async function handleInvoke(command, req, res) {
  try {
    let result;

    if (RAW_BODY_COMMANDS.has(command)) {
      const bytes = await readRawBody(req);
      if (command === 'fs_write_bytes') {
        const p = decodeURIComponent(req.headers['x-path'] || '');
        const offset = Number(req.headers['x-offset']);
        const truncate = req.headers['x-truncate'] === '1';
        result = await fsWriteBytes(p, offset, truncate, bytes);
      } else if (command === 'proc_write') {
        const jobId = decodeURIComponent(req.headers['x-job'] || '');
        result = procWrite(jobId, bytes);
      }
    } else if (command === 'fs_read_bytes') {
      const args = await readJsonBody(req);
      const bytes = await fsReadBytes(args.path, args.offset, args.length);
      setCors(res);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(bytes);
      return;
    } else {
      const handler = JSON_COMMANDS[command];
      if (!handler) {
        throw new Error(`unknown command '${command}'`);
      }
      const args = await readJsonBody(req);
      result = await handler(args);
    }

    setCors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
  } catch (e) {
    setCors(res);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
}

function parseRange(rangeHeader, fileSize) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || '');
  if (!m) return null;
  const start = Number(m[1]);
  if (start >= fileSize) return { unsatisfiable: true };
  let end;
  if (m[2] === '') {
    end = Math.min(start + OPEN_RANGE_CAP - 1, fileSize - 1);
  } else {
    end = Math.min(Number(m[2]), fileSize - 1);
  }
  if (end < start) return { unsatisfiable: true };
  return { start, end };
}

function handleFileRange(req, res, parsedUrl) {
  const p = parsedUrl.searchParams.get('path');
  if (!p) {
    setCors(res);
    res.writeHead(400);
    res.end('missing path');
    return;
  }

  fs.stat(p, (err, stat) => {
    if (err || !stat.isFile()) {
      setCors(res);
      res.writeHead(404);
      res.end();
      return;
    }

    const contentType = contentTypeFor(p);
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      const range = parseRange(rangeHeader, stat.size);
      if (!range) {
        setCors(res);
        res.writeHead(400);
        res.end();
        return;
      }
      if (range.unsatisfiable) {
        setCors(res);
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      const { start, end } = range;
      const length = end - start + 1;
      setCors(res);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': length,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
      });
      const stream = fs.createReadStream(p, { start, end });
      stream.pipe(res);
      return;
    }

    setCors(res);
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
    });
    fs.createReadStream(p).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/events') {
    setCors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/file') {
    handleFileRange(req, res, parsedUrl);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname.startsWith('/api/invoke/')) {
    const command = parsedUrl.pathname.slice('/api/invoke/'.length);
    handleInvoke(command, req, res);
    return;
  }

  setCors(res);
  res.writeHead(404);
  res.end('not found');
});

ensureTestRoot().then(() => {
  server.listen(PORT, () => {
    console.log(`dev-server listening on http://localhost:${PORT} (test root: ${TEST_ROOT})`);
  });
});

// Allow the smoke test (or any other caller) to import without starting the
// server automatically when this file is required rather than executed
// directly — kept simple since Node ESM always executes top-level code, but
// exporting the server is convenient for programmatic shutdown.
export { server };
