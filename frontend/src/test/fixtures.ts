import type {
  AnnotationDto,
  FindingDto,
  ReportDto,
  SampleCaseDto,
  MeshArtifact,
  ModelDto,
  PatientDto,
  PredictionDto,
  StudyDto,
  TokenResponse,
  UserDto,
  Vec3,
} from '@/api/types';

export const doctor: UserDto = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'doctor',
  fullName: 'Dr. Demo',
  roles: ['DOCTOR'],
};

export const admin: UserDto = {
  id: '00000000-0000-4000-8000-000000000002',
  username: 'admin',
  fullName: 'Demo Admin',
  roles: ['ADMIN'],
};

export const technician: UserDto = {
  id: '00000000-0000-4000-8000-000000000003',
  username: 'tech',
  fullName: 'Demo Technician',
  roles: ['TECHNICIAN'],
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
  sample: null,
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
      volumeUrl: null,
      dims: null,
      spacing: null,
      spacingAssumed: false,
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

/** A PENDING AI finding of the 2D study's run. */
export function aiFinding(overrides: Partial<FindingDto> = {}): FindingDto {
  return {
    id: 'f0',
    label: 'Finding',
    confidence: 0.5,
    volumeMl: null,
    bbox: null,
    reviewStatus: 'PENDING',
    review: null,
    source: 'AI',
    version: 0,
    seriesId: study.series[0]?.id ?? '',
    annotationId: null,
    ...overrides,
  };
}

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
    finding('f2', 'Effusion', 0.31),
    finding('f1', 'Cardiomegaly', 0.87),
    finding('f3', 'Atelectasis', 0.12),
  ],
  artifacts: {
    heatmaps: { Cardiomegaly: '/medimg/predictions/j/1/heatmap-Cardiomegaly.png' },
    segmentation: null,
    meshes: [],
  },
});

function finding(id: string, label: string, confidence: number): FindingDto {
  return aiFinding({ id, label, confidence });
}

// ---------- CT volume (slice 2a) ----------

export const ctStudy: StudyDto = {
  id: '77777777-7777-4777-8777-777777777777',
  patientId: patient.id,
  inputType: 'NIFTI',
  modality: 'CT',
  bodyPart: 'ABDOMEN',
  createdAt: '2026-11-25T08:05:00Z',
  series: [
    {
      id: '88888888-8888-4888-8888-888888888888',
      modality: 'CT',
      rows: 512,
      cols: 512,
      numImages: 220,
      imageUrl: null,
      thumbnailUrl: '/medimg/studies/ct/series/v/thumb.png?X-Amz-Signature=abc',
      volumeUrl: '/medimg/studies/ct/series/v/volume.nii.gz?X-Amz-Signature=abc',
      dims: [512, 512, 220],
      spacing: [0.78, 0.78, 1.5],
      spacingAssumed: false,
    },
  ],
};

/** The first labels of `ct-totalseg` in model order: label `i` is voxel value `i + 1`. */
export const SEG_LABELS = ['liver', 'spleen', 'kidney_left', 'kidney_right', 'pancreas'];

export const segModel: ModelDto = {
  id: '99999999-9999-4999-8999-999999999999',
  code: 'ct-totalseg',
  version: '2.18.0-fast',
  name: 'CT organ segmentation',
  task: 'SEGMENTATION_3D',
  labels: SEG_LABELS,
};

export const SEG_JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mesh(label: string, color: string, volumeMl: number, centroid: Vec3): MeshArtifact {
  return {
    label,
    color,
    url: `/medimg/predictions/${SEG_JOB_ID}/1/meshes/${label}.glb?X-Amz-Signature=abc`,
    triangles: 12_000,
    volumeMl,
    centroid,
  };
}

/** Kidney (left) is deliberately listed before spleen: order must come from the model labels. */
export const segMeshes: MeshArtifact[] = [
  mesh('liver', '#DC5A3C', 1520.4, [-62.5, 18.25, -410.0]),
  mesh('kidney_left', '#B4A03C', 162.7, [71.0, 52.5, -455.75]),
  mesh('spleen', '#9E4FC0', 210.9, [96.5, 40.0, -402.0]),
];

export const segPrediction = prediction({
  jobId: SEG_JOB_ID,
  studyId: ctStudy.id,
  seriesId: ctStudy.series[0]?.id ?? '',
  status: 'DONE',
  progress: 100,
  model: { code: segModel.code, version: segModel.version },
  inferenceMs: 95_000,
  finishedAt: '2026-11-25T08:12:00Z',
  params: {},
  findings: segMeshes.map((m, i) =>
    aiFinding({
      id: `seg-${i}`,
      label: m.label,
      confidence: null,
      volumeMl: m.volumeMl,
      seriesId: ctStudy.series[0]?.id ?? '',
    }),
  ),
  artifacts: {
    heatmaps: {},
    segmentation: `/medimg/predictions/${SEG_JOB_ID}/1/segmentation.nii.gz?X-Amz-Signature=abc`,
    meshes: segMeshes,
  },
});

