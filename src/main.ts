import { capture, type Capture, type CaptureParams } from './capture';
import { add, dist, distToSegment, dot, fromAngle, perp, scale, sub, type Circle, type Vec } from './geometry';
import { enclosingCircle, hasTransparency, isEmpty, maskFromImageData, padMask, type Mask } from './mask';
import {
  makeCorner,
  moveAnchor,
  moveHandle,
  nearestOnPath,
  pathLength,
  pullHandles,
  removeAnchor,
  splitSegment,
  straightPath,
  toLocal,
  toWorld,
  type Frame,
  type Path,
} from './path';
import { frameOf, RibbonRenderer } from './ribbon';
import { makeSample } from './sample';

const MAX_SIDE = 2400;
const HIT = 9; // px, screen space

type Tool = 'move' | 'pen' | 'pick';

interface Doc {
  src: HTMLCanvasElement;
  srcMask: Mask | null;
  /** Transparent margin around the photo, so the ribbon has room to run. */
  pad: number;
  w: number;
  h: number;
  image: HTMLCanvasElement;
  imageData: ImageData;
  mask: Mask | null;
  subject: HTMLCanvasElement | null;
  circle: Circle | null;
}

const state = {
  doc: null as Doc | null,
  params: { angle: 0, offset: 0, trimStart: 0, trimEnd: 1, inset: 2, smooth: 0 } as CaptureParams,
  path: straightPath(200) as Path,
  tool: 'move' as Tool,
  selected: null as number | null,
  bg: 'image' as 'image' | 'transparent' | 'color',
  bgColor: '#f4f1ea',
  subjectTop: true,
  clipSubject: true,
  padPct: 0,
  view: { scale: 1, ox: 0, oy: 0 },
  capture: null as Capture | null,
  captureDirty: true,
  busy: false,
};

// ---------------------------------------------------------------------------------------------
// DOM

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const stage = $<HTMLElement>('#stage');
const view = $<HTMLCanvasElement>('#view');
const vctx = view.getContext('2d')!;
const hint = $<HTMLElement>('#hint');
const composite = document.createElement('canvas');
const cctx = composite.getContext('2d')!;
let ribbon: RibbonRenderer | null = null;

const inputs = {
  angle: $<HTMLInputElement>('#angle'),
  offset: $<HTMLInputElement>('#offset'),
  trimStart: $<HTMLInputElement>('#trim-start'),
  trimEnd: $<HTMLInputElement>('#trim-end'),
  inset: $<HTMLInputElement>('#inset'),
  smooth: $<HTMLInputElement>('#smooth'),
  pad: $<HTMLInputElement>('#pad'),
  bg: $<HTMLSelectElement>('#bg'),
  bgColor: $<HTMLInputElement>('#bg-color'),
  subjectTop: $<HTMLInputElement>('#subject-top'),
  clipSubject: $<HTMLInputElement>('#clip-subject'),
};

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Document

function buildDoc(src: HTMLCanvasElement, srcMask: Mask | null, padPct: number): Doc {
  const pad = Math.round((Math.max(src.width, src.height) * padPct) / 200);
  const w = src.width + pad * 2;
  const h = src.height + pad * 2;
  const image = canvasOf(w, h);
  const ictx = image.getContext('2d', { willReadFrequently: true })!;
  ictx.drawImage(src, pad, pad);
  const imageData = ictx.getImageData(0, 0, w, h);

  let mask: Mask | null = null;
  let subject: HTMLCanvasElement | null = null;
  let circle: Circle | null = null;
  if (srcMask && !isEmpty(srcMask)) {
    mask = padMask(srcMask, pad);
    circle = enclosingCircle(mask);
    subject = canvasOf(w, h);
    const sd = new ImageData(new Uint8ClampedArray(imageData.data), w, h);
    for (let i = 0; i < w * h; i++) sd.data[i * 4 + 3] = Math.min(sd.data[i * 4 + 3], mask.data[i]);
    subject.getContext('2d')!.putImageData(sd, 0, 0);
  }
  return { src, srcMask, pad, w, h, image, imageData, mask, subject, circle };
}

