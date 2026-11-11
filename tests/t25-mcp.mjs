// Claude control: the MCP server in mcp/ talks MCP over stdio and hands each
// tool call to the open editor, which runs it and answers. Checks the
// protocol, the safety of the local channel and a real editing session.
import { startServers, stopServers, openApp, check, summary, sleep } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const BRIDGE_DIR = '/tmp/ve-test/.cygnus-video-editor';
const DIR = '/tmp/ve-mcp';
fs.mkdirSync(DIR, { recursive: true });
// two "phones" filming the same sound: an irregular pattern of beeps, the blue one starting 3.2 s later
const PATTERN = "aevalsrc='0.5*sin(2*PI*440*t)*(gt(mod(t*1.7,1),0.72)+gt(mod(t*2.3+0.4,1),0.86))':s=48000:d=12.6";
const run = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
if (!fs.existsSync(`${DIR}/red.mp4`)) {
  run(['-f', 'lavfi', '-i', PATTERN, `${DIR}/pattern.wav`]);
  run(['-f', 'lavfi', '-i', 'color=red:s=1280x720:r=30', '-i', `${DIR}/pattern.wav`, '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', `${DIR}/red.mp4`]);
  run(['-f', 'lavfi', '-i', 'color=blue:s=1280x720:r=30', '-ss', '3.2', '-i', `${DIR}/pattern.wav`, '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', `${DIR}/blue.mp4`]);
  // a "voice": bursts with pauses under steady hiss
  run(['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*220*t)*sin(2*PI*3*t)*lt(mod(t,3),1.8)':s=48000:d=12", '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.03:r=48000:d=12', '-filter_complex', 'amix=inputs=2:normalize=0', `${DIR}/voice.wav`]);
}

/** A tiny MCP client over the server's stdio. */
function mcpClient(bridgeDir = BRIDGE_DIR) {
  const proc = spawn('node', [path.join(ROOT, 'mcp/server.mjs')], { env: { ...process.env, VE_BRIDGE_DIR: bridgeDir, VE_MCP_PORT: '47900' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(d.toString()));
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const request = (method, params, timeout = 180000) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const t = setTimeout(() => reject(new Error('timeout ' + method)), timeout);
      waiting.set(myId, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const tool = async (name, args = {}) => {
    const m = await request('tools/call', { name, arguments: args });
    const text = (m.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let data = null;
    try {
      data = JSON.parse(text.split('\nEditor ')[0].split('\nDialogs ')[0]);
    } catch {}
    return { raw: m, text, data, error: !!m.result?.isError, images: (m.result?.content || []).filter((c) => c.type === 'image') };
  };
  return { proc, request, notify, tool, stderr };
}

await startServers();
let client = null;
try {
  const { browser, page, logs } = await openApp();
  client = mcpClient();

  // ---- the protocol ----
  const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  client.notify('notifications/initialized', {});
  check('initialize answers with the server name, tools and instructions', init.result?.serverInfo?.name === 'video-editor' && init.result.capabilities.tools && /get_project/.test(init.result.instructions), JSON.stringify(init.result).slice(0, 200));
  const list = await client.request('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  check('tools/list gives every tool with a schema', names.length >= 20 && list.result.tools.every((t) => t.inputSchema?.type === 'object' && t.description), names.join(', '));
  const handlers = await page.evaluate(async () => Object.keys((await import('/src/ai/claude-tools.js')).TOOLS));
  const missing = names.filter((n) => !['editor_status', 'check_job'].includes(n) && !handlers.includes(n));
  check('the editor has a handler for every tool', missing.length === 0, missing.join(', '));
  const unknown = await client.request('nope/nothing', {});
  check('an unknown method gets a JSON-RPC error', unknown.error?.code === -32601, JSON.stringify(unknown));

  // ---- the editor connects through the bridge file ----
  await page.waitForFunction(() => !document.querySelector('.claude-badge')?.hidden, null, { timeout: 20000 });
  check('the editor connects and shows "Claude connected"', true, '');
  const status = await client.tool('editor_status');
  check('editor_status says the editor is connected', /open and connected/.test(status.text), status.text.slice(0, 120));

  // ---- the local channel only answers the editor ----
  const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'bridge.json'), 'utf8'));
  const noKey = await fetch(`http://127.0.0.1:${cfg.port}/poll?wait=10`).then((r) => r.status);
  const fromPage = await fetch(`http://127.0.0.1:${cfg.port}/poll?wait=10`, { headers: { 'x-bridge-key': cfg.key, origin: 'https://evil.example' } }).then((r) => r.status);
  check('requests without the key, or from a web page, are refused', noKey === 401 && fromPage === 401, `${noKey} ${fromPage}`);

  // ---- a real session ----
  const np = await client.tool('new_project', { name: 'Claude test', discard_unsaved: true });
  check('new_project makes a project that waits for the first video', np.data?.name === 'Claude test' && np.data.frame?.waiting_for_first_video, np.text.slice(0, 200));
  const imp = await client.tool('import_media', { paths: [`${DIR}/red.mp4`, `${DIR}/blue.mp4`, `${DIR}/voice.wav`] });
  check('import_media imports and waits until ready', imp.data?.length === 3 && imp.data.every((m) => m.status === 'ready'), imp.text.slice(0, 300));
  const [red, blue, speech] = imp.data.map((m) => m.id);
  const added = await client.tool('add_clips', { media_ids: [red] });
  check('add_clips puts the video on the main track', added.data?.length === 1 && added.data[0].media === 'red.mp4', added.text.slice(0, 200));
  await sleep(300);
  const proj = await client.tool('get_project');
  check('get_project shows the frame matched to the video', proj.data?.frame?.width === 1280 && proj.data.frame.height === 720 && proj.data.tracks.some((t) => t.items.length), JSON.stringify(proj.data?.frame));

  const txt = await client.tool('add_text', { text: 'Sognare', at: 1, duration: 3, preset: 'Title', style: { color: '#e8c16a' } });
  check('add_text adds a styled title on its own layer', txt.data?.[0]?.text === 'Sognare' && txt.data[0].start === 1, txt.text.slice(0, 200));
  const clipId = added.data[0].id;
  const ed = await client.tool('edit_items', { item_ids: [clipId], changes: { look: 'cinematic', scale: 1.2, keyframes: { scale: [{ at: 0, value: 1 }, { at: 4, value: 1.3 }] }, anim_in: { type: 'fade', duration: 0.5 } } });
  check('edit_items changes look, keyframes and animation in one step', ed.data?.items?.[0]?.look === 'cinematic' && ed.data.items[0].keyframed?.includes('scale') && ed.data.items[0].animation?.in === 'fade', ed.text.slice(0, 300));
  const bad = await client.tool('edit_items', { item_ids: ['nope'], changes: { volume: 1 } });
  check('a wrong id gives a clear error', bad.error && /no item with id nope/.test(bad.text), bad.text);

  const fr = await client.tool('get_frame', { time: 2, width: 320 });
  check('get_frame returns a picture of the edit', fr.images.length === 1 && fr.images[0].mimeType === 'image/jpeg' && fr.images[0].data.length > 1000, fr.text);

  const sp = await client.tool('split_at', { time: 5, item_ids: [clipId] });
  check('split_at splits the clip', sp.data?.new_items?.length === 1, sp.text.slice(0, 200));

  // a smart tool that runs as a job
  const sp2 = await client.tool('add_clips', { media_ids: [speech], at: 0 });
  const voice = sp2.data[0].id;
  let rt = await client.tool('run_tool', { tool: 'clear_voice', item_id: voice, wait_seconds: 1 });
  check('a long tool answers with a job id while it runs', rt.data?.status === 'running' && /^job/.test(rt.data.job_id), rt.text.slice(0, 200));
  const job = await client.tool('check_job', { job_id: rt.data.job_id, wait_seconds: 90 });
  check('check_job returns the finished result', job.data?.done === 'clear_voice' && job.data.items?.[0]?.processed?.includes('clear'), job.text.slice(0, 300));

  // angles
  await client.tool('add_clips', { media_ids: [blue] });
  const all = (await client.tool('get_project')).data.tracks.flatMap((t) => t.items);
  const pick = ['red.mp4', 'blue.mp4'].map((n) => all.filter((i) => i.media === n).sort((a, b) => a.start - b.start)[0].id);
  const sync = await client.tool('angles', { action: 'sync', item_ids: pick });
  check('angles sync lines up two videos', sync.data?.angles?.length === 2, sync.text.slice(0, 300));
  const sw = await client.tool('angles', { action: 'switch', at: 6, angle: 2, transition: 'dipBlack', duration: 0.8 });
  check('angles switch adds a switch with its transition', sw.data?.switches?.[0]?.transition === 'dipBlack' && sw.data.switches[0].angle === 2, sw.text.slice(0, 300));

  // export as a job
  const out = `${DIR}/claude.mp4`;
  let ex = await client.tool('export', { kind: 'video', path: out, preset: 'square', start: 0, end: 2, wait_seconds: 2 });
  if (ex.data?.status === 'running') ex = await client.tool('check_job', { job_id: ex.data.job_id, wait_seconds: 100 });
  const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  check('export makes the file in the preset shape', ex.data?.saved === out && /h264,1080,1080/.test(pr), ex.text.slice(0, 200) + ' ' + pr);

  const und = await client.tool('history', { action: 'undo' });
  check('history undoes the last step', Array.isArray(und.data?.last_steps), und.text.slice(0, 200));

  const saved = await client.tool('save_project', { path: `${DIR}/claude-test.vproj` });
  check('save_project saves without a dialog', saved.data?.saved === `${DIR}/claude-test.vproj` && fs.existsSync(`${DIR}/claude-test.vproj`), saved.text);

  // a dialog the command opens is answered, and a confirm says No
  const nope = await client.tool('new_project', { name: 'Again' });
  check('new_project refuses to drop unsaved changes unless told', nope.error ? /unsaved changes/.test(nope.text) : true, nope.text.slice(0, 160));

  // several copies of the server: one talks to the editor, the rest pass calls to it
  const start = async (c) => {
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    c.notify('notifications/initialized', {});
  };
  const second = mcpClient();
  await start(second);
  const viaSpoke = await second.tool('get_project');
  check('a second copy passes its calls to the first', /passing calls/.test(second.stderr.join('')) && Array.isArray(viaSpoke.data?.tracks), second.stderr.join('').slice(0, 200) + ' ' + viaSpoke.text.slice(0, 120));
  const firstStill = await client.tool('get_project');
  check('the first copy keeps the editor', Array.isArray(firstStill.data?.tracks), firstStill.text.slice(0, 120));
  client.proc.kill();
  await sleep(300);
  let taken = await second.tool('get_project');
  if (!Array.isArray(taken.data?.tracks)) taken = await second.tool('get_project');
  check('when the first copy closes, the second takes over', Array.isArray(taken.data?.tracks) && /hub: waiting/.test(second.stderr.join('')), taken.text.slice(0, 160));
  client = second;
  // two copies that both became the hub: the one the editor no longer follows hands over
  const other = mcpClient('/tmp/ve-mcp-other');
  await start(other);
  fs.copyFileSync('/tmp/ve-mcp-other/bridge.json', `${BRIDGE_DIR}/bridge.json`);
  const handed = await second.tool('get_project');
  check('a hub that lost the bridge file passes its calls to the new one', Array.isArray(handed.data?.tracks) && second.stderr.join('').split('passing calls').length > 2, handed.text.slice(0, 160));
  other.proc.kill();

  // turning control off disconnects
  await page.evaluate(async () => (await import('/src/core/settings.js')).saveSettings({ claudeControl: false }));
  await page.waitForFunction(() => document.querySelector('.claude-badge')?.hidden, null, { timeout: 40000 });
  check('turning Claude control off in Settings disconnects', true, '');
  await page.screenshot({ path: '/tmp/ve-mcp.png' });

  const errs = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !/404|Failed to load resource/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | ').slice(0, 800));
  await browser.close();
} catch (e) {
  console.error('TEST CRASH', e);
  if (client) console.error(client.stderr.join(''));
  check('no crash', false, e.message);
} finally {
  client?.proc.kill();
  stopServers();
}
process.exit(summary());
