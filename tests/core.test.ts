import { describe, expect, it } from 'vitest';
import { capture, smoothStrip } from '../src/capture';
import { progressAt, ribbonPoint, widthAt } from '../src/ribbon';
import { convexHull, dist, minEnclosingCircle, type Vec } from '../src/geometry';
import { enclosingCircle, type Mask } from '../src/mask';
import { cubicPoint, flatten, moveHandle, nearestFraction, nearestOnPath, pathLength, pointAtFraction, splitSegment, straightPath, type Path } from '../src/path';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function maskFrom(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 255 : 0;
  return { w, h, data };
}

/** Minimal ImageData stand-in: colour encodes the pixel position so we can tell what was sampled. */
function positionImage(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

describe('minEnclosingCircle', () => {
  it('matches brute force on random point sets', () => {
    const rnd = seeded(7);
    for (let trial = 0; trial < 50; trial++) {
      const pts: Vec[] = Array.from({ length: 3 + Math.floor(rnd() * 40) }, () => ({ x: rnd() * 100, y: rnd() * 100 }));
      const c = minEnclosingCircle(pts, rnd);
      for (const p of pts) expect(dist(p, c.c)).toBeLessThanOrEqual(c.r + 1e-6);
      // No circle through 2 or 3 of the points that contains everything is smaller.
      let best = Infinity;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
          const m = { x: (pts[i].x + pts[j].x) / 2, y: (pts[i].y + pts[j].y) / 2 };
          const r = dist(pts[i], m);
          if (pts.every((p) => dist(p, m) <= r + 1e-6)) best = Math.min(best, r);
        }
      expect(c.r).toBeLessThanOrEqual(best + 1e-6);
    }
  });

  it('hull keeps only extreme points', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
    ]);
    expect(hull).toHaveLength(4);
  });

  it('encloses a mask disc tightly', () => {
    const mask = maskFrom(200, 200, (x, y) => Math.hypot(x - 90, y - 110) < 50);
    const c = enclosingCircle(mask)!;
    expect(c.c.x).toBeCloseTo(90, 0);
    expect(c.c.y).toBeCloseTo(110, 0);
    expect(c.r).toBeGreaterThan(49);
    expect(c.r).toBeLessThan(52);
  });
});

describe('capture', () => {
  const W = 200;
  const H = 200;
  // An L shape: a tall bar on the left and a short foot at the bottom.
  const mask = maskFrom(W, H, (x, y) => (x >= 40 && x < 80 && y >= 40 && y < 160) || (x >= 40 && x < 140 && y >= 120 && y < 160));
  const image = positionImage(W, H);
  const circle = enclosingCircle(mask)!;
  const base = { angle: 0, offset: 0, trimStart: 0, trimEnd: 1, inset: 0, smooth: 0, holes: 'empty' as const };

  it('looking from the right finds the outermost pixel of every row', () => {
    const cap = capture(image, mask, circle, base);
    for (let i = 0; i < cap.columns.length; i++) {
      const col = cap.columns[i];
      const y = Math.floor(col.line.y);
      if (y >= 41 && y < 119) {
        expect(col.edge).not.toBeNull();
        expect(cap.colors[i * 4]).toBe(79); // right edge of the bar
      } else if (y >= 121 && y < 159) {
        expect(cap.colors[i * 4]).toBe(139); // right edge of the foot
      } else if (y < 38 || y > 162) {
        expect(col.edge).toBeNull();
        expect(cap.colors[i * 4 + 3]).toBe(0);
      }
    }
  });

  it('looking from above sees the bar top and the foot top', () => {
    const cap = capture(image, mask, circle, { ...base, angle: -Math.PI / 2 });
    // dir points up, so the line runs left→right... normal = perp(dir) = (1, 0).
    expect(cap.normal.x).toBeCloseTo(1);
    for (let i = 0; i < cap.columns.length; i++) {
      const x = Math.floor(cap.columns[i].line.x);
      if (x >= 41 && x < 79) expect(cap.colors[i * 4 + 1]).toBe(40);
      if (x >= 81 && x < 139) expect(cap.colors[i * 4 + 1]).toBe(120);
    }
  });

  it('pushing the line into the subject turns it into a straight slice', () => {
    const offset = circle.c.x + circle.r - 60; // line at x = 60
    const cap = capture(image, mask, circle, { ...base, offset });
    for (let i = 0; i < cap.columns.length; i++) {
      const y = Math.floor(cap.columns[i].line.y);
      if (y >= 41 && y < 159) expect(cap.colors[i * 4]).toBe(60);
    }
  });

  it('inset samples deeper but never leaves the subject', () => {
    const cap = capture(image, mask, circle, { ...base, inset: 5 });
    const i = cap.columns.findIndex((c) => Math.floor(c.line.y) === 80);
    expect(cap.colors[i * 4]).toBe(74);
    const thin = capture(image, mask, circle, { ...base, inset: 500 });
    expect(thin.colors[i * 4]).toBe(40);
  });

  it('trim keeps only part of the line', () => {
    const cap = capture(image, mask, circle, { ...base, trimStart: 0.25, trimEnd: 0.5 });
    expect(cap.columns.length).toBe(Math.round(circle.r * 0.5));
    expect(cap.t0).toBeCloseTo(-circle.r / 2);
    expect(cap.t1).toBeCloseTo(0);
  });
});

