import { Alert, Badge, Empty, Tabs, Tag, Tooltip } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasHounsfieldUnits, type PredictionDto, type SeriesDto } from '@/api/types';
import { AiPanel } from '@/features/ai/AiPanel';
import { isSegmentationResult } from '@/features/ai/findings';
import { useModels } from '@/features/ai/hooks';
import { StructuresTable } from '@/features/ai/StructuresTable';
import { AnnotationsPanel } from '@/features/annotations/AnnotationsPanel';
import {
  useVolumeAnnotations,
  type VolumeAnnotation,
} from '@/features/annotations/useVolumeAnnotations';
import { useCan } from '@/features/auth/permissions';
import { AddToReportButton, ReportLink } from '@/features/reports/AddToReport';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { formatPoint } from '@/shared/lib/format';
import { SeriesSidebar } from '../components/SeriesSidebar';
import type { StudyViewProps } from '../ImageStudyView';
import { useStudyRun } from '../useStudyRun';
import { MeshView } from './mesh/MeshView';
import type { MprLabelmap } from './mpr/MprEngine';
import { MprView, type FocusRequest } from './mpr/MprView';
import { StructureControls } from './StructureControls';
import {
  buildColorLut,
  buildStructures,
  defaultStyle,
  findLabelOrder,
  type Structure,
  type StructureStyle,
} from './structures';

export type VolumeTab = 'mpr' | '3d';
type SideTab = 'ai' | 'annotations';

interface StyleState {
  jobId: string | null;
  styles: Record<string, StructureStyle>;
}

const NO_STYLES: Record<string, StructureStyle> = {};

/** Finished segmentation run of `series`, if the selected run is one. */
function segmentationOf(run: PredictionDto | undefined, series: SeriesDto | undefined) {
  if (!run || !series || run.status !== 'DONE' || run.seriesId !== series.id) return null;
  return isSegmentationResult(run) ? run : null;
}

/**
 * Volume study (CT, MR, image stack): tabs MPR | 3D sharing the structures of the selected
 * segmentation run (visibility, colour and opacity apply to both). A volume that is not a CT in
 * Hounsfield units gets no CT window presets, and no 3D tab while it has no meshes (no model
 * segments it). A spacing the server had to assume is flagged above the views. Locating a structure, from the list or by
 * clicking its mesh, switches to MPR and moves the crosshair to its centroid. Centroids and
 * meshes are in LPS mm, the world space Cornerstone3D derives from the NIfTI affine, so the
 * point is passed through unchanged.
 */
