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

/** Presentation of a case marked as a sample case (`sample_title IS NOT NULL` on the server). */
export interface SampleInfo {
  /** 1..120 characters. */
  title: string;
  /** Up to 500 characters. */
  description: string | null;
  /** Source and licence, 1..300 characters (e.g. dataset, licence, citation). */
  source: string;
}

export interface PatientDto {
  id: Uuid;
  code: string;
  birthYear: number | null;
  sex: Sex | null;
  note: string | null;
  studyCount: number;
  createdAt: IsoDateTime;
  /** Set when an admin marked the case as a sample case; null otherwise. */
  sample: SampleInfo | null;
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

/** `PUT /patients/{id}/sample` (ADMIN). */
export interface MarkSampleRequest {
  title: string;
  description?: string;
  source: string;
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
  /**
   * Voxel spacing `[sx, sy, sz]` in mm (each 0.01..20) for a ZIP of PNG/JPG slices. Ignored for
   * any other content. Without it the server assumes 1 mm and flags the series `spacingAssumed`.
   */
  sliceSpacingMm?: Vec3;
}

/** One presigned S3 `UploadPart` URL. */
export interface UploadPartTarget {
  /** 1-based, as in S3. */
  partNumber: number;
  url: string;
}

/**
 * Multipart plan for a large file (over 64 MB): part `n` is bytes `[(n-1)·partSize, n·partSize)`
 * of the file, the last part being shorter.
 */
export interface MultipartPlan {
  /** Bytes per part (32 MiB); at least 5 MiB, as S3 requires for every part but the last. */
  partSize: number;
  parts: UploadPartTarget[];
}

export interface InitUploadFile {
  fileId: Uuid;
  name: string;
  /**
   * Presigned S3 PUT URL (same origin, under `/medimg/**`) for a single PUT of the whole file;
   * null when the file is uploaded in parts (`multipart`).
   */
  putUrl: string | null;
  /** Present (and `putUrl` null) when the file must be uploaded in parts. */
  multipart?: MultipartPlan | null;
  expiresAt: IsoDateTime;
}

export interface InitUploadResponse {
  uploadId: Uuid;
  files: InitUploadFile[];
}

/** One uploaded part. `etag` is the `ETag` response header of its PUT, quotes included. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/**
 * Body of `POST /uploads/{id}/complete`: required for multipart files (parts in ascending order),
 * forbidden for files uploaded with a single PUT (the request then has no body).
 */
export interface CompleteUploadRequest {
  files: Array<{ fileId: Uuid; parts: CompletedPart[] }>;
}

export type UploadStatus = 'INIT' | 'UPLOADED' | 'PROCESSING' | 'DONE' | 'FAILED';

export interface UploadDto {
  uploadId: Uuid;
  status: UploadStatus;
  error: string | null;
  studyId: Uuid | null;
  /** Server-side processing progress, 0..100. */
  progress: number;
  /**
   * Null until the server has identified the content: known at completion for a single file
   * (e.g. `DICOM_2D`), only once DONE for a ZIP (`DICOM_SERIES` or `IMAGE_STACK`, which the
   * ingest worker decides from what it holds).
   */
  inputType: InputType | null;
}

// ---------- Studies ----------

/**
 * 2D: `IMAGE_2D` (PNG/JPG), `DICOM_2D` (one DICOM X-ray, normalised to an 8-bit PNG).
 * Volumes, all normalised to one NIfTI file: `NIFTI`, `DICOM_SERIES` (ZIP of a DICOM series) and
 * `IMAGE_STACK` (ZIP of PNG/JPG slices; intensities are not Hounsfield units).
 */
export type InputType = 'IMAGE_2D' | 'DICOM_2D' | 'NIFTI' | 'DICOM_SERIES' | 'IMAGE_STACK';

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
  /**
   * True when `spacing` is the 1 mm default the server assumed (an image stack uploaded without
   * slice spacing): distances and volumes measured on it are not real. False otherwise.
   */
  spacingAssumed: boolean;
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

// ---------- Sample cases ----------

export interface SampleStudyDto {
  studyId: Uuid;
  inputType: InputType;
  modality: string;
  /** Presigned GET URL, valid for 15 minutes. */
  thumbnailUrl: string;
  /** Most recent AI run of the study, if any. */
  latestPrediction: { jobId: Uuid; modelCode: string; status: PredictionStatus } | null;
}

/** `GET /samples` item (every role), sorted by title. */
export interface SampleCaseDto {
  patientId: Uuid;
  code: string;
  title: string;
  description: string | null;
  source: string;
  studies: SampleStudyDto[];
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

export const VOLUME_INPUT_TYPES: readonly InputType[] = ['NIFTI', 'DICOM_SERIES', 'IMAGE_STACK'];

/** NIfTI, DICOM series and image stack studies are all served as one normalised NIfTI volume. */
export function isVolumeInput(inputType: InputType | null | undefined): boolean {
  return !!inputType && VOLUME_INPUT_TYPES.includes(inputType);
}

/**
 * Whether a volume's intensities are Hounsfield units, so CT window presets make sense: a CT
 * series read from DICOM or NIfTI. An image stack is never in HU, whatever its modality.
 */
export function hasHounsfieldUnits(inputType: InputType, modality: string): boolean {
  return inputType !== 'IMAGE_STACK' && modality.toUpperCase() === 'CT';
}
