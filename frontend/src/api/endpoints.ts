import axios from 'axios';
import { authHttp, http } from './http';
import type {
  CreatePatientRequest,
  CreatePredictionRequest,
  CreatePredictionResponse,
  InitUploadRequest,
  InitUploadResponse,
  InputType,
  LoginRequest,
  ModelDto,
  Page,
  PatientDto,
  PatientQuery,
  PredictionDto,
  StudyDto,
  TokenResponse,
  UpdatePatientRequest,
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
};

// ---------- Uploads ----------

export const uploadsApi = {
  init: (body: InitUploadRequest) =>
    http.post<InitUploadResponse>('/uploads/init', body).then((r) => r.data),
  complete: (uploadId: Uuid) =>
    http.post<UploadDto>(`/uploads/${uploadId}/complete`).then((r) => r.data),
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