function setDoc(src: HTMLCanvasElement, srcMask: Mask | null, opts: { resetView: boolean; resetPath: boolean }) {
  const prev = state.doc;
  state.doc = buildDoc(src, srcMask, state.padPct);
  composite.width = state.doc.w;
  composite.height = state.doc.h;
  if (opts.resetPath && state.doc.circle) {
    const r = state.doc.circle.r;
    state.params = { ...state.params, offset: 0, trimStart: 0, trimEnd: 1 };
    state.path = straightPath(Math.round(r * 0.9));
    state.selected = null;
  }
  state.captureDirty = true;
  if (opts.resetView || !prev) fitView();
  else if (prev.pad !== state.doc.pad) {
    // Keep the photo still on screen when the margin changes.
    const d = state.doc.pad - prev.pad;
    state.view.ox -= d * state.view.scale;
    state.view.oy -= d * state.view.scale;
  }
  syncPanel();
  render();
}

async function loadBlob(blob: Blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const src = canvasOf(Math.round(bmp.width * k), Math.round(bmp.height * k));
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(bmp, 0, 0, src.width, src.height);
  const data = sctx.getImageData(0, 0, src.width, src.height);
  // A cut-out (e.g. "Copy Subject" from Apple Photos) already is the subject: use its alpha.
  const cutout = hasTransparency(data);
  state.padPct = cutout ? 100 : 0;
  inputs.pad.value = String(state.padPct);
  if (cutout && state.bg === 'image') state.bg = 'transparent';
  setDoc(src, cutout ? maskFromImageData(data) : null, { resetView: true, resetPath: true });
  setTool(cutout ? 'move' : 'pick');
}