describe('holes behind the silhouette', () => {
  // A ring: looking from the right, rows through the middle cross the hole in the centre.
  const W = 200;
  const mask = maskFrom(W, W, (x, y) => {
    const d = Math.hypot(x - 100, y - 100);
    return d < 60 && d >= 30;
  });
  const image = positionImage(W, W);
  const circle = enclosingCircle(mask)!;
  const base = { angle: 0, offset: 0, trimStart: 0, trimEnd: 1, inset: 0, smooth: 0, holes: 'empty' as const };
  const middle = (cap: ReturnType<typeof capture>) => cap.holes.filter((h) => Math.abs(h.from.y - 100.5) < 0.6);

  it('finds nothing when holes are left empty', () => {
    expect(capture(image, mask, circle, base).holes).toHaveLength(0);
  });

  it('spans the gap between the two walls', () => {
    const [hole] = middle(capture(image, mask, circle, { ...base, holes: 'inner' }));
    expect(hole.from.x).toBeGreaterThan(129);
    expect(hole.from.x).toBeLessThan(131.5);
    expect(hole.to.x).toBeGreaterThan(69);
    expect(hole.to.x).toBeLessThan(71);
  });

  it('inner mode uses the inner wall colour, outer mode the outermost colour', () => {
    const inner = capture(image, mask, circle, { ...base, holes: 'inner' });
    const j = inner.holes.indexOf(middle(inner)[0]);
    expect(inner.holeColors[j * 4]).toBe(69); // pixel 69 is the last ring pixel before the hole
    const outer = capture(image, mask, circle, { ...base, holes: 'outer' });
    const k = outer.holes.indexOf(middle(outer)[0]);
    expect(outer.holeColors[k * 4]).toBe(159);
  });
});

describe('smoothStrip', () => {
  it('averages neighbours but keeps gaps empty', () => {
    const c = new Uint8ClampedArray([0, 0, 0, 255, 90, 0, 0, 255, 0, 0, 0, 0, 30, 0, 0, 255]);
    const s = smoothStrip(c, 1);
    expect(s[0]).toBe(45);
    expect(s[4]).toBe(45);
    expect(s[11]).toBe(0);
    expect(s[12]).toBe(30);
  });
});

