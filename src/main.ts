import { capture, type Capture, type CaptureParams, type HoleMode } from './capture';
import { add, dist, distToSegment, dot, fromAngle, perp, scale, sub, type Circle, type Vec } from './geometry';
import { enclosingCircle, hasTransparency, isEmpty, maskFromImageData, padMask, THRESHOLD, type Mask } from './mask';
import { applySelection, brushStroke, magicWand, type MaskOp } from './maskEdit';
import {
  makeCorner,
  moveAnchor,
  nearestFraction,
  pointAtFraction,
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
import { flatProfile, frameOf, progressAt, RibbonRenderer, type BendMode, type WidthProfile } from './ribbon';
import { makeSample } from './sample';

const MAX_SIDE = 2400;
const HIT = 9; // px, screen space

type Tool = 'move' | 'pen' | 'pick' | 'erase' | 'restore';
type ViewMode = 'result' | 'subject' | 'mask';
type Engine = 'ai' | 'wand' | 'brush';

const isMaskTool = (t: Tool) => t === 'pick' || t === 'erase' || t === 'restore';

interface Doc {
  src: HTMLCanvasElement;
  srcData: ImageData;
  /** Transparent margin around the photo, so the ribbon has room to run. */
  pad: number;
  w: number;
  h: number;
  image: HTMLCanvasElement;
  imageData: ImageData;
  /** The subject mask at photo size. Treated as immutable: edits produce a new one. */
  srcMask: Mask | null;
  mask: Mask | null;
  subject: HTMLCanvasElement | null;
  /** Red tint over the background, built on demand for the mask view. */
  tint: HTMLCanvasElement | null;
  circle: Circle | null;
}

const state = {
  doc: null as Doc | null,
  params: { angle: 0, offset: 0, trimStart: 0, trimEnd: 1, inset: 2, smooth: 0, holes: 'empty' } as CaptureParams,
  path: straightPath(200) as Path,
  tool: 'move' as Tool,
  viewMode: 'result' as ViewMode,
  /** The view was switched by a tool, so leaving the tool switches it back. */
  autoView: false,
  engine: 'ai' as Engine,
  tolerance: 40,
  brushSize: 40,
  selected: null as number | null,
  bendMode: 'bend' as BendMode,
  fade: 0,
  width: flatProfile() as WidthProfile,
  /** Tail offset from the path's end, in the capture-line frame. */
  shift: { x: 0, y: 0 } as Vec,
  bg: 'image' as 'image' | 'transparent' | 'color',
  bgColor: '#f4f1ea',
  subjectTop: true,
  clipSubject: true,
  padPct: 0,
  view: { scale: 1, ox: 0, oy: 0 },
  capture: null as Capture | null,
  captureDirty: true,
  /** A brush stroke is in progress; the doc is refreshed once per frame. */
  pendingMask: null as Mask | null,
  pointer: null as Vec | null,
  busy: false,
  /** What the current photo came from; a cut-out is kept to match against a later photo. */
  source: null as null | { kind: 'photo'; scale: number } | { kind: 'cutout'; scale: number; cutout: Loaded },
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
  holes: $<HTMLSelectElement>('#holes'),
  bend: $<HTMLSelectElement>('#bend'),
  fade: $<HTMLInputElement>('#fade'),
  wStart: $<HTMLInputElement>('#w-start'),
  wEnd: $<HTMLInputElement>('#w-end'),
  wFrom: $<HTMLInputElement>('#w-from'),
  wTo: $<HTMLInputElement>('#w-to'),
  wCurve: $<HTMLSelectElement>('#w-curve'),
  engine: $<HTMLSelectElement>('#engine'),
  tol: $<HTMLInputElement>('#tol'),
  brush: $<HTMLInputElement>('#brush'),
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

function buildDoc(src: HTMLCanvasElement, padPct: number): Doc {
  const pad = Math.round((Math.max(src.width, src.height) * padPct) / 200);
  const w = src.width + pad * 2;
  const h = src.height + pad * 2;
  const image = canvasOf(w, h);
  const ictx = image.getContext('2d', { willReadFrequently: true })!;
  ictx.drawImage(src, pad, pad);
  const imageData = ictx.getImageData(0, 0, w, h);
  const srcData = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
  return { src, srcData, pad, w, h, image, imageData, srcMask: null, mask: null, subject: null, tint: null, circle: null };
}

/** Derive everything that depends on the subject mask. */
function applyMask(doc: Doc, srcMask: Mask | null) {
  doc.srcMask = srcMask;
  doc.mask = null;
  doc.subject = null;
  doc.tint = null;
  doc.circle = null;
  if (!srcMask || isEmpty(srcMask)) return;
  const { w, h, pad } = doc;
  const mask = padMask(srcMask, pad);
  doc.mask = mask;
  doc.circle = enclosingCircle(mask);
  const subject = canvasOf(w, h);
  const sd = new ImageData(new Uint8ClampedArray(doc.imageData.data), w, h);
  for (let i = 0; i < w * h; i++) sd.data[i * 4 + 3] = Math.min(sd.data[i * 4 + 3], mask.data[i]);
  subject.getContext('2d')!.putImageData(sd, 0, 0);
  doc.subject = subject;
}

function tintOf(doc: Doc): HTMLCanvasElement {
  if (doc.tint) return doc.tint;
  const { w, h, pad } = doc;
  const c = canvasOf(w, h);
  const id = new ImageData(w, h);
  for (let y = 0; y < doc.src.height; y++) {
    for (let x = 0; x < doc.src.width; x++) {
      const m = doc.srcMask ? doc.srcMask.data[y * doc.src.width + x] : 0;
      const i = ((y + pad) * w + x + pad) * 4;
      id.data[i] = 255;
      id.data[i + 1] = 40;
      id.data[i + 2] = 60;
      id.data[i + 3] = Math.round((255 - m) * 0.55);
    }
  }
  c.getContext('2d')!.putImageData(id, 0, 0);
  return (doc.tint = c);
}

function resetCaptureFor(doc: Doc) {
  if (!doc.circle) return;
  state.params = { ...state.params, offset: 0, trimStart: 0, trimEnd: 1 };
  state.path = straightPath(Math.round(doc.circle.r * 0.9));
  state.shift = { x: 0, y: 0 };
  state.selected = null;
}

function setDoc(src: HTMLCanvasElement, srcMask: Mask | null, opts: { resetView: boolean; resetPath: boolean }) {
  const prev = state.doc;
  const doc = buildDoc(src, state.padPct);
  applyMask(doc, srcMask);
  state.doc = doc;
  composite.width = doc.w;
  composite.height = doc.h;
  if (opts.resetPath) resetCaptureFor(doc);
  state.captureDirty = true;
  if (opts.resetView || !prev) fitView();
  else if (prev.pad !== doc.pad) {
    // Keep the photo still on screen when the margin changes.
    const d = doc.pad - prev.pad;
    state.view.ox -= d * state.view.scale;
    state.view.oy -= d * state.view.scale;
  }
  syncPanel();
  render();
}

/** Swap in a new subject mask on the current photo. */
function setMask(srcMask: Mask | null) {
  const doc = state.doc!;
  const hadSubject = !!doc.mask;
  applyMask(doc, srcMask);
  if (!hadSubject && doc.mask) resetCaptureFor(doc);
  state.captureDirty = true;
  syncPanel();
  render();
}

// ---------------------------------------------------------------------------------------------
// History

interface Snapshot {
  srcMask: Mask | null;
  params: CaptureParams;
  path: Path;
  width: WidthProfile;
  shift: Vec;
}

const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
let lastCheckpoint = { key: '', time: 0 };

const snapshot = (): Snapshot => ({
  srcMask: state.doc?.srcMask ?? null,
  params: state.params,
  path: state.path,
  width: state.width,
  shift: state.shift,
});

/** Remember the current state before a change. Rapid changes with the same key coalesce. */
function checkpoint(key = '') {
  if (!state.doc) return;
  const now = performance.now();
  const coalesce = key && key === lastCheckpoint.key && now - lastCheckpoint.time < 1000;
  lastCheckpoint = { key, time: now };
  if (coalesce) return;
  undoStack.push(snapshot());
  if (undoStack.length > 30) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function restoreSnapshot(s: Snapshot) {
  state.params = s.params;
  state.path = s.path;
  state.width = s.width;
  state.shift = s.shift;
  state.selected = null;
  if (state.doc && s.srcMask !== state.doc.srcMask) applyMask(state.doc, s.srcMask);
  state.captureDirty = true;
  lastCheckpoint = { key: '', time: 0 };
  syncPanel();
  render();
}

function undo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(snapshot());
  restoreSnapshot(s);
  updateHistoryButtons();
}

function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(snapshot());
  restoreSnapshot(s);
  updateHistoryButtons();
}

function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $<HTMLButtonElement>('#undo').disabled = undoStack.length === 0;
  $<HTMLButtonElement>('#redo').disabled = redoStack.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Loading and subject selection

interface Loaded {
  canvas: HTMLCanvasElement;
  data: ImageData;
  /** Working size ÷ original size. */
  scale: number;
  cutout: boolean;
}

async function decode(blob: Blob): Promise<Loaded> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = canvasOf(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { canvas, data, scale, cutout: hasTransparency(data) };
}

/**
 * Any image the user drops, pastes or picks. A full photo becomes the photo; a cut-out (e.g.
 * "Copy Subject" from Apple Photos) is matched against the current photo so it becomes the mask
 * and the background stays. Without a photo to match, the cut-out is used on its own — and if a
 * photo arrives later, the cut-out is matched against that photo instead.
 */
async function loadBlob(blob: Blob) {
  const img = await decode(blob);
  const src = state.source;

  if (img.cutout) {
    if (state.doc && src?.kind === 'photo') {
      const placed = await placeCutout(img, src);
      if (placed) {
        checkpoint();
        setMask(placed.mask);
        setTool('move');
        flash(placed.message, 6000);
        return;
      }
      const alone = await ask('在目前的照片裡找不到這個主體。要改成單獨使用這張去背圖嗎？（原背景不會保留）', '單獨使用', '取消');
      if (!alone) return;
    }
    state.source = { kind: 'cutout', scale: img.scale, cutout: img };
    state.padPct = 100;
    if (state.bg === 'image') state.bg = 'transparent';
    clearHistory();
    setDoc(img.canvas, maskFromImageData(img.data), { resetView: true, resetPath: true });
    setTool('move');
    flash('已載入去背主體。要保留原背景的話，再貼上（或拖進）完整的原圖，會自動對位。', 7000);
    return;
  }

  const previousCutout = src?.kind === 'cutout' ? src.cutout : null;
  state.source = { kind: 'photo', scale: img.scale };
  state.padPct = 0;
  if (previousCutout && state.bg === 'transparent') state.bg = 'image';
  clearHistory();
  setDoc(img.canvas, null, { resetView: true, resetPath: true });
  if (previousCutout) {
    const placed = await placeCutout(previousCutout, state.source);
    if (placed) {
      setMask(placed.mask);
      setTool('move');
      flash(placed.message, 6000);
      return;
    }
  }
  setTool('pick');
}

/** Match a cut-out against the current photo and turn it into a photo-sized mask. */
async function placeCutout(cut: Loaded, photo: { scale: number }): Promise<{ mask: Mask; message: string } | null> {
  const doc = state.doc!;
  flash('正在找主體在原圖中的位置…', 0);
  await new Promise((r) => setTimeout(r, 30)); // let the message paint
  const { alignCutout, GOOD_MATCH } = await import('./align');
  // Same original resolution is the usual case (both copied from Photos), so try that first.
  const place = alignCutout(doc.srcData, cut.data, [photo.scale / cut.scale]);
  if (!place || place.error > GOOD_MATCH) {
    flash('對位失敗。');
    return null;
  }
  const c = canvasOf(doc.src.width, doc.src.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(cut.canvas, place.x, place.y, cut.canvas.width * place.scale, cut.canvas.height * place.scale);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const mask = { w: c.width, h: c.height, data: new Uint8Array(c.width * c.height) };
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = id.data[i * 4 + 3];
  return { mask, message: `已把去背主體對齊到原圖上（色差 ${place.error.toFixed(1)}），背景保留。` };
}

/** A small in-page yes/no dialog. */
function ask(message: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'ask';
    box.innerHTML = `<div class="ask-card"><p></p><div class="row"><button class="btn primary"></button><button class="btn"></button></div></div>`;
    box.querySelector('p')!.textContent = message;
    const [ok, cancel] = box.querySelectorAll('button');
    ok.textContent = yes;
    cancel.textContent = no;
    const done = (v: boolean) => {
      box.remove();
      resolve(v);
    };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    document.body.appendChild(box);
    ok.focus();
  });
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
  checkpoint();
  setMask(mask);
  setTool('move');
}

