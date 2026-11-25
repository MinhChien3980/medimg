import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  dragZoomFactor,
  fitViewport,
  panBy,
  screenToImage,
  wheelZoomFactor,
  zoomAt,
} from './viewport';

describe('fitViewport', () => {
  it('fits a landscape image into a square view and centres it', () => {
    const vp = fitViewport({ width: 200, height: 100 }, { width: 400, height: 400 });
    expect(vp.scale).toBe(2);
    expect(vp.offsetX).toBe(0);
    expect(vp.offsetY).toBe(100); // (400 - 100*2) / 2
  });

  it('respects padding', () => {
    const vp = fitViewport({ width: 100, height: 100 }, { width: 120, height: 220 }, 10);
    expect(vp.scale).toBe(1);
    expect(vp.offsetX).toBe(10);
    expect(vp.offsetY).toBe(60);
  });

  it('is safe for empty sizes', () => {
    expect(fitViewport({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });
});

describe('screenToImage', () => {
  const vp = { scale: 2, offsetX: 10, offsetY: -5 };

  it('screenToImage maps screen pixels back to image pixels', () => {
    expect(screenToImage(vp, { x: 84, y: 157 })).toEqual({ x: 37, y: 81 });
  });
});

describe('panBy', () => {
  it('moves the offset only', () => {
    expect(panBy({ scale: 3, offsetX: 1, offsetY: 2 }, 10, -4)).toEqual({
      scale: 3,
      offsetX: 11,
      offsetY: -2,
    });
  });
});

describe('zoomAt', () => {
  it('keeps the image point under the anchor fixed', () => {
    const vp = { scale: 1, offsetX: 50, offsetY: 20 };
    const anchor = { x: 150, y: 120 };
    const before = screenToImage(vp, anchor);
    const zoomed = zoomAt(vp, 2.5, anchor);
    expect(zoomed.scale).toBe(2.5);
    const after = screenToImage(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('clamps the scale', () => {
    const vp = { scale: 1, offsetX: 0, offsetY: 0 };
    expect(zoomAt(vp, 1e6, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
    expect(zoomAt(vp, 1e-6, { x: 0, y: 0 }).scale).toBe(MIN_SCALE);
  });

  it('ignores invalid factors', () => {
    const vp = { scale: 1, offsetX: 3, offsetY: 4 };
    expect(zoomAt(vp, 0, { x: 0, y: 0 })).toBe(vp);
    expect(zoomAt(vp, Number.NaN, { x: 0, y: 0 })).toBe(vp);
  });
});

describe('zoom factors', () => {
  it('wheel up zooms in, wheel down zooms out, zero is neutral', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1, 10);
  });

  it('dragging up zooms in', () => {
    expect(dragZoomFactor(-50)).toBeGreaterThan(1);
    expect(dragZoomFactor(50)).toBeLessThan(1);
  });
});