async function loadMaskBlob(blob: Blob) {
  const doc = state.doc;
  if (!doc) return;
  const bmp = await createImageBitmap(blob);
  const c = canvasOf(doc.src.width, doc.src.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const mask = maskFromImageData(ctx.getImageData(0, 0, c.width, c.height));
  if (isEmpty(mask)) return flash('這張遮罩裡沒有主體（全黑或全透明）。');
  setDoc(doc.src, mask, { resetView: false, resetPath: true });
  setTool('move');
}

async function pickSubject(world: Vec) {
  const doc = state.doc;
  if (!doc || state.busy) return;
  const x = world.x - doc.pad;
  const y = world.y - doc.pad;
  if (x < 0 || y < 0 || x >= doc.src.width || y >= doc.src.height) return;
  state.busy = true;
  flash('辨識主體中…（第一次會下載約 6 MB 的模型）', 0);
  try {
    const { segmentAt } = await import('./segment');
    const mask = await segmentAt(doc.src, x, y);
    if (isEmpty(mask)) {
      flash('這個位置沒有辨識到主體，換個地方點點看。');
    } else {
      setDoc(doc.src, mask, { resetView: false, resetPath: true });
      setTool('move');
      flash('抓到主體了。拖曳圓上的 ↻（或虛線圓本身）選擇方向。');
    }
  } catch (err) {
    console.error(err);
    // Script/wasm load failures surface as a bare Event rather than an Error.
    const why = err instanceof Error ? err.message : '模型下載失敗，請確認網路';
    flash('主體辨識失敗：' + why + '。也可以改用「匯入遮罩」。', 8000);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering

function ensureCapture(): Capture | null {
  const doc = state.doc;
  if (!doc?.mask || !doc.circle) return (state.capture = null);
  if (state.captureDirty) {
    state.capture = capture(doc.imageData, doc.mask, doc.circle, state.params);
    state.captureDirty = false;
  }
  return state.capture;
}

function renderComposite() {
  const doc = state.doc!;
  const cap = ensureCapture();
  cctx.clearRect(0, 0, doc.w, doc.h);
  if (state.bg === 'image') cctx.drawImage(doc.image, 0, 0);
  else if (state.bg === 'color') {
    cctx.fillStyle = state.bgColor;
    cctx.fillRect(0, 0, doc.w, doc.h);
  }
  if (cap) {
    ribbon ??= new RibbonRenderer();
    cctx.drawImage(ribbon.render(doc.w, doc.h, cap, state.path), 0, 0);
  }
  if (cap && doc.subject && state.subjectTop) {
    cctx.save();
    if (state.clipSubject && state.params.offset > 0) {
      // Keep only the part of the subject behind the capture line.
      const far = (doc.w + doc.h) * 2;
      const a = add(cap.base, scale(cap.normal, far));
      const b = add(cap.base, scale(cap.normal, -far));
      cctx.beginPath();
      cctx.moveTo(a.x, a.y);
      cctx.lineTo(b.x, b.y);
      cctx.lineTo(b.x - cap.dir.x * far, b.y - cap.dir.y * far);
      cctx.lineTo(a.x - cap.dir.x * far, a.y - cap.dir.y * far);
      cctx.closePath();
      cctx.clip();
    }
    cctx.drawImage(doc.subject, 0, 0);
    cctx.restore();
  }
}

let checker: CanvasPattern | null = null;
function checkerPattern(): CanvasPattern {
  if (checker) return checker;
  const c = canvasOf(16, 16);
  const x = c.getContext('2d')!;
  x.fillStyle = '#4a4a4d';
  x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#3c3c3f';
  x.fillRect(0, 0, 8, 8);
  x.fillRect(8, 8, 8, 8);
  return (checker = vctx.createPattern(c, 'repeat')!);
}

const toScreen = (p: Vec): Vec => ({ x: p.x * state.view.scale + state.view.ox, y: p.y * state.view.scale + state.view.oy });
const toDoc = (p: Vec): Vec => ({ x: (p.x - state.view.ox) / state.view.scale, y: (p.y - state.view.oy) / state.view.scale });

let frameRequested = false;
function render() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    draw();
  });
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  if (view.width !== Math.round(cw * dpr) || view.height !== Math.round(ch * dpr)) {
    view.width = Math.round(cw * dpr);
    view.height = Math.round(ch * dpr);
  }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.clearRect(0, 0, cw, ch);
  const doc = state.doc;
  $<HTMLElement>('#empty').classList.toggle('hidden', !!doc);
  if (!doc) return;

  renderComposite();
  const { scale: s, ox, oy } = state.view;
  vctx.save();
  vctx.translate(ox, oy);
  vctx.scale(s, s);
  vctx.fillStyle = checkerPattern();
  vctx.fillRect(0, 0, doc.w, doc.h);
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(composite, 0, 0);
  vctx.restore();
  vctx.strokeStyle = 'rgba(255,255,255,0.15)';
  vctx.lineWidth = 1;
  vctx.strokeRect(ox - 0.5, oy - 0.5, doc.w * s + 1, doc.h * s + 1);

  drawOverlay();
  updateReadouts();
}

const ACCENT = '#ff5a1f';

function strokeOutlined(width: number, color: string, dash: number[] = []) {
  vctx.setLineDash(dash);
  vctx.lineWidth = width + 2;
  vctx.strokeStyle = 'rgba(0,0,0,0.45)';
  vctx.stroke();
  vctx.lineWidth = width;
  vctx.strokeStyle = color;
  vctx.stroke();
  vctx.setLineDash([]);
}

/** Rotation knob: sits on the circle a quarter turn away, clear of the line and the path. */
function dirHandle(circle: Circle, dir: Vec): Vec {
  return sub(circle.c, scale(perp(dir), circle.r));
}

