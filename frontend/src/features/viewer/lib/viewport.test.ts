import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  dragZoomFactor,
  fitViewport,
  imageToScreen,
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

  it('imageToScreen is its inverse', () => {
    expect(imageToScreen(vp, { x: 37, y: 81 })).toEqual({ x: 84, y: 157 });
  });
});

describe('image ↔ screen round trips', () => {
  const image = { width: 2500, height: 2048 };
  const view = { width: 900, height: 700 };
  const fitted = fitViewport(image, view, 8);
  const points = [
    { x: 0, y: 0 },
    { x: 2500, y: 2048 },
    { x: 1234.5, y: 77.25 },
    { x: -10, y: 3000 },
  ];
  // Fitted, zoomed in around an off-centre anchor, zoomed out, panned, both.
  const viewports = [
    fitted,
    zoomAt(fitted, 7.3, { x: 610, y: 95 }),
    zoomAt(fitted, 0.31, { x: 10, y: 690 }),
    panBy(fitted, -333.3, 120.7),
    panBy(zoomAt(fitted, 12, { x: 450, y: 350 }), 1500, -800),
  ];

  it.each(viewports.map((v, i) => [i, v] as const))(
    'viewport %i: image → screen → image',
    (_i, v) => {
      for (const p of points) {
        const back = screenToImage(v, imageToScreen(v, p));
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    },
  );

  it.each(viewports.map((v, i) => [i, v] as const))(
    'viewport %i: screen → image → screen',
    (_i, v) => {
      for (const p of [
        { x: 0, y: 0 },
        { x: 450.5, y: 350.25 },
        { x: 899, y: 699 },
      ]) {
        const back = imageToScreen(v, screenToImage(v, p));
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    },
  );

  it('a point under the zoom anchor stays under it on screen', () => {
    const anchor = { x: 610, y: 95 };
    const imagePoint = screenToImage(fitted, anchor);
    const zoomed = zoomAt(fitted, 5, anchor);
    const onScreen = imageToScreen(zoomed, imagePoint);
    expect(onScreen.x).toBeCloseTo(anchor.x, 9);
    expect(onScreen.y).toBeCloseTo(anchor.y, 9);
  });

  it('screen distances scale with the zoom', () => {
    const zoomed = zoomAt(fitted, 4, { x: 0, y: 0 });
    const a = imageToScreen(zoomed, { x: 100, y: 100 });
    const b = imageToScreen(zoomed, { x: 200, y: 100 });
    expect(b.x - a.x).toBeCloseTo(100 * fitted.scale * 4, 9);
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
