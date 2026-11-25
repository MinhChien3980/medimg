import type { MeshArtifact, ModelDto, PredictionDto, Vec3 } from '@/api/types';

/**
 * Segmented structures of one run and how they map onto `segmentation.nii.gz`.
 *
 * Mapping rule (see Contracts in the root README): the labelmap stores voxel value `i + 1` for the i-th label of the
 * model (`ModelDto.labels`, 0 = background). `meshes[]` only lists the structures that are present,
 * in any order, so the label order must come from the model that produced the run, never from the
 * position of a mesh in the array. A structure whose label the model does not list gets no voxel
 * value: it is still shown in 3D but cannot be overlaid on the MPR.
 */
export interface Structure {
  label: string;
  /** Voxel value in the labelmap, or null when the label order is unknown. */
  value: number | null;
  /** Colour chosen by the worker, `#rrggbb` (lower case). */
  color: string;
  volumeMl: number;
  /** LPS mm. */
  centroid: Vec3;
  meshUrl: string;
  triangles: number;
}

/** What the user changed; applies to both MPR and 3D. */
export interface StructureStyle {
  visible: boolean;
  /** `#rrggbb` */
  color: string;
  /** 0..1 */
  opacity: number;
}

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

const HEX_COLOR = /^#([0-9a-f]{6})$/i;
const FALLBACK_COLOR = '#a0a0a0';

export function parseHexColor(hex: string): Rgb | null {
  const match = HEX_COLOR.exec(hex.trim());
  if (!match?.[1]) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function normalizeHexColor(hex: string): string {
  return parseHexColor(hex) ? hex.trim().toLowerCase() : FALLBACK_COLOR;
}

/** Voxel value of `label` in the labelmap of a model with `labelOrder`, or null. */
export function labelValue(labelOrder: readonly string[] | null, label: string): number | null {
  if (!labelOrder) return null;
  const index = labelOrder.indexOf(label);
  return index < 0 ? null : index + 1;
}

/**
 * Label order of the model that produced the run: same code and version. Another version of the
 * same model may have a different order, so it is not used.
 */
export function findLabelOrder(
  models: readonly ModelDto[] | undefined,
  run: Pick<PredictionDto, 'model'>,
): string[] | null {
  const model = models?.find((m) => m.code === run.model.code && m.version === run.model.version);
  return model ? model.labels : null;
}

export function buildStructures(
  meshes: readonly MeshArtifact[],
  labelOrder: readonly string[] | null,
): Structure[] {
  return meshes
    .map((m) => ({
      label: m.label,
      value: labelValue(labelOrder, m.label),
      color: normalizeHexColor(m.color),
      volumeMl: m.volumeMl,
      centroid: m.centroid,
      meshUrl: m.url,
      triangles: m.triangles,
    }))
    .sort((a, b) => b.volumeMl - a.volumeMl);
}

export function defaultStyle(structure: Structure): StructureStyle {
  return { visible: true, color: structure.color, opacity: 1 };
}

/**
 * Cornerstone colour LUT for the labelmap: entry `v` is the RGBA (0..255) of voxel value `v`.
 * Background and labels without a structure (absent, or under 1 ml) are fully transparent, and so
 * are hidden structures.
 */
export function buildColorLut(
  structures: readonly Structure[],
  styles: Readonly<Record<string, StructureStyle>>,
  labelCount: number,
): Rgba[] {
  const lut: Rgba[] = Array.from({ length: labelCount + 1 }, () => [0, 0, 0, 0]);
  for (const s of structures) {
    if (s.value === null || s.value > labelCount) continue;
    const style = styles[s.label] ?? defaultStyle(s);
    const [r, g, b] = parseHexColor(style.color) ?? parseHexColor(s.color) ?? [160, 160, 160];
    const alpha = style.visible ? Math.round(Math.max(0, Math.min(1, style.opacity)) * 255) : 0;
    lut[s.value] = [r, g, b, alpha];
  }
  return lut;
}

/** Drops the presigned query string: two URLs of the same object compare equal. */
export function artifactKey(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}
