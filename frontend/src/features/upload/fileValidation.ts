/** Client-side checks before an upload (the server re-validates extension, size and magic bytes). */

import type { Vec3 } from '@/api/types';

/**
 * `image`: one PNG/JPG (2D). `dicom`: one DICOM X-ray (2D, decoded by the ingest worker).
 * `volume`: one NIfTI file, or one ZIP of a DICOM series or of PNG/JPG slices.
 */
export type UploadKind = 'image' | 'dicom' | 'volume';

export const MAX_UPLOAD_BYTES: Record<UploadKind, number> = {
  image: 50 * 1024 * 1024,
  dicom: 50 * 1024 * 1024,
  volume: 500 * 1024 * 1024,
};

/** What a ZIP holds. The worker decides from the content; the choice only adds slice spacing. */
export type ZipContent = 'dicomSeries' | 'imageStack';

export interface UploadFileSpec {
  kind: UploadKind;
  /** Sent to `uploads/init` and on the presigned PUT (the signature covers it). */
  contentType: string;
}

interface Rule {
  suffix: string;
  kind: UploadKind;
  /**
   * Content type declared at `uploads/init` and sent on the PUT. The presigned PUT is signed with
   * it, so it is fixed per suffix rather than taken from the browser, which reports these files
   * inconsistently (`.nii` usually as an empty type, `.zip` as `application/x-zip-compressed` on
   * Windows, `.nii.gz` as `application/x-gzip` on some systems).
   */
  contentType: string;
}

/** Longest suffix first, so `.nii.gz` wins over a bare `.gz`. */
const RULES: readonly Rule[] = [
  { suffix: '.nii.gz', kind: 'volume', contentType: 'application/gzip' },
  { suffix: '.nii', kind: 'volume', contentType: 'application/octet-stream' },
  { suffix: '.zip', kind: 'volume', contentType: 'application/zip' },
  { suffix: '.dcm', kind: 'dicom', contentType: 'application/dicom' },
  { suffix: '.png', kind: 'image', contentType: 'image/png' },
  { suffix: '.jpg', kind: 'image', contentType: 'image/jpeg' },
  { suffix: '.jpeg', kind: 'image', contentType: 'image/jpeg' },
];

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

export const ACCEPT_ATTRIBUTE = [
  '.png',
  '.jpg',
  '.jpeg',
  '.nii',
  '.nii.gz',
  // Some file pickers only match the last extension of `.nii.gz`.
  '.gz',
  '.zip',
  '.dcm',
  'image/png',
  'image/jpeg',
].join(',');

export type FileProblem = 'type' | 'size' | 'empty';

export type FileCheck =
  { ok: true; spec: UploadFileSpec } | { ok: false; problem: FileProblem; kind: UploadKind | null };

/** Kind and content type of a file, from its name (or, for images, the type the browser reports). */
export function classifyFile(file: Pick<File, 'name' | 'type'>): UploadFileSpec | null {
  const name = file.name.toLowerCase();
  const rule = RULES.find((r) => name.endsWith(r.suffix));
  if (rule) return { kind: rule.kind, contentType: rule.contentType };
  // An image the browser identified even though its name has no usual extension.
  if (IMAGE_TYPES.has(file.type)) return { kind: 'image', contentType: file.type };
  return null;
}

export function checkUploadFile(file: Pick<File, 'name' | 'type' | 'size'>): FileCheck {
  const spec = classifyFile(file);
  if (!spec) return { ok: false, problem: 'type', kind: null };
  if (file.size === 0) return { ok: false, problem: 'empty', kind: spec.kind };
  if (file.size > MAX_UPLOAD_BYTES[spec.kind]) {
    return { ok: false, problem: 'size', kind: spec.kind };
  }
  return { ok: true, spec };
}

/** Bounds of each voxel spacing value accepted by `uploads/init`, in mm. */
export const SLICE_SPACING_MIN_MM = 0.01;
export const SLICE_SPACING_MAX_MM = 20;

export const SPACING_AXES = ['x', 'y', 'z'] as const;
export type SpacingAxis = (typeof SPACING_AXES)[number];
/** Values of the three spacing inputs (empty = null / undefined). */
export type SpacingValues = Partial<Record<SpacingAxis, number | null>>;

export type SpacingInput = readonly [number | null, number | null, number | null];

export type SpacingCheck =
  { ok: true; spacing: Vec3 | null } | { ok: false; problem: 'range' | 'incomplete' };

export function isSpacingInRange(value: number): boolean {
  return Number.isFinite(value) && value >= SLICE_SPACING_MIN_MM && value <= SLICE_SPACING_MAX_MM;
}

/**
 * Voxel spacing of an image stack, from three optional inputs: all empty means "let the server
 * assume 1 mm" (null), all filled and in range gives `[sx, sy, sz]`. A partial entry is refused
 * rather than completed with 1 mm, which would pass a guess off as a measurement.
 */
export function checkSliceSpacing(input: SpacingInput): SpacingCheck {
  const filled = input.filter((v): v is number => v !== null);
  if (filled.length === 0) return { ok: true, spacing: null };
  if (filled.some((v) => !isSpacingInRange(v))) return { ok: false, problem: 'range' };
  if (filled.length < 3) return { ok: false, problem: 'incomplete' };
  return { ok: true, spacing: [filled[0], filled[1], filled[2]] as Vec3 };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isZipFile(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}
