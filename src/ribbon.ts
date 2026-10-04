import type { Capture } from './capture';
import { perp, type Vec } from './geometry';
import { dirToWorld, flatten, toWorld, type Frame, type Path } from './path';

/**
 * How the strip follows a bent path.
 * - `bend`: the cross-section stays perpendicular to the path. Every pixel takes its colour from
 *   the nearest point on the path, so the inside of a tight turn never folds over itself.
 * - `translate`: the cross-section keeps the capture line's orientation and only slides along the
 *   path, like a broad calligraphy nib.
 */
export type BendMode = 'bend' | 'translate';

export interface RibbonOptions {
  mode: BendMode;
  /** Fraction (0..1) of the ribbon's length over which it fades out at the tail. */
  fade: number;
  /**
   * -1..1. Positive: the strip narrows toward the tail and gathers at the convergence point
   * (1 = all columns meet in one point). Negative: it fans out instead.
   */
  converge: number;
  /** Where the strip gathers, relative to the path's end point, in the capture-line frame. */
  focus: Vec;
}

/**
 * Where a column ends up at arc fraction s: the spine point, the column's offset scaled by the
 * convergence, and a growing shift toward the convergence point.
 */
export function ribbonPoint(p: Vec, nrm: Vec, t: number, s: number, converge: number, focusWorld: Vec): Vec {
  const k = converge * s;
  const w = 1 - k;
  const shift = Math.max(0, k);
  return { x: p.x + nrm.x * t * w + focusWorld.x * shift, y: p.y + nrm.y * t * w + focusWorld.y * shift };
}

const VERT = `#version 300 es
in vec2 aPos;
in float aU;
in float aDepth;
in float aS;
in vec4 aColor;
uniform vec2 uRes;
out float vU;
out float vS;
out vec4 vColor;
void main() {
  vU = aU;
  vS = aS;
  vColor = aColor;
  vec2 c = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, aDepth * 2.0 - 1.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in float vU;
in float vS;
in vec4 vColor;
uniform sampler2D uTex;
uniform bool uUseTex;
uniform float uFade;
out vec4 outColor;
void main() {
  vec4 c = uUseTex ? texture(uTex, vec2(vU, 0.5)) : vColor;
  float k = uFade > 0.0 ? 1.0 - smoothstep(1.0 - uFade, 1.0, vS) : 1.0;
  outColor = c * k;
}`;

const STRIDE = 9; // x, y, u, depth, s, r, g, b, a

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

export const frameOf = (cap: Capture): Frame => ({ origin: cap.origin, dir: cap.dir, normal: cap.normal });

/** Collects vertices in the interleaved layout. */
class Verts {
  data: number[] = [];
  get count() {
    return this.data.length / STRIDE;
  }
  push(p: Vec, u: number, depth: number, s: number, rgba: ArrayLike<number> = [0, 0, 0, 0]) {
    this.data.push(p.x, p.y, u, depth, s, rgba[0], rgba[1], rgba[2], rgba[3]);
  }
  /** A flat-coloured quad from `a` to `b`, `hw` wide on each side, as two triangles. */
  bar(a: Vec, b: Vec, n: Vec, hw: number, rgba: ArrayLike<number>) {
    const q = [
      { x: a.x - n.x * hw, y: a.y - n.y * hw },
      { x: a.x + n.x * hw, y: a.y + n.y * hw },
      { x: b.x + n.x * hw, y: b.y + n.y * hw },
      { x: b.x - n.x * hw, y: b.y - n.y * hw },
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) this.push(q[k], 0, 0, 0, rgba);
  }
}

/** Depth cone around `c` with radius r: depth = distance / reach. */
function cone(v: Verts, c: Vec, r: number, reach: number) {
  const n = 64;
  // A hair deeper than the ribbon so the ribbon wins exact ties along its own edge.
  const bias = 0.002;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    v.push(c, 0, bias, 0);
    const d = Math.min(1, r / reach + bias);
    v.push({ x: c.x + Math.cos(a0) * r, y: c.y + Math.sin(a0) * r }, 0, d, 0);
    v.push({ x: c.x + Math.cos(a1) * r, y: c.y + Math.sin(a1) * r }, 0, d, 0);
  }
}

/** Straight RGBA bytes → premultiplied floats. */
function premul(src: Uint8ClampedArray, i: number): number[] {
  const a = src[i + 3] / 255;
  return [(src[i] / 255) * a, (src[i + 1] / 255) * a, (src[i + 2] / 255) * a, a];
}

/**
 * Draws the stretched pixels: the captured colour strip is used as a 1-pixel-tall texture and
 * swept along the pen path, so every column keeps its colour all the way.
 */
export class RibbonRenderer {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private buf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;

