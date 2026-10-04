import { convexHull, minEnclosingCircle, type Circle, type Vec } from './geometry';

/** Soft subject mask: one byte per pixel, 0 = background, 255 = subject. */
export interface Mask {
  w: number;
  h: number;
  data: Uint8Array;
}

export const THRESHOLD = 128;

export function isSubject(mask: Mask, x: number, y: number): boolean {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= mask.w || iy >= mask.h) return false;
  return mask.data[iy * mask.w + ix] >= THRESHOLD;
}

export function isEmpty(mask: Mask): boolean {
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] >= THRESHOLD) return false;
  return true;
}

/** Use the alpha channel when it carries information, otherwise luminance (white = subject). */
export function maskFromImageData(img: ImageData): Mask {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  let hasAlpha = false;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 250) {
      hasAlpha = true;
      break;
    }
  }
  for (let i = 0; i < w * h; i++) {
    out[i] = hasAlpha
      ? data[i * 4 + 3]
      : Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  }
  return { w, h, data: out };
}

export function hasTransparency(img: ImageData): boolean {
  const { data } = img;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  // A handful of transparent pixels is noise; a cut-out has a real background hole.
  return transparent > data.length / 4 / 100;
}

/** Corners of every subject pixel that touches the background — enough for an exact hull. */
export function boundaryCorners(mask: Mask): Vec[] {
  const { w, h } = mask;
  const pts: Vec[] = [];
  for (let y = 0; y < h; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (mask.data[y * w + x] >= THRESHOLD) {
        if (first < 0) first = x;
        last = x;
      }
    }
    // Only the extreme pixels of each row can lie on the convex hull.
    if (first >= 0) {
      pts.push({ x: first, y }, { x: first, y: y + 1 }, { x: last + 1, y }, { x: last + 1, y: y + 1 });
    }
  }
  return pts;
}

export function enclosingCircle(mask: Mask): Circle | null {
  const pts = boundaryCorners(mask);
  if (pts.length === 0) return null;
  return minEnclosingCircle(convexHull(pts));
}

/** Copy the mask into a larger canvas, offset by (pad, pad). */
export function padMask(mask: Mask, pad: number): Mask {
  if (pad === 0) return mask;
  const w = mask.w + pad * 2;
  const h = mask.h + pad * 2;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < mask.h; y++) {
    data.set(mask.data.subarray(y * mask.w, (y + 1) * mask.w), (y + pad) * w + pad);
  }
  return { w, h, data };
}
