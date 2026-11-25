import axios from 'axios';
import { authHttp, http } from './http';
import type {
  AnnotationDto,
  CompleteUploadRequest,
  CreateAnnotationRequest,
  CreateFindingRequest,
  CreatePatientRequest,
  CreatePredictionRequest,
  CreatePredictionResponse,
  CreateReportRequest,
  FinalizeReportRequest,
  RefillReportRequest,
  FindingDto,
  InitKeyImageRequest,
  InitKeyImageResponse,
  InitUploadRequest,
  InitUploadResponse,
  InputType,
  LoginRequest,
  MarkSampleRequest,
  ModelDto,
  Page,
  PatientDto,
  PatientQuery,
  PdfLinkDto,
  PredictionDto,
  ReportDto,
  ReportSummaryDto,
  ReviewFindingRequest,
  ReviewStatus,
  SampleCaseDto,
  StudyDto,
  TokenResponse,
  UpdateAnnotationRequest,
  UpdatePatientRequest,
  UpdateReportRequest,
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
