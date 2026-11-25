import { ExperimentOutlined, ReloadOutlined, StopOutlined, WifiOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Empty,
  InputNumber,
  List,
  Progress,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/problem';
import type { CreatePredictionResponse, InputType, PredictionDto, Uuid } from '@/api/types';
import { useCan } from '@/features/auth/permissions';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { formatDateTime } from '@/shared/lib/format';
import { FindingsTable } from './FindingsTable';
import {
  DEFAULT_THRESHOLD,
  findingValue,
  isSegmentationModel,
  isSegmentationResult,
  runThreshold,
  sortFindings,
} from './findings';
import { useModels, usePredictionAction, useRunPrediction, useStudyPredictions } from './hooks';
import { PredictionStatusTag } from './PredictionStatusTag';
import { StructuresTable } from './StructuresTable';
import { usePredictionLive } from './usePredictionLive';

export interface AiPanelProps {
  studyId: Uuid;
  /** Input type of the study: only models that accept it are offered. */
  inputType: InputType;
  seriesId: Uuid | null;
  /** Run shown in the panel (and whose heatmaps / labelmap the viewer can overlay). */
  jobId: Uuid | null;
  onSelectJob: (jobId: Uuid) => void;
  visibleHeatmaps?: readonly string[];
  onToggleHeatmap?: (label: string) => void;
  /**
   * Renders the structures of a finished segmentation run (e.g. with viewer controls).
   * Defaults to a read-only table of structures and volumes.
   */
  renderSegmentation?: (prediction: PredictionDto) => ReactNode;
}

const NO_HEATMAPS: readonly string[] = [];
const ignoreHeatmap = () => undefined;

export function AiPanel({
  studyId,
  inputType,
  seriesId,
  jobId,
  onSelectJob,
  visibleHeatmaps = NO_HEATMAPS,
  onToggleHeatmap = ignoreHeatmap,
  renderSegmentation,
}: AiPanelProps) {
  const { t } = useTranslation();
  const can = useCan();
  const history = useStudyPredictions(studyId);
  const [queueInfo, setQueueInfo] = useState<{ jobId: Uuid; position: number } | null>(null);

  const onStarted = (res: CreatePredictionResponse) => {
    setQueueInfo({ jobId: res.jobId, position: res.queuePosition });
    onSelectJob(res.jobId);
  };

  return (
    <div className="ai-panel">
      <div className="ai-panel__section">
        <Typography.Title level={5} className="ai-panel__title">
          <ExperimentOutlined /> {t('ai.title')}
        </Typography.Title>
        {can('runAi') && (
          <RunControls
            studyId={studyId}
            inputType={inputType}
            seriesId={seriesId}
            onStarted={onStarted}
          />
        )}
      </div>

      <div className="ai-panel__section ai-panel__section--grow">
        {jobId ? (
          <RunDetails
            jobId={jobId}
            queuePosition={queueInfo?.jobId === jobId ? queueInfo.position : null}
            canManage={can('manageJob')}
            visibleHeatmaps={visibleHeatmaps}
            onToggleHeatmap={onToggleHeatmap}
            renderSegmentation={renderSegmentation}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ai.selectRun')} />
        )}
      </div>

      <div className="ai-panel__section">
        <Typography.Text strong>{t('ai.history')}</Typography.Text>
        {history.isError && <ProblemAlert error={history.error} />}
        <RunHistory
          runs={history.data ?? []}
          loading={history.isPending}
          selectedJobId={jobId}
          onSelect={onSelectJob}
        />
      </div>
    </div>
  );
}

interface RunControlsProps {
  studyId: Uuid;
  inputType: InputType;
  seriesId: Uuid | null;
  onStarted: (res: CreatePredictionResponse) => void;
}

function RunControls({ studyId, inputType, seriesId, onStarted }: RunControlsProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const models = useModels(inputType);
  const run = useRunPrediction();
  const [modelCode, setModelCode] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);

  const effectiveModel = modelCode ?? models.data?.[0]?.code ?? null;
  const segmentation = isSegmentationModel(models.data?.find((m) => m.code === effectiveModel));

  const onRun = () => {
    if (!seriesId || !effectiveModel) return;
    run.mutate(
      {
        studyId,
        seriesId,
        modelCode: effectiveModel,
        // Segmentation takes no parameters; a threshold only applies to classification.
        params: segmentation ? {} : { threshold },
      },
      {
        onSuccess: (res) => {
          void message.success(t('ai.started'));
          onStarted(res);
        },
        onError: (e) => void message.error(errorMessage(e)),
      },
    );
  };

  return (
    <>
      {models.isError && <ProblemAlert error={models.error} />}
      {models.data && models.data.length === 0 && (
        <Alert type="warning" showIcon title={t('ai.noModels')} />
      )}

      <label className="field-label" htmlFor="ai-model">
        {t('ai.model')}
      </label>
      <Select
        id="ai-model"
        style={{ width: '100%' }}
        loading={models.isPending}
        value={effectiveModel ?? undefined}
        onChange={setModelCode}
        options={(models.data ?? []).map((m) => ({
          value: m.code,
          label: `${m.name} (${m.version})`,
        }))}
      />

      <div className="ai-panel__run">
        {segmentation ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('ai.segmentationHint')}
          </Typography.Text>
        ) : (
          <Space size={6}>
            <label className="field-label" htmlFor="ai-threshold" style={{ margin: 0 }}>
              {t('ai.threshold')}
            </label>
            <InputNumber
              id="ai-threshold"
              size="small"
              min={0.05}
              max={0.95}
              step={0.05}
              value={threshold}
              onChange={(v) => setThreshold(typeof v === 'number' ? v : DEFAULT_THRESHOLD)}
              style={{ width: 80 }}
            />
          </Space>
        )}
        <Button
          type="primary"
          icon={<ExperimentOutlined />}
          onClick={onRun}
          loading={run.isPending}
          disabled={!seriesId || !effectiveModel}
        >
          {t(segmentation ? 'ai.runSegmentation' : 'ai.run')}
        </Button>
      </div>
    </>
  );
}

