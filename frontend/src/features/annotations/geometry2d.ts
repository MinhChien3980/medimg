/**
 * 2D annotation geometry in image pixels (pure functions, unit tested).
 *
 * Coordinates follow the API: origin at the top-left corner of the image, x to the right, y down,
 * in pixels of the stored image (not of the screen). Everything here is independent of the
 * viewport; `scene2d.ts` maps shapes to the screen.
 */
import type {
  Annotation2DKind,
  ArrowGeometry,
  LineGeometry,
  Measurement,
  Point2,
  PolygonGeometry,
  RectangleGeometry,
} from '@/api/types';

export type Shape2D =
  | { kind: 'RECTANGLE'; geometry: RectangleGeometry }
  | { kind: 'POLYGON'; geometry: PolygonGeometry }
  | { kind: 'ARROW'; geometry: ArrowGeometry }
  | { kind: 'LENGTH'; geometry: LineGeometry };

export interface ImageSize {
  width: number;
  height: number;
}

/** Pixel spacing `[x, y]` in mm (column spacing, row spacing), or null when unknown. */
export type PixelSpacing = readonly [number, number] | null | undefined;

export const POLYGON_MIN_POINTS = 3;
export const POLYGON_MAX_POINTS = 200;
export const ARROW_TEXT_MAX = 100;

export const ANNOTATION_2D_KINDS: readonly Annotation2DKind[] = [
  'RECTANGLE',
  'POLYGON',
  'ARROW',
  'LENGTH',
];

// ---------- parsing (server data is not trusted blindly) ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asPoint(value: unknown): Point2 | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value as unknown[];
  return isFiniteNumber(x) && isFiniteNumber(y) ? [x, y] : null;
}

/** Shape of a stored 2D annotation, or null when kind and geometry do not match. */
export function parseShape2D(kind: string, geometry: unknown): Shape2D | null {
  if (!isRecord(geometry)) return null;
  switch (kind) {
    case 'RECTANGLE': {
      const { x, y, width, height } = geometry;
      if (![x, y, width, height].every(isFiniteNumber)) return null;
      return {
        kind,
        geometry: {
          x: x as number,
          y: y as number,
          width: width as number,
          height: height as number,
        },
      };
    }
    case 'POLYGON': {
      if (!Array.isArray(geometry.points)) return null;
      const points = (geometry.points as unknown[]).map(asPoint);
      if (points.some((p) => p === null)) return null;
      return { kind, geometry: { points: points as Point2[] } };
    }
    case 'ARROW': {
      const from = asPoint(geometry.from);
      const to = asPoint(geometry.to);
      if (!from || !to) return null;
      const text = typeof geometry.text === 'string' ? geometry.text : '';
      return { kind, geometry: { from, to, text } };
    }
    case 'LENGTH': {
      const from = asPoint(geometry.from);
      const to = asPoint(geometry.to);
      if (!from || !to) return null;
      return { kind, geometry: { from, to } };
    }
    default:
      return null;
  }
}

/** The checks the server applies: finite numbers, inside the image, enough points. */
export function isValidShape(shape: Shape2D, size: ImageSize): boolean {
  const inside = ([x, y]: Point2) =>
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= size.width &&
    y <= size.height;
  switch (shape.kind) {
    case 'RECTANGLE': {
      const { x, y, width, height } = shape.geometry;
      return width > 0 && height > 0 && inside([x, y]) && inside([x + width, y + height]);
    }
    case 'POLYGON': {
      const { points } = shape.geometry;
      return (
        points.length >= POLYGON_MIN_POINTS &&
        points.length <= POLYGON_MAX_POINTS &&
        points.every(inside)
      );
    }
    case 'ARROW':
    case 'LENGTH':
      return (
        inside(shape.geometry.from) &&
        inside(shape.geometry.to) &&
        distance(shape.geometry.from, shape.geometry.to) > 0
      );
  }
}

// ---------- construction ----------

