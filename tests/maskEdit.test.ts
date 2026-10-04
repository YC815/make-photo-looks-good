import { describe, expect, it } from 'vitest';
import type { Mask } from '../src/mask';
import { applySelection, brushStroke, magicWand } from '../src/maskEdit';

/** 20×10 image: left half red, right half blue. */
function twoTone() {
  const w = 20;
  const h = 10;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data.set(x < 10 ? [220, 30, 30, 255] : [30, 30, 220, 255], i);
    }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

const fullMask = (w: number, h: number, v = 255): Mask => ({ w, h, data: new Uint8Array(w * h).fill(v) });

describe('magicWand', () => {
  const img = twoTone();

  it('selects the contiguous similar colour (plus a 1px rim)', () => {
    const sel = magicWand(img, fullMask(20, 10), { x: 2, y: 5 }, 30, 'erase')!;
    expect(sel[5 * 20 + 0]).toBe(255);
    expect(sel[5 * 20 + 9]).toBe(255);
    expect(sel[5 * 20 + 10]).toBe(255); // rim
    expect(sel[5 * 20 + 11]).toBe(0);
  });

  it('erase only spreads through the subject', () => {
    const mask = fullMask(20, 10);
    for (let y = 0; y < 10; y++) mask.data[y * 20 + 5] = 0; // background column splits the red
    const sel = magicWand(img, mask, { x: 2, y: 5 }, 30, 'erase')!;
    expect(sel[5 * 20 + 3]).toBe(255);
    expect(sel[5 * 20 + 7]).toBe(0);
  });

  it('refuses a seed on the wrong side', () => {
    expect(magicWand(img, fullMask(20, 10), { x: 2, y: 5 }, 30, 'restore')).toBeNull();
    expect(magicWand(img, fullMask(20, 10, 0), { x: 2, y: 5 }, 30, 'erase')).toBeNull();
  });
});

describe('applySelection', () => {
  it('erases with min and restores with max', () => {
    const mask: Mask = { w: 3, h: 1, data: new Uint8Array([255, 100, 0]) };
    const sel = new Uint8Array([255, 0, 200]);
    expect([...applySelection(mask, sel, 'erase').data]).toEqual([0, 100, 0]);
    expect([...applySelection(mask, sel, 'restore').data]).toEqual([255, 100, 200]);
  });
});

describe('brushStroke', () => {
  it('paints a capsule between two points', () => {
    const mask = fullMask(40, 20, 0);
    brushStroke(mask, { x: 5, y: 10 }, { x: 35, y: 10 }, 3, 'restore');
    expect(mask.data[10 * 40 + 20]).toBe(255);
    expect(mask.data[10 * 40 + 1]).toBe(0);
    expect(mask.data[2 * 40 + 20]).toBe(0);
    brushStroke(mask, { x: 20, y: 10 }, { x: 20, y: 10 }, 2, 'erase');
    expect(mask.data[10 * 40 + 20]).toBe(0);
    expect(mask.data[10 * 40 + 30]).toBe(255);
  });
});