function drawOverlay() {
  const doc = state.doc!;
  const cap = state.capture;
  if (!doc.circle || !cap) return;
  const circle = doc.circle;
  const frame = frameOf(cap);

  // Smallest enclosing circle.
  const c = toScreen(circle.c);
  vctx.beginPath();
  vctx.arc(c.x, c.y, circle.r * state.view.scale, 0, Math.PI * 2);
  strokeOutlined(1, 'rgba(255,255,255,0.85)', [5, 5]);

  // Viewing direction (centre → tangent point) and the rotation knob on the ring.
  const rim = toScreen(add(circle.c, scale(cap.dir, circle.r)));
  vctx.beginPath();
  vctx.moveTo(c.x, c.y);
  vctx.lineTo(rim.x, rim.y);
  strokeOutlined(1, 'rgba(255,255,255,0.6)', [2, 4]);
  const knob = toScreen(dirHandle(circle, cap.dir));
  vctx.beginPath();
  vctx.arc(knob.x, knob.y, 10, 0, Math.PI * 2);
  vctx.fillStyle = '#fff';
  vctx.fill();
  strokeOutlined(1.5, ACCENT);
  vctx.fillStyle = ACCENT;
  vctx.font = '600 13px system-ui, sans-serif';
  vctx.textAlign = 'center';
  vctx.textBaseline = 'middle';
  vctx.fillText('↻', knob.x, knob.y + 1);

  // Full-length capture line (dashed) and the kept part (solid).
  const lineAt = (t: number) => toScreen(add(cap.base, scale(cap.normal, t)));
  const l0 = lineAt(-cap.half);
  const l1 = lineAt(cap.half);
  vctx.beginPath();
  vctx.moveTo(l0.x, l0.y);
  vctx.lineTo(l1.x, l1.y);
  strokeOutlined(1, 'rgba(255,255,255,0.7)', [3, 4]);
  const k0 = lineAt(cap.t0);
  const k1 = lineAt(cap.t1);
  vctx.beginPath();
  vctx.moveTo(k0.x, k0.y);
  vctx.lineTo(k1.x, k1.y);
  strokeOutlined(2.5, ACCENT);

  // The silhouette pixels that are being captured.
  vctx.beginPath();
  let prev: Vec | null = null;
  for (const col of cap.columns) {
    if (!col.edge) {
      prev = null;
      continue;
    }
    const p = toScreen(col.edge);
    if (prev && dist(prev, p) < 6) vctx.lineTo(p.x, p.y);
    else vctx.moveTo(p.x, p.y);
    prev = p;
  }
  strokeOutlined(1.5, '#5ef0ff');

  for (const p of [k0, k1]) {
    vctx.beginPath();
    vctx.rect(p.x - 5, p.y - 5, 10, 10);
    vctx.fillStyle = '#fff';
    vctx.fill();
    strokeOutlined(1.5, ACCENT);
  }

  // Pen path.
  const path = state.path;
  const W = (v: Vec) => toScreen(toWorld(frame, v));
  vctx.beginPath();
  const p0 = W(path[0].p);
  vctx.moveTo(p0.x, p0.y);
  for (let i = 0; i < path.length - 1; i++) {
    const a = W(path[i].hout);
    const b = W(path[i + 1].hin);
    const e = W(path[i + 1].p);
    vctx.bezierCurveTo(a.x, a.y, b.x, b.y, e.x, e.y);
  }
  strokeOutlined(1.5, '#fff');

  path.forEach((an, i) => {
    const p = W(an.p);
    for (const which of ['hin', 'hout'] as const) {
      if (i === 0 && which === 'hin') continue;
      if (dist(an[which], an.p) < 0.5) continue;
      const h = W(an[which]);
      vctx.beginPath();
      vctx.moveTo(p.x, p.y);
      vctx.lineTo(h.x, h.y);
      strokeOutlined(1, 'rgba(255,255,255,0.8)');
      vctx.beginPath();
      vctx.arc(h.x, h.y, 4, 0, Math.PI * 2);
      vctx.fillStyle = '#fff';
      vctx.fill();
      strokeOutlined(1, ACCENT);
    }
    vctx.beginPath();
    if (i === 0) {
      vctx.moveTo(p.x, p.y - 6);
      vctx.lineTo(p.x + 6, p.y);
      vctx.lineTo(p.x, p.y + 6);
      vctx.lineTo(p.x - 6, p.y);
      vctx.closePath();
    } else {
      vctx.rect(p.x - 4.5, p.y - 4.5, 9, 9);
    }
    vctx.fillStyle = state.selected === i ? ACCENT : '#fff';
    vctx.fill();
    strokeOutlined(1.5, state.selected === i ? '#fff' : ACCENT);
  });
}

// ---------------------------------------------------------------------------------------------
// View

