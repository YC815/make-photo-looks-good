import { add, fromAngle, perp, scale, type Circle, type Vec } from './geometry';
import { isSubject, type Mask } from './mask';

export interface CaptureParams {
  /** Direction (radians, image space) the capture line faces the subject from. */
  angle: number;
  /** How far the line is pushed from the tangent toward the subject (px). 0 = outermost silhouette. */
  offset: number;
  /** Portion of the line that is kept, as fractions 0..1 along the line. */
  trimStart: number;
  trimEnd: number;
  /** Sample colour this many px inside the edge to skip the anti-aliased fringe. */
  inset: number;
  /** Average each column with its neighbours (radius in columns) to calm noisy edges. */
  smooth: number;
}

export interface Column {
  /** Position along the line, relative to its centre. */
  t: number;
  /** The point on the capture line this column starts from. */
  line: Vec;
  /** First subject pixel hit when looking from the line toward the subject. */
  edge: Vec | null;
}

export interface Capture {
  /** Unit vector pointing from the subject toward the capture line (outward). */
  dir: Vec;
  /** Unit vector along the line (dir rotated +90°). */
  normal: Vec;
  /** Centre of the full-length capture line. */
  base: Vec;
  /** Half length of the full line (= circle radius). */
  half: number;
  /** Kept extent along `normal`, relative to `base`. */
  t0: number;
  t1: number;
  /** Where the ribbon spine starts: middle of the kept part of the line. */
  origin: Vec;
  columns: Column[];
  /** RGBA (straight alpha), one texel per column; alpha 0 where nothing was hit. */
  colors: Uint8ClampedArray;
}

const STEP = 0.5;

export function captureLine(circle: Circle, p: CaptureParams): Pick<Capture, 'dir' | 'normal' | 'base' | 'half' | 't0' | 't1' | 'origin'> {
  const dir = fromAngle(p.angle);
  const normal = perp(dir);
  const base = add(circle.c, scale(dir, circle.r - p.offset));
  const half = circle.r;
  const a = Math.min(p.trimStart, p.trimEnd);
  const b = Math.max(p.trimStart, p.trimEnd);
  const t0 = -half + a * 2 * half;
  const t1 = -half + b * 2 * half;
  const origin = add(base, scale(normal, (t0 + t1) / 2));
  return { dir, normal, base, half, t0, t1, origin };
}

/**
 * Look at the subject from one side: every column of the capture line casts a ray toward the
 * subject and keeps the colour of the first subject pixel it meets.
 */
export function capture(image: ImageData, mask: Mask, circle: Circle, p: CaptureParams): Capture {
  const line = captureLine(circle, p);
  const { dir, normal, base, t0, t1 } = line;
  const width = Math.max(1, Math.round(t1 - t0));
  const columns: Column[] = [];
  const colors = new Uint8ClampedArray(width * 4);
  const maxSteps = Math.ceil((2 * circle.r - p.offset + 4) / STEP);
  const { data, width: iw } = image;

  for (let i = 0; i < width; i++) {
    const t = t0 + ((i + 0.5) * (t1 - t0)) / width;
    const start = add(base, scale(normal, t));
    let edge: Vec | null = null;
    let k = 0;
    for (; k <= maxSteps; k++) {
      const x = start.x - dir.x * k * STEP;
      const y = start.y - dir.y * k * STEP;
      if (isSubject(mask, x, y)) {
        edge = { x, y };
        break;
      }
    }
    columns.push({ t, line: start, edge });
    if (!edge) continue;

    // Walk `inset` px deeper, but never out the other side of a thin part.
    let sx = edge.x;
    let sy = edge.y;
    for (let s = 1; s <= p.inset / STEP; s++) {
      const x = edge.x - dir.x * s * STEP;
      const y = edge.y - dir.y * s * STEP;
      if (!isSubject(mask, x, y)) break;
      sx = x;
      sy = y;
    }
    const idx = (Math.floor(sy) * iw + Math.floor(sx)) * 4;
    colors[i * 4] = data[idx];
    colors[i * 4 + 1] = data[idx + 1];
    colors[i * 4 + 2] = data[idx + 2];
    colors[i * 4 + 3] = 255;
  }

  return { ...line, columns, colors: smoothStrip(colors, Math.round(p.smooth)) };
}

/** Box blur along the strip that only mixes captured columns, so gaps stay transparent. */
export function smoothStrip(colors: Uint8ClampedArray, radius: number): Uint8ClampedArray {
  if (radius <= 0) return colors;
  const n = colors.length / 4;
  const out = new Uint8ClampedArray(colors.length);
  for (let i = 0; i < n; i++) {
    if (colors[i * 4 + 3] === 0) continue;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      if (colors[j * 4 + 3] === 0) continue;
      r += colors[j * 4];
      g += colors[j * 4 + 1];
      b += colors[j * 4 + 2];
      count++;
    }
    out[i * 4] = r / count;
    out[i * 4 + 1] = g / count;
    out[i * 4 + 2] = b / count;
    out[i * 4 + 3] = 255;
  }
  return out;
}
