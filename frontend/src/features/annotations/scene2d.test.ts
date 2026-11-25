import { describe, expect, it } from 'vitest';
import { fitViewport, screenToImage, zoomAt } from '../viewer/lib/viewport';
import { formatMeasurement } from './format';
import type { Shape2D } from './geometry2d';
import { arrowHead, toScreenShape } from './scene2d';

const image = { width: 2000, height: 1600 };
const fitted = fitViewport(image, { width: 800, height: 600 }, 8);

describe('toScreenShape', () => {
  it('places every point through the viewer transform, at any zoom and pan', () => {
    const shape: Shape2D = {
      kind: 'POLYGON',
      geometry: {
        points: [
          [100, 200],
          [900, 250],
          [500, 1500],
        ],
      },
    };
    for (const vp of [fitted, zoomAt(fitted, 6, { x: 123, y: 456 })]) {
      const s = toScreenShape(shape, vp);
      expect(s.closed).toBe(true);
      s.points.forEach((p, i) => {
        const back = screenToImage(vp, p);
        expect(back.x).toBeCloseTo(shape.geometry.points[i]?.[0] ?? NaN, 9);
        expect(back.y).toBeCloseTo(shape.geometry.points[i]?.[1] ?? NaN, 9);
      });
    }
  });

  it('draws a rectangle as its 4 corners and a length with end ticks', () => {
    const rect = toScreenShape(
      { kind: 'RECTANGLE', geometry: { x: 0, y: 0, width: 100, height: 50 } },
      { scale: 2, offsetX: 10, offsetY: 20 },
    );
    expect(rect.points).toEqual([
      { x: 10, y: 20 },
      { x: 210, y: 20 },
      { x: 210, y: 120 },
      { x: 10, y: 120 },
    ]);
    const length = toScreenShape(
      { kind: 'LENGTH', geometry: { from: [0, 0], to: [100, 0] } },
      { scale: 1, offsetX: 0, offsetY: 0 },
    );
    expect(length.closed).toBe(false);
    expect(length.endTicks).toHaveLength(2);
    expect(length.endTicks[0]?.[0]).toEqual({ x: 0, y: -6 });
  });

  it('puts an arrow head at the tip, symmetric around the shaft', () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, Math.PI / 4);
    expect(a.x).toBeCloseTo(100 - 10 * Math.SQRT1_2, 9);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(a.y).toBeCloseTo(-b.y, 9);
  });
});

describe('formatMeasurement', () => {
  const labels = { mean: 'mean', sd: 'SD' };
  it('labels the unit, so calibrated and pixel values are never confused', () => {
    expect(formatMeasurement({ lengthMm: 71.5 }, 'en', labels)).toBe('71.5 mm');
    expect(formatMeasurement({ lengthPx: 500 }, 'en', labels)).toBe('500.0 px');
    expect(formatMeasurement({ areaMm2: 2000 }, 'en', labels)).toBe('2,000 mm²');
    expect(formatMeasurement({ areaPx2: 600 }, 'en', labels)).toBe('600 px²');
    expect(formatMeasurement({ areaMm2: 85.25, meanHu: 42.4, stdHu: 11.2 }, 'en', labels)).toBe(
      '85.3 mm² · mean 42 HU, SD 11',
    );
    expect(formatMeasurement({ lengthMm: 1.5 }, 'vi', labels)).toBe('1,5 mm');
    expect(formatMeasurement(null, 'en', labels)).toBe('');
  });
});
