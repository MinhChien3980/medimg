import {
  BlockOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileImageOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Progress,
  Result,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { patientsApi, studiesApi } from '@/api/endpoints';
import { errorMessage } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type { InputType, PatientDto, Uuid } from '@/api/types';
import { useModels, useRunPrediction } from '@/features/ai/hooks';
import { DEFAULT_THRESHOLD, isSegmentationModel } from '@/features/ai/findings';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { CasePicker } from './CasePicker';
import {
  ACCEPT_ATTRIBUTE,
  checkUploadFile,
  formatBytes,
  type UploadFileSpec,
  type UploadKind,
} from './fileValidation';
import { useUploadFlow, type UploadFailure, type UploadPhase } from './useUploadFlow';

/** Modality hints per kind of file (the worker reads the real modality from DICOM headers). */
const MODALITIES: Record<UploadKind, readonly string[]> = {
  image: ['CR', 'DX'],
  volume: ['CT', 'MR'],
};
const BODY_PARTS = ['CHEST', 'ABDOMEN', 'SKULL', 'EXTREMITY', 'OTHER'];

const PHASE_PERCENT: Record<UploadPhase, number> = {
  idle: 0,
  initializing: 5,
  uploading: 0, // real progress
  completing: 100,
  processing: 0, // real progress
  done: 100,
  failed: 100,
};

export default function UploadWizardPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [params] = useSearchParams();
  const preselectedId = params.get('caseId');

  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<PatientDto | null>(null);
  const [file, setFile] = useState<{ file: File; spec: UploadFileSpec } | null>(null);
  const [modality, setModality] = useState('CR');
  const [bodyPart, setBodyPart] = useState('CHEST');
  const flow = useUploadFlow();

  // `?caseId=` preselects a case (e.g. coming from the case page).
  const preselected = useQuery({
    queryKey: queryKeys.patients.detail(preselectedId ?? ''),
    queryFn: () => patientsApi.get(preselectedId ?? ''),
    enabled: !!preselectedId,
  });
  const patient = picked ?? preselected.data ?? null;

  const modalities = MODALITIES[file?.spec.kind ?? 'image'];

  const beforeUpload = (candidate: File) => {
    const check = checkUploadFile(candidate);
    if (check.ok) {
      setFile({ file: candidate, spec: check.spec });
      const options = MODALITIES[check.spec.kind];
      if (!options.includes(modality)) setModality(options[0] ?? modality);
      if (check.spec.kind === 'volume' && bodyPart === 'CHEST') setBodyPart('ABDOMEN');
    } else if (check.problem === 'type') {
      void message.error(t('upload.invalidType'));
    } else if (check.problem === 'size') {
      void message.error(t(check.kind === 'volume' ? 'upload.tooLargeVolume' : 'upload.tooLarge'));
    } else {
      void message.error(t('upload.empty'));
    }
    return Upload.LIST_IGNORE; // never let antd upload by itself
  };

  const startUpload = () => {
    if (!patient || !file) return;
    setStep(2);
    void flow.start({
      patientId: patient.id,
      file: file.file,
      modalityHint: modality,
      bodyPartHint: bodyPart,
    });
  };

  const restart = () => {
    flow.reset();
    setFile(null);
    setStep(1);
  };

  return (
    <div className="page page--narrow">
      <Typography.Title level={3}>{t('upload.title')}</Typography.Title>
      <Steps
        current={step}
        style={{ marginBottom: 24 }}
        items={[
          { title: t('upload.steps.case'), content: patient?.code },
          { title: t('upload.steps.file'), content: file?.file.name },
          { title: t('upload.steps.process') },
        ]}
      />

      <Card>
        {step === 0 && (
          <>
            <CasePicker value={patient} onChange={setPicked} />
            {patient && (
              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                title={`${t('upload.selectedCase')}: ${patient.code}`}
              />
            )}
            <div className="wizard-actions">
              <Button type="primary" disabled={!patient} onClick={() => setStep(1)}>
                {t('common.next')}
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <Upload.Dragger
              accept={ACCEPT_ATTRIBUTE}
              multiple={false}
              maxCount={1}
              showUploadList={false}
              beforeUpload={beforeUpload}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">{t('upload.dropTitle')}</p>
              <p className="ant-upload-hint">{t('upload.dropHint')}</p>
            </Upload.Dragger>

            {file && (
              <div className="picked-file" data-testid="picked-file">
                {file.spec.kind === 'volume' ? <BlockOutlined /> : <FileImageOutlined />}
                <span className="picked-file__name">{file.file.name}</span>
                <Tag color={file.spec.kind === 'volume' ? 'geekblue' : undefined}>
                  {t(`upload.kinds.${file.spec.kind}`)}
                </Tag>
                <Tag>{formatBytes(file.file.size)}</Tag>
                <Button
                  size="small"
                  type="text"
                  icon={<DeleteOutlined />}
                  aria-label={t('upload.removeFile')}
                  onClick={() => setFile(null)}
                />
              </div>
            )}

            <Form layout="inline" style={{ marginTop: 16 }}>
              <Form.Item label={t('upload.modality')}>
                <Select
                  aria-label={t('upload.modality')}
                  value={modality}
                  onChange={setModality}
                  options={modalities.map((m) => ({ value: m, label: m }))}
                  style={{ width: 100 }}
                />
              </Form.Item>
              <Form.Item label={t('upload.bodyPart')}>
                <Select
                  aria-label={t('upload.bodyPart')}
                  value={bodyPart}
                  onChange={setBodyPart}
                  options={BODY_PARTS.map((b) => ({ value: b, label: b }))}
                  style={{ width: 140 }}
                />
              </Form.Item>
            </Form>

            <div className="wizard-actions">
              <Button onClick={() => setStep(0)}>{t('common.back')}</Button>
              <Button
                type="primary"
                icon={<CloudUploadOutlined />}
                disabled={!file || !patient}
                onClick={startUpload}
              >
                {t('upload.start')}
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <ProcessStep
            flow={flow}
            patientId={patient?.id ?? null}
            onRestart={restart}
            onRetry={startUpload}
          />
        )}
      </Card>
    </div>
  );
}

