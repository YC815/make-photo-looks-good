/**
 * Find where a cut-out subject (e.g. Apple Photos "Copy Subject": tightly cropped, transparent
 * background, any resolution) sits inside the full photo, so its alpha can become the mask while
 * the photo keeps its background.
 *
 * Coarse-to-fine template matching on the subject's opaque pixels: an exhaustive search over
 * position and a sweep of scales on a ~320 px version of the photo, then hill-climbing at full
 * resolution around the best candidates.
 */

export interface Placement {
  /** Top-left of the cut-out in photo pixels. */
  x: number;
  y: number;
  /** Cut-out pixels → photo pixels. */
  scale: number;
  /** Mean absolute colour difference per channel (0..255). */
  error: number;
}

/** Below this the match is trusted (per channel, 0..255). */
export const GOOD_MATCH = 22;

interface Sample {
  x: number;
  y: number;
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Summed-area tables over the cut-out's opaque pixels, for box-averaged colours at any scale. */
class CutoutSAT {
  private w: number;
  private sums: Float64Array[];
  constructor(img: ImageData) {
    const { width: w, height: h, data } = img;
    this.w = w + 1;
    this.sums = [0, 1, 2, 3].map(() => new Float64Array((w + 1) * (h + 1)));
    const [r, g, b, n] = this.sums;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const on = data[i + 3] >= 250 ? 1 : 0;
        const k = (y + 1) * this.w + x + 1;
        const up = k - this.w;
        r[k] = data[i] * on + r[k - 1] + r[up] - r[up - 1];
        g[k] = data[i + 1] * on + g[k - 1] + g[up] - g[up - 1];
        b[k] = data[i + 2] * on + b[k - 1] + b[up] - b[up - 1];
        n[k] = on + n[k - 1] + n[up] - n[up - 1];
      }
    }
  }
  /** Average opaque colour of the box [x0,x1)×[y0,y1). */
  average(x0: number, y0: number, x1: number, y1: number, out: number[]): boolean {
    const box = (t: Float64Array) => t[y1 * this.w + x1] - t[y0 * this.w + x1] - t[y1 * this.w + x0] + t[y0 * this.w + x0];
    const n = box(this.sums[3]);
    if (n < 1) return false;
    out[0] = box(this.sums[0]) / n;
    out[1] = box(this.sums[1]) / n;
    out[2] = box(this.sums[2]) / n;
    return true;
  }
}

/** Opaque pixels well inside the cut-out (not on its anti-aliased rim). */
function pickSamples(img: ImageData, count: number): Sample[] {
  const { width: w, height: h, data } = img;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= 250;
  const candidates: Sample[] = [];
  const r = Math.max(2, Math.round(Math.min(w, h) / 100));
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      if (solid(x, y) && solid(x - r, y) && solid(x + r, y) && solid(x, y - r) && solid(x, y + r)) candidates.push({ x, y });
    }
  }
  const rnd = seeded(12345);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, count);
}

/** Box-downsampled RGB copy of the photo. */
function shrink(img: ImageData, factor: number) {
  const { width: w, height: h, data } = img;
  const sw = Math.max(1, Math.floor(w / factor));
  const sh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = Math.floor(y * factor); yy < Math.min(h, Math.floor((y + 1) * factor)); yy++) {
        for (let xx = Math.floor(x * factor); xx < Math.min(w, Math.floor((x + 1) * factor)); xx++) {
          const i = (yy * w + xx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const k = (y * sw + x) * 3;
      out[k] = r / n;
      out[k + 1] = g / n;
      out[k + 2] = b / n;
    }
  }
  return { w: sw, h: sh, rgb: out };
}

/** Sample colours as they look when the cut-out is drawn at `scale` (box filter). */
function colorsAt(sat: CutoutSAT, samples: Sample[], scale: number, cw: number, ch: number): Float32Array {
  const rr = Math.max(0, Math.round(0.5 / scale - 0.5));
  const out = new Float32Array(samples.length * 3);
  const c = [0, 0, 0];
  samples.forEach((p, i) => {
    sat.average(Math.max(0, p.x - rr), Math.max(0, p.y - rr), Math.min(cw, p.x + rr + 1), Math.min(ch, p.y + rr + 1), c);
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  });
  return out;
}

