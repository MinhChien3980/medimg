import { WarningOutlined } from '@ant-design/icons';
import { Spin } from 'antd';
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  dragZoomFactor,
  fitViewport,
  panBy,
  wheelZoomFactor,
  zoomAt,
  type Size,
  type Viewport,
} from '../lib/viewport';
import {
  DEFAULT_WINDOW,
  adjustWindowLevel,
  applyLut,
  buildLut,
  formatWindowLevel,
  toGrayscale,
  type WindowLevel,
} from '../lib/windowLevel';

/**
 * Minimal 2D canvas viewer for PNG/JPG (slice 1).
 *
 * The props are deliberately renderer-agnostic (image URL, overlays, tool mode, imperative
 * reset/screenshot) so this component can be swapped for a Cornerstone3D viewport when
 * DICOM/MPR arrives, without touching the pages that use it.
 */
export type ViewerTool = 'pan' | 'zoom' | 'windowLevel';

export interface ViewerOverlay {
  id: string;
  /** RGBA image with the same pixel size as the base image (e.g. a Grad-CAM heatmap). */
  url: string;
  /** 0..1 */
  opacity: number;
}

export interface ImageViewerHandle {
  /** Fit to window and restore the default window/level. */
  reset: () => void;
  /**
   * PNG of the current view: image, heatmap overlays and whatever `paintOverlay` paints (the
   * visible annotations), or null if unavailable.
   */
  toBlob: () => Promise<Blob | null>;
}

/** The viewer's current image → screen mapping, given to `children` (e.g. an SVG annotation layer). */
export interface ViewerTransform {
  viewport: Viewport;
  /** Natural size of the image, in pixels. */
  image: Size;
  /** Size of the viewer, in CSS pixels (the layer covers the viewer exactly). */
  view: Size;
}

export interface ImageViewer2DProps {
  imageUrl: string;
  overlays?: readonly ViewerOverlay[];
  /** Action of the primary (left) mouse button. Right-drag is always W/L, middle-drag pan. */
  tool?: ViewerTool;
  onImageError?: (url: string) => void;
  onImageLoad?: (size: Size) => void;
  onOverlayError?: (overlay: ViewerOverlay) => void;
  ariaLabel?: string;
  /**
   * Layer drawn on top of the image (rendered once the image is shown). Its pointer and key events
   * reach the viewer unless it stops their propagation, so it handles what it needs (e.g. the left
   * button while drawing) and the viewer keeps wheel zoom, middle-drag pan and right-drag W/L.
   */
  children?: (transform: ViewerTransform) => ReactNode;
  /** Paints the layer of `children` into captures (`toBlob`), in CSS pixels of the viewer. */
  paintOverlay?: (ctx: CanvasRenderingContext2D, viewport: Viewport) => void;
  ref?: Ref<ImageViewerHandle>;
}

interface LoadedImage {
  url: string;
  width: number;
  height: number;
  element: HTMLImageElement;
  /** Luminance per pixel; null if pixels cannot be read (cross-origin) → W/L disabled. */
  gray: Uint8Array | null;
}

interface WindowedBuffer {
  url: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  imageData: ImageData;
  wlKey: string;
}

type DragMode = ViewerTool;

interface DragState {
  pointerId: number;
  mode: DragMode;
  startX: number;
  startY: number;
  startViewport: Viewport;
  startWindow: WindowLevel;
}

type OverlayEntry = HTMLImageElement | 'loading' | 'error';

const FIT_PADDING = 8;
const OVERLAY_URL_SEPARATOR = '\n';

function readImage(element: HTMLImageElement, url: string): LoadedImage {
  const width = element.naturalWidth;
  const height = element.naturalHeight;
  let gray: Uint8Array | null = null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    try {
      ctx.drawImage(element, 0, 0);
      gray = toGrayscale(ctx.getImageData(0, 0, width, height).data);
    } catch {
      gray = null; // tainted canvas: draw the raw image, no W/L
    }
  }
  return { url, width, height, element, gray };
}

function modeFor(button: number, tool: ViewerTool): DragMode | null {
  if (button === 0) return tool;
  if (button === 1) return 'pan';
  if (button === 2) return 'windowLevel';
  return null;
}

const CURSORS: Record<ViewerTool, string> = {
  pan: 'grab',
  zoom: 'zoom-in',
  windowLevel: 'crosshair',
};