// ---------- Slice 2b: DICOM X-ray, image stack, sample cases ----------

/** One DICOM X-ray, normalised by the worker to an 8-bit PNG: viewed like a PNG upload. */
export const dicomXrayStudy: StudyDto = {
  ...study,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  inputType: 'DICOM_2D',
  modality: 'DX',
  series: study.series.map((s) => ({
    ...s,
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    modality: 'DX',
    rows: 2048,
    cols: 2500,
  })),
};

/** A ZIP of 8-bit PNG slices uploaded without spacing: stored as `OT`, 1 mm assumed. */
export const stackStudy: StudyDto = {
  ...ctStudy,
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  inputType: 'IMAGE_STACK',
  modality: 'OT',
  bodyPart: 'OTHER',
  series: [
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      modality: 'OT',
      rows: 256,
      cols: 256,
      numImages: 40,
      imageUrl: null,
      thumbnailUrl: '/medimg/studies/st/series/v/thumb.png?X-Amz-Signature=abc',
      volumeUrl: '/medimg/studies/st/series/v/volume.nii.gz?X-Amz-Signature=abc',
      dims: [256, 256, 40],
      spacing: [1, 1, 1],
      spacingAssumed: true,
    },
  ],
};

export const samplePatient: PatientDto = {
  ...patient,
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  code: 'CASE-SAMPLE1',
  note: null,
  studyCount: 1,
  sample: {
    title: 'Abdominal CT, 2 mm',
    description: 'Portal venous phase, liver and kidneys in view.',
    source: 'TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0, Wasserthal et al. 2023',
  },
};

export const sampleCases: SampleCaseDto[] = [
  {
    patientId: samplePatient.id,
    code: samplePatient.code,
    title: 'Abdominal CT, 2 mm',
    description: 'Portal venous phase, liver and kidneys in view.',
    source: 'TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0, Wasserthal et al. 2023',
    studies: [
      {
        studyId: ctStudy.id,
        inputType: 'NIFTI',
        modality: 'CT',
        thumbnailUrl: '/medimg/studies/ct/series/v/thumb.png?X-Amz-Signature=abc',
        latestPrediction: { jobId: SEG_JOB_ID, modelCode: 'ct-totalseg', status: 'DONE' },
      },
    ],
  },
  {
    patientId: '12121212-1212-4121-8121-121212121212',
    code: 'CASE-SAMPLE2',
    title: 'Thorax CT, not segmented yet',
    description: null,
    source: 'TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0, Wasserthal et al. 2023',
    studies: [
      {
        studyId: '13131313-1313-4131-8131-131313131313',
        inputType: 'DICOM_SERIES',
        modality: 'CT',
        thumbnailUrl: '/medimg/studies/ct2/series/v/thumb.png?X-Amz-Signature=abc',
        latestPrediction: null,
      },
    ],
  },
];

// ---------- Slice 3: annotations, reports ----------

/** A 2D rectangle on the X-ray, drawn by the doctor. */
export function annotation(overrides: Partial<AnnotationDto> = {}): AnnotationDto {
  return {
    id: 'ann-1',
    studyId: study.id,
    seriesId: study.series[0]?.id ?? '',
    author: { id: doctor.id, fullName: doctor.fullName },
    kind: 'RECTANGLE',
    geometry: { x: 100, y: 120, width: 200, height: 150 },
    label: 'Nodule',
    note: null,
    measurement: { areaPx2: 30000 },
    createdAt: '2026-11-25T09:00:00Z',
    updatedAt: '2026-11-25T09:00:00Z',
    version: 0,
    ...overrides,
  };
}

/** A draft report of the 2D study, version 1. */
export function report(overrides: Partial<ReportDto> = {}): ReportDto {
  return {
    id: 'rep-1',
    studyId: study.id,
    version: 1,
    status: 'DRAFT',
    template: 'CXR',
    language: 'en',
    clinicalInfo: 'Cough for two weeks.',
    technique: 'Chest X-ray, PA view.',
    findingsText: '- Cardiomegaly (AI, 87%), accepted.',
    impression: '',
    author: { id: doctor.id, fullName: doctor.fullName },
    signedBy: null,
    signedAt: null,
    amendsReportId: null,
    keyImages: [],
    createdAt: '2026-11-25T09:30:00Z',
    updatedAt: '2026-11-25T09:30:00Z',
    rowVersion: 0,
    ...overrides,
  };
}

export function finalReport(overrides: Partial<ReportDto> = {}): ReportDto {
  return report({
    status: 'FINAL',
    impression: 'Cardiomegaly.',
    signedBy: { id: doctor.id, fullName: doctor.fullName },
    signedAt: '2026-11-25T10:00:00Z',
    ...overrides,
  });
}
