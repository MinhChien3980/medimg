import { describe, expect, it } from 'vitest';
import { CT_WINDOW_PRESETS, fromVoiRange, matchPreset, toVoiRange } from './ctWindow';

describe('CT window presets', () => {
  it('are soft tissue 400/40, lung 1500/-600 and bone 1800/400', () => {
    expect(CT_WINDOW_PRESETS).toEqual([
      { id: 'softTissue', width: 400, center: 40 },
      { id: 'lung', width: 1500, center: -600 },
      { id: 'bone', width: 1800, center: 400 },
    ]);
  });

  it('map to a VOI range with the DICOM linear formula, and back', () => {
    expect(toVoiRange({ width: 400, center: 40 })).toEqual({ lower: -160, upper: 239 });
    expect(toVoiRange({ width: 1500, center: -600 })).toEqual({ lower: -1350, upper: 149 });
    for (const p of CT_WINDOW_PRESETS) {
      expect(fromVoiRange(toVoiRange(p))).toEqual({ width: p.width, center: p.center });
    }
  });

  it('recognises a preset after rounding, and a custom window as none', () => {
    expect(matchPreset({ width: 1500.2, center: -599.7 })).toBe('lung');
    expect(matchPreset({ width: 1701, center: -149.5 })).toBeNull();
  });
});
