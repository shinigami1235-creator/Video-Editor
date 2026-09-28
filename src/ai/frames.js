// Reads frames of a media file for analysis (faces, tracking, segmentation).

import { Input, UrlSource, ALL_FORMATS, CanvasSink, VideoSampleSink } from 'mediabunny';
import { fileUrl } from '../backend/index.js';

export async function openVideo(media) {
  const input = new Input({ source: new UrlSource(fileUrl(media.edit)), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`${media.name} has no video.`);
  return { input, track };
}

/**
 * Yields { time, canvas } for each requested source time, scaled to `width`
 * pixels wide (height follows the aspect ratio).
 */
export async function* framesAt(media, times, { width = 640, alpha = false } = {}) {
  const { input, track } = await openVideo(media);
  try {
    const sink = new CanvasSink(track, { width: Math.round(width / 2) * 2, poolSize: 3, alpha });
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      yield { time: times[i], canvas: wc?.canvas || null, frameTime: wc?.timestamp ?? times[i] };
      i++;
    }
  } finally {
    input.dispose?.();
  }
}

/** Yields every frame from start to end as { time, sample } (VideoSample; caller must not keep it). */
export async function* samplesBetween(media, start, end) {
  const { input, track } = await openVideo(media);
  try {
    const sink = new VideoSampleSink(track);
    for await (const s of sink.samples(start, end)) {
      yield s;
      s.close();
    }
  } finally {
    input.dispose?.();
  }
}

export function frameTimes(start, end, fps) {
  const out = [];
  const step = 1 / fps;
  for (let t = start; t < end - 1e-6; t += step) out.push(t);
  return out;
}

export function grayscale(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) g[j] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  return { g, width, height };
}
