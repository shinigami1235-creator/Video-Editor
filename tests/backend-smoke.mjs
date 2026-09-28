#!/usr/bin/env node
// Exercises every command in docs/backend-api.md against tests/dev-server.mjs
// over plain HTTP, the same way a browser-based frontend would. Prints
// PASS/FAIL per check and exits non-zero if anything failed.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.VE_SMOKE_ROOT || '/tmp/claude-0/-home-claude/adc55fe3-7d01-51b6-94d7-21c79f219ce4/scratchpad/ve-smoke';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passCount++;
  } catch (e) {
    console.log(`FAIL: ${name}: ${(e && e.stack) || e}`);
    failCount++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Find a free TCP port
// ---------------------------------------------------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// SSE client
// ---------------------------------------------------------------------------

class SSEClient {
  constructor(url) {
    this.events = [];
    this._closed = false;
    this.ready = this._connect(url);
  }

  async _connect(url) {
    const res = await fetch(url);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        while (!this._closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this._parseEvent(raw);
          }
        }
      } catch {
        // stream closed
      }
    })();
  }

  _parseEvent(raw) {
    const lines = raw.split('\n');
    let name = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      data = dataLines.join('\n');
    }
    this.events.push({ name, data, t: Date.now() });
  }

  async waitFor(pred, timeoutMs = 10000, pollMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.events.find(pred);
      if (found) return found;
      await delay(pollMs);
    }
    return null;
  }

  close() {
    this._closed = true;
  }
}

// ---------------------------------------------------------------------------
// Invoke helpers
// ---------------------------------------------------------------------------

let BASE = '';

