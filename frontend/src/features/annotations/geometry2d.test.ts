import { describe, expect, it } from 'vitest';
import {
  clampPoint,
  distance,
  isValidShape,
  measureShape,
  moveHandle,
  parseShape2D,
  polygonArea,
  rectFromCorners,
  roundShape,
  shapeFromDrag,
  shapeHandles,
  translateShape,
  type Shape2D,
} from './geometry2d';

const IMAGE = { width: 1000, height: 800 };
const rect: Shape2D = { kind: 'RECTANGLE', geometry: { x: 100, y: 50, width: 200, height: 100 } };
const triangle: Shape2D = {
  kind: 'POLYGON',
  geometry: {
    points: [
      [0, 0],
      [40, 0],
      [0, 30],
    ],
  },
};

describe('parseShape2D', () => {
  it('accepts each kind with its geometry', () => {
    expect(parseShape2D('RECTANGLE', { x: 1, y: 2, width: 3, height: 4 })).toEqual({
      kind: 'RECTANGLE',
      geometry: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(
      parseShape2D('POLYGON', {
        points: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      })?.kind,
    ).toBe('POLYGON');
    expect(parseShape2D('ARROW', { from: [1, 2], to: [3, 4], text: 'nodule' })).toEqual({
      kind: 'ARROW',
      geometry: { from: [1, 2], to: [3, 4], text: 'nodule' },
    });
    expect(parseShape2D('ARROW', { from: [1, 2], to: [3, 4] })?.geometry).toMatchObject({
      text: '',
    });
    expect(parseShape2D('LENGTH', { from: [0, 0], to: [3, 4] })?.kind).toBe('LENGTH');
  });

  it('rejects mismatched or malformed geometry (e.g. a volume annotation)', () => {
    expect(parseShape2D('RECTANGLE', { points: [[0, 0]] })).toBeNull();
    expect(parseShape2D('POLYGON', { points: [[0, 'a']] })).toBeNull();
    expect(parseShape2D('LENGTH', { from: [0, 0, 0], to: [1, 1, 1] })).toBeNull();
    expect(parseShape2D('LENGTH', { points: [[0, 0, 0]], viewPlaneNormal: [0, 0, 1] })).toBeNull();
    expect(parseShape2D('ELLIPSE_ROI', { points: [] })).toBeNull();
    expect(parseShape2D('RECTANGLE', null)).toBeNull();
    expect(parseShape2D('RECTANGLE', { x: Infinity, y: 0, width: 1, height: 1 })).toBeNull();
  });
});

describe('isValidShape', () => {
  it('requires a positive size inside the image', () => {
    expect(isValidShape(rect, IMAGE)).toBe(true);
    expect(
      isValidShape({ kind: 'RECTANGLE', geometry: { x: 0, y: 0, width: 0, height: 5 } }, IMAGE),
    ).toBe(false);
    expect(
      isValidShape({ kind: 'RECTANGLE', geometry: { x: 900, y: 0, width: 200, height: 5 } }, IMAGE),
    ).toBe(false);
  });

  it('requires 3 to 200 polygon points', () => {
    expect(isValidShape(triangle, IMAGE)).toBe(true);
    const two: Shape2D = {
      kind: 'POLYGON',
      geometry: {
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    };
    expect(isValidShape(two, IMAGE)).toBe(false);
    const many: Shape2D = {
      kind: 'POLYGON',
      geometry: { points: Array.from({ length: 201 }, (_, i) => [i, i % 7] as [number, number]) },
    };
    expect(isValidShape(many, IMAGE)).toBe(false);
  });

  it('rejects a zero-length line', () => {
    expect(isValidShape({ kind: 'LENGTH', geometry: { from: [5, 5], to: [5, 5] } }, IMAGE)).toBe(
      false,
    );
  });
});

describe('construction', () => {
  it('clamps points to the image', () => {
    expect(clampPoint([-5, 900], IMAGE)).toEqual([0, 800]);
  });

  it('builds a rectangle from corners in any order', () => {
    expect(rectFromCorners([300, 150], [100, 50])).toEqual(rect.geometry);
  });

  it('draws a shape by dragging, clamped, arrows pointing at the release point', () => {
    expect(shapeFromDrag('RECTANGLE', [100, 50], [300, 150], IMAGE)).toEqual(rect);
    expect(shapeFromDrag('ARROW', [10, 10], [1200, -4], IMAGE)).toEqual({
      kind: 'ARROW',
      geometry: { from: [10, 10], to: [1000, 0], text: '' },
    });
    expect(shapeFromDrag('LENGTH', [1, 2], [3, 4], IMAGE).geometry).toEqual({
      from: [1, 2],
      to: [3, 4],
    });
  });

  it('rounds coordinates to 1/100 px', () => {
    expect(
      roundShape({ kind: 'LENGTH', geometry: { from: [1.23456, 2.3333], to: [3.005, 4] } })
        .geometry,
    ).toEqual({ from: [1.23, 2.33], to: [3.01, 4] });
  });
});

describe('editing', () => {
  it('lists handles: rectangle corners clockwise, polygon vertices, line ends', () => {
    expect(shapeHandles(rect)).toEqual([
      [100, 50],
      [300, 50],
      [300, 150],
      [100, 150],
    ]);
    expect(shapeHandles(triangle)).toHaveLength(3);
    expect(shapeHandles({ kind: 'LENGTH', geometry: { from: [1, 2], to: [3, 4] } })).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('moves a shape, sliding along the image edge instead of leaving it', () => {
    expect(translateShape(rect, 10, -20, IMAGE)).toEqual({
      kind: 'RECTANGLE',
      geometry: { x: 110, y: 30, width: 200, height: 100 },
    });
    // Far to the right and up: stops at the right and top edges.
    expect(translateShape(rect, 5000, -5000, IMAGE).geometry).toEqual({
      x: 800,
      y: 0,
      width: 200,
      height: 100,
    });
    const moved = translateShape(triangle, -10, 5, IMAGE);
    expect(shapeHandles(moved)).toEqual([
      [0, 5],
      [40, 5],
      [0, 35],
    ]);
  });

  it('moves a rectangle corner keeping the opposite one, flipping when crossed', () => {
    expect(moveHandle(rect, 2, [400, 300], IMAGE).geometry).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 250,
    });
    // Bottom-right dragged above and left of the top-left corner.
    expect(moveHandle(rect, 2, [50, 10], IMAGE).geometry).toEqual({
      x: 50,
      y: 10,
      width: 50,
      height: 40,
    });
  });

  it('moves one polygon vertex or one line end, clamped', () => {
    expect(shapeHandles(moveHandle(triangle, 1, [60, -9], IMAGE))[1]).toEqual([60, 0]);
    const arrow: Shape2D = { kind: 'ARROW', geometry: { from: [0, 0], to: [5, 5], text: 'x' } };
    expect(moveHandle(arrow, 1, [7, 8], IMAGE)).toEqual({
      kind: 'ARROW',
      geometry: { from: [0, 0], to: [7, 8], text: 'x' },
    });
    expect(moveHandle(arrow, 5, [7, 8], IMAGE)).toBe(arrow);
  });
});

describe('measurement', () => {
  it('measures distance in px, or in mm with an anisotropic pixel spacing', () => {
    expect(distance([0, 0], [3, 4])).toBe(5);
    expect(distance([0, 0], [10, 10], [0.2, 0.15])).toBeCloseTo(Math.hypot(2, 1.5), 12);
  });

  it('computes a polygon area whatever the winding', () => {
    expect(
      polygonArea([
        [0, 0],
        [40, 0],
        [0, 30],
      ]),
    ).toBe(600);
    expect(
      polygonArea([
        [0, 0],
        [0, 30],
        [40, 0],
      ]),
    ).toBe(600);
  });

  it('reports lengths in mm with a pixel spacing and in px without', () => {
    const line: Shape2D = { kind: 'LENGTH', geometry: { from: [0, 0], to: [300, 400] } };
    expect(measureShape(line, [0.143, 0.143])).toEqual({ lengthMm: 71.5 });
    expect(measureShape(line, null)).toEqual({ lengthPx: 500 });
    // A broken spacing is ignored rather than producing a wrong mm value.
    expect(measureShape(line, [0, 0.1])).toEqual({ lengthPx: 500 });
  });

  it('reports areas of rectangles and polygons, nothing for arrows', () => {
    expect(measureShape(rect, [0.5, 0.2])).toEqual({ areaMm2: 2000 });
    expect(measureShape(triangle, null)).toEqual({ areaPx2: 600 });
    expect(
      measureShape({ kind: 'ARROW', geometry: { from: [0, 0], to: [1, 1], text: '' } }, null),
    ).toBeNull();
    expect(
      measureShape({ kind: 'LENGTH', geometry: { from: [1, 1], to: [1, 1] } }, null),
    ).toBeNull();
  });
});
