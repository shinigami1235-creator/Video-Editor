// Turns each page of a PDF (lecture slides) into an image in the library.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readBytes, writeBytes, join, mkdir, basename, stat, stripExt } from '../backend/index.js';
import { store } from '../core/store.js';
import { uid, hashString } from '../core/util.js';
import { cacheRoot } from './library.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function importPdf(path, { targetHeight = 1440 } = {}) {
  const st = await stat(path);
  const key = hashString(path + '|' + st.size + '|' + Math.round(st.mtimeMs));
  const dir = join(cacheRoot(), 'pdf-' + key);
  await mkdir(dir);
  const data = await readBytes(path);
  const doc = await pdfjs.getDocument({ data }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = targetHeight / vp1.height;
    const vp = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const file = join(dir, `page-${String(i).padStart(3, '0')}.png`);
    await writeBytes(file, new Uint8Array(await blob.arrayBuffer()), { offset: 0, truncate: true });
    const m = {
      id: uid('m'),
      path: file,
      display: file,
      name: `${stripExt(basename(path))} p${i}`,
      kind: 'image',
      duration: 0,
      width: canvas.width,
      height: canvas.height,
      fps: 0,
      hasAudio: false,
      cacheKey: 'pdf-' + key + '-' + i,
      status: 'ready',
      progress: 1,
      pdfSource: path,
      imported: Date.now(),
    };
    store.project.media[m.id] = m;
    store.emit('media', m);
    out.push(m);
  }
  store.touch();
  return out;
}