describe('path', () => {
  it('straight path flattens to its length', () => {
    expect(pathLength(straightPath(300))).toBeCloseTo(300, 0);
  });

  it('splitting keeps the curve shape', () => {
    const path: Path = [
      { p: { x: 0, y: 0 }, hin: { x: 0, y: 0 }, hout: { x: 100, y: 0 }, smooth: false },
      { p: { x: 200, y: 100 }, hin: { x: 200, y: 0 }, hout: { x: 200, y: 100 }, smooth: false },
    ];
    const split = splitSegment(path, 0, 0.3);
    expect(split).toHaveLength(3);
    const orig = cubicPoint(path[0].p, path[0].hout, path[1].hin, path[1].p, 0.3);
    expect(dist(split[1].p, orig)).toBeLessThan(1e-9);
    expect(pathLength(split)).toBeCloseTo(pathLength(path), 0);
  });

  it('smooth handles stay mirrored', () => {
    const path: Path = [
      { p: { x: 0, y: 0 }, hin: { x: 0, y: 0 }, hout: { x: 0, y: 0 }, smooth: false },
      { p: { x: 100, y: 0 }, hin: { x: 80, y: 0 }, hout: { x: 140, y: 0 }, smooth: true },
    ];
    const moved = moveHandle(path, 1, 'hout', { x: 100, y: 30 });
    expect(moved[1].hin.x).toBeCloseTo(100);
    expect(moved[1].hin.y).toBeCloseTo(-20);
    const broken = moveHandle(path, 1, 'hout', { x: 100, y: 30 }, true);
    expect(broken[1].hin).toEqual({ x: 80, y: 0 });
  });

  it('corners get a fan of cross-sections', () => {
    const path: Path = [
      { p: { x: 0, y: 0 }, hin: { x: 0, y: 0 }, hout: { x: 0, y: 0 }, smooth: false },
      { p: { x: 100, y: 0 }, hin: { x: 100, y: 0 }, hout: { x: 100, y: 0 }, smooth: false },
      { p: { x: 100, y: 100 }, hin: { x: 100, y: 100 }, hout: { x: 100, y: 100 }, smooth: false },
    ];
    const line = flatten(path);
    const atCorner = line.points.filter((p) => p.x === 100 && p.y === 0).length;
    expect(atCorner).toBeGreaterThan(10);
    for (let i = 1; i < line.tangents.length; i++) {
      const a = Math.atan2(line.tangents[i - 1].y, line.tangents[i - 1].x);
      const b = Math.atan2(line.tangents[i].y, line.tangents[i].x);
      expect(Math.abs(b - a)).toBeLessThan(0.1);
    }
  });

  it('maps between points and length fractions', () => {
    const path: Path = [
      { p: { x: 0, y: 0 }, hin: { x: 0, y: 0 }, hout: { x: 0, y: 0 }, smooth: false },
      { p: { x: 100, y: 0 }, hin: { x: 100, y: 0 }, hout: { x: 100, y: 0 }, smooth: false },
      { p: { x: 100, y: 100 }, hin: { x: 100, y: 100 }, hout: { x: 100, y: 100 }, smooth: false },
    ];
    expect(dist(pointAtFraction(path, 0.75), { x: 100, y: 50 })).toBeLessThan(0.5);
    expect(nearestFraction(path, { x: 110, y: 50 })).toBeCloseTo(0.75, 2);
    expect(nearestFraction(path, { x: -20, y: 5 })).toBe(0);
  });

  it('finds the nearest segment', () => {
    const near = nearestOnPath(straightPath(100), { x: 40, y: 3 });
    expect(near.seg).toBe(0);
    expect(near.t).toBeCloseTo(0.4, 1);
    expect(near.d).toBeCloseTo(3, 1);
  });
});

describe('width profile', () => {
  const base = { start: 1, end: 0, from: 0.2, to: 0.6, curve: 'linear' as const };

  it('holds the start width before the transition and the end width after it', () => {
    expect(widthAt(base, 0.1)).toBe(1);
    expect(widthAt(base, 0.4)).toBeCloseTo(0.5);
    expect(widthAt(base, 0.9)).toBe(0);
  });

  it('smooth eases, step jumps at the start of the transition', () => {
    expect(progressAt({ ...base, curve: 'smooth' }, 0.25)).toBeLessThan(progressAt(base, 0.25));
    expect(progressAt({ ...base, curve: 'smooth' }, 0.4)).toBeCloseTo(0.5);
    expect(progressAt({ ...base, curve: 'step' }, 0.19)).toBe(0);
    expect(progressAt({ ...base, curve: 'step' }, 0.2)).toBe(1);
  });

  it('accepts from/to in either order', () => {
    expect(progressAt({ ...base, from: 0.6, to: 0.2 }, 0.4)).toBeCloseTo(0.5);
  });

  it('places columns by width and shift', () => {
    const p = { x: 100, y: 0 };
    const n = { x: 0, y: 1 };
    expect(ribbonPoint(p, n, 30, 1, { x: 0, y: 40 }, 0)).toEqual({ x: 100, y: 30 });
    for (const t of [-50, 0, 50]) expect(ribbonPoint(p, n, t, 0, { x: 0, y: 40 }, 1)).toEqual({ x: 100, y: 40 });
    expect(ribbonPoint(p, n, 30, 1.5, { x: 0, y: 0 }, 1)).toEqual({ x: 100, y: 45 });
  });
});
