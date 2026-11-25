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
}

// ---------- Studies ----------

export type InputType = 'IMAGE_2D';

export interface SeriesDto {
  id: Uuid;
  modality: string;
  rows: number;
  cols: number;
  numImages: number;
  /** Presigned GET URL, valid for 15 minutes. */
  imageUrl: string;
  /** Presigned GET URL, valid for 15 minutes. */
  thumbnailUrl: string;
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

export interface ModelDto {
  id: Uuid;
  code: string;
  version: string;
  name: string;
  task: string;
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
  /** 0..1 */
  confidence: number;
  bbox: BBox | null;
  reviewStatus: 'PENDING';
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
  /** `heatmaps` maps a finding label to a presigned PNG (RGBA, same size as the image). */
  artifacts: { heatmaps: Record<string, string> } | null;
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
