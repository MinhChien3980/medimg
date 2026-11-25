import { describe, expect, it } from 'vitest';
import type { VolumeGeometry } from '@/api/types';
import {
  annotationCenter,
  displayKey,
  fromCornerstoneAnnotation,
  hasStats,
  kindOfTool,
  measurementFromStats,
  parseVolumeGeometry,
  toCornerstoneAnnotation,
  type CsAnnotation,
  type MprAnnotationInput,
} from './annotationConverters';

const AXIAL: Pick<VolumeGeometry, 'viewPlaneNormal' | 'viewUp'> = {
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
};

const ellipse: MprAnnotationInput = {
  uid: 'a1',
  kind: 'ELLIPSE_ROI',
  geometry: {
    points: [
      [-60, 30, -410],
      [-60, 10, -410],
      [-70, 20, -410],
      [-50, 20, -410],
    ],
    ...AXIAL,
    sliceIndex: 42,
  },
  label: 'Liver lesion',
  locked: false,
};

/** Shape of an annotation as Cornerstone3D 5.19 creates it on a volume viewport. */
function drawn(overrides: Partial<CsAnnotation['metadata']> = {}, stats?: Record<string, unknown>) {
  return {
    annotationUID: 'cs-uid',
    metadata: {
      toolName: 'RectangleROI',
      FrameOfReferenceUID: 'for-1',
      viewPlaneNormal: [0, 0, -1],
      viewUp: [0, -1, 0],
      sliceIndex: 12,
      cameraFocalPoint: [0, 0, -400],
      ...overrides,
    },
    data: {
      handles: {
        points: [
          [-10.12345, 5, -400],
          [10, 5, -400],
          [-10, -5, -400],
          [10, -5, -400],
        ],
        textBox: {},
      },
      label: '',
      cachedStats: stats ? { 'volumeId:x': stats } : {},
    },
  } satisfies CsAnnotation;
}

describe('kinds and tools', () => {
  it('maps the three Cornerstone tools, nothing else', () => {
    expect(kindOfTool('RectangleROI')).toBe('RECTANGLE_ROI');
    expect(kindOfTool('EllipticalROI')).toBe('ELLIPSE_ROI');
    expect(kindOfTool('Length')).toBe('LENGTH');
    expect(kindOfTool('Crosshairs')).toBeNull();
    expect(kindOfTool(undefined)).toBeNull();
  });
});

describe('toCornerstoneAnnotation', () => {
  it('builds an annotation shown on the plane it was drawn on, stats to be computed', () => {
    const cs = toCornerstoneAnnotation(ellipse, 'for-1');
    expect(cs.annotationUID).toBe('a1');
    expect(cs.metadata).toEqual({
      toolName: 'EllipticalROI',
      FrameOfReferenceUID: 'for-1',
      viewPlaneNormal: [0, 0, -1],
      viewUp: [0, -1, 0],
      sliceIndex: 42,
    });
    expect(cs.data.handles.points).toEqual(ellipse.geometry.points);
    expect(cs.data.label).toBe('Liver lesion');
    expect(cs.data.cachedStats).toEqual({});
    expect(cs.invalidated).toBe(true);
    expect(cs.isLocked).toBe(false);
  });

  it('copies the points (Cornerstone mutates handles while dragging)', () => {
    const cs = toCornerstoneAnnotation(ellipse, 'for-1');
    (cs.data.handles.points[0] as number[])[0] = 999;
    expect(ellipse.geometry.points[0]?.[0]).toBe(-60);
  });

  it('locks annotations the user may not edit', () => {
    expect(toCornerstoneAnnotation({ ...ellipse, locked: true }, 'f').isLocked).toBe(true);
  });
});