export function clampPoint([x, y]: Point2, size: ImageSize): Point2 {
  return [Math.min(size.width, Math.max(0, x)), Math.min(size.height, Math.max(0, y))];
}

/** Axis-aligned rectangle spanned by two opposite corners, in any order. */
export function rectFromCorners(a: Point2, b: Point2): RectangleGeometry {
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(b[0] - a[0]),
    height: Math.abs(b[1] - a[1]),
  };
}

/**
 * Shape drawn by a drag from `start` to `end` (rectangle, arrow, length), both clamped to the
 * image. Arrows point from where the drag started to where it ended.
 */
export function shapeFromDrag(
  kind: Exclude<Annotation2DKind, 'POLYGON'>,
  start: Point2,
  end: Point2,
  size: ImageSize,
): Shape2D {
  const a = clampPoint(start, size);
  const b = clampPoint(end, size);
  switch (kind) {
    case 'RECTANGLE':
      return { kind, geometry: rectFromCorners(a, b) };
    case 'ARROW':
      return { kind, geometry: { from: a, to: b, text: '' } };
    case 'LENGTH':
      return { kind, geometry: { from: a, to: b } };
  }
}

/** Rounds coordinates to 1/100 px: plenty for display, and stable JSON. */
export function roundShape(shape: Shape2D): Shape2D {
  const r = (v: number) => Math.round(v * 100) / 100;
  const rp = ([x, y]: Point2): Point2 => [r(x), r(y)];
  switch (shape.kind) {
    case 'RECTANGLE': {
      const { x, y, width, height } = shape.geometry;
      return {
        kind: 'RECTANGLE',
        geometry: { x: r(x), y: r(y), width: r(width), height: r(height) },
      };
    }
    case 'POLYGON':
      return { kind: 'POLYGON', geometry: { points: shape.geometry.points.map(rp) } };
    case 'ARROW':
      return {
        kind: 'ARROW',
        geometry: { ...shape.geometry, from: rp(shape.geometry.from), to: rp(shape.geometry.to) },
      };
    case 'LENGTH':
      return {
        kind: 'LENGTH',
        geometry: { from: rp(shape.geometry.from), to: rp(shape.geometry.to) },
      };
  }
}

// ---------- editing ----------

/**
 * Editable points of a shape: rectangle = corners clockwise from the top-left, polygon = its
 * vertices, arrow / length = `[from, to]`.
 */
export function shapeHandles(shape: Shape2D): Point2[] {
  switch (shape.kind) {
    case 'RECTANGLE': {
      const { x, y, width, height } = shape.geometry;
      return [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ];
    }
    case 'POLYGON':
      return shape.geometry.points.map(([x, y]) => [x, y]);
    case 'ARROW':
    case 'LENGTH':
      return [shape.geometry.from, shape.geometry.to];
  }
}

