/**
 * Tiny synthetic CT study for the browser smoke test, generated in memory (no patient data, nothing
 * committed): a NIfTI-1 volume (int16 HU, canonical RAS), its uint8 labelmap on the same grid and
 * affine, and one GLB mesh per structure in LPS millimetres, the contract of the AI worker.
 */
import { gzipSync } from 'node:zlib';

export type Vec3 = [number, number, number];

export const DIMS: Vec3 = [96, 96, 64];
export const SPACING: Vec3 = [1.5, 1.5, 2.5];
/** Voxel (0,0,0) in RAS mm. The affine is diagonal, as after `nibabel.as_closest_canonical`. */
export const ORIGIN_RAS: Vec3 = [-72, -90, -400];

/** Model label order: voxel value = index + 1 (see Contracts in the root README). Only the first two are present. */
export const LABELS = ['liver', 'spleen', 'kidney_left', 'kidney_right', 'pancreas'];

export interface SyntheticStructure {
  label: string;
  value: number;
  color: string;
  /** Intensity of the structure in the volume. */
  hu: number;
  volumeMl: number;
  /** LPS mm. */
  centroid: Vec3;
  glb: Buffer;
  /** Slice range `[first, last]` along k (axial). */
  kRange: [number, number];
}

export interface SyntheticStudy {
  volume: Buffer;
  segmentation: Buffer;
  structures: SyntheticStructure[];
}

const [NX, NY, NZ] = DIMS;

export function voxelToRas([i, j, k]: Vec3): Vec3 {
  return [
    ORIGIN_RAS[0] + i * SPACING[0],
    ORIGIN_RAS[1] + j * SPACING[1],
    ORIGIN_RAS[2] + k * SPACING[2],
  ];
}

/** DICOM patient space: RAS with x and y negated (what Cornerstone3D derives from the affine). */
export function rasToLps([x, y, z]: Vec3): Vec3 {
  return [-x, -y, z];
}

const voxelToLps = (ijk: Vec3) => rasToLps(voxelToRas(ijk));

/** Liver: a box of voxels on the patient's right (high i in RAS). */
const LIVER = { from: [58, 40, 34] as Vec3, to: [82, 64, 52] as Vec3 };
/** Spleen: a ball on the patient's left, low in z so the middle axial slice misses it. */
const SPLEEN = { center: [22, 44, 12] as Vec3, radius: 6 };

function inLiver(i: number, j: number, k: number): boolean {
  return (
    i >= LIVER.from[0] &&
    i < LIVER.to[0] &&
    j >= LIVER.from[1] &&
    j < LIVER.to[1] &&
    k >= LIVER.from[2] &&
    k < LIVER.to[2]
  );
}