/** Photo-space position of a doc-space point, or null when outside the photo. */
function photoPoint(world: Vec): Vec | null {
  const doc = state.doc!;
  const p = { x: world.x - doc.pad, y: world.y - doc.pad };
  return p.x < 0 || p.y < 0 || p.x >= doc.src.width || p.y >= doc.src.height ? null : p;
}

async function segmentWithModel(p: Vec): Promise<Mask | null> {
  if (state.busy) return null;
  state.busy = true;
  flash('AI 辨識中…（第一次會下載約 6 MB 的模型）', 0);
  try {
    const { segmentAt } = await import('./segment');
    return await segmentAt(state.doc!.src, p.x, p.y);
  } catch (err) {
    console.error(err);
    // Script/wasm load failures surface as a bare Event rather than an Error.
    const why = err instanceof Error ? err.message : '模型下載失敗，請確認網路';
    flash('AI 辨識失敗：' + why + '。可以改用顏色魔術棒、筆刷或「匯入遮罩」。', 8000);
    return null;
  } finally {
    state.busy = false;
  }
}

async function pickSubject(world: Vec) {
  const p = photoPoint(world);
  if (!p) return;
  const mask = await segmentWithModel(p);
  if (!mask) return;
  if (isEmpty(mask)) return flash('這個位置沒有辨識到主體，換個地方點點看。');
  checkpoint();
  setMask(mask);
  flash('抓到主體了。按「只看主體」檢查去背；沒問題就到第 3 步選方向。', 6000);
}