export function alignCutout(photo: ImageData, cutout: ImageData, hints: number[] = []): Placement | null {
  const W = photo.width;
  const H = photo.height;
  const cw = cutout.width;
  const ch = cutout.height;
  const samples = pickSamples(cutout, 400);
  if (samples.length < 20) return null;
  const sat = new CutoutSAT(cutout);

  const smax = Math.min(W / cw, H / ch);
  const scales: number[] = [];
  for (let s = smax; s >= smax * 0.08; s /= 1.05) scales.push(s);
  for (const h of hints) if (h > 0 && h <= smax * 1.0001) scales.push(Math.min(h, smax));

  // --- Coarse: exhaustive over position, per scale. --------------------------------------------
  const factor = Math.max(1, Math.max(W, H) / 320);
  const small = shrink(photo, factor);
  const coarseSamples = samples.slice(0, 120);
  const candidates: Placement[] = [];
  for (const s of scales) {
    const k = s / factor; // cut-out px → small photo px
    const cols = colorsAt(sat, coarseSamples, s / factor, cw, ch);
    const offs = coarseSamples.map((p) => [Math.floor((p.x + 0.5) * k), Math.floor((p.y + 0.5) * k)]);
    const spanX = small.w - Math.ceil(cw * k);
    const spanY = small.h - Math.ceil(ch * k);
    if (spanX < 0 || spanY < 0) continue;
    let best = { err: Infinity, x: 0, y: 0 };
    const n = coarseSamples.length;
    for (let ty = 0; ty <= spanY; ty++) {
      for (let tx = 0; tx <= spanX; tx++) {
        let err = 0;
        const limit = best.err * n * 3;
        let i = 0;
        for (; i < n; i++) {
          const px = tx + offs[i][0];
          const py = ty + offs[i][1];
          const q = (Math.min(small.h - 1, py) * small.w + Math.min(small.w - 1, px)) * 3;
          err +=
            Math.abs(small.rgb[q] - cols[i * 3]) +
            Math.abs(small.rgb[q + 1] - cols[i * 3 + 1]) +
            Math.abs(small.rgb[q + 2] - cols[i * 3 + 2]);
          if ((i & 7) === 7 && err > limit) break;
        }
        if (i === n && err / (n * 3) < best.err) best = { err: err / (n * 3), x: tx, y: ty };
      }
    }
    if (best.err < Infinity) candidates.push({ x: best.x * factor, y: best.y * factor, scale: s, error: best.err });
  }
  candidates.sort((a, b) => a.error - b.error);

  // --- Fine: hill-climb at full resolution around the best few. --------------------------------
  const errorAt = (x: number, y: number, s: number, cols: Float32Array): number => {
    let err = 0;
    for (let i = 0; i < samples.length; i++) {
      const px = x + (samples[i].x + 0.5) * s;
      const py = y + (samples[i].y + 0.5) * s;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) return Infinity;
      const q = (iy * W + ix) * 4;
      err +=
        Math.abs(photo.data[q] - cols[i * 3]) +
        Math.abs(photo.data[q + 1] - cols[i * 3 + 1]) +
        Math.abs(photo.data[q + 2] - cols[i * 3 + 2]);
    }
    return err / (samples.length * 3);
  };

  let winner: Placement | null = null;
  for (const c of candidates.slice(0, 4)) {
    let cur = { ...c };
    let cols = colorsAt(sat, samples, cur.scale, cw, ch);
    cur.error = errorAt(cur.x, cur.y, cur.scale, cols);
    for (let step = factor; step >= 0.5; step /= 2) {
      for (let improved = true; improved; ) {
        improved = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const e = errorAt(cur.x + dx * step, cur.y + dy * step, cur.scale, cols);
          if (e < cur.error) {
            cur = { ...cur, x: cur.x + dx * step, y: cur.y + dy * step, error: e };
            improved = true;
          }
        }
        // Scale nudges keep the subject's centre in place.
        for (const f of [1.004, 1 / 1.004]) {
          const s = cur.scale * f;
          const nx = cur.x + (cw * (cur.scale - s)) / 2;
          const ny = cur.y + (ch * (cur.scale - s)) / 2;
          const c2 = colorsAt(sat, samples, s, cw, ch);
          const e = errorAt(nx, ny, s, c2);
          if (e < cur.error) {
            cur = { x: nx, y: ny, scale: s, error: e };
            cols = c2;
            improved = true;
          }
        }
      }
    }
    if (!winner || cur.error < winner.error) winner = cur;
  }
  return winner;
}
