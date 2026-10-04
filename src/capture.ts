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
  /**
   * Gaps the ray finds behind the first subject pixel: leave them, fill them with the colour of
   * the inner wall (each inner surface stretches too), or let the outer colour run through.
   */
  holes: HoleMode;
}

export type HoleMode = 'empty' | 'inner' | 'outer';

/** A stretch of background enclosed by the subject along one column's ray. */
export interface Hole {
  col: number;
  /** End nearest the capture line. */
  from: Vec;
  /** Inner wall. */
  to: Vec;
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
  holes: Hole[];
  /** RGBA per hole. */
  holeColors: Uint8ClampedArray;
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
 * subject and keeps the colour of the first subject pixel it meets. The ray keeps going so that
 * gaps enclosed by the subject (between petals, inside a handle…) can be filled as well.
 */
export function capture(image: ImageData, mask: Mask, circle: Circle, p: CaptureParams): Capture {
  const line = captureLine(circle, p);
  const { dir, normal, base, t0, t1 } = line;
  const width = Math.max(1, Math.round(t1 - t0));
  const columns: Column[] = [];
  const colors = new Uint8ClampedArray(width * 4);
  const holes: Hole[] = [];
  const holeRGBA: number[] = [];
  const maxSteps = Math.ceil((2 * circle.r - p.offset + 4) / STEP);
  const { data, width: iw } = image;
  const at = (o: Vec, k: number): Vec => ({ x: o.x - dir.x * k * STEP, y: o.y - dir.y * k * STEP });

  /** Colour `inset` px deeper than step k, without walking out the other side of a thin part. */
  const sample = (o: Vec, k: number): number => {
    let q = at(o, k);
    for (let s = 1; s <= p.inset / STEP; s++) {
      const next = at(o, k + s);
      if (!isSubject(mask, next.x, next.y)) break;
      q = next;
    }
    return (Math.floor(q.y) * iw + Math.floor(q.x)) * 4;
  };

  for (let i = 0; i < width; i++) {
    const t = t0 + ((i + 0.5) * (t1 - t0)) / width;
    const start = add(base, scale(normal, t));
    let first = -1;
    let exit = -1; // step where the ray last left the subject
    let inside = false;
    for (let k = 0; k <= maxSteps; k++) {
      const q = at(start, k);
      const now = isSubject(mask, q.x, q.y);
      if (now && !inside) {
        if (first < 0) first = k;
        else if (p.holes !== 'empty') {
          // Back inside after a gap: [exit, k) was a hole hidden behind the subject.
          holes.push({ col: i, from: at(start, exit - 0.5), to: at(start, k + 0.5) });
          if (p.holes === 'inner') {
            const idx = sample(start, k);
            holeRGBA.push(data[idx], data[idx + 1], data[idx + 2], 255);
          }
        }
      } else if (!now && inside) {
        exit = k;
      }
      inside = now;
      if (first >= 0 && p.holes === 'empty') break;
    }

    columns.push({ t, line: start, edge: first >= 0 ? at(start, first) : null });
    if (first < 0) continue;
    const idx = sample(start, first);
    colors[i * 4] = data[idx];
    colors[i * 4 + 1] = data[idx + 1];
    colors[i * 4 + 2] = data[idx + 2];
    colors[i * 4 + 3] = 255;
  }

  const strip = smoothStrip(colors, Math.round(p.smooth));
  let holeColors: Uint8ClampedArray;
  if (p.holes === 'outer') {
    // The outermost colour punches straight through the subject into the gaps.
    holeColors = new Uint8ClampedArray(holes.length * 4);
    holes.forEach((h, j) => holeColors.set(strip.subarray(h.col * 4, h.col * 4 + 4), j * 4));
  } else {
    holeColors = new Uint8ClampedArray(holeRGBA);
  }
  return { ...line, columns, colors: strip, holes, holeColors };
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
