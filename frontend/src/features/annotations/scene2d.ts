/**
 * 2D annotations on screen. The SVG layer (`AnnotationLayer2D`) and the canvas painter used for
 * screenshots / key images both draw from `toScreenShape`, so what is captured is exactly what is
 * shown. Coordinates are CSS pixels of the viewer, through the same viewport transform as the image
 * (`imageToScreen`), so the annotations follow zoom and pan exactly.
 */
import type { Point2 } from '@/api/types';
import { imageToScreen, type Point, type Viewport } from '../viewer/lib/viewport';
import { labelAnchor, shapeHandles, type Shape2D } from './geometry2d';

export interface ScreenShape {
  /** Outline (closed for a rectangle or polygon). */
  points: Point[];
  closed: boolean;
  /** The two ends of the barbs of an arrow head at `points[1]`. */
  arrowHead: [Point, Point] | null;
  /** Ticks across both ends of a length. */
  endTicks: Array<[Point, Point]>;
  handles: Point[];
  /** Top-left anchor of the text label. */
  labelAt: Point;
}

const toPoint = (vp: Viewport, [x, y]: Point2): Point => imageToScreen(vp, { x, y });

/** Barb ends of an arrow head pointing at `to`, `size` screen px long. */
export function arrowHead(from: Point, to: Point, size = 14, spread = Math.PI / 7): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const barb = (sign: number): Point => ({
    x: to.x - size * Math.cos(angle + sign * spread),
    y: to.y - size * Math.sin(angle + sign * spread),
  });
  return [barb(1), barb(-1)];
}

/** Short segment across the line `from → to` at `at`, `size` px long. */
function tick(from: Point, to: Point, at: Point, size = 6): [Point, Point] {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const nx = (-(to.y - from.y) / length) * size;
  const ny = ((to.x - from.x) / length) * size;
  return [
    { x: at.x - nx, y: at.y - ny },
    { x: at.x + nx, y: at.y + ny },
  ];
}

export function toScreenShape(shape: Shape2D, vp: Viewport): ScreenShape {
  const handles = shapeHandles(shape).map((p) => toPoint(vp, p));
  const anchor = toPoint(vp, labelAnchor(shape));
  switch (shape.kind) {
    case 'RECTANGLE':
    case 'POLYGON':
      return {
        points: handles,
        closed: true,
        arrowHead: null,
        endTicks: [],
        handles,
        labelAt: { x: anchor.x, y: anchor.y - 6 },
      };
    case 'ARROW': {
      const [from, to] = handles as [Point, Point];
      return {
        points: [from, to],
        closed: false,
        arrowHead: arrowHead(from, to),
        endTicks: [],
        handles,
        labelAt: { x: from.x + 4, y: from.y - 6 },
      };
    }
    case 'LENGTH': {
      const [from, to] = handles as [Point, Point];
      return {
        points: [from, to],
        closed: false,
        arrowHead: null,
        endTicks: [tick(from, to, from), tick(from, to, to)],
        handles,
        labelAt: { x: anchor.x + 8, y: anchor.y - 8 },
      };
    }
  }
}

export const ANNOTATION_COLORS = {
  /** Editable by the current user. */
  own: '#ffd54f',
  /** Someone else's: shown, not editable. */
  other: '#90caf9',
  selected: '#5cc8cf',
  /** Being drawn. */
  draft: '#ffe082',
} as const;

export interface PaintItem {
  shape: Shape2D;
  /** Text shown next to the shape (label, arrow text, measurement); may be empty. */
  text: string;
  color: string;
}

/**
 * Paints annotations on a 2D context whose transform maps CSS pixels of the viewer (call it after
 * `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`). Used to bake the visible annotations into a capture.
 */
export function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  items: readonly PaintItem[],
  vp: Viewport,
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'bottom';
  for (const item of items) {
    const s = toScreenShape(item.shape, vp);
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 2;

    ctx.beginPath();
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (s.closed) ctx.closePath();
    ctx.stroke();

    for (const [a, b] of s.endTicks) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const tip = s.points[1];
    if (s.arrowHead && tip) {
      const [a, b] = s.arrowHead;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    if (item.text) {
      ctx.shadowBlur = 0;
      const width = ctx.measureText(item.text).width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(s.labelAt.x - 3, s.labelAt.y - 17, width + 6, 19);
      ctx.fillStyle = item.color;
      ctx.fillText(item.text, s.labelAt.x, s.labelAt.y);
    }
  }
  ctx.restore();
}
