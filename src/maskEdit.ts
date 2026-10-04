import type { Vec } from './geometry';
import { THRESHOLD, type Mask } from './mask';

/** Erase removes from the subject, restore gives back to it. */
export type MaskOp = 'erase' | 'restore';

const inSubject = (mask: Mask, i: number) => mask.data[i] >= THRESHOLD;

/**
 * Magic wand: the contiguous region around `seed` whose colour is within `tolerance` (RGB
 * distance) of the seed colour. Erasing only spreads through the current subject and restoring
 * only through the current background, so the selection cannot leak across the cut-out edge.
 * Returns a 0/255 selection, or null when the seed is on the wrong side.
 */
export function magicWand(img: ImageData, mask: Mask, seed: Vec, tolerance: number, op: MaskOp): Uint8Array | null {
  const { width: w, height: h, data } = img;
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const allowed = (i: number) => (op === 'erase' ? inSubject(mask, i) : !inSubject(mask, i));
  const start = sy * w + sx;
  if (!allowed(start)) return null;

  const r0 = data[start * 4];
  const g0 = data[start * 4 + 1];
  const b0 = data[start * 4 + 2];
  const tol2 = tolerance * tolerance;
  const sel = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  stack[top++] = start;
  sel[start] = 255;
  while (top > 0) {
    const i = stack[--top];
    const x = i % w;
    const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    for (const j of neighbours) {
      if (j < 0 || j >= w * h || sel[j] || !allowed(j)) continue;
      const dr = data[j * 4] - r0;
      const dg = data[j * 4 + 1] - g0;
      const db = data[j * 4 + 2] - b0;
      if (dr * dr + dg * dg + db * db > tol2) continue;
      sel[j] = 255;
      stack[top++] = j;
    }
  }
  // Grow by one pixel so the anti-aliased rim between regions goes with the selection.
  return dilate(sel, w, h);
}

function dilate(sel: Uint8Array, w: number, h: number): Uint8Array {
  const out = sel.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (sel[i]) continue;
      if ((x > 0 && sel[i - 1]) || (x < w - 1 && sel[i + 1]) || (y > 0 && sel[i - w]) || (y < h - 1 && sel[i + w])) out[i] = 255;
    }
  }
  return out;
}

/** Combine a soft selection (0..255) into the mask. */
export function applySelection(mask: Mask, sel: Uint8Array, op: MaskOp): Mask {
  const data = new Uint8Array(mask.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = op === 'erase' ? Math.min(mask.data[i], 255 - sel[i]) : Math.max(mask.data[i], sel[i]);
  }
  return { w: mask.w, h: mask.h, data };
}

/** Paint a round, anti-aliased brush stroke from `a` to `b` into `mask` (in place). */
export function brushStroke(mask: Mask, a: Vec, b: Vec, radius: number, op: MaskOp): void {
  const { w, h, data } = mask;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius - 1));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + radius + 1));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius - 1));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + radius + 1));
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / l2)) : 0;
      const d = Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
      const cover = Math.max(0, Math.min(1, radius - d + 0.5));
      if (cover <= 0) continue;
      const i = y * w + x;
      const v = Math.round(cover * 255);
      data[i] = op === 'erase' ? Math.min(data[i], 255 - v) : Math.max(data[i], v);
    }
  }
}
