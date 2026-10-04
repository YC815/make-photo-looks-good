export interface Vec {
  x: number;
  y: number;
}

export interface Circle {
  c: Vec;
  r: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
/** Rotate +90° (in y-down image space this turns "right" into "down"). */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const normalize = (a: Vec): Vec => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};
export const fromAngle = (theta: number): Vec => ({ x: Math.cos(theta), y: Math.sin(theta) });

/** Andrew's monotone chain. Returns the hull in counter-clockwise order (y-up sense). */
export function convexHull(points: Vec[]): Vec[] {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (o: Vec, a: Vec, b: Vec) => cross(sub(a, o), sub(b, o));
  const lower: Vec[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function circleFrom2(a: Vec, b: Vec): Circle {
  const c = lerp(a, b, 0.5);
  return { c, r: dist(a, c) };
}

function circleFrom3(a: Vec, b: Vec, c: Vec): Circle | null {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const cx = c.x - a.x;
  const cy = c.y - a.y;
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12) return null;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (cy * b2 - by * c2) / d;
  const uy = (bx * c2 - cx * b2) / d;
  const center = { x: a.x + ux, y: a.y + uy };
  return { c: center, r: Math.hypot(ux, uy) };
}

const EPS = 1e-7;
const inCircle = (circle: Circle, p: Vec) => dist(circle.c, p) <= circle.r * (1 + EPS) + EPS;

/**
 * Smallest enclosing circle (Welzl, iterative randomized form). Expected O(n).
 * Feed it the convex hull of the subject to keep n tiny.
 */
export function minEnclosingCircle(points: Vec[], random: () => number = Math.random): Circle {
  if (points.length === 0) return { c: { x: 0, y: 0 }, r: 0 };
  const pts = points.slice();
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  let circle: Circle = { c: pts[0], r: 0 };
  for (let i = 1; i < pts.length; i++) {
    if (inCircle(circle, pts[i])) continue;
    circle = { c: pts[i], r: 0 };
    for (let j = 0; j < i; j++) {
      if (inCircle(circle, pts[j])) continue;
      circle = circleFrom2(pts[i], pts[j]);
      for (let k = 0; k < j; k++) {
        if (inCircle(circle, pts[k])) continue;
        circle = circleFrom3(pts[i], pts[j], pts[k]) ?? circle;
      }
    }
  }
  return circle;
}

/** Distance from p to segment ab, and the parameter of the closest point. */
export function distToSegment(p: Vec, a: Vec, b: Vec): { d: number; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return { d: dist(p, add(a, scale(ab, t))), t };
}
