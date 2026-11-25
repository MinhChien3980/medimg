import { describe, expect, it } from 'vitest';
import type { MeshArtifact, ModelDto } from '@/api/types';
import { SEG_LABELS, segMeshes, segModel, segPrediction } from '@/test/fixtures';
import {
  artifactKey,
  buildColorLut,
  buildStructures,
  defaultStyle,
  findLabelOrder,
  labelValue,
  normalizeHexColor,
  parseHexColor,
  type StructureStyle,
} from './structures';

describe('label → voxel value', () => {
  it('is the 1-based position of the label in the model order (0 is background)', () => {
    expect(labelValue(SEG_LABELS, 'liver')).toBe(1);
    expect(labelValue(SEG_LABELS, 'spleen')).toBe(2);
    expect(labelValue(SEG_LABELS, 'kidney_left')).toBe(3);
    expect(labelValue(SEG_LABELS, 'brain')).toBeNull();
    expect(labelValue(null, 'liver')).toBeNull();
  });

  it('takes the label order from the exact model (code and version) that produced the run', () => {
    const otherVersion: ModelDto = { ...segModel, version: '3.0.0', labels: ['spleen', 'liver'] };
    expect(findLabelOrder([otherVersion, segModel], segPrediction)).toEqual(SEG_LABELS);
    expect(findLabelOrder([otherVersion], segPrediction)).toBeNull();
    expect(findLabelOrder(undefined, segPrediction)).toBeNull();
  });

  it('maps meshes by label, never by their position in the array', () => {
    // segMeshes lists kidney_left before spleen.
    const structures = buildStructures(segMeshes, SEG_LABELS);
    const values = Object.fromEntries(structures.map((s) => [s.label, s.value]));
    expect(values).toEqual({ liver: 1, spleen: 2, kidney_left: 3 });
    // Largest first, colours normalised, centroid passed through untouched (LPS mm).
    expect(structures.map((s) => s.label)).toEqual(['liver', 'spleen', 'kidney_left']);
    expect(structures[0]).toMatchObject({ color: '#dc5a3c', centroid: [-62.5, 18.25, -410.0] });
  });

  it('keeps structures the model does not list, without a voxel value', () => {
    const mystery: MeshArtifact = { ...(segMeshes[0] as MeshArtifact), label: 'x', volumeMl: 1 };
    const structures = buildStructures([...segMeshes, mystery], SEG_LABELS);
    expect(structures.find((s) => s.label === 'x')?.value).toBeNull();
    expect(buildStructures(segMeshes, null).every((s) => s.value === null)).toBe(true);
  });
});

describe('colour LUT', () => {
  const structures = buildStructures(segMeshes, SEG_LABELS);
  const styles: Record<string, StructureStyle> = Object.fromEntries(
    structures.map((s) => [s.label, defaultStyle(s)]),
  );

  it('colours each voxel value with its structure colour and leaves the rest transparent', () => {
    const lut = buildColorLut(structures, styles, SEG_LABELS.length);
    expect(lut).toHaveLength(SEG_LABELS.length + 1);
    expect(lut[0]).toEqual([0, 0, 0, 0]);
    expect(lut[1]).toEqual([0xdc, 0x5a, 0x3c, 255]); // liver
    expect(lut[2]).toEqual([0x9e, 0x4f, 0xc0, 255]); // spleen
    expect(lut[3]).toEqual([0xb4, 0xa0, 0x3c, 255]); // kidney_left
    expect(lut[4]).toEqual([0, 0, 0, 0]); // kidney_right: no structure
  });

  it('applies the user colour, opacity and visibility', () => {
    const lut = buildColorLut(
      structures,
      {
        ...styles,
        liver: { visible: true, color: '#00ff00', opacity: 0.5 },
        spleen: { visible: false, color: '#9e4fc0', opacity: 1 },
      },
      SEG_LABELS.length,
    );
    expect(lut[1]).toEqual([0, 255, 0, 128]);
    expect(lut[2]?.[3]).toBe(0);
  });

  it('ignores values beyond the label count', () => {
    expect(buildColorLut(structures, styles, 2)).toHaveLength(3);
  });
});

describe('helpers', () => {
  it('parses #rrggbb colours and rejects anything else', () => {
    expect(parseHexColor('#0A0b0C')).toEqual([10, 11, 12]);
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('#fff')).toBeNull();
    expect(normalizeHexColor('#ABCDEF')).toBe('#abcdef');
    expect(normalizeHexColor('nope')).toBe('#a0a0a0');
  });

  it('identifies an object independently of its presigned signature', () => {
    expect(artifactKey('/medimg/a/volume.nii.gz?X-Amz-Signature=1')).toBe(
      artifactKey('/medimg/a/volume.nii.gz?X-Amz-Signature=2'),
    );
    expect(artifactKey('/medimg/a/b.glb')).toBe('/medimg/a/b.glb');
  });
});
