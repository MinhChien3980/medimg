import { CompressOutlined, ScissorOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Slider, Spin, Tooltip, Typography } from 'antd';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '@/shared/components/ErrorBoundary';
import {
  AXES,
  clipPlanes,
  fitClipBox,
  fullClipBox,
  sliderRange,
  type Axis,
  type Bounds,
  type ClipBox,
} from '../../lib/clipping';
import { useVolumeBackends } from '../backends';
import type { Structure, StructureStyle } from '../structures';
import type { SceneStructure } from './MeshScene.types';

export interface MeshViewProps {
  structures: readonly Structure[];
  styles: Readonly<Record<string, StructureStyle>>;
  /** A structure was clicked in the scene. */
  onPick: (label: string) => void;
  /** A mesh failed to load (its presigned URL may have expired). */
  onLoadError: (label: string) => void;
}

interface ClipState {
  bounds: Bounds | null;
  box: ClipBox | null;
}

const AXIS_KEY: Record<Axis, 'x' | 'y' | 'z'> = { 0: 'x', 1: 'y', 2: 'z' };

/**
 * 3D tab: the segmented structures as meshes (lazy react-three-fiber scene) with a clipping box.
 * Everything here is in LPS millimetres, the world space of the MPR viewer and of the GLB files.
 */
export function MeshView({ structures, styles, onPick, onLoadError }: MeshViewProps) {
  const { t } = useTranslation();
  const { MeshScene } = useVolumeBackends();
  const [clip, setClip] = useState<ClipState>({ bounds: null, box: null });
  const [fitSignal, setFitSignal] = useState(0);

  const sceneStructures = useMemo<SceneStructure[]>(
    () =>
      structures.map((s) => {
        const style = styles[s.label];
        return {
          label: s.label,
          url: s.meshUrl,
          color: style?.color ?? s.color,
          opacity: style?.opacity ?? 1,
          visible: style?.visible ?? true,
        };
      }),
    [structures, styles],
  );

  const planes = useMemo(
    () => (clip.bounds && clip.box ? clipPlanes(clip.box, clip.bounds) : []),
    [clip],
  );

  const onBoundsChange = useCallback(
    (bounds: Bounds | null) =>
      setClip((prev) => ({
        bounds,
        box: bounds ? fitClipBox(prev.box, prev.bounds, bounds) : null,
      })),
    [],
  );

  const setAxis = (axis: Axis, range: [number, number]) =>
    setClip((prev) => {
      if (!prev.box) return prev;
      const box = [...prev.box] as ClipBox;
      box[axis] = range;
      return { ...prev, box };
    });

  const resetClip = () =>
    setClip((prev) => (prev.bounds ? { ...prev, box: fullClipBox(prev.bounds) } : prev));

  return (
    <div className="mesh-view">
      <div className="viewer-toolbar" role="toolbar" aria-label={t('viewer.mesh.toolbar')}>
        <Tooltip title={t('viewer.mesh.fitHint')}>
          <Button icon={<CompressOutlined />} onClick={() => setFitSignal((n) => n + 1)}>
            {t('viewer.mesh.fit')}
          </Button>
        </Tooltip>
        <Button icon={<ScissorOutlined />} disabled={planes.length === 0} onClick={resetClip}>
          {t('viewer.mesh.resetClip')}
        </Button>
        <span className="viewer-toolbar__info">
          {t('viewer.mesh.count', { count: structures.length })}
        </span>
      </div>

      <div className="mesh-view__body">
        <div className="mesh-view__canvas" data-testid="mesh-canvas">
          <ErrorBoundary
            fallback={
              <div className="mpr-view__status mpr-view__status--error" role="alert">
                <WarningOutlined />
                <span>{t('viewer.webglRequired')}</span>
              </div>
            }
          >
            <Suspense
              fallback={
                <div className="mpr-view__status" role="status">
                  <Spin />
                  <span>{t('viewer.mesh.loading')}</span>
                </div>
              }
            >
              <MeshScene
                structures={sceneStructures}
                clipPlanes={planes}
                onBoundsChange={onBoundsChange}
                onPick={onPick}
                onLoadError={onLoadError}
                fitSignal={fitSignal}
                ariaLabel={t('viewer.mesh.sceneLabel')}
              />
            </Suspense>
          </ErrorBoundary>
        </div>

        <fieldset className="mesh-view__clip" aria-describedby="clip-hint">
          <legend>{t('viewer.mesh.clipping')}</legend>
          {clip.bounds && clip.box ? (
            AXES.map((axis) => {
              const bounds = clip.bounds;
              const box = clip.box;
              if (!bounds || !box) return null;
              const [min, max] = sliderRange(bounds, axis);
              const key = AXIS_KEY[axis];
              const label = t(`viewer.mesh.axis.${key}`);
              return (
                <div key={key} className="mesh-view__axis" data-testid={`clip-${key}`}>
                  <span className="mesh-view__axis-label">
                    {label}
                    <span className="mesh-view__axis-range">
                      {box[axis][0]} … {box[axis][1]} mm
                    </span>
                  </span>
                  <Slider
                    range
                    min={min}
                    max={max}
                    step={1}
                    value={box[axis]}
                    onChange={(v) => setAxis(axis, [v[0] ?? min, v[1] ?? max])}
                    ariaLabelForHandle={[
                      t('viewer.mesh.clipFrom', { axis: label }),
                      t('viewer.mesh.clipTo', { axis: label }),
                    ]}
                  />
                </div>
              );
            })
          ) : (
            <Typography.Text type="secondary">{t('viewer.mesh.clipWaiting')}</Typography.Text>
          )}
          <Typography.Paragraph id="clip-hint" type="secondary" className="mesh-view__hint">
            {t('viewer.mesh.hint')}
          </Typography.Paragraph>
        </fieldset>
      </div>
    </div>
  );
}
