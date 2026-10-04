import { describe, expect, it } from 'vitest';
import { alignCutout, GOOD_MATCH } from '../src/align';

const img = (w: number, h: number, data: Uint8ClampedArray) => ({ width: w, height: h, data, colorSpace: 'srgb' }) as ImageData;

/** A photo with enough structure that every spot looks different. */
function photo(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 128 + 100 * Math.sin(x / 23 + Math.cos(y / 41));
      data[i + 1] = 128 + 100 * Math.sin(y / 17 + x / 59);
      data[i + 2] = 128 + 100 * Math.cos((x + y) / 31);
      data[i + 3] = 255;
    }
  return img(w, h, data);
}

/**
 * Cut an elliptical "subject" out of the photo at (x0, y0) with size (sw, sh) in photo pixels,
 * resampled to `res` cut-out pixels per photo pixel (like a cut-out at a different resolution).
 */
function cutout(src: ImageData, x0: number, y0: number, sw: number, sh: number, res: number) {
  const w = Math.round(sw * res);
  const h = Math.round(sh * res);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w - 0.5;
      const ny = (y + 0.5) / h - 0.5;
      const i = (y * w + x) * 4;
      if (nx * nx + ny * ny > 0.25) continue;
      const px = Math.floor(x0 + (x + 0.5) / res);
      const py = Math.floor(y0 + (y + 0.5) / res);
      const j = (py * src.width + px) * 4;
      data.set([src.data[j], src.data[j + 1], src.data[j + 2], 255], i);
    }
  return img(w, h, data);
}

describe('alignCutout', () => {
  const big = photo(640, 480);

  it('finds a same-resolution cut-out', () => {
    const p = alignCutout(big, cutout(big, 210, 130, 180, 220, 1))!;
    expect(p.error).toBeLessThan(GOOD_MATCH);
    expect(p.x).toBeCloseTo(210, -0.5);
    expect(p.y).toBeCloseTo(130, -0.5);
    expect(p.scale).toBeCloseTo(1, 1);
  });

  it('finds a cut-out made from a twice-as-large original', () => {
    const p = alignCutout(big, cutout(big, 400, 60, 160, 200, 2))!;
    expect(p.error).toBeLessThan(GOOD_MATCH);
    expect(Math.abs(p.x - 400)).toBeLessThan(2);
    expect(Math.abs(p.y - 60)).toBeLessThan(2);
    expect(p.scale).toBeCloseTo(0.5, 1);
  });

  it('reports a poor match for a subject that is not in the photo', () => {
    // Unrelated content: blocky noise.
    const other = photo(300, 300);
    for (let i = 0; i < other.data.length; i += 4) {
      const cell = Math.floor(i / 4 / 300 / 10) * 31 + Math.floor(((i / 4) % 300) / 10);
      const seed = (cell * 2654435761) >>> 0;
      other.data.set([seed & 255, (seed >> 8) & 255, (seed >> 16) & 255], i);
    }
    const p = alignCutout(big, cutout(other, 50, 50, 150, 150, 1));
    expect(p === null || p.error > GOOD_MATCH).toBe(true);
  });
});