describe('fromCornerstoneAnnotation', () => {
  it('keeps the world points (rounded to µm) and the view plane', () => {
    const converted = fromCornerstoneAnnotation(drawn(), { hounsfield: true });
    expect(converted).toEqual({
      kind: 'RECTANGLE_ROI',
      geometry: {
        points: [
          [-10.123, 5, -400],
          [10, 5, -400],
          [-10, -5, -400],
          [10, -5, -400],
        ],
        viewPlaneNormal: [0, 0, -1],
        viewUp: [0, -1, 0],
        sliceIndex: 12,
      },
      measurement: null,
    });
  });

  it('round-trips with toCornerstoneAnnotation', () => {
    const back = fromCornerstoneAnnotation(toCornerstoneAnnotation(ellipse, 'f'), {
      hounsfield: true,
    });
    expect(back?.kind).toBe('ELLIPSE_ROI');
    expect(back?.geometry).toEqual(ellipse.geometry);
    expect(displayKey({ ...ellipse, geometry: back?.geometry ?? ellipse.geometry })).toBe(
      displayKey(ellipse),
    );
  });

  it('takes the view plane from the view when the metadata lacks it', () => {
    const converted = fromCornerstoneAnnotation(
      drawn({ viewPlaneNormal: undefined, viewUp: undefined }),
      { hounsfield: true, fallback: { viewPlaneNormal: [1, 0, 0], viewUp: [0, 0, 1] } },
    );
    expect(converted?.geometry.viewPlaneNormal).toEqual([1, 0, 0]);
    expect(converted?.geometry.viewUp).toEqual([0, 0, 1]);
  });

  it('ignores other tools and malformed annotations', () => {
    expect(
      fromCornerstoneAnnotation(drawn({ toolName: 'Probe' }), { hounsfield: true }),
    ).toBeNull();
    const twoPoints = drawn();
    twoPoints.data.handles.points = twoPoints.data.handles.points.slice(0, 2);
    expect(fromCornerstoneAnnotation(twoPoints, { hounsfield: true })).toBeNull();
    expect(
      fromCornerstoneAnnotation(drawn({ viewUp: undefined }), { hounsfield: true }),
    ).toBeNull();
  });
});

describe('measurementFromStats', () => {
  const roiStats = {
    area: 314.159,
    areaUnit: 'mm²',
    mean: 54.36,
    stdDev: 12.04,
    modalityUnit: 'HU',
  };

  it('reports area, mean and SD (HU) of an ROI on a CT', () => {
    expect(measurementFromStats('ELLIPSE_ROI', { t: roiStats }, true)).toEqual({
      areaMm2: 314.16,
      meanHu: 54.4,
      stdHu: 12,
    });
  });

  it('drops mean and SD on a volume that is not in HU', () => {
    expect(measurementFromStats('RECTANGLE_ROI', { t: roiStats }, false)).toEqual({
      areaMm2: 314.16,
    });
  });

  it('reports a length in mm, never uncalibrated pixels', () => {
    expect(measurementFromStats('LENGTH', { t: { length: 42.1234, unit: 'mm' } }, true)).toEqual({
      lengthMm: 42.12,
    });
    expect(measurementFromStats('LENGTH', { t: { length: 42, unit: 'px' } }, true)).toBeNull();
    expect(
      measurementFromStats('RECTANGLE_ROI', { t: { area: 4, areaUnit: 'px²' } }, false),
    ).toBeNull();
  });

  it('skips empty stats entries and non-finite values', () => {
    expect(measurementFromStats('ELLIPSE_ROI', {}, true)).toBeNull();
    expect(
      measurementFromStats(
        'ELLIPSE_ROI',
        { a: {}, b: { area: 10, areaUnit: 'mm²', mean: NaN } },
        true,
      ),
    ).toEqual({ areaMm2: 10 });
  });

  it('is read when converting', () => {
    const converted = fromCornerstoneAnnotation(drawn({}, roiStats), { hounsfield: true });
    expect(converted?.measurement).toEqual({ areaMm2: 314.16, meanHu: 54.4, stdHu: 12 });
  });
});

describe('helpers', () => {
  it('knows when the statistics are ready', () => {
    expect(hasStats(drawn())).toBe(false);
    expect(hasStats(drawn({}, { area: 1, areaUnit: 'mm²' }))).toBe(true);
    expect(hasStats(drawn({ toolName: 'Length' }, { length: 3, unit: 'mm' }))).toBe(true);
  });

  it('validates stored geometry', () => {
    expect(
      parseVolumeGeometry('LENGTH', {
        points: [
          [0, 0, 0],
          [1, 1, 1],
        ],
        ...AXIAL,
      }),
    ).toEqual({
      points: [
        [0, 0, 0],
        [1, 1, 1],
      ],
      ...AXIAL,
    });
    expect(
      parseVolumeGeometry('LENGTH', {
        points: [
          [0, 0],
          [1, 1],
        ],
        ...AXIAL,
      }),
    ).toBeNull();
    expect(parseVolumeGeometry('RECTANGLE_ROI', { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });

  it('centres the crosshair on the annotation', () => {
    expect(annotationCenter(ellipse.geometry)).toEqual([-60, 20, -410]);
  });
});
