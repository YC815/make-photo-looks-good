import type { InteractiveSegmenterLegacy } from '@mediapipe/tasks-vision';
import type { Mask } from './mask';

// Google's "magic touch" model: tap an object, get its mask — the closest open equivalent of
// long-pressing a subject in Apple Photos. Loaded lazily so the editor starts without it.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite';

/**
 * Confidence → mask. Raw confidences leave unsure areas half transparent (a ghostly vase after an
 * erase), so commit to a side around 0.5 and keep only a narrow soft band for the edge.
 */
function decide(v: number): number {
  const t = Math.max(0, Math.min(1, (v - 0.4) / 0.2));
  return t * t * (3 - 2 * t);
}

let segmenter: Promise<InteractiveSegmenterLegacy> | null = null;

async function load(): Promise<InteractiveSegmenterLegacy> {
  const { FilesetResolver, InteractiveSegmenterLegacy } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    return await InteractiveSegmenterLegacy.createFromOptions(fileset, options('GPU'));
  } catch {
    return await InteractiveSegmenterLegacy.createFromOptions(fileset, options('CPU'));
  }
}

/** Segment the object under a point. x/y are in image pixels. */
export async function segmentAt(image: HTMLCanvasElement, x: number, y: number): Promise<Mask> {
  segmenter ??= load().catch((err) => {
    segmenter = null;
    throw err;
  });
  const seg = await segmenter;
  const result = seg.segment(image, { keypoint: { x: x / image.width, y: y / image.height } });
  const conf = result.confidenceMasks?.[0];
  if (!conf) throw new Error('模型沒有回傳遮罩');
  const mw = conf.width;
  const mh = conf.height;
  const values = conf.getAsFloat32Array();

  const w = image.width;
  const h = image.height;
  const data = new Uint8Array(w * h);
  const at = (px: number, py: number) =>
    values[Math.min(mh - 1, Math.floor((py * mh) / h)) * mw + Math.min(mw - 1, Math.floor((px * mw) / w))];
  // The model's channel order is not documented; the tapped point must be "subject".
  const invert = at(x, y) < 0.5;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const v = at(px, py);
      data[py * w + px] = Math.round(decide(invert ? 1 - v : v) * 255);
    }
  }
  result.close();
  return { w, h, data };
}
