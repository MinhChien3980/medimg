import axios from 'axios';
import { authHttp, http } from './http';
import type {
  AdminModelDto,
  AdminUserDto,
  AdminUserQuery,
  AnnotationDto,
  AuditEntryDto,
  AuditQuery,
  ChangePasswordRequest,
  CompleteUploadRequest,
  CreateAnnotationRequest,
  CreateFindingRequest,
  CreatePatientRequest,
  CreatePredictionRequest,
  CreatePredictionResponse,
  CreateReportRequest,
  CreateUserRequest,
  CreateUserResponse,
  DashboardDto,
  FinalizeReportRequest,
  FindingDto,
  InitKeyImageRequest,
  InitKeyImageResponse,
  InitUploadRequest,
  InitUploadResponse,
  InputType,
  IsoDate,
  LoginRequest,
  MarkSampleRequest,
  ModelDto,
  Page,
  PatientDto,
  PatientQuery,
  PdfLinkDto,
  PredictionDto,
  RefillReportRequest,
  ReportDto,
  ReportSummaryDto,
  ReviewFindingRequest,
  ReviewStatus,
  SampleCaseDto,
  StudyDto,
  TemporaryPasswordResponse,
  TokenResponse,
  UpdateAnnotationRequest,
  UpdatePatientRequest,
  UpdateReportRequest,
  UpdateUserRequest,
  UploadDto,
  UserDto,
  Uuid,
} from './types';

// ---------- Auth ----------

export const authApi = {
  login: (body: LoginRequest) =>
    authHttp.post<TokenResponse>('/auth/login', body).then((r) => r.data),
  /** Revokes the refresh token; needs no access token. */
  logout: (refreshToken: string) =>
    authHttp.post<void>('/auth/logout', { refreshToken }).then(() => undefined),
  me: () => http.get<UserDto>('/me').then((r) => r.data),
};

// ---------- Patients ----------

export const patientsApi = {
  list: (query: PatientQuery) =>
    http
      .get<Page<PatientDto>>('/patients', {
        params: { q: query.q || undefined, page: query.page, size: query.size },
      })
      .then((r) => r.data),
  get: (id: Uuid) => http.get<PatientDto>(`/patients/${id}`).then((r) => r.data),
  create: (body: CreatePatientRequest) =>
    http.post<PatientDto>('/patients', body).then((r) => r.data),
  update: (id: Uuid, body: UpdatePatientRequest) =>
    http.put<PatientDto>(`/patients/${id}`, body).then((r) => r.data),
  remove: (id: Uuid) => http.delete<void>(`/patients/${id}`).then(() => undefined),
  studies: (id: Uuid) => http.get<StudyDto[]>(`/patients/${id}/studies`).then((r) => r.data),
  /** ADMIN: marks the case as a sample case, or updates its sample presentation. */
  markSample: (id: Uuid, body: MarkSampleRequest) =>
    http.put<PatientDto>(`/patients/${id}/sample`, body).then((r) => r.data),
  /** ADMIN: the case is no longer a sample case. */
  unmarkSample: (id: Uuid) => http.delete<void>(`/patients/${id}/sample`).then(() => undefined),
};

// ---------- Sample cases ----------

export const samplesApi = {
  list: () => http.get<SampleCaseDto[]>('/samples').then((r) => r.data),
};

// ---------- Uploads ----------

export const uploadsApi = {
  init: (body: InitUploadRequest) =>
    http.post<InitUploadResponse>('/uploads/init', body).then((r) => r.data),
  /** `body` lists the parts of multipart files; a single-PUT upload is completed without a body. */
  complete: (uploadId: Uuid, body?: CompleteUploadRequest) =>
    http.post<UploadDto>(`/uploads/${uploadId}/complete`, body).then((r) => r.data),
  get: (uploadId: Uuid) => http.get<UploadDto>(`/uploads/${uploadId}`).then((r) => r.data),
};

/**
 * Plain client for presigned object-storage URLs. It must NOT carry the Authorization
 * header (S3 would reject the request / the signature does not cover it).
 */
const storage = axios.create({ timeout: 0 });

