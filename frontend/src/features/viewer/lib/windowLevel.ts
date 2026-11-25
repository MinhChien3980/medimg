/**
 * Window/level (contrast/brightness) on 8-bit grayscale pixel data (pure, unit tested).
 *
 * A window maps the input interval [center - width/2, center + width/2] linearly onto
 * the display range [0, 255]; values outside are clamped.
 */

export interface WindowLevel {
  width: number;
  center: number;
}

/** Identity mapping for 8-bit data. */
export const DEFAULT_WINDOW: WindowLevel = { width: 255, center: 127.5 };

export const MIN_WINDOW_WIDTH = 1;
export const MAX_WINDOW_WIDTH = 512;
export const MIN_CENTER = -128;
export const MAX_CENTER = 383;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Display value (0..255) for one input value. */
export function windowValue(value: number, wl: WindowLevel): number {
  const width = Math.max(MIN_WINDOW_WIDTH, wl.width);
  const lower = wl.center - width / 2;
  return clamp(Math.round(((value - lower) / width) * 255), 0, 255);
}

/** 256-entry lookup table for `wl`. */
export function buildLut(wl: WindowLevel): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = windowValue(v, wl);
  return lut;
}

/**
 * Drag interaction: horizontal movement changes the width (contrast), vertical movement
 * the center (dragging down raises the center → darker image, as in common PACS viewers).
 */
export function adjustWindowLevel(
  start: WindowLevel,
  dx: number,
  dy: number,
  sensitivity = 1,
): WindowLevel {
  return {
    width: clamp(start.width + dx * sensitivity, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
    center: clamp(start.center + dy * sensitivity, MIN_CENTER, MAX_CENTER),
  };
}

/** Rec. 601 luma of RGBA pixels → one byte per pixel. */
export function toGrayscale(rgba: Uint8ClampedArray): Uint8Array {
  const n = Math.floor(rgba.length / 4);
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = Math.round(
      0.299 * (rgba[j] ?? 0) + 0.587 * (rgba[j + 1] ?? 0) + 0.114 * (rgba[j + 2] ?? 0),
    );
  }
  return out;
}

/** Writes `lut[gray]` into an RGBA buffer (opaque grey pixels). `out.length` = 4 × gray. */
export function applyLut(gray: Uint8Array, lut: Uint8ClampedArray, out: Uint8ClampedArray): void {
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const v = lut[gray[i] ?? 0] ?? 0;
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
}

/** Human readout, e.g. "W 255 / L 128". */
export function formatWindowLevel(wl: WindowLevel): string {
  return `W ${Math.round(wl.width)} / L ${Math.round(wl.center)}`;
}