function fitView() {
  const doc = state.doc;
  if (!doc) return;
  const margin = 56;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  const s = Math.min((cw - margin * 2) / doc.w, (ch - margin * 2) / doc.h, 4);
  state.view = { scale: s, ox: (cw - doc.w * s) / 2, oy: (ch - doc.h * s) / 2 };
  render();
}

function zoomAt(screen: Vec, factor: number) {
  const before = toDoc(screen);
  state.view.scale = Math.max(0.05, Math.min(16, state.view.scale * factor));
  state.view.ox = screen.x - before.x * state.view.scale;
  state.view.oy = screen.y - before.y * state.view.scale;
  render();
}

// ---------------------------------------------------------------------------------------------
// Interaction

type Hit =
  | { kind: 'handle'; i: number; which: 'hin' | 'hout' }
  | { kind: 'anchor'; i: number }
  | { kind: 'trim'; which: 'trimStart' | 'trimEnd' }
  | { kind: 'dir' }
  | { kind: 'ring' }
  | { kind: 'offset' }
  | { kind: 'segment'; seg: number; t: number }
  | { kind: 'none' };

function hitTest(screen: Vec): Hit {
  const doc = state.doc;
  const cap = state.capture;
  if (!doc?.circle || !cap) return { kind: 'none' };
  const frame = frameOf(cap);
  const S = (v: Vec) => toScreen(toWorld(frame, v));
  const path = state.path;

  for (let i = path.length - 1; i >= 0; i--) {
    for (const which of ['hout', 'hin'] as const) {
      if (i === 0 && which === 'hin') continue;
      if (dist(path[i][which], path[i].p) < 0.5) continue;
      if (dist(S(path[i][which]), screen) < HIT) return { kind: 'handle', i, which };
    }
  }
  for (let i = path.length - 1; i >= 1; i--) {
    if (dist(S(path[i].p), screen) < HIT) return { kind: 'anchor', i };
  }
  const lineAt = (t: number) => toScreen(add(cap.base, scale(cap.normal, t)));
  const p = cap.t0 <= cap.t1 ? (['trimStart', 'trimEnd'] as const) : (['trimEnd', 'trimStart'] as const);
  if (dist(lineAt(cap.t1), screen) < HIT) return { kind: 'trim', which: p[1] };
  if (dist(lineAt(cap.t0), screen) < HIT) return { kind: 'trim', which: p[0] };
  if (dist(toScreen(dirHandle(doc.circle, cap.dir)), screen) < HIT + 4) return { kind: 'dir' };
  if (distToSegment(screen, lineAt(cap.t0), lineAt(cap.t1)).d < HIT - 3) return { kind: 'offset' };

  const local = toLocal(frame, toDoc(screen));
  const near = nearestOnPath(path, local);
  if (near.seg >= 0 && near.d * state.view.scale < HIT - 3) return { kind: 'segment', seg: near.seg, t: near.t };
  // Grabbing the dashed circle anywhere also rotates.
  if (Math.abs(dist(toScreen(doc.circle.c), screen) - doc.circle.r * state.view.scale) < 5) return { kind: 'ring' };
  return { kind: 'none' };
}

type Drag =
  | { kind: 'handle'; i: number; which: 'hin' | 'hout' }
  | { kind: 'anchor'; i: number; grab: Vec }
  | { kind: 'pull'; i: number; start: Vec }
  | { kind: 'trim'; which: 'trimStart' | 'trimEnd' }
  | { kind: 'dir'; from: number; angle: number }
  | { kind: 'offset'; grab: number }
  | { kind: 'pan'; start: Vec; ox: number; oy: number };

let drag: Drag | null = null;
let spaceDown = false;

const currentFrame = (): Frame | null => (state.capture ? frameOf(state.capture) : null);