interface ProcessStepProps {
  flow: ReturnType<typeof useUploadFlow>;
  patientId: Uuid | null;
  onRestart: () => void;
  onRetry: () => void;
}

function ProcessStep({ flow, patientId, onRestart, onRetry }: ProcessStepProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (flow.phase === 'done' && flow.studyId) {
    return (
      <Result
        status="success"
        title={t(flow.kind === 'volume' ? 'upload.phases.doneVolume' : 'upload.phases.done')}
        subTitle={t('upload.doneSubtitle')}
        extra={
          <Space orientation="vertical" align="center" size="middle">
            <Space wrap>
              <Button
                type="primary"
                icon={<EyeOutlined />}
                onClick={() => void navigate(`/studies/${flow.studyId}`)}
              >
                {t('upload.openViewer')}
              </Button>
              <RunAiButton studyId={flow.studyId} inputType={flow.inputType} />
            </Space>
            <Space>
              <Button type="link" onClick={onRestart}>
                {t('upload.another')}
              </Button>
              {patientId && (
                <Button type="link" onClick={() => void navigate(`/cases/${patientId}`)}>
                  {t('caseDetail.backToList')}
                </Button>
              )}
            </Space>
          </Space>
        }
      />
    );
  }

  if (flow.phase === 'failed') {
    return (
      <Result
        status="error"
        title={t('upload.phases.failed')}
        extra={[
          <Button key="retry" type="primary" onClick={onRetry}>
            {t('upload.tryAgain')}
          </Button>,
          <Button key="back" onClick={onRestart}>
            {t('common.back')}
          </Button>,
        ]}
      >
        {flow.failure && <FailureAlert failure={flow.failure} kind={flow.kind} />}
      </Result>
    );
  }

  const processing = flow.phase === 'processing';
  const percent =
    flow.phase === 'uploading'
      ? flow.percent
      : processing
        ? Math.round(flow.processingPercent)
        : PHASE_PERCENT[flow.phase];
  const phaseKey =
    flow.phase === 'idle'
      ? 'initializing'
      : processing && flow.kind === 'volume'
        ? 'processingVolume'
        : flow.phase;

  return (
    <div className="process-step" data-testid="process-step">
      <Spin />
      <Typography.Paragraph style={{ marginTop: 12 }}>
        {t(`upload.phases.${phaseKey}`)}
      </Typography.Paragraph>
      <Progress
        percent={percent}
        status={processing ? 'active' : 'normal'}
        aria-label={t(processing ? 'upload.processingLabel' : 'upload.progressLabel')}
      />
      {flow.uploadStatus && <Tag>{t(`upload.status.${flow.uploadStatus}`)}</Tag>}
    </div>
  );
}

function FailureAlert({ failure, kind }: { failure: UploadFailure; kind: UploadKind }) {
  const { t } = useTranslation();
  switch (failure.kind) {
    case 'request':
      return <ProblemAlert error={failure.error} />;
    case 'processing':
      return (
        <Alert
          type="error"
          showIcon
          title={t('upload.errors.processing')}
          description={failure.detail ?? undefined}
        />
      );
    case 'timeout':
      return (
        <Alert
          type="error"
          showIcon
          title={t(kind === 'volume' ? 'upload.errors.timeoutVolume' : 'upload.errors.timeout')}
        />
      );
    case 'invalidResponse':
      return <Alert type="error" showIcon title={t('upload.errors.invalidResponse')} />;
  }
}

/** Starts an AI run on the first series of the new study, then opens the viewer on it. */
function RunAiButton({ studyId, inputType }: { studyId: Uuid; inputType: InputType | null }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const models = useModels(inputType ?? 'IMAGE_2D');
  const run = useRunPrediction();
  const [modelCode, setModelCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveModel = modelCode ?? models.data?.[0]?.code ?? null;
  const selected = models.data?.find((m) => m.code === effectiveModel);

  const onRun = async () => {
    if (!effectiveModel) return;
    setBusy(true);
    try {
      const study = await studiesApi.get(studyId);
      const seriesId = study.series[0]?.id;
      if (!seriesId) throw new Error(t('viewer.noSeries'));
      const res = await run.mutateAsync({
        studyId,
        seriesId,
        modelCode: effectiveModel,
        params: isSegmentationModel(selected) ? {} : { threshold: DEFAULT_THRESHOLD },
      });
      await navigate(`/studies/${studyId}?job=${res.jobId}`);
    } catch (e) {
      void message.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Space.Compact>
      <Select
        aria-label={t('upload.chooseModel')}
        style={{ width: 220 }}
        loading={models.isPending}
        value={effectiveModel ?? undefined}
        onChange={setModelCode}
        options={(models.data ?? []).map((m) => ({ value: m.code, label: m.name }))}
      />
      <Button
        icon={<ExperimentOutlined />}
        loading={busy}
        disabled={!effectiveModel}
        onClick={() => void onRun()}
      >
        {t('upload.runAi')}
      </Button>
    </Space.Compact>
  );
}
