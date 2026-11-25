import { describe, expect, it } from 'vitest';
import {
  clipPlanes,
  fitClipBox,
  fullClipBox,
  isKept,
  sliderRange,
  unionBounds,
  type Bounds,
} from './clipping';

const liver: Bounds = { min: [-120.2, -10, -470.5], max: [-20, 60, -380] };
const spleen: Bounds = { min: [60, 20, -430], max: [110.7, 90.3, -390] };
const both: Bounds = { min: [-120.2, -10, -470.5], max: [110.7, 90.3, -380] };

describe('clipping', () => {
  it('unions the mesh bounds', () => {
    expect(unionBounds([])).toBeNull();
    expect(unionBounds([liver, spleen])).toEqual(both);
  });

  it('offers whole-millimetre slider ranges that contain every mesh', () => {
    expect(sliderRange(both, 0)).toEqual([-121, 111]);
    expect(sliderRange(both, 2)).toEqual([-471, -380]);
  });

  it('adds no plane until a side is moved', () => {
    expect(clipPlanes(fullClipBox(liver), liver)).toEqual([]);
  });

  it('keeps points inside the box only (THREE.Plane convention: n·p + c >= 0)', () => {
    const box = fullClipBox(liver);
    box[0] = [-100, -50];
    box[2] = [-471, -400];
    const planes = clipPlanes(box, liver);
    expect(planes).toEqual([
      { normal: [1, 0, 0], constant: 100 },
      { normal: [-1, 0, 0], constant: -50 },
      { normal: [0, 0, -1], constant: -400 },
    ]);
    expect(isKept([-75, 0, -420], planes)).toBe(true);
    expect(isKept([-40, 0, -420], planes)).toBe(false); // beyond x = -50
    expect(isKept([-75, 0, -390], planes)).toBe(false); // above z = -400
  });

  it('keeps the user box when more meshes load, and full axes stay full', () => {
    const first = fullClipBox(liver);
    first[0] = [-100, -50];
    const fitted = fitClipBox(first, liver, both);
    expect(fitted[0]).toEqual([-100, -50]);
    expect(fitted[1]).toEqual(sliderRange(both, 1));
    expect(fitClipBox(null, null, both)).toEqual(fullClipBox(both));
  });
});