export function ImageViewer2D({
  imageUrl,
  overlays = [],
  tool = 'pan',
  onImageError,
  onImageLoad,
  onOverlayError,
  ariaLabel,
  children,
  paintOverlay,
  ref,
}: ImageViewer2DProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<WindowedBuffer | null>(null);
  const overlayCacheRef = useRef(new Map<string, OverlayEntry>());
  const dragRef = useRef<DragState | null>(null);
  const captureRef = useRef<{
    viewport: Viewport | null;
    paint: ImageViewer2DProps['paintOverlay'];
  }>({ viewport: null, paint: undefined });

  const [size, setSize] = useState<Size | null>(null);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [view, setView] = useState<{ key: string; viewport: Viewport } | null>(null);
  const [wl, setWl] = useState<WindowLevel>(DEFAULT_WINDOW);
  const [overlayVersion, bumpOverlayVersion] = useReducer((n: number) => n + 1, 0);

  const imageKey = image ? `${image.width}x${image.height}` : null;
  const fitted = image && size ? fitViewport(image, size, FIT_PADDING) : null;
  // A manual viewport survives URL refreshes of the same image, but not a new image size.
  const viewport = view && view.key === imageKey ? view.viewport : fitted;

  useEffect(() => {
    captureRef.current = { viewport, paint: paintOverlay };
  });

  const loading = image?.url !== imageUrl && failedUrl !== imageUrl;
  const failed = failedUrl === imageUrl;

  // ---- container size ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- base image ----
  const handleImageLoaded = useEffectEvent((loaded: LoadedImage) => {
    setImage(loaded);
    onImageLoad?.({ width: loaded.width, height: loaded.height });
  });
  const handleImageFailed = useEffectEvent((url: string) => {
    setFailedUrl(url);
    onImageError?.(url);
  });

  useEffect(() => {
    let cancelled = false;
    const element = new Image();
    element.decoding = 'async';
    element.onload = () => {
      if (!cancelled) handleImageLoaded(readImage(element, imageUrl));
    };
    element.onerror = () => {
      if (!cancelled) handleImageFailed(imageUrl);
    };
    element.src = imageUrl;
    return () => {
      cancelled = true;
      element.onload = null;
      element.onerror = null;
    };
  }, [imageUrl]);

  // ---- overlays (cached by URL; presigned URLs change when refreshed) ----
  const overlayUrlsKey = overlays.map((o) => o.url).join(OVERLAY_URL_SEPARATOR);
  const handleOverlayFailed = useEffectEvent((url: string) => {
    const overlay = overlays.find((o) => o.url === url);
    if (overlay) onOverlayError?.(overlay);
  });

  useEffect(() => {
    const cache = overlayCacheRef.current;
    for (const url of overlayUrlsKey.split(OVERLAY_URL_SEPARATOR)) {
      if (!url || cache.has(url)) continue;
      cache.set(url, 'loading');
      const element = new Image();
      element.decoding = 'async';
      element.onload = () => {
        cache.set(url, element);
        bumpOverlayVersion();
      };
      element.onerror = () => {
        cache.set(url, 'error');
        handleOverlayFailed(url);
      };
      element.src = url;
    }
  }, [overlayUrlsKey]);

  // ---- draw ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.max(1, Math.round(size.width * dpr));
    const pixelH = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, pixelW, pixelH);
    if (!image || !viewport) return;

    let source: CanvasImageSource = image.element;
    if (image.gray) {
      let buffer = bufferRef.current;
      if (!buffer || buffer.url !== image.url) {
        const bufferCanvas = document.createElement('canvas');
        bufferCanvas.width = image.width;
        bufferCanvas.height = image.height;
        const bufferCtx = bufferCanvas.getContext('2d');
        if (bufferCtx) {
          buffer = {
            url: image.url,
            canvas: bufferCanvas,
            ctx: bufferCtx,
            imageData: bufferCtx.createImageData(image.width, image.height),
            wlKey: '',
          };
          bufferRef.current = buffer;
        }
      }
      if (buffer) {
        const wlKey = `${wl.width}:${wl.center}`;
        if (buffer.wlKey !== wlKey) {
          applyLut(image.gray, buildLut(wl), buffer.imageData.data);
          buffer.ctx.putImageData(buffer.imageData, 0, 0);
          buffer.wlKey = wlKey;
        }
        source = buffer.canvas;
      }
    }

    const s = viewport.scale * dpr;
    ctx.setTransform(s, 0, 0, s, viewport.offsetX * dpr, viewport.offsetY * dpr);
    ctx.imageSmoothingEnabled = viewport.scale < 2;
    ctx.drawImage(source, 0, 0, image.width, image.height);

    for (const overlay of overlays) {
      const entry = overlayCacheRef.current.get(overlay.url);
      if (!(entry instanceof HTMLImageElement)) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, overlay.opacity));
      ctx.drawImage(entry, 0, 0, image.width, image.height);
    }
    ctx.globalAlpha = 1;
  }, [size, image, viewport, wl, overlays, overlayVersion]);

  // ---- imperative API ----
  useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        setView(null);
        setWl(DEFAULT_WINDOW);
      },
      toBlob: () =>
        new Promise<Blob | null>((resolve) => {
          const canvas = canvasRef.current;
          if (!canvas) {
            resolve(null);
            return;
          }
          const { viewport: current, paint } = captureRef.current;
          const ctx = paint && current ? document.createElement('canvas').getContext('2d') : null;
          if (!paint || !current || !ctx) {
            canvas.toBlob(resolve, 'image/png');
            return;
          }
          // Compose on a copy so the on-screen canvas never shows the baked-in layer.
          ctx.canvas.width = canvas.width;
          ctx.canvas.height = canvas.height;
          ctx.drawImage(canvas, 0, 0);
          const dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          paint(ctx, current);
          ctx.canvas.toBlob(resolve, 'image/png');
        }),
    }),
    [],
  );

  // ---- interaction ----
  const setViewport = (next: Viewport) => {
    if (imageKey) setView({ key: imageKey, viewport: next });
  };

  const localPoint = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!viewport) return;
    const mode = modeFor(e.button, tool);
    if (!mode) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startViewport: viewport,
      startWindow: wl,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    switch (drag.mode) {
      case 'pan':
        setViewport(panBy(drag.startViewport, dx, dy));
        break;
      case 'zoom':
        setViewport(
          zoomAt(drag.startViewport, dragZoomFactor(dy), localPoint(drag.startX, drag.startY)),
        );
        break;
      case 'windowLevel':
        if (image?.gray) setWl(adjustWindowLevel(drag.startWindow, dx, dy));
        break;
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  };

  const onWheel = useEffectEvent((e: WheelEvent) => {
    if (!viewport) return;
    e.preventDefault();
    setViewport(zoomAt(viewport, wheelZoomFactor(e.deltaY), localPoint(e.clientX, e.clientY)));
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Non-passive so the page does not scroll while zooming; on the container, so that zooming
    // also works over the annotation layer.
    const listener = (e: WheelEvent) => onWheel(e);
    container.addEventListener('wheel', listener, { passive: false });
    return () => container.removeEventListener('wheel', listener);
  }, []);

  // Keys reach the container from the focused canvas or from the layer of `children`.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!viewport || !size || e.defaultPrevented) return;
    const center = { x: size.width / 2, y: size.height / 2 };
    const step = 40;
    const actions: Record<string, () => void> = {
      '+': () => setViewport(zoomAt(viewport, 1.25, center)),
      '=': () => setViewport(zoomAt(viewport, 1.25, center)),
      '-': () => setViewport(zoomAt(viewport, 0.8, center)),
      ArrowLeft: () => setViewport(panBy(viewport, step, 0)),
      ArrowRight: () => setViewport(panBy(viewport, -step, 0)),
      ArrowUp: () => setViewport(panBy(viewport, 0, step)),
      ArrowDown: () => setViewport(panBy(viewport, 0, -step)),
      r: () => {
        setView(null);
        setWl(DEFAULT_WINDOW);
      },
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  };

  const transform: ViewerTransform | null =
    image && viewport && size
      ? {
          viewport,
          image: { width: image.width, height: image.height },
          view: size,
        }
      : null;

  return (
    // Pointer, wheel and key events bubble here from the focusable canvas and from the layer of
    // `children`, which stops the ones it consumes.
    <div
      ref={containerRef}
      className="image-viewer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={() => {
        setView(null);
        setWl(DEFAULT_WINDOW);
      }}
      onKeyDown={onKeyDown}
    >
      <canvas
        ref={canvasRef}
        className="image-viewer__canvas"
        style={{ cursor: CURSORS[tool] }}
        tabIndex={0}
        role="img"
        aria-label={ariaLabel}
      />
      {transform && children?.(transform)}
      {loading && !image && (
        <div className="image-viewer__status" role="status" aria-label={t('common.loading')}>
          <Spin />
        </div>
      )}
      {failed && !image && (
        <div className="image-viewer__status image-viewer__status--error" role="alert">
          <WarningOutlined aria-hidden />
          {t('viewer.imageError')}
        </div>
      )}
      {image && viewport && (
        <div className="image-viewer__hud" aria-live="polite">
          {image.width}×{image.height} · {Math.round(viewport.scale * 100)}%
          {image.gray ? ` · ${formatWindowLevel(wl)}` : ''}
        </div>
      )}
    </div>
  );
}