function pointerPos(e: PointerEvent | WheelEvent): Vec {
  const r = view.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

view.addEventListener('pointerdown', (e) => {
  const doc = state.doc;
  if (!doc) return;
  const screen = pointerPos(e);
  const world = toDoc(screen);
  view.setPointerCapture(e.pointerId);

  if (e.button === 1 || spaceDown) {
    drag = { kind: 'pan', start: screen, ox: state.view.ox, oy: state.view.oy };
    return;
  }
  if (state.tool === 'pick') {
    void pickSubject(world);
    return;
  }

  const frame = currentFrame();
  const hit = hitTest(screen);
  switch (hit.kind) {
    case 'handle':
      state.selected = hit.i;
      drag = { kind: 'handle', i: hit.i, which: hit.which };
      break;
    case 'anchor':
      state.selected = hit.i;
      if (e.altKey) {
        const an = state.path[hit.i];
        if (dist(an.hin, an.p) > 0.5 || dist(an.hout, an.p) > 0.5) state.path = makeCorner(state.path, hit.i);
        else drag = { kind: 'pull', i: hit.i, start: screen };
      } else {
        const local = toLocal(frame!, world);
        drag = { kind: 'anchor', i: hit.i, grab: sub(state.path[hit.i].p, local) };
      }
      break;
    case 'trim':
      drag = { kind: 'trim', which: hit.which };
      break;
    case 'ring':
    case 'dir': {
      const v = sub(world, doc.circle!.c);
      drag = { kind: 'dir', from: Math.atan2(v.y, v.x), angle: state.params.angle };
      break;
    }
    case 'offset': {
      const cap = state.capture!;
      drag = { kind: 'offset', grab: dot(sub(world, cap.base), cap.dir) };
      break;
    }
    case 'segment':
      if (state.tool === 'pen') {
        state.path = splitSegment(state.path, hit.seg, hit.t);
        state.selected = hit.seg + 1;
        drag = { kind: 'anchor', i: hit.seg + 1, grab: { x: 0, y: 0 } };
      } else {
        state.selected = null;
        drag = { kind: 'pan', start: screen, ox: state.view.ox, oy: state.view.oy };
      }
      break;
    case 'none':
      if (state.tool === 'pen' && frame) {
        const local = toLocal(frame, world);
        state.path = [...state.path, { p: local, hin: local, hout: local, smooth: false }];
        state.selected = state.path.length - 1;
        drag = { kind: 'pull', i: state.selected, start: screen };
      } else {
        state.selected = null;
        drag = { kind: 'pan', start: screen, ox: state.view.ox, oy: state.view.oy };
      }
      break;
  }
  render();
});

view.addEventListener('pointermove', (e) => {
  const screen = pointerPos(e);
  if (!drag) {
    updateCursor(screen);
    return;
  }
  const doc = state.doc!;
  const world = toDoc(screen);
  const frame = currentFrame();
  switch (drag.kind) {
    case 'pan':
      state.view.ox = drag.ox + screen.x - drag.start.x;
      state.view.oy = drag.oy + screen.y - drag.start.y;
      break;
    case 'handle': {
      let local = toLocal(frame!, world);
      // The ribbon leaves the capture line square-on, so the first handle only slides outward.
      if (drag.i === 0) local = { x: Math.max(0, local.x), y: 0 };
      state.path = moveHandle(state.path, drag.i, drag.which, local, e.altKey);
      break;
    }
    case 'anchor':
      state.path = moveAnchor(state.path, drag.i, add(toLocal(frame!, world), drag.grab));
      break;
    case 'pull':
      if (dist(screen, drag.start) > 3) state.path = pullHandles(state.path, drag.i, toLocal(frame!, world));
      break;
    case 'trim': {
      const cap = state.capture!;
      const t = dot(sub(world, cap.base), cap.normal);
      state.params = { ...state.params, [drag.which]: clamp((t + cap.half) / (2 * cap.half), 0, 1) };
      state.captureDirty = true;
      break;
    }
    case 'dir': {
      const v = sub(world, doc.circle!.c);
      state.params = { ...state.params, angle: drag.angle + Math.atan2(v.y, v.x) - drag.from };
      state.captureDirty = true;
      break;
    }
    case 'offset': {
      const r = doc.circle!.r;
      const along = dot(sub(world, doc.circle!.c), fromAngle(state.params.angle));
      state.params = { ...state.params, offset: clamp(r - (along - drag.grab), 0, 2 * r) };
      state.captureDirty = true;
      break;
    }
  }
  render();
});

const endDrag = () => {
  drag = null;
  syncPanel();
};
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

view.addEventListener(
  'wheel',
  (e) => {
    if (!state.doc) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(pointerPos(e), Math.exp(-e.deltaY * 0.01));
    else {
      state.view.ox -= e.deltaX;
      state.view.oy -= e.deltaY;
      render();
    }
  },
  { passive: false },
);

function updateCursor(screen: Vec) {
  if (spaceDown) return void (view.style.cursor = 'grab');
  if (state.tool === 'pick') return void (view.style.cursor = 'crosshair');
  const hit = hitTest(screen);
  const cursors: Record<Hit['kind'], string> = {
    handle: 'pointer',
    anchor: 'move',
    trim: 'ew-resize',
    dir: 'grab',
    ring: 'grab',
    offset: 'move',
    segment: state.tool === 'pen' ? 'copy' : 'default',
    none: state.tool === 'pen' ? 'crosshair' : 'default',
  };
  view.style.cursor = cursors[hit.kind];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------------------------
// Panel

const HINTS: Record<Tool, string> = {
  move: '移動：拖曳把手、擷取線與錨點；拖曳空白處平移畫面。',
  pen: '鋼筆：點空白處新增錨點，按住拖曳拉出曲線；點在路徑上插入錨點。',
  pick: '點選主體：在照片中點一下想抓的主體。',
};

let flashTimer = 0;
function flash(msg: string, ms = 4000) {
  hint.textContent = msg;
  clearTimeout(flashTimer);
  if (ms > 0) flashTimer = window.setTimeout(() => (hint.textContent = HINTS[state.tool]), ms);
}

function setTool(tool: Tool) {
  state.tool = tool;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  hint.textContent = HINTS[tool];
  render();
}

function syncPanel() {
  const doc = state.doc;
  const r = doc?.circle?.r ?? 1;
  const deg = angleDeg();
  inputs.angle.value = String(deg);
  inputs.offset.value = String((state.params.offset / (2 * r)) * 100);
  inputs.trimStart.value = String(state.params.trimStart * 100);
  inputs.trimEnd.value = String(state.params.trimEnd * 100);
  inputs.inset.value = String(state.params.inset);
  inputs.smooth.value = String(state.params.smooth);
  inputs.bg.value = state.bg;
  inputs.pad.value = String(state.padPct);
  $<HTMLElement>('#bg-color-field').style.display = state.bg === 'color' ? '' : 'none';
  document.querySelectorAll<HTMLElement>('[data-needs="subject"]').forEach((el) => el.classList.toggle('disabled', !doc?.mask));
  $<HTMLElement>('#mask-status').textContent = !doc
    ? '先載入一張照片。'
    : doc.mask
      ? '已抓到主體。'
      : '還沒有主體：點選主體，或匯入遮罩。';
  updateReadouts();
}

const angleDeg = () => (((Math.round((state.params.angle * 1800) / Math.PI) / 10) % 360) + 360) % 360;

function updateReadouts() {
  const deg = angleDeg();
  $<HTMLOutputElement>('#angle-out').textContent = `${deg.toFixed(1)}°`;
  $<HTMLOutputElement>('#offset-out').textContent = `${Math.round(state.params.offset)} px`;
  $<HTMLOutputElement>('#trim-start-out').textContent = `${Math.round(state.params.trimStart * 100)}%`;
  $<HTMLOutputElement>('#trim-end-out').textContent = `${Math.round(state.params.trimEnd * 100)}%`;
  $<HTMLOutputElement>('#inset-out').textContent = `${state.params.inset} px`;
  $<HTMLOutputElement>('#smooth-out').textContent = `${state.params.smooth} px`;
  $<HTMLOutputElement>('#pad-out').textContent = `${state.padPct}%`;
  $<HTMLElement>('#length-out').textContent = String(Math.round(pathLength(state.path)));
}

function bindRange(el: HTMLInputElement, apply: (v: number) => void) {
  el.addEventListener('input', () => {
    apply(Number(el.value));
    render();
  });
}

bindRange(inputs.angle, (v) => {
  state.params = { ...state.params, angle: (v * Math.PI) / 180 };
  state.captureDirty = true;
});
bindRange(inputs.offset, (v) => {
  const r = state.doc?.circle?.r ?? 0;
  state.params = { ...state.params, offset: (v / 100) * 2 * r };
  state.captureDirty = true;
});
bindRange(inputs.trimStart, (v) => {
  state.params = { ...state.params, trimStart: v / 100 };
  state.captureDirty = true;
});
bindRange(inputs.trimEnd, (v) => {
  state.params = { ...state.params, trimEnd: v / 100 };
  state.captureDirty = true;
});
bindRange(inputs.inset, (v) => {
  state.params = { ...state.params, inset: v };
  state.captureDirty = true;
});
bindRange(inputs.smooth, (v) => {
  state.params = { ...state.params, smooth: v };
  state.captureDirty = true;
});
inputs.pad.addEventListener('change', () => {
  state.padPct = Number(inputs.pad.value);
  if (state.doc) setDoc(state.doc.src, state.doc.srcMask, { resetView: false, resetPath: false });
});
inputs.pad.addEventListener('input', () => updateReadouts());
inputs.bg.addEventListener('change', () => {
  state.bg = inputs.bg.value as typeof state.bg;
  syncPanel();
  render();
});
inputs.bgColor.addEventListener('input', () => {
  state.bgColor = inputs.bgColor.value;
  render();
});
inputs.subjectTop.addEventListener('change', () => {
  state.subjectTop = inputs.subjectTop.checked;
  render();
});
inputs.clipSubject.addEventListener('change', () => {
  state.clipSubject = inputs.clipSubject.checked;
  render();
});

document.querySelectorAll<HTMLInputElement>('input[data-role="open"]').forEach((input) =>
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void loadBlob(f);
    input.value = '';
  }),
);
$<HTMLInputElement>('#mask-file').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) void loadMaskBlob(f);
  input.value = '';
});
$<HTMLButtonElement>('#sample').addEventListener('click', () => {
  const { image, mask } = makeSample();
  state.padPct = 0;
  setDoc(image, mask, { resetView: true, resetPath: true });
  state.params = { ...state.params, angle: -0.35 };
  state.captureDirty = true;
  setTool('move');
  syncPanel();
});
$<HTMLButtonElement>('#pick').addEventListener('click', () => setTool('pick'));
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool)),
);
$<HTMLButtonElement>('#fit').addEventListener('click', fitView);
$<HTMLButtonElement>('#reset-path').addEventListener('click', () => {
  state.path = straightPath(Math.round((state.doc?.circle?.r ?? 200) * 0.9));
  state.selected = null;
  render();
});
$<HTMLButtonElement>('#delete-anchor').addEventListener('click', deleteSelected);
$<HTMLButtonElement>('#export').addEventListener('click', () => {
  if (!state.doc) return;
  renderComposite();
  composite.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pixel-stretch.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
});

function deleteSelected() {
  const i = state.selected;
  if (i === null || i === 0 || state.path.length <= 2) return;
  state.path = removeAnchor(state.path, i);
  state.selected = null;
  render();
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox') return;
  if (e.key === ' ') {
    spaceDown = true;
    view.style.cursor = 'grab';
    if (t === document.body) e.preventDefault();
  } else if (e.metaKey || e.ctrlKey) {
    return;
  } else if (e.key === 'v' || e.key === 'V') setTool('move');
  else if (e.key === 'p' || e.key === 'P') setTool('pen');
  else if (e.key === 's' || e.key === 'S') setTool('pick');
  else if (e.key === '0') fitView();
  else if (e.key === 'Escape') {
    state.selected = null;
    render();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (t instanceof HTMLInputElement) return;
    deleteSelected();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') spaceDown = false;
});

window.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) {
    e.preventDefault();
    void loadBlob(file);
  }
});
stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragover');
});
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) void loadBlob(file);
});

new ResizeObserver(() => render()).observe(stage);

// Debug/automation hook (also handy from the console).
Object.assign(window, { __pixelStretch: { state, render, syncPanel } });

setTool('move');
syncPanel();
render();
