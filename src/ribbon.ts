import type { Capture } from './capture';
import { perp } from './geometry';
import { dirToWorld, flatten, toWorld, type Frame, type Path } from './path';

const VERT = `#version 300 es
in vec2 aPos;
in float aU;
uniform vec2 uRes;
out float vU;
void main() {
  vU = aU;
  vec2 c = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in float vU;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vec2(vU, 0.5));
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

export const frameOf = (cap: Capture): Frame => ({ origin: cap.origin, dir: cap.dir, normal: cap.normal });

/**
 * Draws the stretched pixels: the captured colour strip is used as a 1-pixel-tall texture and
 * swept along the pen path as a triangle strip, so every column keeps its colour all the way.
 */
export class RibbonRenderer {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private buf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;

  constructor() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
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
    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aU = gl.getAttribLocation(prog, 'aU');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(aU);
    gl.vertexAttribPointer(aU, 1, gl.FLOAT, false, 12, 8);
  }

  render(w: number, h: number, cap: Capture, path: Path): HTMLCanvasElement {
    const { gl } = this;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

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

    const verts: number[] = [];
    const frame = frameOf(cap);
    const half = (cap.t1 - cap.t0) / 2;
    const colW = (cap.t1 - cap.t0) / n;

    // 1) Streaks that fill the gap between each edge pixel and the capture line.
    for (let i = 0; i < n; i++) {
      const col = cap.columns[i];
      if (!col.edge || cap.colors[i * 4 + 3] === 0) continue;
      const u = (i + 0.5) / n;
      const hw = colW / 2 + 0.35;
      const a = { x: col.edge.x + cap.normal.x * -hw, y: col.edge.y + cap.normal.y * -hw };
      const b = { x: col.edge.x + cap.normal.x * hw, y: col.edge.y + cap.normal.y * hw };
      const c = { x: col.line.x + cap.normal.x * hw, y: col.line.y + cap.normal.y * hw };
      const d = { x: col.line.x + cap.normal.x * -hw, y: col.line.y + cap.normal.y * -hw };
      verts.push(a.x, a.y, u, b.x, b.y, u, c.x, c.y, u, a.x, a.y, u, c.x, c.y, u, d.x, d.y, u);
    }
    const streakCount = verts.length / 3;

    // 2) The ribbon itself, swept along the pen path.
    if (path.length >= 2) {
      const line = flatten(path, 1.5, { x: 1, y: 0 });
      for (let k = 0; k < line.points.length; k++) {
        const p = toWorld(frame, line.points[k]);
        const nrm = perp(dirToWorld(frame, line.tangents[k]));
        verts.push(p.x - nrm.x * half, p.y - nrm.y * half, 0, p.x + nrm.x * half, p.y + nrm.y * half, 1);
      }
    }
    const ribbonCount = verts.length / 3 - streakCount;

    gl.useProgram(this.prog);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'uRes'), w, h);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uTex'), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    if (streakCount) gl.drawArrays(gl.TRIANGLES, 0, streakCount);
    if (ribbonCount >= 4) gl.drawArrays(gl.TRIANGLE_STRIP, streakCount, ribbonCount);
    return this.canvas;
  }
}
