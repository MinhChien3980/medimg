import {
  AimOutlined,
  BulbOutlined,
  DragOutlined,
  ExpandOutlined,
  ReloadOutlined,
  WarningOutlined,
  ZoomInOutlined,
} from '@ant-design/icons';
import { Alert, Button, Segmented, Slider, Spin, Tooltip, Typography } from 'antd';
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Vec3 } from '@/api/types';
import { formatPoint } from '@/shared/lib/format';
import {
  CT_WINDOW_PRESETS,
  DEFAULT_CT_WINDOW,
  matchPreset,
  windowFromRange,
  type CtPresetId,
  type CtWindow,
} from '../../lib/ctWindow';
import { useVolumeBackends } from '../backends';
import { artifactKey } from '../structures';
import {
  MPR_ORIENTATIONS,
  type MprEngine,
  type MprLabelmap,
  type MprOrientation,
  type MprTool,
} from './MprEngine';

/** A request to move the crosshair; `seq` makes repeated jumps to the same point distinct. */
export interface FocusRequest {
  point: Vec3;
  seq: number;
}

export interface MprViewProps {
  /** Presigned URL of the normalised volume. Only its object path is tracked (see below). */
  volumeUrl: string;
  /**
   * The volume is a CT in Hounsfield units: CT window presets, soft tissue by default. Otherwise
   * (an image stack, MR) there are no presets and the default window spans the data range.
   */
  hounsfield?: boolean;
  /** Memoised by the caller; a new object with the same object path only restyles. */
  labelmap: MprLabelmap | null;
  /** Shown above the views (e.g. why the labelmap cannot be overlaid). */
  notice?: string | null;
  focus: FocusRequest | null;
  /** The volume failed to load: the caller should fetch a fresh presigned URL. */
  onVolumeError: () => void;
}

type Status = 'loading' | 'ready' | 'error' | 'unsupported';
type OverlayState = { key: string | null; state: 'ready' | 'error' };

const SCROLL_KEYS: Record<string, number> = {
  ArrowUp: -1,
  ArrowLeft: -1,
  PageUp: -10,
  ArrowDown: 1,
  ArrowRight: 1,
  PageDown: 10,
};

/**
 * Axial, coronal and sagittal views of one volume in one rendering engine, with crosshairs,
 * window/level (CT presets for a CT) and the segmentation labelmap. The rendering library sits behind
 * `MprEngine`, created once per mount and destroyed on unmount.
 *
 * Presigned URLs change on every refetch (new signature) for the same object, so loads are keyed
 * by the object path: a refetch neither reloads the volume nor the labelmap.
 */