export function VolumeStudyView({ study, refetchStudy, refreshBudget }: StudyViewProps) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [tab, setTab] = useState<VolumeTab>('mpr');
  const [sideTab, setSideTab] = useState<SideTab>('ai');
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [styleState, setStyleState] = useState<StyleState>({ jobId: null, styles: {} });
  const { jobId, selectJob, prediction } = useStudyRun(study.id);
  const models = useModels(study.inputType);

  const series = study.series.find((s) => s.id === seriesId) ?? study.series[0];
  const hounsfield = hasHounsfieldUnits(study.inputType, series?.modality ?? study.modality);
  const notes = useVolumeAnnotations(study.id, series, hounsfield);
  const run = segmentationOf(prediction.data, series);
  const labelOrder = run ? findLabelOrder(models.data, run) : null;
  const structures = useMemo(
    () => buildStructures(run?.artifacts?.meshes ?? [], labelOrder),
    [run, labelOrder],
  );

  const overrides = styleState.jobId === run?.jobId ? styleState.styles : NO_STYLES;
  const styles = useMemo(
    () =>
      Object.fromEntries(
        structures.map((s) => [s.label, overrides[s.label] ?? defaultStyle(s)]),
      ) as Record<string, StructureStyle>,
    [structures, overrides],
  );

  const labelmapUrl = run?.artifacts?.segmentation ?? null;
  const labelmap = useMemo<MprLabelmap | null>(() => {
    if (!labelmapUrl || !labelOrder) return null;
    return {
      url: labelmapUrl,
      colorLut: buildColorLut(structures, styles, labelOrder.length),
      hidden: structures
        .filter((s) => s.value !== null && styles[s.label]?.visible === false)
        .map((s) => s.value ?? 0),
    };
  }, [labelmapUrl, labelOrder, structures, styles]);

  const notice =
    labelmapUrl && !labelOrder && models.isSuccess
      ? t('viewer.mpr.labelOrderUnknown', { model: run?.model.code ?? '' })
      : null;

  const runJobId = run?.jobId ?? null;
  const changeStyles = useCallback(
    (update: (current: Structure) => Partial<StructureStyle> | null) =>
      setStyleState((prev) => {
        const base = prev.jobId === runJobId ? prev.styles : {};
        const next: Record<string, StructureStyle> = { ...base };
        for (const s of structures) {
          const patch = update(s);
          if (patch) next[s.label] = { ...(base[s.label] ?? defaultStyle(s)), ...patch };
        }
        return { jobId: runJobId, styles: next };
      }),
    [runJobId, structures],
  );

  const locate = useCallback(
    (label: string) => {
      const target = structures.find((s) => s.label === label);
      if (!target) return;
      setFocus((prev) => ({ point: target.centroid, seq: (prev?.seq ?? 0) + 1 }));
      setTab('mpr');
    },
    [structures],
  );

  /** Shows a measurement: its slice on the MPR (crosshair on its centre), highlighted. */
  const locateAnnotation = (annotation: VolumeAnnotation) => {
    notes.select(annotation.dto.id);
    setFocus((prev) => ({ point: notes.centerOf(annotation), seq: (prev?.seq ?? 0) + 1 }));
    setTab('mpr');
  };

  const showAnnotation = (id: string) => {
    const annotation = notes.annotations.find((a) => a.dto.id === id);
    if (annotation) locateAnnotation(annotation);
    setSideTab('annotations');
  };

  const show3d = hounsfield || structures.length > 0;
  const activeTab: VolumeTab = show3d ? tab : 'mpr';

  const renderSegmentation = (p: PredictionDto) =>
    p.jobId === run?.jobId ? (
      <StructureControls
        studyId={study.id}
        findings={p.findings}
        structures={structures}
        styles={styles}
        onChange={(label, patch) => changeStyles((s) => (s.label === label ? patch : null))}
        onChangeAll={(patch) => changeStyles(() => patch)}
        onLocate={locate}
      />
    ) : (
      <StructuresTable
        studyId={study.id}
        findings={p.findings}
        meshes={p.artifacts?.meshes ?? []}
      />
    );

  return (
    <div className="viewer-page viewer-page--volume">
      <SeriesSidebar
        study={study}
        loading={false}
        selectedId={series?.id}
        onSelect={setSeriesId}
        onThumbnailError={() => refreshBudget.spend(refetchStudy)}
      />

      <section className="viewer-page__center">
        {series?.spacingAssumed && (
          <Alert
            className="volume-notice"
            type="warning"
            showIcon
            banner
            title={t('viewer.spacingAssumed')}
          />
        )}
        <Tabs
          className="volume-tabs"
          activeKey={activeTab}
          onChange={(key) => setTab(key as VolumeTab)}
          tabBarExtraContent={
            <span className="volume-tabs__info">
              <Tag color="blue">{study.modality}</Tag>
              <Tag>{study.bodyPart}</Tag>
              {series?.dims && <Tag>{series.dims.join('×')}</Tag>}
              {series?.spacing && (
                <Tooltip title={series.spacingAssumed ? t('viewer.spacingAssumed') : undefined}>
                  <Tag color={series.spacingAssumed ? 'warning' : undefined}>
                    {series.spacing.map((v) => v.toFixed(2)).join(' × ')} mm
                    {series.spacingAssumed && ` (${t('viewer.spacingAssumedTag')})`}
                  </Tag>
                </Tooltip>
              )}
            </span>
          }
          items={[
            {
              key: 'mpr',
              label: t('viewer.tabs.mpr'),
              children: series?.volumeUrl ? (
                <MprView
                  key={series.id}
                  volumeUrl={series.volumeUrl}
                  hounsfield={hounsfield}
                  labelmap={labelmap}
                  notice={notice}
                  focus={focus}
                  onVolumeError={() => refreshBudget.spend(refetchStudy)}
                  canAnnotate={can('annotate')}
                  annotations={notes.inputs}
                  selectedAnnotation={notes.selectedUid}
                  onAnnotationChange={notes.onEngineChange}
                  onAnnotationRemove={notes.onEngineRemove}
                  onAnnotationSelect={(uid) => {
                    notes.selectUid(uid);
                    if (uid) setSideTab('annotations');
                  }}
                  onDeleteSelected={() => {
                    if (notes.selected && notes.canEdit(notes.selected.dto)) {
                      notes.remove(notes.selected.dto.id);
                    }
                  }}
                  toolbarExtra={({ active, capture, ready }) => (
                    <>
                      <AddToReportButton
                        studyId={study.id}
                        capture={capture}
                        disabled={!ready}
                        defaultCaption={[
                          `${study.modality} ${study.bodyPart}`,
                          t(`viewer.mpr.views.${active}`),
                          notes.selected?.name ?? '',
                        ]
                          .filter(Boolean)
                          .join(' – ')}
                      />
                      <ReportLink studyId={study.id} />
                    </>
                  )}
                />
              ) : (
                <Empty description={t('viewer.noSeries')} />
              ),
            },
            {
              key: '3d',
              label: t('viewer.tabs.mesh'),
              children:
                structures.length > 0 ? (
                  <MeshView
                    key={run?.jobId}
                    structures={structures}
                    styles={styles}
                    onPick={locate}
                    onLoadError={() => refreshBudget.spend(prediction.refetch)}
                  />
                ) : (
                  <Empty
                    className="volume-tabs__empty"
                    description={t(run ? 'viewer.mesh.noMeshes' : 'viewer.mesh.runFirst')}
                  />
                ),
            },
          ].filter((item) => item.key !== '3d' || show3d)}
        />
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
                  renderSegmentation={renderSegmentation}
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
                  {!hounsfield && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 8 }}
                      title={t('annotations.noHu')}
                    />
                  )}
                  <AnnotationsPanel
                    annotations={notes.annotations.map((a) => a.dto)}
                    selectedId={notes.selectedId}
                    onSelect={notes.select}
                    onLocate={(dto) => {
                      const annotation = notes.annotations.find((a) => a.dto.id === dto.id);
                      if (annotation) locateAnnotation(annotation);
                    }}
                    canEdit={notes.canEdit}
                    onUpdate={notes.update}
                    onDelete={notes.remove}
                  />
                  {notes.selected && (
                    <p className="annotation-list__where">
                      {t('annotations.centre', {
                        point: formatPoint(notes.centerOf(notes.selected), i18n.language),
                      })}
                    </p>
                  )}
                </div>
              ),
            },
          ]}
        />
      </aside>
    </div>
  );
}
