import { add, dist, dot, lerp, normalize, scale, sub, distToSegment, type Vec } from './geometry';

/**
 * A pen-tool anchor. Handles are absolute positions; a handle equal to `p` means "no handle".
 * `smooth` anchors keep their two handles collinear while editing.
 */
export interface Anchor {
  p: Vec;
  hin: Vec;
  hout: Vec;
  smooth: boolean;
}

export type Path = Anchor[];

/**
 * The path lives in the capture line's frame: x points away from the subject, y runs along the
 * line. Rotating or moving the capture line therefore carries the bent ribbon with it.
 */
export interface Frame {
  origin: Vec;
  dir: Vec;
  normal: Vec;
}

export const toWorld = (f: Frame, v: Vec): Vec => add(f.origin, add(scale(f.dir, v.x), scale(f.normal, v.y)));
export const toLocal = (f: Frame, w: Vec): Vec => {
  const d = sub(w, f.origin);
  return { x: dot(d, f.dir), y: dot(d, f.normal) };
};
/** Rotate a local direction into world space (no translation). */
export const dirToWorld = (f: Frame, v: Vec): Vec => add(scale(f.dir, v.x), scale(f.normal, v.y));

export const corner = (p: Vec): Anchor => ({ p, hin: p, hout: p, smooth: false });

export function straightPath(length: number): Path {
  return [corner({ x: 0, y: 0 }), corner({ x: length, y: 0 })];
}

export function cubicPoint(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function cubicTangent(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const d = {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
  if (Math.hypot(d.x, d.y) > 1e-6) return normalize(d);
  // A handle sits on its anchor: the derivative vanishes, so look at the neighbourhood instead.
  const a = cubicPoint(p0, p1, p2, p3, Math.max(0, t - 1e-3));
  const b = cubicPoint(p0, p1, p2, p3, Math.min(1, t + 1e-3));
  return Math.hypot(b.x - a.x, b.y - a.y) > 1e-9 ? normalize(sub(b, a)) : normalize(sub(p3, p0));
}

const segment = (path: Path, i: number): [Vec, Vec, Vec, Vec] => [path[i].p, path[i].hout, path[i + 1].hin, path[i + 1].p];

export interface Polyline {
  points: Vec[];
  tangents: Vec[];
  length: number;
}

const MAX_TURN = 0.08; // radians between consecutive ribbon cross-sections

/**
 * Flatten the path into closely spaced samples with tangents. Sharp turns (corner anchors) get a
 * fan of extra samples so the ribbon pivots around the corner instead of leaving a wedge gap.
 */
export function flatten(path: Path, spacing = 1.5, startTangent?: Vec): Polyline {
  const raw: { p: Vec; t: Vec }[] = [];
  // Lets the ribbon leave the capture line square-on and then pivot into the path's direction.
  if (startTangent && path.length > 0) raw.push({ p: path[0].p, t: normalize(startTangent) });
  for (let i = 0; i < path.length - 1; i++) {
    const [p0, p1, p2, p3] = segment(path, i);
    const approx = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
    const n = Math.max(2, Math.ceil(approx / spacing));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      raw.push({ p: cubicPoint(p0, p1, p2, p3, t), t: cubicTangent(p0, p1, p2, p3, t) });
      // Keep the outgoing tangent at an anchor as well, so corners are explicit.
      if (k === n && i < path.length - 2) {
        const [q0, q1, q2, q3] = segment(path, i + 1);
        raw.push({ p: p3, t: cubicTangent(q0, q1, q2, q3, 0) });
      }
    }
  }

  const points: Vec[] = [];
  const tangents: Vec[] = [];
  let length = 0;
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    if (i > 0) {
      const prev = raw[i - 1];
      length += dist(prev.p, cur.p);
      const a0 = Math.atan2(prev.t.y, prev.t.x);
      let da = Math.atan2(cur.t.y, cur.t.x) - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const fan = Math.floor(Math.abs(da) / MAX_TURN);
      for (let k = 1; k <= fan; k++) {
        const a = a0 + (da * k) / (fan + 1);
        points.push(cur.p);
        tangents.push({ x: Math.cos(a), y: Math.sin(a) });
      }
    }
    points.push(cur.p);
    tangents.push(cur.t);
  }
  return { points, tangents, length };
}

/** Closest point on the path, as (segment index, curve parameter, distance). */
export function nearestOnPath(path: Path, q: Vec, spacing = 2): { seg: number; t: number; d: number } {
  let best = { seg: -1, t: 0, d: Infinity };
  for (let i = 0; i < path.length - 1; i++) {
    const [p0, p1, p2, p3] = segment(path, i);
    const n = Math.max(8, Math.ceil((dist(p0, p1) + dist(p1, p2) + dist(p2, p3)) / spacing));
    let prev = p0;
    for (let k = 1; k <= n; k++) {
      const cur = cubicPoint(p0, p1, p2, p3, k / n);
      const r = distToSegment(q, prev, cur);
      if (r.d < best.d) best = { seg: i, t: (k - 1 + r.t) / n, d: r.d };
      prev = cur;
    }
  }
  return best;
}

/** Insert an anchor on segment `seg` at parameter t without changing the curve's shape. */
export function splitSegment(path: Path, seg: number, t: number): Path {
  const [p0, p1, p2, p3] = segment(path, seg);
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const m = lerp(d, e, t);
  const out = path.map((an) => ({ ...an }));
  out[seg].hout = a;
  out[seg + 1].hin = c;
  out.splice(seg + 1, 0, { p: m, hin: d, hout: e, smooth: true });
  return out;
}

/** Move an anchor together with its handles. */
export function moveAnchor(path: Path, i: number, to: Vec): Path {
  const out = path.map((an) => ({ ...an }));
  const a = out[i];
  const delta = sub(to, a.p);
  out[i] = { ...a, p: to, hin: add(a.hin, delta), hout: add(a.hout, delta) };
  return out;
}

/**
 * Move one handle. Smooth anchors mirror the direction onto the opposite handle (keeping its
 * length), exactly like the pen tool; `breakSmooth` turns the anchor into a corner first.
 */
export function moveHandle(path: Path, i: number, which: 'hin' | 'hout', to: Vec, breakSmooth = false): Path {
  const out = path.map((an) => ({ ...an }));
  const a = { ...out[i] };
  if (breakSmooth) a.smooth = false;
  a[which] = to;
  if (a.smooth) {
    const other = which === 'hin' ? 'hout' : 'hin';
    const v = sub(to, a.p);
    const l = Math.hypot(v.x, v.y);
    const ol = dist(a[other], a.p);
    if (l > 1e-6) a[other] = sub(a.p, scale(v, (ol > 1e-6 ? ol : l) / l));
  }
  out[i] = a;
  return out;
}

/** Pen-tool click-drag: pull symmetric handles out of anchor i. */
export function pullHandles(path: Path, i: number, to: Vec): Path {
  const out = path.map((an) => ({ ...an }));
  const a = out[i];
  out[i] = { ...a, hout: to, hin: sub(a.p, sub(to, a.p)), smooth: true };
  return out;
}

export function removeAnchor(path: Path, i: number): Path {
  return path.filter((_, k) => k !== i);
}

export function makeCorner(path: Path, i: number): Path {
  const out = path.map((an) => ({ ...an }));
  out[i] = corner(out[i].p);
  return out;
}

export function pathLength(path: Path): number {
  return flatten(path, 2).length;
}