  constructor() {
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('這個瀏覽器不支援 WebGL2');
    this.gl = gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    this.prog = prog;

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.buf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const attrib = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    };
    attrib('aPos', 2, 0);
    attrib('aU', 1, 2);
    attrib('aDepth', 1, 3);
    attrib('aS', 1, 4);
    attrib('aColor', 4, 5);
  }

  render(w: number, h: number, cap: Capture, path: Path, opts: RibbonOptions): HTMLCanvasElement {
    const { gl } = this;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const n = cap.columns.length;
    // Premultiply ourselves: empty columns must not bleed black into their neighbours.
    const texels = new Uint8Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      const a = cap.colors[i + 3] / 255;
      texels[i] = cap.colors[i] * a;
      texels[i + 1] = cap.colors[i + 1] * a;
      texels[i + 2] = cap.colors[i + 2] * a;
      texels[i + 3] = cap.colors[i + 3];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels);

    const flat = new Verts();
    const colW = (cap.t1 - cap.t0) / n;
    const hw = colW / 2 + 0.35;

    // 1) Streaks between each edge pixel and the capture line.
    for (let i = 0; i < n; i++) {
      const col = cap.columns[i];
      if (col.edge && cap.colors[i * 4 + 3] > 0) flat.bar(col.edge, col.line, cap.normal, hw, premul(cap.colors, i * 4));
    }
    // 2) Gaps hidden behind the silhouette.
    cap.holes.forEach((hole, j) => flat.bar(hole.to, hole.from, cap.normal, hw, premul(cap.holeColors, j * 4)));

    // 3) The ribbon, swept along the pen path.
    const ribbon = new Verts();
    const caps = new Verts();
    const strips: [number, number][] = [];
    if (path.length >= 2) {
      const frame = frameOf(cap);
      const half = (cap.t1 - cap.t0) / 2;
      const line = flatten(path, 1.5, { x: 1, y: 0 });
      const pts = line.points.map((p) => toWorld(frame, p));
      const nrms = line.tangents.map((t) => (opts.mode === 'bend' ? perp(dirToWorld(frame, t)) : cap.normal));
      const total = Math.max(line.length, 1e-6);
      const along: number[] = [0];
      for (let k = 1; k < pts.length; k++) along.push(along[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
      const focus = dirToWorld(frame, opts.focus);
      const at = (k: number, t: number) => ribbonPoint(pts[k], nrms[k], t, along[k] / total, opts.converge, focus);

      if (opts.mode === 'bend') {
        // Two half-ribbons with depth = distance from the spine; the depth test then keeps, for
        // every pixel, the spine point closest to it. Distance cones at both ends (depth only)
        // complete the distance field, so the inside of a turn cannot reach past the start of the
        // ribbon or wrap around its tail.
        // Depth is the true distance from the spine, scaled so the widest point maps to 1.
        const last = pts.length - 1;
        const widthAt = (s: number) => Math.max(0, 1 - opts.converge * s);
        const reach = half * Math.max(1, widthAt(1));
        cone(caps, at(0, 0), reach, reach);
        cone(caps, at(last, 0), reach, reach);
        for (const side of [-1, 1]) {
          const begin = ribbon.count;
          for (let k = 0; k < pts.length; k++) {
            const s = along[k] / total;
            ribbon.push(at(k, 0), 0.5, 0, s);
            ribbon.push(at(k, side * half), side < 0 ? 0 : 1, (half * widthAt(s)) / reach, s);
          }
          strips.push([begin, ribbon.count - begin]);
        }
      } else {
        const begin = ribbon.count;
        for (let k = 0; k < pts.length; k++) {
          const s = along[k] / total;
          ribbon.push(at(k, -half), 0, 0, s);
          ribbon.push(at(k, half), 1, 0, s);
        }
        strips.push([begin, ribbon.count - begin]);
      }
    }

    gl.useProgram(this.prog);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'uRes'), w, h);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uTex'), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const useTex = gl.getUniformLocation(this.prog, 'uUseTex');
    const fade = gl.getUniformLocation(this.prog, 'uFade');

    gl.disable(gl.DEPTH_TEST);
    gl.uniform1i(useTex, 0);
    gl.uniform1f(fade, 0);
    if (flat.count) {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(flat.data), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, flat.count);
    }

    if (ribbon.count) {
      if (opts.mode === 'bend') {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        if (caps.count) {
          gl.colorMask(false, false, false, false);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(caps.data), gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.TRIANGLES, 0, caps.count);
          gl.colorMask(true, true, true, true);
        }
      }
      gl.uniform1i(useTex, 1);
      gl.uniform1f(fade, Math.max(0, Math.min(1, opts.fade)));
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ribbon.data), gl.DYNAMIC_DRAW);
      for (const [first, count] of strips) if (count >= 4) gl.drawArrays(gl.TRIANGLE_STRIP, first, count);
      gl.disable(gl.DEPTH_TEST);
    }
    return this.canvas;
  }
}
