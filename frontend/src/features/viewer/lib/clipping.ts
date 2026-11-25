import type { Vec3 } from '@/api/types';

/** Axis-aligned box in LPS mm. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export type Axis = 0 | 1 | 2;
export const AXES: readonly Axis[] = [0, 1, 2];

/** Kept interval per axis, `[low, high]` in LPS mm. */
export type ClipBox = [[number, number], [number, number], [number, number]];

/** A half-space `normal · p + constant >= 0` (the convention of `THREE.Plane` clipping). */
export interface ClipPlane {
  normal: Vec3;
  constant: number;
}

const unit = (axis: Axis, sign: 1 | -1): Vec3 => {
  const n: Vec3 = [0, 0, 0];
  n[axis] = sign;
  return n;
};

/** Union of the boxes, or null when there is none. */
export function unionBounds(boxes: readonly Bounds[]): Bounds | null {
  if (boxes.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (const a of AXES) {
      min[a] = Math.min(min[a], b.min[a]);
      max[a] = Math.max(max[a], b.max[a]);
    }
  }
  return { min, max };
}

/** Slider range for an axis: whole millimetres that contain the bounds. */
export function sliderRange(bounds: Bounds, axis: Axis): [number, number] {
  return [Math.floor(bounds.min[axis]), Math.ceil(bounds.max[axis])];
}

/** The box that clips nothing. */
export function fullClipBox(bounds: Bounds): ClipBox {
  return [sliderRange(bounds, 0), sliderRange(bounds, 1), sliderRange(bounds, 2)];
}

/** Keeps a box inside new bounds (e.g. after more meshes loaded); a full axis stays full. */
export function fitClipBox(box: ClipBox | null, previous: Bounds | null, next: Bounds): ClipBox {
  const full = fullClipBox(next);
  if (!box || !previous) return full;
  const prevFull = fullClipBox(previous);
  return AXES.map((a) => {
    const [lo, hi] = box[a];
    const [fLo, fHi] = full[a];
    const [pLo, pHi] = prevFull[a];
    const low = lo <= pLo ? fLo : Math.min(Math.max(lo, fLo), fHi);
    const high = hi >= pHi ? fHi : Math.max(Math.min(hi, fHi), low);
    return [low, high];
  }) as ClipBox;
}

/** Planes for the clipped sides only (an untouched side adds no plane). */
export function clipPlanes(box: ClipBox, bounds: Bounds): ClipPlane[] {
  const full = fullClipBox(bounds);
  const planes: ClipPlane[] = [];
  for (const a of AXES) {
    const [lo, hi] = box[a];
    if (lo > full[a][0]) planes.push({ normal: unit(a, 1), constant: -lo });
    if (hi < full[a][1]) planes.push({ normal: unit(a, -1), constant: hi });
  }
  return planes;
}

/** Whether a point survives the planes (used by tests and picking). */
export function isKept(point: Vec3, planes: readonly ClipPlane[]): boolean {
  return planes.every(
    (p) =>
      p.normal[0] * point[0] + p.normal[1] * point[1] + p.normal[2] * point[2] + p.constant >= 0,
  );
}