function boundsOf(points: readonly Point2[]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/**
 * Moves the whole shape by `(dx, dy)` image pixels; the move is limited so that the shape stays
 * inside the image (it slides along an edge instead of leaving it).
 */
export function translateShape(shape: Shape2D, dx: number, dy: number, size: ImageSize): Shape2D {
  const b = boundsOf(shapeHandles(shape));
  const tx = Math.min(size.width - b.maxX, Math.max(-b.minX, dx));
  const ty = Math.min(size.height - b.maxY, Math.max(-b.minY, dy));
  const move = ([x, y]: Point2): Point2 => [x + tx, y + ty];
  switch (shape.kind) {
    case 'RECTANGLE':
      return {
        kind: 'RECTANGLE',
        geometry: { ...shape.geometry, x: shape.geometry.x + tx, y: shape.geometry.y + ty },
      };
    case 'POLYGON':
      return { kind: 'POLYGON', geometry: { points: shape.geometry.points.map(move) } };
    case 'ARROW':
      return {
        kind: 'ARROW',
        geometry: {
          ...shape.geometry,
          from: move(shape.geometry.from),
          to: move(shape.geometry.to),
        },
      };
    case 'LENGTH':
      return {
        kind: 'LENGTH',
        geometry: { from: move(shape.geometry.from), to: move(shape.geometry.to) },
      };
  }
}

/**
 * Moves handle `index` (see `shapeHandles`) to `point`, clamped to the image. For a rectangle the
 * opposite corner stays where it is, so dragging a corner across it flips the rectangle.
 */
export function moveHandle(shape: Shape2D, index: number, point: Point2, size: ImageSize): Shape2D {
  const p = clampPoint(point, size);
  switch (shape.kind) {
    case 'RECTANGLE': {
      const corners = shapeHandles(shape);
      const opposite = corners[(index + 2) % 4];
      if (!opposite || index < 0 || index > 3) return shape;
      return { kind: 'RECTANGLE', geometry: rectFromCorners(opposite, p) };
    }
    case 'POLYGON': {
      if (index < 0 || index >= shape.geometry.points.length) return shape;
      const points = shape.geometry.points.map((q, i): Point2 => (i === index ? p : q));
      return { kind: 'POLYGON', geometry: { points } };
    }
    case 'ARROW':
      if (index === 0) return { kind: 'ARROW', geometry: { ...shape.geometry, from: p } };
      if (index === 1) return { kind: 'ARROW', geometry: { ...shape.geometry, to: p } };
      return shape;
    case 'LENGTH':
      if (index === 0) return { kind: 'LENGTH', geometry: { ...shape.geometry, from: p } };
      if (index === 1) return { kind: 'LENGTH', geometry: { ...shape.geometry, to: p } };
      return shape;
  }
}

/** Where the label of a shape is anchored (image pixels). */
export function labelAnchor(shape: Shape2D): Point2 {
  switch (shape.kind) {
    case 'RECTANGLE':
      return [shape.geometry.x, shape.geometry.y];
    case 'POLYGON': {
      const b = boundsOf(shape.geometry.points);
      return [b.minX, b.minY];
    }
    case 'ARROW':
      return shape.geometry.from;
    case 'LENGTH': {
      const { from, to } = shape.geometry;
      return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    }
  }
}

// ---------- measurement ----------

/** Distance between two image points: in mm with a pixel spacing, in pixels otherwise. */
export function distance(a: Point2, b: Point2, spacing?: PixelSpacing): number {
  const sx = spacing?.[0] ?? 1;
  const sy = spacing?.[1] ?? 1;
  return Math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy);
}

/** Area of a simple polygon (shoelace formula), always positive, in square pixels. */
export function polygonArea(points: readonly Point2[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i] ?? [0, 0];
    const [x2, y2] = points[(i + 1) % points.length] ?? [0, 0];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

function usableSpacing(spacing: PixelSpacing): readonly [number, number] | null {
  if (!spacing) return null;
  const [x, y] = spacing;
  return x > 0 && y > 0 && Number.isFinite(x) && Number.isFinite(y) ? spacing : null;
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * What the client measures and sends with the annotation: the length of a LENGTH, the area of a
 * rectangle or polygon. In mm / mm² with a pixel spacing, otherwise in px / px² (and said so).
 * Arrows measure nothing; a zero-sized shape neither.
 */
export function measureShape(shape: Shape2D, pixelSpacing: PixelSpacing): Measurement | null {
  const spacing = usableSpacing(pixelSpacing);
  const pixelArea = spacing ? spacing[0] * spacing[1] : 1;
  let area: number | null = null;
  switch (shape.kind) {
    case 'LENGTH': {
      const length = distance(shape.geometry.from, shape.geometry.to, spacing);
      if (length <= 0) return null;
      return spacing ? { lengthMm: round(length) } : { lengthPx: round(length) };
    }
    case 'ARROW':
      return null;
    case 'RECTANGLE':
      area = shape.geometry.width * shape.geometry.height;
      break;
    case 'POLYGON':
      area = polygonArea(shape.geometry.points);
      break;
  }
  if (!(area > 0)) return null;
  return spacing ? { areaMm2: round(area * pixelArea) } : { areaPx2: round(area) };
}
