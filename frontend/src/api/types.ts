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

/** A user as shown next to what they did (review, annotation, report signature). */
export interface UserRef {
  id: Uuid;
  fullName: string;
}

export type Role = 'ADMIN' | 'DOCTOR' | 'TECHNICIAN' | 'RESEARCHER';

export const ROLES: readonly Role[] = ['ADMIN', 'DOCTOR', 'TECHNICIAN', 'RESEARCHER'];

export interface UserDto {
  id: Uuid;
  username: string;
  fullName: string;
  roles: Role[];
  /**
   * Set after an admin created the account or reset its password: every API except `/me`,
   * `/me/password` and `/auth/*` answers 403 (`password-change-required`) until the user changes
   * it. Absent from sessions stored before slice 4a, which means false.
   */
  passwordChangeRequired?: boolean;
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
   * 2D only: pixel spacing `[x, y]` in mm (column spacing, row spacing) of a DICOM X-ray; null for a
   * PNG/JPG (lengths are then measured in pixels) and for volumes. Optional for older servers.
   */
  pixelSpacing?: [number, number] | null;
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
  /** 0..1; null for a segmented structure and for a finding added by a doctor. */
  confidence: number | null;
  /** Volume of a segmented structure in millilitres; null for 2D findings. */
  volumeMl: number | null;
  bbox: BBox | null;
  /** `PENDING` until a doctor reviews an AI finding; a MANUAL finding is `ACCEPTED` at once. */
  reviewStatus: ReviewStatus;
  /** The doctor's decision; null while PENDING. */
  review: FindingReview | null;
  source: FindingSource;
  /** Optimistic-locking version, sent back with `PATCH /findings/{id}/review`. */
  version: number;
  seriesId: Uuid;
  /** Annotation a MANUAL finding points at, if any. */
  annotationId: Uuid | null;
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

// ---------- Finding review (slice 3) ----------

export type ReviewStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EDITED';
export type ReviewDecision = Exclude<ReviewStatus, 'PENDING'>;
export type FindingSource = 'AI' | 'MANUAL';

/** Limits shared with the server. */
export const FINDING_LABEL_MAX = 100;
export const FINDING_NOTE_MAX = 1000;

export interface FindingReview {
  status: ReviewDecision;
  /** Corrected label (EDITED only). */
  label: string | null;
  note: string | null;
  reviewedBy: UserRef;
  reviewedAt: IsoDateTime;
}

/** `PATCH /findings/{id}/review`; `label` is required for EDITED. 409 when `version` is stale. */
export interface ReviewFindingRequest {
  status: ReviewDecision;
  label?: string;
  note?: string;
  version: number;
}

/** `POST /studies/{id}/findings`: a MANUAL finding, ACCEPTED at once. */
export interface CreateFindingRequest {
  seriesId: Uuid;
  label: string;
  note?: string;
  annotationId?: Uuid;
}

// ---------- Annotations (slice 3) ----------

/** `[x, y]` in image pixels: origin at the top-left corner, x to the right, y down. */
export type Point2 = [number, number];

export type Annotation2DKind = 'RECTANGLE' | 'POLYGON' | 'ARROW' | 'LENGTH';
export type VolumeAnnotationKind = 'RECTANGLE_ROI' | 'ELLIPSE_ROI' | 'LENGTH';
/** `LENGTH` exists in both spaces: the series (2D image or volume) tells which geometry it has. */
export type AnnotationKind = Annotation2DKind | VolumeAnnotationKind;

export interface RectangleGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PolygonGeometry {
  /** 3..200 points. */
  points: Point2[];
}

export interface ArrowGeometry {
  /** Tail. */
  from: Point2;
  /** Head (the point being shown). */
  to: Point2;
  text: string;
}

export interface LineGeometry {
  from: Point2;
  to: Point2;
}

/**
 * Volume annotation in LPS millimetres (the world space of the MPR viewer), with the plane it was
 * drawn on. `points` keep Cornerstone3D's handle order: rectangle = 4 corners (top-left,
 * top-right, bottom-left, bottom-right), ellipse = ends of its axes (bottom, top, left, right),
 * length = its 2 ends.
 */
export interface VolumeGeometry {
  points: Vec3[];
  viewPlaneNormal: Vec3;
  viewUp: Vec3;
  sliceIndex?: number | null;
}

export type AnnotationGeometry =
  RectangleGeometry | PolygonGeometry | ArrowGeometry | LineGeometry | VolumeGeometry;

/**
 * Computed by the client, checked by the server (finite, positive). `lengthPx` / `areaPx2` are used
 * for a 2D image without pixel spacing (PNG/JPG); mean / std are in HU (CT only).
 */
export interface Measurement {
  lengthMm?: number;
  areaMm2?: number;
  lengthPx?: number;
  areaPx2?: number;
  meanHu?: number;
  stdHu?: number;
}

export const ANNOTATION_LABEL_MAX = 100;
export const ANNOTATION_NOTE_MAX = 1000;

export interface AnnotationDto {
  id: Uuid;
  studyId: Uuid;
  seriesId: Uuid;
  author: UserRef;
  kind: AnnotationKind;
  geometry: AnnotationGeometry;
  label: string | null;
  note: string | null;
  measurement: Measurement | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Optimistic-locking version, sent back with `PUT /annotations/{id}`. */
  version: number;
}

export interface CreateAnnotationRequest {
  seriesId: Uuid;
  kind: AnnotationKind;
  geometry: AnnotationGeometry;
  label?: string | null;
  note?: string | null;
  measurement?: Measurement | null;
}

/** `PUT /annotations/{id}` (author only); 409 when `version` is stale. */
export interface UpdateAnnotationRequest {
  geometry: AnnotationGeometry;
  label: string | null;
  note: string | null;
  measurement: Measurement | null;
  version: number;
}

// ---------- Reports (slice 3) ----------

export type ReportStatus = 'DRAFT' | 'FINAL';
/** CXR for a 2D study, CT for a volume. */
export type ReportTemplate = 'CXR' | 'CT';
export type ReportLanguage = 'vi' | 'en';

export const KEY_IMAGE_MAX_COUNT = 6;
export const KEY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const KEY_IMAGE_CAPTION_MAX = 200;
/** Per-section caps, the same as core-service's validation and columns. */
export const REPORT_SECTION_MAX = {
  clinicalInfo: 2000,
  technique: 4000,
  findingsText: 10000,
  impression: 4000,
} as const;

export interface ReportKeyImageDto {
  id: Uuid;
  caption: string | null;
  /** 0-based order in the report. */
  position: number;
  /** False until `complete` succeeded (a report cannot be signed with such an image). */
  uploaded: boolean;
  /** Presigned GET URL of the PNG (valid for 15 minutes); null while not uploaded. */
  url: string | null;
}

export interface ReportDto {
  id: Uuid;
  studyId: Uuid;
  /** 1, 2, … – an amendment is the next version. */
  version: number;
  status: ReportStatus;
  template: ReportTemplate;
  language: ReportLanguage;
  clinicalInfo: string | null;
  technique: string | null;
  findingsText: string | null;
  impression: string | null;
  author: UserRef;
  signedBy: UserRef | null;
  signedAt: IsoDateTime | null;
  /** The FINAL report this one amends (its previous version); null for version 1. */
  amendsReportId: Uuid | null;
  /** Key images ordered by `position`. */
  keyImages: ReportKeyImageDto[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Optimistic-locking version of the report row (`PUT`, `finalize`); 409 when stale. */
  rowVersion: number;
}

/**
 * Item of `GET /studies/{id}/reports` (latest first). The server may send only the summary fields;
 * the full report comes from `GET /reports/{id}`.
 */
export type ReportSummaryDto = Pick<ReportDto, 'id' | 'version' | 'status'> & Partial<ReportDto>;

export interface CreateReportRequest {
  /** Defaults by input type on the server (2D → CXR, volume → CT). */
  template?: ReportTemplate;
  language: ReportLanguage;
}

/** Caption and order of the key images, sent with a draft's sections. */
export interface KeyImageOrderItem {
  id: Uuid;
  /** null keeps the caption, blank clears it. */
  caption: string | null;
}

/** `PUT /reports/{id}` (DRAFT only; the language is chosen at creation). */
export interface UpdateReportRequest {
  clinicalInfo: string;
  technique: string;
  findingsText: string;
  impression: string;
  /** Every key image once, in the new order (omitted: unchanged). */
  keyImages?: KeyImageOrderItem[];
  rowVersion: number;
}

export interface FinalizeReportRequest {
  rowVersion: number;
}

/** `POST /reports/{id}/refill` on a DRAFT: 409 when `rowVersion` is stale or the report is FINAL. */
export interface RefillReportRequest {
  rowVersion: number;
}

export interface InitKeyImageRequest {
  contentType: 'image/png';
  /** Bytes, at most 5 MB; the PUT must send exactly this many. */
  size: number;
  caption?: string;
}

export interface InitKeyImageResponse {
  imageId: Uuid;
  /** Presigned PUT URL (same origin); the PNG is sent with `Content-Type: image/png`. */
  putUrl: string;
  expiresAt: IsoDateTime;
}

/** `GET /reports/{id}/pdf` of a FINAL report. */
export interface PdfLinkDto {
  /** Presigned GET URL of `report.pdf` (same origin). */
  url: string;
  expiresAt: IsoDateTime;
}

// ---------- Slice 4a: account ----------

/** `POST /me/password` → 204. A wrong current password is a 422 (not a 401, which would log out). */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// ---------- Slice 4a: user administration (ADMIN) ----------

export type UserStatus = 'ACTIVE' | 'LOCKED';

export interface AdminUserDto {
  id: Uuid;
  username: string;
  fullName: string;
  email: string | null;
  roles: Role[];
  status: UserStatus;
  passwordChangeRequired: boolean;
  lastLoginAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  /** Optimistic lock: sent back with `PUT /admin/users/{id}`, a stale one is a 409. */
  version: number;
}

/** `GET /admin/users`; `page` is 0-based. */
export interface AdminUserQuery {
  q?: string;
  role?: Role;
  status?: UserStatus;
  page: number;
  size: number;
}

export interface CreateUserRequest {
  /** 3–50 of `[a-z0-9._-]`, unique ignoring case (409 otherwise). */
  username: string;
  /** 1–100 characters. */
  fullName: string;
  email?: string;
  /** At least one. */
  roles: Role[];
}

/** 201: the temporary password is returned once and never again. */
export interface CreateUserResponse {
  user: AdminUserDto;
  temporaryPassword: string;
}

export interface UpdateUserRequest {
  fullName: string;
  email?: string;
  roles: Role[];
  version: number;
}

/** `POST /admin/users/{id}/reset-password`. */
export interface TemporaryPasswordResponse {
  temporaryPassword: string;
}

// ---------- Slice 4a: model administration (ADMIN) ----------

/**
 * Only ACTIVE and DISABLED can be switched (`POST /admin/models/{id}/enable|disable`); a model in
 * STAGING or RETIRED is listed but the server refuses to switch it (409 `…/model-status`).
 */
export type ModelStatus = 'ACTIVE' | 'DISABLED' | 'STAGING' | 'RETIRED';

/** Over every job of the model; times are the inference times the worker reported. */
export interface ModelStatsDto {
  jobs: number;
  done: number;
  failed: number;
  /** Null without any DONE job. */
  avgInferenceMs: number | null;
  p95InferenceMs: number | null;
  /** Null when the model never ran. */
  lastUsedAt: IsoDateTime | null;
}

/** `GET /admin/models` item. A DISABLED model is left out of `GET /models`. */
export interface AdminModelDto {
  id: Uuid;
  code: string;
  version: string;
  name: string;
  task: ModelTask;
  inputTypes: InputType[];
  /** Comma separated DICOM modalities (e.g. `CR,DX`); null when the model takes any. */
  modality: string | null;
  /** e.g. `CHEST`; null when not tied to a body part. */
  bodyPart: string | null;
  status: ModelStatus;
  stats: ModelStatsDto;
}

// ---------- Slice 4a: dashboard (every role) ----------

/** `YYYY-MM-DD`, a calendar day in the server's dashboard time zone. */
export type IsoDate = string;

/** Over the DONE jobs of the model queued in the range. */
export interface DashboardModelProcessing {
  modelCode: string;
  /** Number of DONE jobs. */
  jobs: number;
  /** Queue to finish (of the last attempt), in milliseconds; null without any DONE job. */
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Inference time reported by the worker, in milliseconds; null when none was reported. */
  avgInferenceMs: number | null;
}

export interface DashboardDay {
  date: IsoDate;
  cases: number;
  jobs: number;
  failedJobs: number;
}

export interface DashboardRecentJob {
  jobId: Uuid;
  studyId: Uuid;
  modelCode: string;
  status: PredictionStatus;
  queuedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

/** `GET /dashboard?from=&to=`: aggregates only, nothing that identifies a patient. */
export interface DashboardDto {
  /** The range answered, both days included, in the dashboard time zone `zone`. */
  from: IsoDate;
  to: IsoDate;
  zone: string;
  totals: {
    cases: number;
    studies: number;
    studiesByInputType: Partial<Record<InputType, number>>;
    jobs: number;
    jobsByStatus: Partial<Record<PredictionStatus, number>>;
    /** Reports created in the range, by their current status. */
    reports: { draft: number; final: number };
  };
  processing: { perModel: DashboardModelProcessing[] };
  review: {
    reviewed: number;
    accepted: number;
    edited: number;
    rejected: number;
    /** (accepted + edited) / reviewed, 0..1; null when nothing was reviewed. */
    acceptanceRate: number | null;
  };
  /** Top 10 AI labels accepted or edited, most first. */
  labels: Array<{ label: string; accepted: number }>;
  /** One entry per day of the range, empty days included. */
  daily: DashboardDay[];
  /** The 10 latest jobs. */
  recentJobs: DashboardRecentJob[];
}

// ---------- Slice 4a: audit log (ADMIN) ----------

export type AuditOutcome = 'SUCCESS' | 'FAILURE';

export interface AuditEntryDto {
  id: number | string;
  occurredAt: IsoDateTime;
  userId: Uuid | null;
  username: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: AuditOutcome | null;
  clientIp: string | null;
  userAgent: string | null;
  detail: unknown;
}

/** Filters of `GET /admin/audit`, `/admin/audit/actions` and `/admin/audit/export.csv`. */
export interface AuditQuery {
  username?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  outcome?: AuditOutcome;
  /** Inclusive days, at most 93 days in all. */
  from: IsoDate;
  to: IsoDate;
}
