import {
  ArrowLeftOutlined,
  CameraOutlined,
  DragOutlined,
  ExpandOutlined,
  ZoomInOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Empty, Result, Segmented, Skeleton, Slider, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { studiesApi } from '@/api/endpoints';
import { toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type { SeriesDto } from '@/api/types';
import { AiPanel } from '@/features/ai/AiPanel';
import { useStudyPredictions } from '@/features/ai/hooks';
import { usePrediction } from '@/features/ai/usePredictionLive';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { downloadBlob } from '@/shared/lib/format';
import {
  ImageViewer2D,
  type ImageViewerHandle,
  type ViewerOverlay,
  type ViewerTool,
} from './components/ImageViewer2D';

/** Presigned URLs expire after 15 min; refetching returns fresh ones. Cap retries per URL. */
const MAX_URL_REFRESHES = 3;

export default function ViewerPage() {
  const { studyId = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const viewerRef = useRef<ImageViewerHandle>(null);
  const [tool, setTool] = useState<ViewerTool>('pan');
  const [opacity, setOpacity] = useState(0.5);
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [heatmapSel, setHeatmapSel] = useState<{ jobId: string; labels: string[] } | null>(null);
  const refreshCount = useRef(0);

  const study = useQuery({
    queryKey: queryKeys.studies.detail(studyId),
    queryFn: () => studiesApi.get(studyId),
    enabled: !!studyId,
  });
  const history = useStudyPredictions(studyId);

  // Selected run: ?job=… or the latest run of the study.
  const jobId = params.get('job') ?? history.data?.[0]?.jobId ?? null;
  const prediction = usePrediction(jobId);

  const series: SeriesDto | undefined =
    study.data?.series.find((s) => s.id === seriesId) ?? study.data?.series[0];

  const visibleHeatmaps = heatmapSel && heatmapSel.jobId === jobId ? heatmapSel.labels : [];
  const heatmapUrls = prediction.data?.artifacts?.heatmaps ?? {};
  const overlays: ViewerOverlay[] = visibleHeatmaps
    .filter((label) => heatmapUrls[label])
    .map((label) => ({ id: label, url: heatmapUrls[label] ?? '', opacity }));

  const selectJob = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set('job', id);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const toggleHeatmap = (label: string) => {
    if (!jobId) return;
    const current = visibleHeatmaps;
    const labels = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label];
    setHeatmapSel({ jobId, labels });
  };

  const refreshStudy = () => {
    if (refreshCount.current >= MAX_URL_REFRESHES) return;
    refreshCount.current += 1;
    void study.refetch();
  };
  const refreshPrediction = () => {
    if (refreshCount.current >= MAX_URL_REFRESHES) return;
    refreshCount.current += 1;
    void prediction.refetch();
  };

  const screenshot = async () => {
    const blob = await viewerRef.current?.toBlob();
    if (blob) downloadBlob(blob, `study-${studyId.slice(0, 8)}-${Date.now()}.png`);
  };

  if (study.isError && toAppError(study.error).status === 404) {
    return (
      <Result
        status="404"
        title={t('viewer.studyNotFound')}
        extra={<Button onClick={() => void navigate('/cases')}>{t('nav.cases')}</Button>}
      />
    );
  }

  return (
    <div className="viewer-page">
      <aside className="viewer-page__series">
        {study.data && (
          <Link to={`/cases/${study.data.patientId}`} className="back-link back-link--dark">
            <ArrowLeftOutlined /> {t('viewer.backToCase')}
          </Link>
        )}
        <div className="viewer-page__series-title">{t('viewer.series')}</div>
        {study.isPending && <Skeleton.Image active style={{ width: 112, height: 112 }} />}
        {study.data?.series.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`series-thumb${s.id === series?.id ? ' series-thumb--active' : ''}`}
            onClick={() => setSeriesId(s.id)}
            aria-pressed={s.id === series?.id}
          >
            <img src={s.thumbnailUrl} alt={s.modality} onError={refreshStudy} />
            <span>
              {s.modality} · {s.cols}×{s.rows}
            </span>
          </button>
        ))}
      </aside>

      <section className="viewer-page__center">
        <div className="viewer-toolbar">
          <Segmented<ViewerTool>
            value={tool}
            onChange={setTool}
            options={[
              {
                value: 'pan',
                icon: <DragOutlined />,
                label: t('viewer.tools.pan'),
              },
              {
                value: 'zoom',
                icon: <ZoomInOutlined />,
                label: t('viewer.tools.zoom'),
              },
              {
                value: 'windowLevel',
                icon: <BulbOutlined />,
                label: t('viewer.tools.windowLevel'),
              },
            ]}
          />
          <Tooltip title={t('viewer.reset')}>
            <Button
              icon={<ExpandOutlined />}
              aria-label={t('viewer.reset')}
              onClick={() => viewerRef.current?.reset()}
            />
          </Tooltip>
          <Tooltip title={t('viewer.screenshot')}>
            <Button
              icon={<CameraOutlined />}
              aria-label={t('viewer.screenshot')}
              onClick={() => void screenshot()}
            />
          </Tooltip>
          <div className="viewer-toolbar__opacity">
            <span>{t('viewer.overlayOpacity')}</span>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={setOpacity}
              style={{ width: 120 }}
              tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
            />
          </div>
          {study.data && (
            <span className="viewer-toolbar__info">
              <Tag color="blue">{study.data.modality}</Tag>
              <Tag>{study.data.bodyPart}</Tag>
            </span>
          )}
        </div>

        <div className="viewer-page__canvas">
          {study.isError && (
            <ProblemAlert error={study.error} onRetry={() => void study.refetch()} />
          )}
          {series ? (
            <ImageViewer2D
              ref={viewerRef}
              imageUrl={series.imageUrl}
              overlays={overlays}
              tool={tool}
              ariaLabel={`${series.modality} ${study.data?.bodyPart ?? ''}`}
              onImageLoad={() => {
                refreshCount.current = 0;
              }}
              onImageError={refreshStudy}
              onOverlayError={refreshPrediction}
            />
          ) : study.data ? (
            <Empty description={t('viewer.noSeries')} />
          ) : null}
        </div>
        <Typography.Text className="viewer-page__hint">{t('viewer.hint')}</Typography.Text>
      </section>

      <aside className="viewer-page__ai">
        <AiPanel
          studyId={studyId}
          seriesId={series?.id ?? null}
          jobId={jobId}
          onSelectJob={selectJob}
          visibleHeatmaps={visibleHeatmaps}
          onToggleHeatmap={toggleHeatmap}
        />
      </aside>
    </div>
  );
}
