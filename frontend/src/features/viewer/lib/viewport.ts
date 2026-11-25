/**
 * 2D viewport math (pure functions, unit tested).
 *
 * Mapping from image pixels to screen (CSS) pixels:
 *   screen = image * scale + offset
 */

export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 40;

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(max, Math.max(min, scale));
}

/** Largest scale at which the whole image fits, centred, with `padding` px around it. */
export function fitViewport(image: Size, view: Size, padding = 0): Viewport {
  if (image.width <= 0 || image.height <= 0 || view.width <= 0 || view.height <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const availW = Math.max(1, view.width - 2 * padding);
  const availH = Math.max(1, view.height - 2 * padding);
  const scale = clampScale(Math.min(availW / image.width, availH / image.height));
  return {
    scale,
    offsetX: (view.width - image.width * scale) / 2,
    offsetY: (view.height - image.height * scale) / 2,
  };
}

export function screenToImage(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.offsetX) / vp.scale, y: (p.y - vp.offsetY) / vp.scale };
}

export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, offsetX: vp.offsetX + dx, offsetY: vp.offsetY + dy };
}

/**
 * Multiplies the scale by `factor` keeping the image point under `anchor` (screen px)
 * fixed on screen. The resulting scale is clamped to [MIN_SCALE, MAX_SCALE].
 */
export function zoomAt(vp: Viewport, factor: number, anchor: Point): Viewport {
  if (!Number.isFinite(factor) || factor <= 0) return vp;
  const scale = clampScale(vp.scale * factor);
  const imagePoint = screenToImage(vp, anchor);
  return {
    scale,
    offsetX: anchor.x - imagePoint.x * scale,
    offsetY: anchor.y - imagePoint.y * scale,
  };
}

/** Mouse-wheel delta (px) → zoom factor. Wheel up (negative delta) zooms in. */
export function wheelZoomFactor(deltaY: number, sensitivity = 0.0015): number {
  return Math.exp(-deltaY * sensitivity);
}

/** Vertical drag distance (px) → zoom factor. Dragging up zooms in. */
export function dragZoomFactor(dy: number, sensitivity = 0.01): number {
  return Math.exp(-dy * sensitivity);
}