const emptyMask = (doc: Doc): Mask => ({ w: doc.src.width, h: doc.src.height, data: new Uint8Array(doc.src.width * doc.src.height) });

async function magicEdit(world: Vec, op: MaskOp) {
  const doc = state.doc!;
  const p = photoPoint(world);
  if (!p) return;
  const current = doc.srcMask ?? emptyMask(doc);
  if (op === 'erase' && !doc.srcMask) return flash('還沒有主體可以擦除。');

  let sel: Uint8Array | null;
  if (state.engine === 'ai') {
    const m = await segmentWithModel(p);
    if (!m) return;
    sel = m.data;
  } else {
    sel = magicWand(doc.srcData, current, p, state.tolerance, op);
    if (!sel) {
      return flash(op === 'erase' ? '這裡已經是背景了，點在要擦掉的主體上。' : '這裡已經是主體了，點在要補回的區域上。');
    }
  }
  checkpoint();
  setMask(applySelection(current, sel, op));
  flash(op === 'erase' ? '已擦除。不對的話按 ⌘Z。' : '已補回。不對的話按 ⌘Z。');
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
    cctx.drawImage(ribbon.render(doc.w, doc.h, cap, state.path, ribbonOptions()), 0, 0);
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

const ribbonOptions = () => ({ mode: state.bendMode, fade: state.fade, width: state.width, shift: state.shift });

/** The centre of the ribbon's tail (where it gathers when it converges to a point). */
function tailCenter(): Vec {
  const end = state.path[state.path.length - 1].p;
  const k = progressAt(state.width, 1);
  return { x: end.x + state.shift.x * k, y: end.y + state.shift.y * k };
}

/** Transition markers that are currently meaningful. */
const transitionMarks = (): ('from' | 'to')[] => (state.width.curve === 'step' ? ['from'] : ['from', 'to']);

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

  if (state.pendingMask) {
    applyMask(doc, state.pendingMask);
    state.pendingMask = null;
    state.captureDirty = true;
  }

  const { scale: s, ox, oy } = state.view;
  vctx.save();
  vctx.translate(ox, oy);
  vctx.scale(s, s);
  vctx.fillStyle = checkerPattern();
  vctx.fillRect(0, 0, doc.w, doc.h);
  vctx.imageSmoothingQuality = 'high';
  if (state.viewMode === 'result') {
    renderComposite();
    vctx.drawImage(composite, 0, 0);
  } else if (state.viewMode === 'subject') {
    vctx.drawImage(doc.subject ?? doc.image, 0, 0);
  } else {
    vctx.drawImage(doc.image, 0, 0);
    vctx.drawImage(tintOf(doc), 0, 0);
  }
  vctx.restore();
  vctx.strokeStyle = 'rgba(255,255,255,0.15)';
  vctx.lineWidth = 1;
  vctx.strokeRect(ox - 0.5, oy - 0.5, doc.w * s + 1, doc.h * s + 1);

  if (state.viewMode === 'result' && !isMaskTool(state.tool)) {
    ensureCapture();
    drawOverlay();
  }
  if ((state.tool === 'erase' || state.tool === 'restore') && state.engine === 'brush' && state.pointer) {
    vctx.beginPath();
    vctx.arc(state.pointer.x, state.pointer.y, (state.brushSize / 2) * s, 0, Math.PI * 2);
    strokeOutlined(1, state.tool === 'erase' ? '#ff8a8a' : '#8affb0');
  }
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

  // Where the width transition starts and ends, on the path.
  for (const which of transitionMarks()) {
    const local = pointAtFraction(path, state.width[which]);
    const m = W(local);
    vctx.beginPath();
    vctx.arc(m.x, m.y, 6, 0, Math.PI * 2);
    vctx.fillStyle = '#1d1d1f';
    vctx.fill();
    strokeOutlined(1.5, '#5ef0ff');
    vctx.fillStyle = '#5ef0ff';
    vctx.font = '600 10px system-ui, sans-serif';
    vctx.textAlign = 'center';
    vctx.textBaseline = 'middle';
    vctx.fillText(which === 'from' ? '始' : '終', m.x, m.y - 14);
  }

  // Tail centre: drag it anywhere to move where the ribbon ends up.
  const end = W(path[path.length - 1].p);
  const f = W(tailCenter());
  if (dist(end, f) < 4) {
    vctx.beginPath();
    vctx.arc(f.x, f.y, 11, 0, Math.PI * 2);
    strokeOutlined(2, '#5ef0ff');
  } else {
    vctx.beginPath();
    vctx.moveTo(end.x, end.y);
    vctx.lineTo(f.x, f.y);
    strokeOutlined(1, 'rgba(255,255,255,0.7)', [3, 3]);
    vctx.beginPath();
    vctx.arc(f.x, f.y, 7, 0, Math.PI * 2);
    vctx.fillStyle = '#5ef0ff';
    vctx.fill();
    strokeOutlined(1.5, '#fff');
  }
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

function setViewMode(mode: ViewMode, auto = false) {
  state.viewMode = mode;
  state.autoView = auto;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
  render();
}

// ---------------------------------------------------------------------------------------------
// Interaction

type Hit =
  | { kind: 'focus' }
  | { kind: 'mark'; which: 'from' | 'to' }
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
  if (!doc?.circle || !cap || state.viewMode !== 'result') return { kind: 'none' };
  const frame = frameOf(cap);
  const S = (v: Vec) => toScreen(toWorld(frame, v));
  const path = state.path;

  for (const which of transitionMarks()) {
    if (dist(S(pointAtFraction(path, state.width[which])), screen) < HIT) return { kind: 'mark', which };
  }
  {
    // Unmoved, the tail handle is a ring around the last anchor: ring = tail, centre = anchor.
    const d = dist(S(tailCenter()), screen);
    const onAnchor = dist(S(tailCenter()), S(path[path.length - 1].p)) < 4;
    if (onAnchor ? d > 6 && d < 15 : d < HIT) return { kind: 'focus' };
  }
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
  | { kind: 'focus'; grab: Vec }
  | { kind: 'mark'; which: 'from' | 'to' }
  | { kind: 'handle'; i: number; which: 'hin' | 'hout' }
  | { kind: 'anchor'; i: number; grab: Vec }
  | { kind: 'pull'; i: number; start: Vec }
  | { kind: 'trim'; which: 'trimStart' | 'trimEnd' }
  | { kind: 'dir'; from: number; angle: number }
  | { kind: 'offset'; grab: number }
  | { kind: 'pan'; start: Vec; ox: number; oy: number }
  | { kind: 'brush'; mask: Mask; last: Vec; op: MaskOp };

let drag: Drag | null = null;
let spaceDown = false;

const currentFrame = (): Frame | null => (state.capture ? frameOf(state.capture) : null);
const panFrom = (screen: Vec): Drag => ({ kind: 'pan', start: screen, ox: state.view.ox, oy: state.view.oy });

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
    drag = panFrom(screen);
    return;
  }
  if (state.tool === 'pick') {
    void pickSubject(world);
    return;
  }
  if (state.tool === 'erase' || state.tool === 'restore') {
    const op: MaskOp = state.tool;
    if (state.engine !== 'brush') {
      void magicEdit(world, op);
      return;
    }
    const p = photoPoint(world) ?? { x: world.x - doc.pad, y: world.y - doc.pad };
    checkpoint();
    const base = doc.srcMask ?? emptyMask(doc);
    const mask: Mask = { w: base.w, h: base.h, data: base.data.slice() };
    brushStroke(mask, p, p, state.brushSize / 2, op);
    state.pendingMask = mask;
    drag = { kind: 'brush', mask, last: p, op };
    render();
    return;
  }

  const frame = currentFrame();
  const hit = hitTest(screen);
  if (hit.kind !== 'none' && hit.kind !== 'segment') checkpoint();
  switch (hit.kind) {
    case 'focus':
      drag = { kind: 'focus', grab: sub(tailCenter(), toLocal(frame!, world)) };
      break;
    case 'mark':
      drag = { kind: 'mark', which: hit.which };
      break;
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
        checkpoint();
        state.path = splitSegment(state.path, hit.seg, hit.t);
        state.selected = hit.seg + 1;
        drag = { kind: 'anchor', i: hit.seg + 1, grab: { x: 0, y: 0 } };
      } else {
        state.selected = null;
        drag = panFrom(screen);
      }
      break;
    case 'none':
      if (state.tool === 'pen' && frame && state.viewMode === 'result') {
        checkpoint();
        const local = toLocal(frame, world);
        state.path = [...state.path, { p: local, hin: local, hout: local, smooth: false }];
        state.selected = state.path.length - 1;
        drag = { kind: 'pull', i: state.selected, start: screen };
      } else {
        state.selected = null;
        drag = panFrom(screen);
      }
      break;
  }
  render();
});

