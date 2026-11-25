import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW,
  MAX_WINDOW_WIDTH,
  MIN_WINDOW_WIDTH,
  adjustWindowLevel,
  applyLut,
  buildLut,
  formatWindowLevel,
  toGrayscale,
  windowValue,
} from './windowLevel';

describe('windowValue / buildLut', () => {
  it('default window is the identity', () => {
    const lut = buildLut(DEFAULT_WINDOW);
    for (let v = 0; v < 256; v++) expect(lut[v]).toBe(v);
  });

  it('narrow window increases contrast and clamps outside values', () => {
    const wl = { width: 100, center: 128 }; // [78, 178] → [0, 255]
    expect(windowValue(78, wl)).toBe(0);
    expect(windowValue(128, wl)).toBe(128);
    expect(windowValue(178, wl)).toBe(255);
    expect(windowValue(10, wl)).toBe(0);
    expect(windowValue(250, wl)).toBe(255);
  });

  it('raising the center darkens the image', () => {
    expect(windowValue(128, { width: 255, center: 160 })).toBeLessThan(
      windowValue(128, DEFAULT_WINDOW),
    );
  });

  it('guards against zero width', () => {
    expect(windowValue(128, { width: 0, center: 128 })).toBe(128);
  });
});

describe('adjustWindowLevel', () => {
  it('maps dx to width and dy to center', () => {
    expect(adjustWindowLevel({ width: 200, center: 100 }, 20, -10)).toEqual({
      width: 220,
      center: 90,
    });
  });

  it('applies sensitivity and clamps width', () => {
    expect(adjustWindowLevel({ width: 10, center: 0 }, -100, 0, 2).width).toBe(MIN_WINDOW_WIDTH);
    expect(adjustWindowLevel({ width: 500, center: 0 }, 100, 0).width).toBe(MAX_WINDOW_WIDTH);
  });
});

describe('pixel helpers', () => {
  it('toGrayscale uses Rec.601 luma', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 10, 10, 10, 255]);
    expect(Array.from(toGrayscale(rgba))).toEqual([76, 150, 10]);
  });

  it('applyLut writes opaque grey RGBA', () => {
    const gray = new Uint8Array([0, 128, 255]);
    const lut = buildLut({ width: 255, center: 255 }); // shifted: everything darker
    const out = new Uint8ClampedArray(12);
    applyLut(gray, lut, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 1, 1, 1, 255, 128, 128, 128, 255]);
  });

  it('formats a readout', () => {
    expect(formatWindowLevel({ width: 254.6, center: 127.5 })).toBe('W 255 / L 128');
  });
});