/** Direct PUT of the raw file body to a presigned URL, with progress in percent. */
export async function putToPresignedUrl(
  putUrl: string,
  file: Blob,
  contentType: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  await storage.put(putUrl, file, {
    headers: { 'Content-Type': contentType },
    signal,
    transformRequest: [(data: unknown) => data],
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  onProgress?.(100);
}

// ---------- Studies ----------

export const studiesApi = {
  get: (id: Uuid) => http.get<StudyDto>(`/studies/${id}`).then((r) => r.data),
  predictions: (id: Uuid) =>
    http.get<PredictionDto[]>(`/studies/${id}/predictions`).then((r) => r.data),
};

// ---------- Models ----------

export const modelsApi = {
  list: (inputType: InputType) =>
    http.get<ModelDto[]>('/models', { params: { inputType } }).then((r) => r.data),
};

// ---------- Predictions ----------

export const predictionsApi = {
  /** `idempotencyKey` should be a fresh UUID per user action. */
  create: (body: CreatePredictionRequest, idempotencyKey: string) =>
    http
      .post<CreatePredictionResponse>('/predictions', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      })
      .then((r) => r.data),
  get: (jobId: Uuid) => http.get<PredictionDto>(`/predictions/${jobId}`).then((r) => r.data),
  retry: (jobId: Uuid) =>
    http.post<PredictionDto>(`/predictions/${jobId}/retry`).then((r) => r.data),
  cancel: (jobId: Uuid) =>
    http.post<PredictionDto>(`/predictions/${jobId}/cancel`).then((r) => r.data),
};

// ---------- Findings (review, manual findings) ----------

export const findingsApi = {
  /** AI findings of every DONE run of the study plus its MANUAL findings, optionally by status. */
  forStudy: (studyId: Uuid, statuses: readonly ReviewStatus[] = []) => {
    const query = new URLSearchParams(statuses.map((s) => ['status', s]));
    const suffix = statuses.length > 0 ? `?${query.toString()}` : '';
    return http.get<FindingDto[]>(`/studies/${studyId}/findings${suffix}`).then((r) => r.data);
  },
  review: (findingId: Uuid, body: ReviewFindingRequest) =>
    http.patch<FindingDto>(`/findings/${findingId}/review`, body).then((r) => r.data),
  create: (studyId: Uuid, body: CreateFindingRequest) =>
    http.post<FindingDto>(`/studies/${studyId}/findings`, body).then((r) => r.data),
  /** MANUAL findings of the caller only, while no FINAL report includes them. */
  remove: (findingId: Uuid) => http.delete<void>(`/findings/${findingId}`).then(() => undefined),
};

// ---------- Annotations ----------

export const annotationsApi = {
  list: (studyId: Uuid) =>
    http.get<AnnotationDto[]>(`/studies/${studyId}/annotations`).then((r) => r.data),
  create: (studyId: Uuid, body: CreateAnnotationRequest) =>
    http.post<AnnotationDto>(`/studies/${studyId}/annotations`, body).then((r) => r.data),
  update: (id: Uuid, body: UpdateAnnotationRequest) =>
    http.put<AnnotationDto>(`/annotations/${id}`, body).then((r) => r.data),
  remove: (id: Uuid) => http.delete<void>(`/annotations/${id}`).then(() => undefined),
};

// ---------- Reports ----------

export const reportsApi = {
  /** Every version of the study's report, latest first (a researcher only gets FINAL ones). */
  forStudy: (studyId: Uuid) =>
    http.get<ReportSummaryDto[]>(`/studies/${studyId}/reports`).then((r) => r.data),
  create: (studyId: Uuid, body: CreateReportRequest) =>
    http.post<ReportDto>(`/studies/${studyId}/reports`, body).then((r) => r.data),
  get: (id: Uuid) => http.get<ReportDto>(`/reports/${id}`).then((r) => r.data),
  update: (id: Uuid, body: UpdateReportRequest) =>
    http.put<ReportDto>(`/reports/${id}`, body).then((r) => r.data),
  remove: (id: Uuid) => http.delete<void>(`/reports/${id}`).then(() => undefined),
  finalize: (id: Uuid, body: FinalizeReportRequest) =>
    http.post<ReportDto>(`/reports/${id}/finalize`, body).then((r) => r.data),
  /**
   * Rewrites Technique and Findings of a DRAFT from the study's reviewed findings and annotations
   * as they are now (the other sections are kept).
   */
  refill: (id: Uuid, body: RefillReportRequest) =>
    http.post<ReportDto>(`/reports/${id}/refill`, body).then((r) => r.data),
  /** New DRAFT (version + 1) copied from a FINAL report. */
  amend: (id: Uuid) => http.post<ReportDto>(`/reports/${id}/amend`).then((r) => r.data),
  /** Draft PDF with a watermark, rendered on demand (needs the access token, hence a blob). */
  previewPdf: (id: Uuid) =>
    http
      .get<Blob>(`/reports/${id}/preview.pdf`, { responseType: 'blob', timeout: 60_000 })
      .then((r) => r.data),
  /** Presigned link to the signed PDF of a FINAL report. */
  pdfLink: (id: Uuid) => http.get<PdfLinkDto>(`/reports/${id}/pdf`).then((r) => r.data),
  initKeyImage: (id: Uuid, body: InitKeyImageRequest) =>
    http.post<InitKeyImageResponse>(`/reports/${id}/key-images/init`, body).then((r) => r.data),
  /** The server checks the uploaded object (PNG, size); the report is read again afterwards. */
  completeKeyImage: (id: Uuid, imageId: Uuid) =>
    http.post<unknown>(`/reports/${id}/key-images/${imageId}/complete`).then(() => undefined),
  removeKeyImage: (id: Uuid, imageId: Uuid) =>
    http.delete<unknown>(`/reports/${id}/key-images/${imageId}`).then(() => undefined),
};

// ---------- Account (slice 4a) ----------

export const accountApi = {
  /** 204. Allowed while a password change is required (like `/me` and `/auth/*`). */
  changePassword: (body: ChangePasswordRequest) =>
    http.post<void>('/me/password', body).then(() => undefined),
};

// ---------- Dashboard (slice 4a, every role) ----------

export const dashboardApi = {
  get: (from: IsoDate, to: IsoDate) =>
    http.get<DashboardDto>('/dashboard', { params: { from, to } }).then((r) => r.data),
};

// ---------- Administration (slice 4a, ADMIN) ----------

/** Drops empty filters so they are not sent as `q=`. */
function filters<T extends object>(query: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}

export const adminUsersApi = {
  list: (query: AdminUserQuery) =>
    http.get<Page<AdminUserDto>>('/admin/users', { params: filters(query) }).then((r) => r.data),
  create: (body: CreateUserRequest) =>
    http.post<CreateUserResponse>('/admin/users', body).then((r) => r.data),
  update: (id: Uuid, body: UpdateUserRequest) =>
    http.put<AdminUserDto>(`/admin/users/${id}`, body).then((r) => r.data),
  lock: (id: Uuid) => http.post<AdminUserDto>(`/admin/users/${id}/lock`).then((r) => r.data),
  unlock: (id: Uuid) => http.post<AdminUserDto>(`/admin/users/${id}/unlock`).then((r) => r.data),
  resetPassword: (id: Uuid) =>
    http.post<TemporaryPasswordResponse>(`/admin/users/${id}/reset-password`).then((r) => r.data),
};

export const adminModelsApi = {
  list: () => http.get<AdminModelDto[]>('/admin/models').then((r) => r.data),
  enable: (id: Uuid) => http.post<AdminModelDto>(`/admin/models/${id}/enable`).then((r) => r.data),
  disable: (id: Uuid) =>
    http.post<AdminModelDto>(`/admin/models/${id}/disable`).then((r) => r.data),
};

/** `attachment; filename="audit.csv"` / `filename*=UTF-8''…` → the file name, if any. */
export function fileNameFromDisposition(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ''));
    } catch {
      // malformed escape: fall back to the plain parameter
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1])?.trim();
  return name ? name : null;
}

export const auditApi = {
  list: (query: AuditQuery & { page: number; size: number }) =>
    http.get<Page<AuditEntryDto>>('/admin/audit', { params: filters(query) }).then((r) => r.data),
  /** Actions that occur in the range (for the filter dropdown). */
  actions: (from: IsoDate, to: IsoDate) =>
    http.get<string[]>('/admin/audit/actions', { params: { from, to } }).then((r) => r.data),
  /**
   * The CSV (streamed by the server, UTF-8 with BOM) through the authenticated client, as a blob
   * to save: a plain link could not carry the access token.
   */
  exportCsv: (query: AuditQuery) =>
    http
      .get<Blob>('/admin/audit/export.csv', {
        params: filters(query),
        responseType: 'blob',
        timeout: 120_000,
      })
      .then((r) => ({
        blob: r.data,
        fileName: fileNameFromDisposition(r.headers['content-disposition']),
      })),
};
