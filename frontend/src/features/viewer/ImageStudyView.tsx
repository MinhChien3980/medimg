import {
  BulbOutlined,
  CameraOutlined,
  DragOutlined,
  ExpandOutlined,
  ZoomInOutlined,
} from '@ant-design/icons';
import { Badge, Button, Empty, Segmented, Slider, Tabs, Tag, Tooltip, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SeriesDto, StudyDto } from '@/api/types';
import { AiPanel } from '@/features/ai/AiPanel';
import { AnnotationLayer2D, type DrawTool } from '@/features/annotations/AnnotationLayer2D';
import { AnnotationsPanel } from '@/features/annotations/AnnotationsPanel';
import { AnnotationTools, ArrowTextDialog } from '@/features/annotations/AnnotationTools';
import type { Shape2D } from '@/features/annotations/geometry2d';
import { useImageAnnotations } from '@/features/annotations/useImageAnnotations';
import { useCan } from '@/features/auth/permissions';
import { AddToReportButton, ReportLink } from '@/features/reports/AddToReport';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
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

type SideTab = 'ai' | 'annotations';

/**
 * 2D study (PNG/JPG, DICOM X-ray): canvas viewer with Grad-CAM heatmap overlays, 2D annotations
 * (SVG layer sharing the viewer's transform), finding review and key images for the report.
 */
export function ImageStudyView({ study, refetchStudy, refreshBudget }: StudyViewProps) {
  const { t } = useTranslation();
  const can = useCan();
  const viewerRef = useRef<ImageViewerHandle>(null);
  const [tool, setTool] = useState<ViewerTool>('pan');
  const [drawTool, setDrawTool] = useState<DrawTool | null>(null);
  const [pendingArrow, setPendingArrow] = useState<Shape2D | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('ai');
  const [opacity, setOpacity] = useState(0.5);
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [heatmapSel, setHeatmapSel] = useState<{ jobId: string; labels: string[] } | null>(null);
  const { jobId, selectJob, prediction } = useStudyRun(study.id);
  const refreshStudy = () => refreshBudget.spend(refetchStudy);

  const series: SeriesDto | undefined =
    study.series.find((s) => s.id === seriesId) ?? study.series[0];
  const notes = useImageAnnotations(study.id, series);

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

  const capture = async () => (await viewerRef.current?.toBlob()) ?? null;

  const screenshot = async () => {
    const blob = await capture();
    if (blob) downloadBlob(blob, `study-${study.id.slice(0, 8)}-${Date.now()}.png`);
  };

  const keyImageCaption = [
    `${study.modality} ${study.bodyPart}`,
    visibleHeatmaps.length > 0
      ? t('reports.addImage.heatmaps', { labels: visibleHeatmaps.join(', ') })
      : '',
    notes.selected ? notes.selected.name : '',
  ]
    .filter(Boolean)
    .join(' – ');

  const onCreate = (shape: Shape2D) => {
    if (shape.kind === 'ARROW') setPendingArrow(shape);
    else void notes.create(shape);
  };

  const showAnnotation = (id: string) => {
    notes.setVisible(true);
    notes.select(id);
    setSideTab('annotations');
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
        <div className="viewer-toolbar" role="toolbar" aria-label={t('viewer.toolbar')}>
          <Segmented<ViewerTool>
            value={tool}
            onChange={(next) => {
              setTool(next);
              setDrawTool(null);
            }}
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
          <AnnotationTools
            tool={drawTool}
            onTool={setDrawTool}
            visible={notes.visible}
            onVisible={notes.setVisible}
            canDraw={can('annotate') && !!series}
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
          <AddToReportButton
            studyId={study.id}
            capture={capture}
            defaultCaption={keyImageCaption}
            disabled={!series?.imageUrl}
          />
          <ReportLink studyId={study.id} />
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
            <Tooltip title={t(series?.pixelSpacing ? 'viewer.calibrated' : 'viewer.uncalibrated')}>
              <Tag color={series?.pixelSpacing ? undefined : 'warning'} data-testid="pixel-spacing">
                {series?.pixelSpacing
                  ? `${series.pixelSpacing.map((v) => v.toFixed(3)).join(' × ')} mm`
                  : t('viewer.pixelsOnly')}
              </Tag>
            </Tooltip>
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
              paintOverlay={notes.paint}
            >
              {(transform) => (
                <AnnotationLayer2D
                  transform={transform}
                  items={notes.items}
                  selectedId={notes.selectedId}
                  tool={drawTool}
                  onSelect={(id) => {
                    notes.select(id);
                    if (id) setSideTab('annotations');
                  }}
                  onCreate={onCreate}
                  onChange={notes.reshape}
                  onDelete={notes.remove}
                />
              )}
            </ImageViewer2D>
          ) : (
            <Empty description={t('viewer.noSeries')} />
          )}
        </div>
        <Typography.Text className="viewer-page__hint">
          {drawTool ? t(`annotations.toolHints.${drawTool}`) : t('viewer.hint')}
        </Typography.Text>
      </section>

      <aside className="viewer-page__ai">
        <Tabs
          className="side-tabs"
          activeKey={sideTab}
          onChange={(key) => setSideTab(key as SideTab)}
          items={[
            {
              key: 'ai',
              label: t('ai.title'),
              children: (
                <AiPanel
                  studyId={study.id}
                  inputType={study.inputType}
                  seriesId={series?.id ?? null}
                  jobId={jobId}
                  onSelectJob={selectJob}
                  visibleHeatmaps={visibleHeatmaps}
                  onToggleHeatmap={toggleHeatmap}
                  selectedAnnotation={
                    notes.selected ? { id: notes.selected.dto.id, name: notes.selected.name } : null
                  }
                  onShowAnnotation={showAnnotation}
                />
              ),
            },
            {
              key: 'annotations',
              label: (
                <span>
                  {t('annotations.title')}{' '}
                  <Badge count={notes.annotations.length} showZero size="small" color="#5b6b78" />
                </span>
              ),
              children: (
                <div className="side-tabs__pane">
                  {notes.query.isError && (
                    <ProblemAlert
                      error={notes.query.error}
                      onRetry={() => void notes.query.refetch()}
                    />
                  )}
                  <AnnotationsPanel
                    annotations={notes.annotations.map((a) => a.dto)}
                    selectedId={notes.selectedId}
                    onSelect={(id) => {
                      notes.setVisible(true);
                      notes.select(id);
                    }}
                    canEdit={notes.canEdit}
                    onUpdate={notes.update}
                    onDelete={notes.remove}
                  />
                </div>
              ),
            },
          ]}
        />
      </aside>

      {pendingArrow && (
        <ArrowTextDialog
          onCancel={() => setPendingArrow(null)}
          onSubmit={(text) => {
            if (pendingArrow.kind === 'ARROW') {
              void notes.create({ kind: 'ARROW', geometry: { ...pendingArrow.geometry, text } });
            }
            setPendingArrow(null);
          }}
        />
      )}
    </div>
  );
}