export function MprView({
  volumeUrl,
  hounsfield = true,
  labelmap,
  notice,
  focus,
  onVolumeError,
}: MprViewProps) {
  const { t, i18n } = useTranslation();
  const { loadMprEngine } = useVolumeBackends();
  const containerRef = useRef<HTMLDivElement>(null);
  const axialRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const volumeUrlRef = useRef(volumeUrl);
  const labelmapRef = useRef(labelmap);

  const [engine, setEngine] = useState<MprEngine | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [attempt, setAttempt] = useState(0);
  const [overlay, setOverlay] = useState<OverlayState>({ key: null, state: 'ready' });
  const [tool, setTool] = useState<MprTool>('crosshairs');
  // A CT starts on soft tissue; other data waits for its range, then shows all of it.
  const [dataWindow, setDataWindow] = useState<CtWindow | null>(null);
  const [ctWindow, setCtWindow] = useState<CtWindow | null>(hounsfield ? DEFAULT_CT_WINDOW : null);
  const defaultWindow = hounsfield ? DEFAULT_CT_WINDOW : dataWindow;
  const [opacity, setOpacity] = useState(0.5);
  const [crosshair, setCrosshair] = useState<Vec3 | null>(null);

  const ready = status === 'ready';
  const labelmapKey = labelmap ? artifactKey(labelmap.url) : null;

  useEffect(() => {
    volumeUrlRef.current = volumeUrl;
    labelmapRef.current = labelmap;
  });

  const handleCrosshair = useEffectEvent((point: Vec3) => setCrosshair(point));
  const handleWindow = useEffectEvent((next: CtWindow) => setCtWindow(next));
  const handleVolumeError = useEffectEvent(() => onVolumeError());

  // One engine per mount.
  useEffect(() => {
    const axial = axialRef.current;
    const coronal = coronalRef.current;
    const sagittal = sagittalRef.current;
    if (!axial || !coronal || !sagittal) return;
    let disposed = false;
    let created: MprEngine | null = null;
    loadMprEngine()
      .then((factory) => {
        if (disposed) return;
        created = factory(
          { axial, coronal, sagittal },
          {
            onCrosshairChange: (point) => handleCrosshair(point),
            onWindowChange: (next) => handleWindow(next),
          },
        );
        setEngine(created);
      })
      .catch((error: unknown) => {
        console.error('[MPR] cannot initialise the viewer', error);
        if (!disposed) setStatus('unsupported');
      });
    return () => {
      disposed = true;
      created?.destroy();
    };
  }, [loadMprEngine]);

  useEffect(() => {
    if (!engine) return;
    let current = true;
    engine.loadVolume(volumeUrlRef.current).then(
      ({ range }) => {
        if (!current) return;
        setStatus('ready');
        if (!hounsfield) {
          const initial = windowFromRange(range);
          setDataWindow(initial);
          setCtWindow((w) => w ?? initial);
        }
      },
      (error: unknown) => {
        console.error('[MPR] cannot load the volume', error);
        if (!current) return;
        setStatus('error');
        handleVolumeError();
      },
    );
    return () => {
      current = false;
    };
  }, [engine, attempt, hounsfield]);

  useEffect(() => {
    if (!engine || !ready) return;
    let current = true;
    engine.setLabelmap(labelmapRef.current).then(
      () => {
        if (current) setOverlay({ key: labelmapKey, state: 'ready' });
      },
      (error: unknown) => {
        console.error('[MPR] cannot load the segmentation', error);
        if (current) setOverlay({ key: labelmapKey, state: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [engine, ready, labelmapKey]);

  useEffect(() => {
    if (engine && labelmap) engine.styleLabelmap(labelmap.colorLut, labelmap.hidden);
  }, [engine, labelmap]);

  useEffect(() => {
    engine?.setLabelmapOpacity(opacity);
  }, [engine, opacity]);

  useEffect(() => {
    if (ctWindow) engine?.setWindow(ctWindow);
  }, [engine, ctWindow]);

  useEffect(() => {
    engine?.setTool(tool);
  }, [engine, tool]);

  useEffect(() => {
    if (engine && ready && focus) engine.jumpTo(focus.point);
  }, [engine, ready, focus]);

  useEffect(() => {
    const container = containerRef.current;
    if (!engine || !container) return;
    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [engine]);

  const retry = () => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  };

  const onViewportKey = (orientation: MprOrientation) => (e: ReactKeyboardEvent) => {
    const delta = SCROLL_KEYS[e.key];
    if (delta === undefined || !engine || !ready) return;
    e.preventDefault();
    engine.scroll(orientation, delta);
  };

  const overlayLoading = labelmapKey !== null && overlay.key !== labelmapKey;
  const overlayFailed =
    labelmapKey !== null && overlay.key === labelmapKey && overlay.state === 'error';
  const preset: CtPresetId | 'custom' = (ctWindow && matchPreset(ctWindow)) ?? 'custom';
  const refs: Record<MprOrientation, typeof axialRef> = {
    axial: axialRef,
    coronal: coronalRef,
    sagittal: sagittalRef,
  };

  return (
    <div className="mpr-view">
      <div className="viewer-toolbar" role="toolbar" aria-label={t('viewer.mpr.toolbar')}>
        <Segmented<MprTool>
          value={tool}
          onChange={setTool}
          options={[
            { value: 'crosshairs', icon: <AimOutlined />, label: t('viewer.mpr.crosshairs') },
            { value: 'windowLevel', icon: <BulbOutlined />, label: t('viewer.tools.windowLevel') },
            { value: 'pan', icon: <DragOutlined />, label: t('viewer.tools.pan') },
            { value: 'zoom', icon: <ZoomInOutlined />, label: t('viewer.tools.zoom') },
          ]}
        />
        {hounsfield && (
          <Segmented<CtPresetId | 'custom'>
            aria-label={t('viewer.mpr.presets')}
            value={preset}
            onChange={(id) => {
              const next = CT_WINDOW_PRESETS.find((p) => p.id === id);
              if (next) setCtWindow({ width: next.width, center: next.center });
            }}
            options={CT_WINDOW_PRESETS.map((p) => ({
              value: p.id,
              label: t(`viewer.mpr.preset.${p.id}`),
            }))}
          />
        )}
        <span className="viewer-toolbar__value" data-testid="mpr-window">
          {ctWindow &&
            t('viewer.mpr.window', {
              width: Math.round(ctWindow.width),
              center: Math.round(ctWindow.center),
            })}
        </span>
        <Tooltip title={t('viewer.reset')}>
          <Button
            icon={<ExpandOutlined />}
            aria-label={t('viewer.reset')}
            disabled={!ready}
            onClick={() => {
              if (defaultWindow) setCtWindow(defaultWindow);
              engine?.reset();
            }}
          />
        </Tooltip>
        {labelmap && (
          <div className="viewer-toolbar__opacity">
            <span id="mpr-opacity-label">{t('viewer.mpr.overlayOpacity')}</span>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={setOpacity}
              style={{ width: 110 }}
              ariaLabelledByForHandle="mpr-opacity-label"
              tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
            />
          </div>
        )}
        <span className="viewer-toolbar__info" data-testid="mpr-crosshair" aria-live="polite">
          {crosshair &&
            t('viewer.mpr.crosshairAt', { point: formatPoint(crosshair, i18n.language) })}
        </span>
      </div>

      {notice && <Alert className="mpr-view__notice" type="warning" showIcon title={notice} />}
      {overlayFailed && (
        <Alert
          className="mpr-view__notice"
          type="error"
          showIcon
          title={t('viewer.mpr.overlayError')}
        />
      )}

      <div className="mpr-view__grid" ref={containerRef}>
        {MPR_ORIENTATIONS.map((o) => (
          <div key={o} className={`mpr-view__cell mpr-view__cell--${o}`}>
            <div
              ref={refs[o]}
              className="mpr-view__viewport"
              data-testid={`mpr-${o}`}
              role="img"
              tabIndex={0}
              aria-label={t(`viewer.mpr.views.${o}`)}
              onKeyDown={onViewportKey(o)}
              onContextMenu={(e) => e.preventDefault()}
            />
            <span className={`mpr-view__label mpr-view__label--${o}`} aria-hidden>
              {t(`viewer.mpr.views.${o}`)}
            </span>
          </div>
        ))}

        {status === 'loading' && (
          <div className="mpr-view__status" role="status">
            <Spin />
            <span>{t(hounsfield ? 'viewer.mpr.loading' : 'viewer.mpr.loadingVolume')}</span>
          </div>
        )}
        {ready && overlayLoading && (
          <div className="mpr-view__badge" role="status">
            <Spin size="small" /> {t('viewer.mpr.overlayLoading')}
          </div>
        )}
        {status === 'error' && (
          <div className="mpr-view__status mpr-view__status--error" role="alert">
            <WarningOutlined />
            <span>{t(hounsfield ? 'viewer.mpr.loadError' : 'viewer.mpr.loadErrorVolume')}</span>
            <Button size="small" icon={<ReloadOutlined />} onClick={retry}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {status === 'unsupported' && (
          <div className="mpr-view__status mpr-view__status--error" role="alert">
            <WarningOutlined />
            <span>{t('viewer.webglRequired')}</span>
          </div>
        )}
      </div>
      <Typography.Text className="viewer-page__hint">{t('viewer.mpr.hint')}</Typography.Text>
    </div>
  );
}
