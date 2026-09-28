import { invoke, on } from './index.js';

const handlers = new Map();
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  on('proc-output', (p) => handlers.get(p.jobId)?.line(p.line, p.stream));
  on('proc-exit', (p) => handlers.get(p.jobId)?.exit(p.code));
}

let counter = 0;
export function newJobId(prefix = 'job') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export class ProcessError extends Error {
  constructor(message, { code, tail } = {}) {
    super(message);
    this.code = code;
    this.tail = tail || [];
  }
}

/**
 * Runs a program and resolves with { code, lines } when it exits with code 0.
 * onLine(line, stream) gets every output line. signal (AbortSignal) kills it.
 * Rejects with ProcessError on a non-zero exit, carrying the last output lines.
 */
export function runProcess(program, args, { onLine, cwd = null, signal, keep = 400, jobId, onStart } = {}) {
  wire();
  const id = jobId || newJobId();
  const lines = [];
  const errLines = [];
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      handlers.delete(id);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      invoke('proc_kill', { jobId: id }).catch(() => {});
      finish(() => reject(new DOMException('Cancelled', 'AbortError')));
    };
    handlers.set(id, {
      line(line, stream) {
        lines.push(line);
        if (lines.length > keep) lines.shift();
        if (stream === 'stderr') {
          errLines.push(line);
          if (errLines.length > 60) errLines.shift();
        }
        onLine?.(line, stream);
      },
      exit(code) {
        finish(() => {
          if (code === 0) resolve({ code, lines });
          else {
            // stderr carries the real messages; stdout is mostly progress lines
            const useful = (errLines.length ? errLines : lines).filter((l) => !/^\w+=/.test(l) && !/^\s*(frame|size)=/.test(l));
            const tail = useful.slice(-12);
            reject(new ProcessError(`${baseName(program)} stopped with code ${code}: ${tail.slice(-3).join(' | ')}`, { code, tail }));
          }
        });
      },
    });
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
    invoke('proc_spawn', { jobId: id, program, args, cwd })
      .then(() => onStart?.(id))
      .catch((e) => finish(() => reject(new ProcessError(`${baseName(program)} could not start: ${e?.message || e}`))));
  });
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}
