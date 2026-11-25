import {
  BulbOutlined,
  CameraOutlined,
  DragOutlined,
  ExpandOutlined,
  ZoomInOutlined,
} from '@ant-design/icons';
import { Button, Empty, Segmented, Slider, Tag, Tooltip, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SeriesDto, StudyDto } from '@/api/types';
import { AiPanel } from '@/features/ai/AiPanel';
import { downloadBlob } from '@/shared/lib/format';
import {
  ImageViewer2D,
  type ImageViewerHandle,
  type ViewerOverlay,
  type ViewerTool,
} from './components/ImageViewer2D';
import { SeriesSidebar } from './components/SeriesSidebar';
import type { RefreshBudget } from './lib/useRefreshBudget';
import { useStudyRun } from './useStudyRun';

export interface StudyViewProps {
  study: StudyDto;
  /** Refetches the study to get fresh presigned URLs. */
  refetchStudy: () => unknown;
  /** Shared cap on URL refreshes (see `useRefreshBudget`). */
  refreshBudget: RefreshBudget;
}

/** 2D study (PNG/JPG): canvas viewer with Grad-CAM heatmap overlays (slice 1). */
export function ImageStudyView({ study, refetchStudy, refreshBudget }: StudyViewProps) {
  const { t } = useTranslation();
  const viewerRef = useRef<ImageViewerHandle>(null);
  const [tool, setTool] = useState<ViewerTool>('pan');
  const [opacity, setOpacity] = useState(0.5);
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [heatmapSel, setHeatmapSel] = useState<{ jobId: string; labels: string[] } | null>(null);
  const { jobId, selectJob, prediction } = useStudyRun(study.id);
  const refreshStudy = () => refreshBudget.spend(refetchStudy);

  const series: SeriesDto | undefined =
    study.series.find((s) => s.id === seriesId) ?? study.series[0];

  const visibleHeatmaps = heatmapSel && heatmapSel.jobId === jobId ? heatmapSel.labels : [];
  const heatmapUrls = prediction.data?.artifacts?.heatmaps ?? {};
  const overlays: ViewerOverlay[] = visibleHeatmaps
    .filter((label) => heatmapUrls[label])
    .map((label) => ({ id: label, url: heatmapUrls[label] ?? '', opacity }));

  const toggleHeatmap = (label: string) => {
    if (!jobId) return;
    const labels = visibleHeatmaps.includes(label)
      ? visibleHeatmaps.filter((l) => l !== label)
      : [...visibleHeatmaps, label];
    setHeatmapSel({ jobId, labels });
  };

  const screenshot = async () => {
    const blob = await viewerRef.current?.toBlob();
    if (blob) downloadBlob(blob, `study-${study.id.slice(0, 8)}-${Date.now()}.png`);
  };

  return (
    <div className="viewer-page">
      <SeriesSidebar
        study={study}
        loading={false}
        selectedId={series?.id}
        onSelect={setSeriesId}
        onThumbnailError={refreshStudy}
      />

      <section className="viewer-page__center">
        <div className="viewer-toolbar">
          <Segmented<ViewerTool>
            value={tool}
            onChange={setTool}
            options={[
              { value: 'pan', icon: <DragOutlined />, label: t('viewer.tools.pan') },
              { value: 'zoom', icon: <ZoomInOutlined />, label: t('viewer.tools.zoom') },
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
          <span className="viewer-toolbar__info">
            <Tag color="blue">{study.modality}</Tag>
            <Tag>{study.bodyPart}</Tag>
          </span>
        </div>

        <div className="viewer-page__canvas">
          {series?.imageUrl ? (
            <ImageViewer2D
              ref={viewerRef}
              imageUrl={series.imageUrl}
              overlays={overlays}
              tool={tool}
              ariaLabel={`${series.modality} ${study.bodyPart}`}
              onImageLoad={refreshBudget.reset}
              onImageError={refreshStudy}
              onOverlayError={() => refreshBudget.spend(prediction.refetch)}
            />
          ) : (
            <Empty description={t('viewer.noSeries')} />
          )}
        </div>
        <Typography.Text className="viewer-page__hint">{t('viewer.hint')}</Typography.Text>
      </section>

      <aside className="viewer-page__ai">
        <AiPanel
          studyId={study.id}
          inputType={study.inputType}
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