async function invoke(command, args = {}) {
  const res = await fetch(`${BASE}/api/invoke/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`invoke ${command} failed: ${json.error}`);
  return json.result;
}

async function invokeExpectError(command, args = {}) {
  const res = await fetch(`${BASE}/api/invoke/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  return json;
}

async function invokeRawBody(command, headers, bodyBuffer) {
  const res = await fetch(`${BASE}/api/invoke/${command}`, {
    method: 'POST',
    headers,
    body: bodyBuffer,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`invoke ${command} failed: ${json.error}`);
  return json.result;
}

async function fsReadBytesRaw(argsObj) {
  const res = await fetch(`${BASE}/api/invoke/fs_read_bytes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(argsObj),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    throw new Error(`fs_read_bytes failed: ${json.error}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await fsp.rm(SCRATCH, { recursive: true, force: true });
  await fsp.mkdir(SCRATCH, { recursive: true });

  const port = await getFreePort();
  BASE = `http://127.0.0.1:${port}`;
  const testRoot = path.join(SCRATCH, 've-test-root');

  const serverPath = path.join(__dirname, 'dev-server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), VE_TEST_ROOT: testRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d.toString('utf8')));
  child.stderr.on('data', (d) => (serverLog += d.toString('utf8')));

  // Wait for the server to come up.
  {
    const start = Date.now();
    let up = false;
    while (Date.now() - start < 10000) {
      try {
        const res = await fetch(`${BASE}/api/invoke/app_paths`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
      await delay(100);
    }
    if (!up) {
      console.error('dev-server did not start in time. Log:\n' + serverLog);
      process.exit(1);
    }
  }

  const sse = new SSEClient(`${BASE}/api/events`);
  // Give the SSE connection a moment to establish before relying on it.
  await delay(200);

  try {
    // -------------------------------------------------------------------
    // app_paths
    // -------------------------------------------------------------------
    await test('app_paths returns expected shape', async () => {
      const paths = await invoke('app_paths');
      for (const key of ['appData', 'cache', 'documents', 'videos', 'music', 'pictures', 'temp', 'home', 'resource', 'platform', 'sep']) {
        assert(key in paths, `app_paths missing key '${key}'`);
      }
      assertEqual(paths.platform, 'linux', 'platform');
      assertEqual(paths.sep, '/', 'sep');
      assert(paths.home === testRoot, 'home should be the test root');
    });

    // -------------------------------------------------------------------
    // fs_mkdir / fs_exists
    // -------------------------------------------------------------------
    const workDir = path.join(testRoot, 'work');
    await test('fs_mkdir creates a directory, fs_exists confirms it', async () => {
      await invoke('fs_mkdir', { path: workDir });
      const exists = await invoke('fs_exists', { path: workDir });
      assertEqual(exists, true, 'workDir should exist after fs_mkdir');
      const missing = await invoke('fs_exists', { path: path.join(workDir, 'nope') });
      assertEqual(missing, false, 'nonexistent path should not exist');
    });

    // -------------------------------------------------------------------
    // fs_write_text / fs_read_text round trip
    // -------------------------------------------------------------------
    const textPath = path.join(workDir, 'notes', 'hello.txt');
    await test('fs_write_text creates parent folders and round-trips through fs_read_text', async () => {
      await invoke('fs_write_text', { path: textPath, contents: 'hello, video editor' });
      const contents = await invoke('fs_read_text', { path: textPath });
      assertEqual(contents, 'hello, video editor', 'text round trip');
    });

    // -------------------------------------------------------------------
    // fs_stat / fs_list
    // -------------------------------------------------------------------
    await test('fs_stat reports size/isFile and null for missing paths', async () => {
      const stat = await invoke('fs_stat', { path: textPath });
      assert(stat !== null, 'stat should not be null');
      assertEqual(stat.isFile, true, 'isFile');
      assertEqual(stat.isDir, false, 'isDir');
      assertEqual(stat.size, Buffer.byteLength('hello, video editor'), 'size');
      assert(typeof stat.mtimeMs === 'number' && stat.mtimeMs > 0, 'mtimeMs should be a positive number');

      const missingStat = await invoke('fs_stat', { path: path.join(workDir, 'does-not-exist') });
      assertEqual(missingStat, null, 'missing file stat should be null');
    });

    await test('fs_list lists directory entries', async () => {
      const entries = await invoke('fs_list', { path: path.join(workDir, 'notes') });
      assert(Array.isArray(entries), 'entries should be an array');
      const entry = entries.find((e) => e.name === 'hello.txt');
      assert(entry, 'hello.txt should be listed');
      assertEqual(entry.isDir, false, 'hello.txt is not a dir');
    });

    // -------------------------------------------------------------------
    // fs_write_bytes: offset write, append, truncate + fs_read_bytes ranges
    // -------------------------------------------------------------------
    const binPath = path.join(workDir, 'data.bin');
    await test('fs_write_bytes (truncate) creates a fresh file', async () => {
      const buf = Buffer.from('AAAABBBBCCCC', 'utf8');
      const written = await invokeRawBody(
        'fs_write_bytes',
        { 'x-path': encodeURIComponent(binPath), 'x-offset': '0', 'x-truncate': '1' },
        buf,
      );
      assertEqual(written, buf.length, 'bytes written should match buffer length');
      const readBack = await fsReadBytesRaw({ path: binPath, offset: 0, length: -1 });
      assertEqual(readBack.toString('utf8'), 'AAAABBBBCCCC', 'content after truncating write');
    });

    await test('fs_write_bytes at an offset overwrites in place', async () => {
      const buf = Buffer.from('XXXX', 'utf8');
      await invokeRawBody(
        'fs_write_bytes',
        { 'x-path': encodeURIComponent(binPath), 'x-offset': '4', 'x-truncate': '0' },
        buf,
      );
      const readBack = await fsReadBytesRaw({ path: binPath, offset: 0, length: -1 });
      assertEqual(readBack.toString('utf8'), 'AAAAXXXXCCCC', 'content after offset write');
    });

    await test('fs_write_bytes with offset -1 appends', async () => {
      const buf = Buffer.from('DDDD', 'utf8');
      await invokeRawBody(
        'fs_write_bytes',
        { 'x-path': encodeURIComponent(binPath), 'x-offset': '-1', 'x-truncate': '0' },
        buf,
      );
      const readBack = await fsReadBytesRaw({ path: binPath, offset: 0, length: -1 });
      assertEqual(readBack.toString('utf8'), 'AAAAXXXXCCCCDDDD', 'content after append');
    });

    await test('fs_read_bytes supports a bounded range read', async () => {
      const readBack = await fsReadBytesRaw({ path: binPath, offset: 4, length: 4 });
      assertEqual(readBack.toString('utf8'), 'XXXX', 'ranged read');
    });

    // -------------------------------------------------------------------
    // fs_copy / fs_rename / fs_remove
    // -------------------------------------------------------------------
    const copyPath = path.join(workDir, 'data-copy.bin');
    const renamedPath = path.join(workDir, 'data-renamed.bin');
    await test('fs_copy, fs_rename and fs_remove behave as documented', async () => {
      await invoke('fs_copy', { from: binPath, to: copyPath });
      const copyExists = await invoke('fs_exists', { path: copyPath });
      assertEqual(copyExists, true, 'copy should exist');

      await invoke('fs_rename', { from: copyPath, to: renamedPath });
      const oldExists = await invoke('fs_exists', { path: copyPath });
      const newExists = await invoke('fs_exists', { path: renamedPath });
      assertEqual(oldExists, false, 'old path should be gone after rename');
      assertEqual(newExists, true, 'new path should exist after rename');

      await invoke('fs_remove', { path: renamedPath });
      const removedExists = await invoke('fs_exists', { path: renamedPath });
      assertEqual(removedExists, false, 'removed path should no longer exist');

      // no error removing something that doesn't exist
      await invoke('fs_remove', { path: renamedPath });
    });

    // -------------------------------------------------------------------
    // proc_spawn + proc-output/proc-exit events: ffmpeg
    // -------------------------------------------------------------------
    await test('proc_spawn runs ffmpeg and streams proc-output/proc-exit over SSE', async () => {
      const jobId = `ffmpeg-${crypto.randomUUID()}`;
      const pid = await invoke('proc_spawn', {
        jobId,
        program: 'ffmpeg',
        args: ['-hide_banner', '-f', 'lavfi', '-i', 'testsrc=d=1', '-f', 'null', '-'],
        cwd: null,
      });
      assert(typeof pid === 'number' && pid > 0, 'pid should be a positive number');

      const output = await sse.waitFor((e) => e.name === 'proc-output' && e.data.jobId === jobId, 15000);
      assert(output, 'expected at least one proc-output event from ffmpeg');

      const exit = await sse.waitFor((e) => e.name === 'proc-exit' && e.data.jobId === jobId, 15000);
      assert(exit, 'expected a proc-exit event from ffmpeg');
      assertEqual(exit.data.code, 0, 'ffmpeg should exit cleanly');
    });

    // -------------------------------------------------------------------
    // proc_write + proc_close_stdin: cat
    // -------------------------------------------------------------------
    await test('proc_write and proc_close_stdin round-trip through cat', async () => {
      const jobId = `cat-${crypto.randomUUID()}`;
      await invoke('proc_spawn', { jobId, program: 'cat', args: [], cwd: null });

      const message = 'echo-me-please';
      await invokeRawBody('proc_write', { 'x-job': encodeURIComponent(jobId) }, Buffer.from(message, 'utf8'));
      await invoke('proc_close_stdin', { jobId });

      const output = await sse.waitFor(
        (e) => e.name === 'proc-output' && e.data.jobId === jobId && e.data.line.includes('echo-me-please'),
        8000,
      );
      assert(output, 'expected cat to echo the written bytes back over stdout');

      const exit = await sse.waitFor((e) => e.name === 'proc-exit' && e.data.jobId === jobId, 8000);
      assert(exit, 'expected proc-exit for cat');
      assertEqual(exit.data.code, 0, 'cat should exit cleanly once stdin closes');
    });

    // -------------------------------------------------------------------
    // proc_kill: sleep 30
    // -------------------------------------------------------------------
    await test('proc_kill terminates a long-running process', async () => {
      const jobId = `sleep-${crypto.randomUUID()}`;
      await invoke('proc_spawn', { jobId, program: 'sleep', args: ['30'], cwd: null });
      await delay(200);
      await invoke('proc_kill', { jobId });

      const exit = await sse.waitFor((e) => e.name === 'proc-exit' && e.data.jobId === jobId, 8000);
      assert(exit, 'expected proc-exit after proc_kill');
      assertEqual(exit.data.code, null, 'killed process should report a null exit code');

      // killing again (already finished) should not error
      await invoke('proc_kill', { jobId });
    });

    // -------------------------------------------------------------------
    // download: real file over HTTPS with progress events
    // -------------------------------------------------------------------
    await test('download streams a real file with progress events and renames it into place', async () => {
      const jobId = `dl-${crypto.randomUUID()}`;
      const dest = path.join(workDir, 'u2netp.onnx');
      const url = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx';

      const downloadPromise = invoke('download', { jobId, url, dest });
      const progress = await sse.waitFor((e) => e.name === 'download-progress' && e.data.jobId === jobId, 15000);
      assert(progress, 'expected at least one download-progress event');

      await downloadPromise;

      const partExists = await invoke('fs_exists', { path: `${dest}.part` });
      assertEqual(partExists, false, '.part file should be renamed away once done');

      const stat = await invoke('fs_stat', { path: dest });
      assert(stat !== null, 'downloaded file should exist');
      assert(stat.size > 4_000_000 && stat.size < 5_000_000, `unexpected downloaded size: ${stat.size}`);

      const finalProgress = [...sse.events].reverse().find((e) => e.name === 'download-progress' && e.data.jobId === jobId);
      assertEqual(finalProgress.data.received, stat.size, 'final progress event should report the full size received');
    });

    // -------------------------------------------------------------------
    // unzip
    // -------------------------------------------------------------------
    await test('unzip extracts a zip built with python, preserving folder structure', async () => {
      const zipPath = path.join(workDir, 'sample.zip');
      const extractDir = path.join(workDir, 'extracted');

      await new Promise((resolve, reject) => {
        const script = `
import zipfile, sys
zip_path = sys.argv[1]
with zipfile.ZipFile(zip_path, 'w') as zf:
    zf.writestr('top.txt', 'top level file')
    zf.writestr('nested/inner.txt', 'nested file contents')
    zf.writestr('nested/deep/deep.txt', 'deep file contents')
`;
        const p = spawn('python3', ['-c', script, zipPath]);
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString('utf8')));
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`python3 zip build failed: ${err}`))));
      });

      const count = await invoke('unzip', { zipPath, destDir: extractDir });
      assertEqual(count, 3, 'expected 3 extracted files');

      const top = await invoke('fs_read_text', { path: path.join(extractDir, 'top.txt') });
      assertEqual(top, 'top level file', 'top.txt contents');
      const nested = await invoke('fs_read_text', { path: path.join(extractDir, 'nested', 'inner.txt') });
      assertEqual(nested, 'nested file contents', 'nested/inner.txt contents');
      const deep = await invoke('fs_read_text', { path: path.join(extractDir, 'nested', 'deep', 'deep.txt') });
      assertEqual(deep, 'deep file contents', 'nested/deep/deep.txt contents');
    });

    // -------------------------------------------------------------------
    // http_request
    // -------------------------------------------------------------------
    await test('http_request performs an arbitrary HTTP call and returns status/headers/body', async () => {
      const result = await invoke('http_request', {
        method: 'GET',
        url: `${BASE}/file?path=${encodeURIComponent(textPath)}`,
        headers: { 'X-Test': '1' },
        body: null,
      });
      assertEqual(result.status, 200, 'status');
      assertEqual(result.body, 'hello, video editor', 'body');
      assert(result.headers['content-type'], 'should have a content-type header');
    });

    // -------------------------------------------------------------------
    // /file range requests
    // -------------------------------------------------------------------
    const rangeFile = path.join(workDir, 'range-source.bin');
    const rangeFileSize = 10 * 1024 * 1024; // 10 MiB, bigger than the 8 MiB open-ended cap
    let rangeFileBuffer;
    await test('prepare a large binary file for range tests', async () => {
      rangeFileBuffer = crypto.randomBytes(rangeFileSize);
      await fsp.writeFile(rangeFile, rangeFileBuffer);
      const exists = await invoke('fs_exists', { path: rangeFile });
      assertEqual(exists, true, 'range source file should exist');
    });

    await test('/file answers a bounded range request with 206 and exact bytes', async () => {
      const res = await fetch(`${BASE}/file?path=${encodeURIComponent(rangeFile)}`, {
        headers: { Range: 'bytes=10-19' },
      });
      assertEqual(res.status, 206, 'status should be 206 Partial Content');
      assertEqual(res.headers.get('content-range'), `bytes 10-19/${rangeFileSize}`, 'content-range header');
      assertEqual(res.headers.get('access-control-allow-origin'), '*', 'CORS header');
      const buf = Buffer.from(await res.arrayBuffer());
      assertEqual(buf.length, 10, 'body length should match the requested range');
      assert(buf.equals(rangeFileBuffer.subarray(10, 20)), 'bytes should match the source file exactly');
    });

    await test('/file caps an open-ended range at 8 MiB', async () => {
      const res = await fetch(`${BASE}/file?path=${encodeURIComponent(rangeFile)}`, {
        headers: { Range: 'bytes=0-' },
      });
      assertEqual(res.status, 206, 'status should be 206 Partial Content');
      const expectedCap = 8 * 1024 * 1024;
      assertEqual(res.headers.get('content-range'), `bytes 0-${expectedCap - 1}/${rangeFileSize}`, 'content-range header should reflect the 8 MiB cap');
      const buf = Buffer.from(await res.arrayBuffer());
      assertEqual(buf.length, expectedCap, 'body should be capped at 8 MiB');
      assert(buf.equals(rangeFileBuffer.subarray(0, expectedCap)), 'capped bytes should match the source file exactly');
    });

    await test('/file answers a request with no range with the whole file and 200', async () => {
      const smallFile = path.join(workDir, 'small.png');
      const smallBuf = Buffer.from('not really a png but fine for this test');
      await fsp.writeFile(smallFile, smallBuf);
      const res = await fetch(`${BASE}/file?path=${encodeURIComponent(smallFile)}`);
      assertEqual(res.status, 200, 'status should be 200');
      assertEqual(res.headers.get('content-type'), 'image/png', 'content-type inferred from extension');
      const buf = Buffer.from(await res.arrayBuffer());
      assert(buf.equals(smallBuf), 'full body should match the file exactly');
    });

    await test('/file answers a missing file with 404', async () => {
      const res = await fetch(`${BASE}/file?path=${encodeURIComponent(path.join(workDir, 'does-not-exist.mp4'))}`);
      assertEqual(res.status, 404, 'missing file should 404');
    });

    // -------------------------------------------------------------------
    // reveal_path / open_path (best-effort no-ops in the test server)
    // -------------------------------------------------------------------
    await test('reveal_path and open_path return null without erroring', async () => {
      const revealResult = await invoke('reveal_path', { path: textPath });
      assertEqual(revealResult, null, 'reveal_path result');
      const openResult = await invoke('open_path', { path: textPath });
      assertEqual(openResult, null, 'open_path result');
    });

    // -------------------------------------------------------------------
    // Error handling sanity check
    // -------------------------------------------------------------------
    await test('an unknown command returns ok:false with a 500-shaped error', async () => {
      const json = await invokeExpectError('not_a_real_command', {});
      assertEqual(json.ok, false, 'ok should be false');
      assert(typeof json.error === 'string' && json.error.length > 0, 'error should be a non-empty string');
    });
  } finally {
    sse.close();
    child.kill('SIGKILL');
    await delay(100);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