view.addEventListener('pointermove', (e) => {
  const screen = pointerPos(e);
  state.pointer = screen;
  if (!drag) {
    updateCursor(screen);
    if (state.engine === 'brush' && (state.tool === 'erase' || state.tool === 'restore')) render();
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
    case 'brush': {
      const p = { x: world.x - doc.pad, y: world.y - doc.pad };
      brushStroke(drag.mask, drag.last, p, state.brushSize / 2, drag.op);
      drag.last = p;
      state.pendingMask = drag.mask;
      break;
    }
    case 'focus': {
      const target = add(toLocal(frame!, world), drag.grab);
      const end = state.path[state.path.length - 1].p;
      const k = Math.max(1e-3, progressAt(state.width, 1));
      state.shift = { x: (target.x - end.x) / k, y: (target.y - end.y) / k };
      break;
    }
    case 'mark':
      state.width = { ...state.width, [drag.which]: nearestFraction(state.path, toLocal(frame!, world)) };
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
  if (drag?.kind === 'brush') state.pendingMask = drag.mask;
  drag = null;
  syncPanel();
  render();
};
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
view.addEventListener('pointerleave', () => {
  state.pointer = null;
  render();
});

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
  if (isMaskTool(state.tool)) {
    view.style.cursor = state.engine === 'brush' && state.tool !== 'pick' ? 'none' : 'crosshair';
    return;
  }
  const hit = hitTest(screen);
  const cursors: Record<Hit['kind'], string> = {
    focus: 'move',
    mark: 'ew-resize',
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

function toolHint(): string {
  const how = { ai: '點一下物件（AI 判斷範圍）', wand: '點一下（選取相近顏色的連續區域）', brush: '直接塗' }[state.engine];
  switch (state.tool) {
    case 'move':
      return '移動：拖曳把手、擷取線與錨點；拖曳空白處平移畫面。';
    case 'pen':
      return '鋼筆：點空白處新增錨點，按住拖曳拉出曲線；點在路徑上插入錨點。';
    case 'pick':
      return '點選主體：在照片中點一下想抓的主體（會整個重抓）。';
    case 'erase':
      return `魔法擦除：在多抓的地方${how}。⌘Z 上一步。`;
    case 'restore':
      return `魔法復原：在漏抓的地方${how}。⌘Z 上一步。`;
  }
}

let flashTimer = 0;
function flash(msg: string, ms = 4000) {
  hint.textContent = msg;
  clearTimeout(flashTimer);
  if (ms > 0) flashTimer = window.setTimeout(() => (hint.textContent = toolHint()), ms);
}

function setTool(tool: Tool) {
  state.tool = tool;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll<HTMLButtonElement>('[data-tool-btn]').forEach((b) => b.classList.toggle('active', b.dataset.toolBtn === tool));
  // Erasing is easiest against an empty background, restoring needs to see what is missing.
  if (tool === 'erase') setViewMode('subject', true);
  else if (tool === 'restore') setViewMode('mask', true);
  else if (state.autoView) setViewMode('result');
  hint.textContent = toolHint();
  render();
}

function syncPanel() {
  const doc = state.doc;
  const r = doc?.circle?.r ?? 1;
  inputs.angle.value = String(angleDeg());
  inputs.offset.value = String((state.params.offset / (2 * r)) * 100);
  inputs.trimStart.value = String(state.params.trimStart * 100);
  inputs.trimEnd.value = String(state.params.trimEnd * 100);
  inputs.inset.value = String(state.params.inset);
  inputs.smooth.value = String(state.params.smooth);
  inputs.holes.value = state.params.holes;
  inputs.bend.value = state.bendMode;
  inputs.fade.value = String(state.fade * 100);
  inputs.wStart.value = String(state.width.start * 100);
  inputs.wEnd.value = String(state.width.end * 100);
  inputs.wFrom.value = String(state.width.from * 100);
  inputs.wTo.value = String(state.width.to * 100);
  inputs.wCurve.value = state.width.curve;
  $<HTMLElement>('#w-to-field').style.display = state.width.curve === 'step' ? 'none' : '';
  inputs.engine.value = state.engine;
  inputs.tol.value = String(state.tolerance);
  inputs.brush.value = String(state.brushSize);
  inputs.bg.value = state.bg;
  inputs.pad.value = String(state.padPct);
  $<HTMLElement>('#bg-color-field').style.display = state.bg === 'color' ? '' : 'none';
  $<HTMLElement>('#tol-field').style.display = state.engine === 'wand' ? '' : 'none';
  $<HTMLElement>('#brush-field').style.display = state.engine === 'brush' ? '' : 'none';
  document.querySelectorAll<HTMLElement>('[data-needs="subject"]').forEach((el) => el.classList.toggle('disabled', !doc?.mask));
  let coverage = 0;
  if (doc?.srcMask) {
    for (let i = 0; i < doc.srcMask.data.length; i++) if (doc.srcMask.data[i] >= THRESHOLD) coverage++;
    coverage /= doc.srcMask.data.length;
  }
  $<HTMLElement>('#mask-status').textContent = !doc
    ? '先載入一張照片。'
    : doc.mask
      ? `已抓到主體（佔畫面 ${Math.round(coverage * 100)}%）。`
      : '還沒有主體：點選主體、匯入遮罩，或用魔法復原自己圈。';
  updateReadouts();
}

const angleDeg = () => (((Math.round((state.params.angle * 1800) / Math.PI) / 10) % 360) + 360) % 360;

function updateReadouts() {
  $<HTMLOutputElement>('#angle-out').textContent = `${angleDeg().toFixed(1)}°`;
  $<HTMLOutputElement>('#offset-out').textContent = `${Math.round(state.params.offset)} px`;
  $<HTMLOutputElement>('#trim-start-out').textContent = `${Math.round(state.params.trimStart * 100)}%`;
  $<HTMLOutputElement>('#trim-end-out').textContent = `${Math.round(state.params.trimEnd * 100)}%`;
  $<HTMLOutputElement>('#inset-out').textContent = `${state.params.inset} px`;
  $<HTMLOutputElement>('#smooth-out').textContent = `${state.params.smooth} px`;
  $<HTMLOutputElement>('#fade-out').textContent = `${Math.round(state.fade * 100)}%`;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  $<HTMLOutputElement>('#w-start-out').textContent = pct(state.width.start);
  $<HTMLOutputElement>('#w-end-out').textContent = pct(state.width.end);
  $<HTMLOutputElement>('#w-from-out').textContent = pct(state.width.from);
  $<HTMLOutputElement>('#w-to-out').textContent = pct(state.width.to);
  $<HTMLOutputElement>('#tol-out').textContent = String(state.tolerance);
  $<HTMLOutputElement>('#brush-out').textContent = `${state.brushSize} px`;
  $<HTMLOutputElement>('#pad-out').textContent = `${state.padPct}%`;
  $<HTMLElement>('#length-out').textContent = String(Math.round(pathLength(state.path)));
}

/** A capture/path control: remembered for undo, re-captures, redraws. */
function bindParam(el: HTMLInputElement | HTMLSelectElement, apply: (v: string) => void) {
  el.addEventListener('input', () => {
    checkpoint(el.id);
    apply(el.value);
    state.captureDirty = true;
    updateReadouts();
    render();
  });
}

const setParam = <K extends keyof CaptureParams>(k: K, v: CaptureParams[K]) => (state.params = { ...state.params, [k]: v });
bindParam(inputs.angle, (v) => setParam('angle', (Number(v) * Math.PI) / 180));
bindParam(inputs.offset, (v) => setParam('offset', (Number(v) / 100) * 2 * (state.doc?.circle?.r ?? 0)));
bindParam(inputs.trimStart, (v) => setParam('trimStart', Number(v) / 100));
bindParam(inputs.trimEnd, (v) => setParam('trimEnd', Number(v) / 100));
bindParam(inputs.inset, (v) => setParam('inset', Number(v)));
bindParam(inputs.smooth, (v) => setParam('smooth', Number(v)));
bindParam(inputs.holes, (v) => setParam('holes', v as HoleMode));

/** A view/output setting: no undo needed. */
function bindSetting(el: HTMLInputElement | HTMLSelectElement, apply: (v: string) => void) {
  el.addEventListener('input', () => {
    apply(el.type === 'checkbox' ? String((el as HTMLInputElement).checked) : el.value);
    syncPanel();
    render();
  });
}

bindSetting(inputs.bend, (v) => (state.bendMode = v as BendMode));
bindSetting(inputs.fade, (v) => (state.fade = Number(v) / 100));
/** Width profile controls: undoable, but nothing to re-capture. */
function bindWidth(el: HTMLInputElement | HTMLSelectElement, apply: (v: string) => Partial<WidthProfile>) {
  el.addEventListener('input', () => {
    checkpoint(el.id);
    state.width = { ...state.width, ...apply(el.value) };
    syncPanel();
    render();
  });
}
bindWidth(inputs.wStart, (v) => ({ start: Number(v) / 100 }));
bindWidth(inputs.wEnd, (v) => ({ end: Number(v) / 100 }));
bindWidth(inputs.wFrom, (v) => ({ from: Number(v) / 100 }));
bindWidth(inputs.wTo, (v) => ({ to: Number(v) / 100 }));
bindWidth(inputs.wCurve, (v) => ({ curve: v as WidthProfile['curve'] }));
document.querySelectorAll<HTMLButtonElement>('[data-width-preset]').forEach((b) =>
  b.addEventListener('click', () => {
    checkpoint();
    const presets: Record<string, Partial<WidthProfile>> = {
      flat: { start: 1, end: 1 },
      point: { start: 1, end: 0 },
      fan: { start: 1, end: 2 },
    };
    state.width = { ...state.width, ...presets[b.dataset.widthPreset!] };
    syncPanel();
    render();
  }),
);
$<HTMLButtonElement>('#reset-tail').addEventListener('click', () => {
  checkpoint();
  state.shift = { x: 0, y: 0 };
  render();
});
bindSetting(inputs.engine, (v) => {
  state.engine = v as Engine;
  if (state.tool === 'erase' || state.tool === 'restore') hint.textContent = toolHint();
});
bindSetting(inputs.tol, (v) => (state.tolerance = Number(v)));
bindSetting(inputs.brush, (v) => (state.brushSize = Number(v)));
bindSetting(inputs.bg, (v) => (state.bg = v as typeof state.bg));
bindSetting(inputs.bgColor, (v) => (state.bgColor = v));
bindSetting(inputs.subjectTop, (v) => (state.subjectTop = v === 'true'));
bindSetting(inputs.clipSubject, (v) => (state.clipSubject = v === 'true'));
inputs.pad.addEventListener('input', () => {
  state.padPct = Number(inputs.pad.value);
  updateReadouts();
});
inputs.pad.addEventListener('change', () => {
  if (state.doc) setDoc(state.doc.src, state.doc.srcMask, { resetView: false, resetPath: false });
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
  state.source = { kind: 'photo', scale: 1 };
  state.padPct = 0;
  clearHistory();
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
document.querySelectorAll<HTMLButtonElement>('[data-tool-btn]').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.toolBtn as Tool)),
);
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => setViewMode(b.dataset.view as ViewMode)),
);
$<HTMLButtonElement>('#undo').addEventListener('click', undo);
$<HTMLButtonElement>('#redo').addEventListener('click', redo);
$<HTMLButtonElement>('#fit').addEventListener('click', fitView);
$<HTMLButtonElement>('#reset-path').addEventListener('click', () => {
  checkpoint();
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
  checkpoint();
  state.path = removeAnchor(state.path, i);
  state.selected = null;
  render();
}

const VIEW_CYCLE: ViewMode[] = ['result', 'subject', 'mask'];

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (e.key === ' ') {
    spaceDown = true;
    view.style.cursor = 'grab';
    if (t === document.body) e.preventDefault();
  } else if (key === 'v') setTool('move');
  else if (key === 'p') setTool('pen');
  else if (key === 's') setTool('pick');
  else if (key === 'e') setTool('erase');
  else if (key === 'r') setTool('restore');
  else if (key === 'b') setViewMode(VIEW_CYCLE[(VIEW_CYCLE.indexOf(state.viewMode) + 1) % VIEW_CYCLE.length]);
  else if (key === '[' || key === ']') {
    state.brushSize = clamp(Math.round(state.brushSize * (key === '[' ? 0.8 : 1.25)), 4, 300);
    syncPanel();
    render();
  } else if (key === '0') fitView();
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
setViewMode('result');
updateHistoryButtons();
syncPanel();
render();
