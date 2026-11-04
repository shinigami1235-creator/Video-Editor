// Adds the Video Editor to the Claude desktop app's settings file, for when
// the Claude app has no "Install Extension" button. It backs the file up
// first, keeps every other tool already there, and only adds or updates the
// "video-editor" entry. Run by "Connect Video Editor to Claude.bat".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, 'server.mjs');
const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

// the normal Claude app, and the Microsoft Store one, which keeps its files elsewhere
const folders = [];
if (process.platform === 'darwin') folders.push(path.join(home, 'Library', 'Application Support', 'Claude'));
else {
  folders.push(path.join(appData, 'Claude'));
  try {
    for (const d of fs.readdirSync(path.join(localAppData, 'Packages'))) {
      if (/^(AnthropicPBC\.)?Claude/i.test(d) || /^Claude_/i.test(d)) folders.push(path.join(localAppData, 'Packages', d, 'LocalCache', 'Roaming', 'Claude'));
    }
  } catch {}
}
const found = folders.filter((f) => fs.existsSync(f));
const targets = found.length ? found : [folders[0]];

const entry = { command: process.execPath, args: [server] };
let done = 0;
for (const dir of targets) {
  const file = path.join(dir, 'claude_desktop_config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      cfg = text.trim() ? JSON.parse(text) : {};
    } catch {
      console.log(`\nCould not read ${file}, so it was left alone.\nIt has a typing mistake in it. Send Claude a screenshot of it.`);
      continue;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const backup = path.join(dir, `claude_desktop_config.backup-${stamp}.json`);
    fs.copyFileSync(file, backup);
    console.log(`Backup: ${backup}`);
  } else fs.mkdirSync(dir, { recursive: true });
  cfg.mcpServers ||= {};
  const had = !!cfg.mcpServers['video-editor'];
  cfg.mcpServers['video-editor'] = entry;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const others = Object.keys(cfg.mcpServers).filter((k) => k !== 'video-editor');
  console.log(`${had ? 'Updated' : 'Added'} the Video Editor in ${file}`);
  if (others.length) console.log(`Kept: ${others.join(', ')}`);
  done++;
}
if (done) console.log('\nNow quit Claude completely (right-click its icon by the clock, then Quit) and open it again.');