interface RunDetailsProps {
  jobId: Uuid;
  queuePosition: number | null;
  canManage: boolean;
  visibleHeatmaps: readonly string[];
  onToggleHeatmap: (label: string) => void;
  renderSegmentation: ((prediction: PredictionDto) => ReactNode) | undefined;
}

function RunDetails({
  jobId,
  queuePosition,
  canManage,
  visibleHeatmaps,
  onToggleHeatmap,
  renderSegmentation,
}: RunDetailsProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const live = usePredictionLive(jobId);
  const retry = usePredictionAction('retry');
  const cancel = usePredictionAction('cancel');
  const p = live.prediction;

  if (live.isError) return <ProblemAlert error={live.error} onRetry={() => void live.refetch()} />;
  if (!p) return <Skeleton active paragraph={{ rows: 4 }} />;

  const active = p.status === 'QUEUED' || p.status === 'RUNNING';
  const onError = (e: unknown) => void message.error(errorMessage(e));

  return (
    <div className="run-details" data-testid="run-details">
      <div className="run-details__head">
        <PredictionStatusTag status={p.status} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {p.model.code}@{p.model.version}
          {p.attempt > 1 ? ` · ${t('ai.attempt', { n: p.attempt })}` : ''}
        </Typography.Text>
      </div>

      {active && (
        <>
          <Progress
            percent={Math.round(p.progress)}
            status="active"
            size="small"
            aria-label={t('ai.progressLabel')}
          />
          <div className="run-details__meta">
            {p.status === 'QUEUED' && queuePosition !== null && (
              <Tag>{t('ai.queuePosition', { position: queuePosition })}</Tag>
            )}
            {live.transport !== 'idle' && (
              <Tag
                icon={<WifiOutlined />}
                color={live.transport === 'sse' ? 'green' : 'orange'}
                data-testid="transport"
              >
                {t(`ai.transport.${live.transport}`)}
              </Tag>
            )}
            {canManage && (
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={cancel.isPending}
                onClick={() => cancel.mutate(jobId, { onError })}
              >
                {t('ai.cancelJob')}
              </Button>
            )}
          </div>
        </>
      )}

      {p.status === 'FAILED' && (
        <Alert
          type="error"
          showIcon
          title={t('ai.status.FAILED')}
          description={p.error ?? undefined}
          action={
            canManage && (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={retry.isPending}
                onClick={() => retry.mutate(jobId, { onError })}
              >
                {t('ai.retryJob')}
              </Button>
            )
          }
        />
      )}

      {p.status === 'DONE' && isSegmentationResult(p) && (
        <>
          <div className="run-details__meta">
            <Typography.Text strong>
              {t('ai.structures', { count: p.findings.length })}
            </Typography.Text>
            {p.inferenceMs != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('ai.inference', { ms: p.inferenceMs })}
              </Typography.Text>
            )}
          </div>
          {renderSegmentation ? (
            renderSegmentation(p)
          ) : (
            <StructuresTable findings={p.findings} meshes={p.artifacts?.meshes ?? []} />
          )}
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            {t('ai.disclaimer')}
          </Typography.Paragraph>
        </>
      )}

      {p.status === 'DONE' && !isSegmentationResult(p) && (
        <>
          <div className="run-details__meta">
            <Typography.Text strong>{t('ai.findings')}</Typography.Text>
            {p.inferenceMs != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('ai.inference', { ms: p.inferenceMs })}
              </Typography.Text>
            )}
          </div>
          <FindingsTable
            findings={p.findings}
            threshold={runThreshold(p)}
            heatmaps={p.artifacts?.heatmaps ?? {}}
            visibleHeatmaps={visibleHeatmaps}
            onToggleHeatmap={onToggleHeatmap}
          />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            {t('ai.disclaimer')}
          </Typography.Paragraph>
        </>
      )}
    </div>
  );
}

interface RunHistoryProps {
  runs: PredictionDto[];
  loading: boolean;
  selectedJobId: Uuid | null;
  onSelect: (jobId: Uuid) => void;
}

function RunHistory({ runs, loading, selectedJobId, onSelect }: RunHistoryProps) {
  const { t, i18n } = useTranslation();
  if (loading) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (runs.length === 0) {
    return <Typography.Paragraph type="secondary">{t('ai.noRuns')}</Typography.Paragraph>;
  }
  return (
    <List
      size="small"
      className="run-history"
      dataSource={runs}
      renderItem={(r) => {
        const top = sortFindings(r.findings)[0];
        const selected = r.jobId === selectedJobId;
        const summary = isSegmentationResult(r)
          ? t('ai.structures', { count: r.findings.length })
          : top
            ? `${top.label} ${findingValue(top, i18n.language)}`
            : '';
        return (
          <List.Item
            className={`run-history__item${selected ? ' run-history__item--selected' : ''}`}
          >
            <button
              type="button"
              className="run-history__select"
              aria-pressed={selected}
              onClick={() => onSelect(r.jobId)}
            >
              <span className="run-history__row">
                <PredictionStatusTag status={r.status} />
                <span className="run-history__time">
                  {formatDateTime(r.queuedAt, i18n.language)}
                </span>
              </span>
              <span className="run-history__sub">
                {r.model.code}@{r.model.version}
                {summary ? ` · ${summary}` : ''}
              </span>
            </button>
          </List.Item>
        );
      }}
    />
  );
}
