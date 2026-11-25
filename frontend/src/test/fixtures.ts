import type {
  ModelDto,
  PatientDto,
  PredictionDto,
  StudyDto,
  TokenResponse,
  UserDto,
} from '@/api/types';

export const doctor: UserDto = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'doctor',
  fullName: 'Dr. Demo',
  roles: ['DOCTOR'],
};

export const researcher: UserDto = {
  id: '00000000-0000-4000-8000-000000000004',
  username: 'researcher',
  fullName: 'Demo Researcher',
  roles: ['RESEARCHER'],
};

export function tokens(access: string, refresh: string, user: UserDto = doctor): TokenResponse {
  return { accessToken: access, refreshToken: refresh, expiresIn: 900, user };
}

export const patient: PatientDto = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'CASE-000001',
  birthYear: 1970,
  sex: 'M',
  note: 'follow-up',
  studyCount: 0,
  createdAt: '2026-11-20T08:00:00Z',
};

export const study: StudyDto = {
  id: '22222222-2222-4222-8222-222222222222',
  patientId: patient.id,
  inputType: 'IMAGE_2D',
  modality: 'CR',
  bodyPart: 'CHEST',
  createdAt: '2026-11-20T08:05:00Z',
  series: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      modality: 'CR',
      rows: 1024,
      cols: 1024,
      numImages: 1,
      imageUrl: '/medimg/studies/s/series/x/image.png?X-Amz-Signature=abc',
      thumbnailUrl: '/medimg/studies/s/series/x/thumb.png?X-Amz-Signature=abc',
    },
  ],
};

export const model: ModelDto = {
  id: '44444444-4444-4444-8444-444444444444',
  code: 'cxr-multilabel',
  version: '0.1.0-xrv',
  name: 'Chest X-ray multilabel',
  task: 'CLASSIFICATION_2D',
  labels: ['Cardiomegaly', 'Effusion', 'Atelectasis'],
};

export const JOB_ID = '55555555-5555-4555-8555-555555555555';

export function prediction(overrides: Partial<PredictionDto> = {}): PredictionDto {
  return {
    jobId: JOB_ID,
    studyId: study.id,
    seriesId: study.series[0]?.id ?? '',
    status: 'QUEUED',
    progress: 0,
    attempt: 1,
    model: { code: model.code, version: model.version },
    inferenceMs: null,
    error: null,
    queuedAt: '2026-11-20T08:10:00Z',
    finishedAt: null,
    params: { threshold: 0.5 },
    findings: [],
    artifacts: null,
    ...overrides,
  };
}

export const donePrediction = prediction({
  status: 'DONE',
  progress: 100,
  inferenceMs: 1234,
  finishedAt: '2026-11-20T08:10:05Z',
  // Deliberately NOT sorted, the UI must sort by confidence desc.
  findings: [
    { id: 'f2', label: 'Effusion', confidence: 0.31, bbox: null, reviewStatus: 'PENDING' },
    { id: 'f1', label: 'Cardiomegaly', confidence: 0.87, bbox: null, reviewStatus: 'PENDING' },
    { id: 'f3', label: 'Atelectasis', confidence: 0.12, bbox: null, reviewStatus: 'PENDING' },
  ],
  artifacts: { heatmaps: { Cardiomegaly: '/medimg/predictions/j/1/heatmap-Cardiomegaly.png' } },
});