function inSpleen(i: number, j: number, k: number): boolean {
  const [ci, cj, ck] = SPLEEN.center;
  return (i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2 <= SPLEEN.radius ** 2;
}

function niftiHeader(datatype: 2 | 4, bitpix: 8 | 16): Buffer {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  header.write('r', 38, 'latin1');
  const dims = [3, NX, NY, NZ, 1, 1, 1, 1];
  dims.forEach((d, n) => header.writeInt16LE(d, 40 + n * 2));
  header.writeInt16LE(datatype, 70);
  header.writeInt16LE(bitpix, 72);
  const pixdim = [1, ...SPACING, 0, 0, 0, 0];
  pixdim.forEach((p, n) => header.writeFloatLE(p, 76 + n * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeFloatLE(0, 116);
  header.writeUInt8(2, 123); // mm
  header.writeInt16LE(0, 252); // qform_code
  header.writeInt16LE(1, 254); // sform_code: scanner anatomical
  const srow = [
    [SPACING[0], 0, 0, ORIGIN_RAS[0]],
    [0, SPACING[1], 0, ORIGIN_RAS[1]],
    [0, 0, SPACING[2], ORIGIN_RAS[2]],
  ];
  srow.forEach((row, r) => row.forEach((v, c) => header.writeFloatLE(v, 280 + r * 16 + c * 4)));
  header.write('n+1\0', 344, 'latin1');
  return header;
}

function buildVolumes(): { volume: Buffer; segmentation: Buffer; counts: Map<number, number> } {
  const hu = Buffer.alloc(NX * NY * NZ * 2);
  const mask = Buffer.alloc(NX * NY * NZ);
  const counts = new Map<number, number>();
  let n = 0;
  for (let k = 0; k < NZ; k += 1) {
    for (let j = 0; j < NY; j += 1) {
      for (let i = 0; i < NX; i += 1) {
        const dx = (i - NX / 2) / 42;
        const dy = (j - NY / 2) / 34;
        const body = dx * dx + dy * dy <= 1;
        const spine = (i - NX / 2) ** 2 + (j - 20) ** 2 <= 36;
        let value = body ? 30 : -1000;
        if (spine && body) value = 700;
        let label = 0;
        if (inLiver(i, j, k)) {
          value = 60;
          label = 1;
        } else if (inSpleen(i, j, k)) {
          value = 50;
          label = 2;
        }
        hu.writeInt16LE(value, n * 2);
        mask.writeUInt8(label, n);
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
        n += 1;
      }
    }
  }
  return {
    volume: gzipSync(Buffer.concat([niftiHeader(4, 16), hu])),
    segmentation: gzipSync(Buffer.concat([niftiHeader(2, 8), mask])),
    counts,
  };
}

/** Minimal glTF 2.0 binary with one indexed triangle mesh (positions only). */
export function encodeGlb(positions: number[], indices: number[]): Buffer {
  const pos = Buffer.alloc(positions.length * 4);
  positions.forEach((v, n) => pos.writeFloatLE(v, n * 4));
  const idx = Buffer.alloc(indices.length * 4);
  indices.forEach((v, n) => idx.writeUInt32LE(v, n * 4));
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < positions.length; n += 3) {
    for (const a of [0, 1, 2] as const) {
      const v = positions[n + a] ?? 0;
      min[a] = Math.min(min[a], v);
      max[a] = Math.max(max[a], v);
    }
  }
  const bin = Buffer.concat([pos, idx]);
  const json = {
    asset: { version: '2.0', generator: 'medimg e2e fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length, byteLength: idx.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const pad = (b: Buffer, fill: number) =>
    b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunkHeader = (length: number, type: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  return Buffer.concat([
    header,
    chunkHeader(jsonChunk.length, 0x4e4f534a),
    jsonChunk,
    chunkHeader(binChunk.length, 0x004e4942),
    binChunk,
  ]);
}

/** Box mesh around voxels [from, to) (faces on voxel boundaries), in LPS mm. */
function boxMesh(from: Vec3, to: Vec3): Buffer {
  const lo: Vec3 = [from[0] - 0.5, from[1] - 0.5, from[2] - 0.5];
  const hi: Vec3 = [to[0] - 0.5, to[1] - 0.5, to[2] - 0.5];
  const corners: Vec3[] = [];
  for (const z of [lo[2], hi[2]]) {
    for (const y of [lo[1], hi[1]]) for (const x of [lo[0], hi[0]]) corners.push([x, y, z]);
  }
  const positions = corners.flatMap((c) => voxelToLps(c));
  const quads = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  const indices = quads.flatMap(([a = 0, b = 0, c = 0, d = 0]) => [a, b, c, a, c, d]);
  return encodeGlb(positions, indices);
}

/** UV sphere through the ball's boundary, in LPS mm. */
function ballMesh(center: Vec3, radius: number, segments = 24, rings = 16): Buffer {
  const positions: number[] = [];
  for (let r = 0; r <= rings; r += 1) {
    const theta = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const phi = (s / segments) * 2 * Math.PI;
      const ijk: Vec3 = [
        center[0] + (radius + 0.5) * Math.sin(theta) * Math.cos(phi),
        center[1] + (radius + 0.5) * Math.sin(theta) * Math.sin(phi),
        center[2] + (radius + 0.5) * Math.cos(theta),
      ];
      positions.push(...voxelToLps(ijk));
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return encodeGlb(positions, indices);
}

export function generateSyntheticStudy(): SyntheticStudy {
  const { volume, segmentation, counts } = buildVolumes();
  const voxelMl = (SPACING[0] * SPACING[1] * SPACING[2]) / 1000;
  const liverCentroid = voxelToLps([
    (LIVER.from[0] + LIVER.to[0] - 1) / 2,
    (LIVER.from[1] + LIVER.to[1] - 1) / 2,
    (LIVER.from[2] + LIVER.to[2] - 1) / 2,
  ]);
  return {
    volume,
    segmentation,
    structures: [
      {
        label: 'liver',
        value: 1,
        color: '#DC5A3C',
        hu: 60,
        volumeMl: (counts.get(1) ?? 0) * voxelMl,
        centroid: liverCentroid,
        glb: boxMesh(LIVER.from, LIVER.to),
        kRange: [LIVER.from[2], LIVER.to[2] - 1],
      },
      {
        label: 'spleen',
        value: 2,
        color: '#9E4FC0',
        hu: 50,
        volumeMl: (counts.get(2) ?? 0) * voxelMl,
        centroid: voxelToLps(SPLEEN.center),
        glb: ballMesh(SPLEEN.center, SPLEEN.radius),
        kRange: [SPLEEN.center[2] - SPLEEN.radius, SPLEEN.center[2] + SPLEEN.radius],
      },
    ],
  };
}

/** Highest voxel value of the image stack below (lowest: 0, the background). */
export const STACK_MAX = 219;

/**
 * An 8-bit image stack as the ingest worker stores it (uint8 NIfTI, same grid and affine as the
 * CT above): an ellipse whose grey level rises from 60 on the first slice to `STACK_MAX` on the
 * last, on a black background. Not Hounsfield units, so the viewer windows it over 0..STACK_MAX.
 */
export function generateImageStackVolume(): Buffer {
  const grey = Buffer.alloc(NX * NY * NZ);
  let n = 0;
  for (let k = 0; k < NZ; k += 1) {
    const level = 60 + Math.round(((STACK_MAX - 60) * k) / (NZ - 1));
    for (let j = 0; j < NY; j += 1) {
      for (let i = 0; i < NX; i += 1) {
        const dx = (i - NX / 2) / 40;
        const dy = (j - NY / 2) / 30;
        grey.writeUInt8(dx * dx + dy * dy <= 1 ? level : 0, n);
        n += 1;
      }
    }
  }
  return gzipSync(Buffer.concat([niftiHeader(2, 8), grey]));
}
