/**
 * Hand-written types for the core-service REST contract (base `/api/v1`).
 * Mirrors the DTOs exposed by core-service (OpenAPI document at `/v3/api-docs`).
 * All ids are UUID strings, all timestamps ISO-8601 UTC strings.
 */

export type Uuid = string;
export type IsoDateTime = string;

// ---------- Errors ----------

/** RFC 7807 problem detail returned by every non-2xx response. */
export interface ProblemDetail {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /**
   * Field-level validation errors. The contract does not pin the shape, so both
   * `{ field: message }` and `[{ field, message }]` are accepted (see `api/problem.ts`).
   */
  errors?: Record<string, string> | ReadonlyArray<{ field?: string; message?: string }>;
}

// ---------- Auth ----------

export type Role = 'ADMIN' | 'DOCTOR' | 'TECHNICIAN' | 'RESEARCHER';

export interface UserDto {
  id: Uuid;
  username: string;
  fullName: string;
  roles: Role[];
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  user: UserDto;
}

// ---------- Paging ----------

/** Spring-style page. `page` is 0-based. */
export interface Page<T> {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

// ---------- Patients (cases) ----------

export type Sex = 'M' | 'F' | 'O';

export interface PatientDto {
  id: Uuid;
  code: string;
  birthYear: number | null;
  sex: Sex | null;
  note: string | null;
  studyCount: number;
  createdAt: IsoDateTime;
}

export interface CreatePatientRequest {
  code?: string;
  birthYear?: number;
  sex?: Sex;
  note?: string;
}

export interface UpdatePatientRequest {
  birthYear?: number;
  sex?: Sex;
  note?: string;
}

export interface PatientQuery {
  q?: string;
  /** 0-based page index. */
  page?: number;
  size?: number;
}

// ---------- Uploads ----------

export interface UploadFileSpec {
  name: string;
  size: number;
  contentType: string;
}

export interface InitUploadRequest {
  patientId: Uuid;
  files: UploadFileSpec[];
  modalityHint?: string;
  bodyPartHint?: string;
}

export interface InitUploadFile {
  fileId: Uuid;
  name: string;
  /** Presigned S3 PUT URL (same origin, under `/medimg/**`). */
  putUrl: string;
  expiresAt: IsoDateTime;
}

export interface InitUploadResponse {
  uploadId: Uuid;
  files: InitUploadFile[];
}

export type UploadStatus = 'INIT' | 'UPLOADED' | 'PROCESSING' | 'DONE' | 'FAILED';

export interface UploadDto {
  uploadId: Uuid;
  status: UploadStatus;
  error: string | null;
  studyId: Uuid | null;
  /** Server-side processing progress, 0..100. */
  progress: number;
  /** Detected from the file's magic bytes; null until the server has identified it. */
  inputType: InputType | null;
}

// ---------- Studies ----------

/** `IMAGE_2D`: PNG/JPG. `NIFTI` / `DICOM_SERIES`: CT volume, normalised to one NIfTI file. */
export type InputType = 'IMAGE_2D' | 'NIFTI' | 'DICOM_SERIES';

/** `[x, y, z]`. In patient space: LPS millimetres (the DICOM convention Cornerstone3D uses). */
export type Vec3 = [number, number, number];

export interface SeriesDto {
  id: Uuid;
  modality: string;
  rows: number;
  cols: number;
  numImages: number;
  /** Presigned GET URL of the 2D image (valid for 15 minutes); null for a volume. */
  imageUrl: string | null;
  /** Presigned GET URL, valid for 15 minutes. Always present (middle axial slice for a volume). */
  thumbnailUrl: string;
  /** Presigned GET URL of the normalised `volume.nii.gz` (canonical RAS, int16 HU); null for 2D. */
  volumeUrl: string | null;
  /** Voxel grid `[x, y, z]`; null for 2D. */
  dims: Vec3 | null;
  /** Voxel spacing `[sx, sy, sz]` in mm; null for 2D. */
  spacing: Vec3 | null;
}

export interface StudyDto {
  id: Uuid;
  patientId: Uuid;
  inputType: InputType;
  modality: string;
  bodyPart: string;
  createdAt: IsoDateTime;
  series: SeriesDto[];
}

// ---------- Models ----------

export type ModelTask = 'CLASSIFICATION_2D' | 'SEGMENTATION_3D';

export interface ModelDto {
  id: Uuid;
  code: string;
  version: string;
  name: string;
  task: ModelTask;
  /** Output labels in model order. For segmentation, label `i` is voxel value `i + 1`. */
  labels: string[];
}

// ---------- Predictions ----------

export type PredictionStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface PredictionParams {
  threshold?: number;
  [key: string]: unknown;
}

export interface CreatePredictionRequest {
  studyId: Uuid;
  seriesId: Uuid;
  modelCode: string;
  params?: PredictionParams;
}

export interface CreatePredictionResponse {
  jobId: Uuid;
  status: 'QUEUED';
  queuePosition: number;
}

export type BBox = [number, number, number, number];

export interface FindingDto {
  id: Uuid;
  label: string;
  /** 0..1; null for a segmented structure. */
  confidence: number | null;
  /** Volume of a segmented structure in millilitres; null for 2D findings. */
  volumeMl: number | null;
  bbox: BBox | null;
  reviewStatus: 'PENDING';
}

/** One segmented structure rendered as a mesh. */
export interface MeshArtifact {
  label: string;
  /** `#RRGGBB` */
  color: string;
  /** Presigned GET URL of the GLB (vertices in LPS mm). */
  url: string;
  triangles: number;
  volumeMl: number;
  /** Centre of mass in LPS mm, the world space of the MPR viewer. */
  centroid: Vec3;
}

export interface PredictionArtifacts {
  /** Maps a finding label to a presigned PNG (RGBA, same size as the image). Empty for volumes. */
  heatmaps: Record<string, string>;
  /**
   * Presigned URL of `segmentation.nii.gz` (uint8, same grid and affine as the volume); voxel value
   * `i + 1` is the i-th label of the model (`ModelDto.labels`), 0 is background. Null for 2D.
   */
  segmentation: string | null;
  /** One entry per structure present (at least 1 ml); empty for 2D. */
  meshes: MeshArtifact[];
}

export interface PredictionDto {
  jobId: Uuid;
  studyId: Uuid;
  seriesId: Uuid;
  status: PredictionStatus;
  /** 0..100 */
  progress: number;
  attempt: number;
  model: { code: string; version: string };
  inferenceMs: number | null;
  error: string | null;
  queuedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  /** Parameters the job was started with (empty object when none were sent). */
  params: PredictionParams;
  findings: FindingDto[];
  artifacts: PredictionArtifacts | null;
}

/** Payload of the SSE `progress` event. `done` / `failed` events carry a full PredictionDto. */
export interface PredictionProgressEvent {
  jobId: Uuid;
  status: PredictionStatus;
  progress: number;
}

export const TERMINAL_PREDICTION_STATUSES: readonly PredictionStatus[] = [
  'DONE',
  'FAILED',
  'CANCELLED',
];

export function isTerminalPrediction(status: PredictionStatus): boolean {
  return TERMINAL_PREDICTION_STATUSES.includes(status);
}

export const TERMINAL_UPLOAD_STATUSES: readonly UploadStatus[] = ['DONE', 'FAILED'];

export function isTerminalUpload(status: UploadStatus): boolean {
  return TERMINAL_UPLOAD_STATUSES.includes(status);
}

export const VOLUME_INPUT_TYPES: readonly InputType[] = ['NIFTI', 'DICOM_SERIES'];

/** NIfTI and DICOM series studies are both served as one normalised NIfTI volume. */
export function isVolumeInput(inputType: InputType | null | undefined): boolean {
  return !!inputType && VOLUME_INPUT_TYPES.includes(inputType);
}
