import { Alert, Empty, Tabs, Tag, Tooltip } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasHounsfieldUnits, type PredictionDto, type SeriesDto } from '@/api/types';
import { AiPanel } from '@/features/ai/AiPanel';
import { isSegmentationResult } from '@/features/ai/findings';
import { useModels } from '@/features/ai/hooks';
import { StructuresTable } from '@/features/ai/StructuresTable';
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
  const { t } = useTranslation();
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [tab, setTab] = useState<VolumeTab>('mpr');
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [styleState, setStyleState] = useState<StyleState>({ jobId: null, styles: {} });
  const { jobId, selectJob, prediction } = useStudyRun(study.id);
  const models = useModels(study.inputType);

  const series = study.series.find((s) => s.id === seriesId) ?? study.series[0];
  const hounsfield = hasHounsfieldUnits(study.inputType, series?.modality ?? study.modality);
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

  const show3d = hounsfield || structures.length > 0;
  const activeTab: VolumeTab = show3d ? tab : 'mpr';

  const renderSegmentation = (p: PredictionDto) =>
    p.jobId === run?.jobId ? (
      <StructureControls
        structures={structures}
        styles={styles}
        onChange={(label, patch) => changeStyles((s) => (s.label === label ? patch : null))}
        onChangeAll={(patch) => changeStyles(() => patch)}
        onLocate={locate}
      />
    ) : (
      <StructuresTable findings={p.findings} meshes={p.artifacts?.meshes ?? []} />
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
        <AiPanel
          studyId={study.id}
          inputType={study.inputType}
          seriesId={series?.id ?? null}
          jobId={jobId}
          onSelectJob={selectJob}
          renderSegmentation={renderSegmentation}
        />
      </aside>
    </div>
  );
}
