// Asks Claude through the Anthropic API with the user's own key. Used for
// picking shorts out of a lecture, translating captions and writing YouTube
// chapters. Each request is billed to that key.

import { store } from '../core/store.js';
import { invoke } from '../backend/index.js';
import { paidOn, PAID_OFF_MESSAGE } from '../core/settings.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

export function hasClaude() {
  return paidOn() && (!!store.settings.claudeKey || !!globalThis.__claudeMock);
}

/** Sends one prompt and returns the text answer. */
export async function askClaude(prompt, { system = '', maxTokens = 4000, signal } = {}) {
  if (globalThis.__claudeMock) return globalThis.__claudeMock(prompt, { system });
  if (!paidOn()) throw new Error(PAID_OFF_MESSAGE);
  const key = store.settings.claudeKey;
  if (!key) throw new Error('Add your Claude API key in Settings first.');
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const res = await invoke('http_request', {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: store.settings.claudeModel || DEFAULT_CLAUDE_MODEL, max_tokens: maxTokens, system: system || undefined, messages: [{ role: 'user', content: prompt }] }),
  });
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {}
  if (res.status >= 400) throw new Error(`Claude answered ${res.status}: ${json?.error?.message || res.body.slice(0, 200)}`);
  return (json?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

/** Like askClaude, but reads the first JSON value out of the answer. */
export async function askClaudeJson(prompt, opts = {}) {
  const text = await askClaude(prompt, opts);
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('Claude did not answer with a list.');
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  const end = text.lastIndexOf(close);
  return JSON.parse(text.slice(start, end + 1));
}

/** Transcript words grouped into sentences with their times, for prompts. */
export function sentences(words, { maxGap = 0.9, maxLen = 30 } = {}) {
  const out = [];
  let cur = null;
  for (const w of words) {
    const text = w.t ?? w.text;
    const s = w.s ?? w.start;
    const e = w.e ?? w.end;
    if (!cur || s - cur.e > maxGap || cur.n >= maxLen || /[.!?]$/.test(cur.text)) {
      cur = { s, e, text: text.trim(), n: 1 };
      out.push(cur);
    } else {
      cur.text += ' ' + text.trim();
      cur.e = e;
      cur.n++;
    }
  }
  return out;
}
