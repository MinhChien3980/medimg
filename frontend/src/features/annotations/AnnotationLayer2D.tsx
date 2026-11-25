import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Annotation2DKind, Point2 } from '@/api/types';
import type { ViewerTransform } from '../viewer/components/ImageViewer2D';
import { imageToScreen, screenToImage, type Point } from '../viewer/lib/viewport';
import {
  POLYGON_MAX_POINTS,
  POLYGON_MIN_POINTS,
  clampPoint,
  moveHandle,
  shapeFromDrag,
  translateShape,
  type Shape2D,
} from './geometry2d';
import { ANNOTATION_COLORS, toScreenShape } from './scene2d';

export type DrawTool = Annotation2DKind;

export interface LayerItem {
  id: string;
  shape: Shape2D;
  /** Label / arrow text / measurement shown next to the shape. */
  text: string;
  /** The current user may move, reshape and delete it. */
  editable: boolean;
}

export interface AnnotationLayer2DProps {
  transform: ViewerTransform;
  items: readonly LayerItem[];
  selectedId: string | null;
  /** Shape drawn by the left button; null = select / edit (the left button pans elsewhere). */
  tool: DrawTool | null;
  onSelect: (id: string | null) => void;
  /** A shape was drawn (already clamped to the image). */
  onCreate: (shape: Shape2D) => void;
  /** A shape was moved or reshaped (on release). */
  onChange: (id: string, shape: Shape2D) => void;
  onDelete: (id: string) => void;
}

/** Below this many screen pixels a drag is a click. */
const MIN_DRAG_PX = 4;
/** A click this close (screen px) to the first vertex closes the polygon. */
const CLOSE_PX = 8;

type Draft =
  | {
      type: 'drag';
      kind: Exclude<DrawTool, 'POLYGON'>;
      pointerId: number;
      start: Point2;
      end: Point2;
    }
  | { type: 'polygon'; points: Point2[]; hover: Point2 | null };

interface Edit {
  pointerId: number;
  id: string;
  /** Handle index, or null to move the whole shape. */
  handle: number | null;
  start: Point2;
  original: Shape2D;
  preview: Shape2D;
}

const path = (points: readonly Point[], closed: boolean) =>
  points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
  (closed ? ' Z' : '');

/**
 * SVG layer over `ImageViewer2D`: draws the annotations through the viewer's own image → screen
 * transform (so they stay on the anatomy through zoom and pan), draws new ones with the left
 * button, selects, moves, reshapes (handles) and deletes (Delete key) the user's own.
 *
 * Events it does not consume (wheel, middle / right button, the left button on empty space in
 * select mode) bubble to the viewer, which pans, zooms and sets W/L as usual.
 *
 * Keys (the layer takes focus when clicked): Esc cancels a drawing or clears the selection,
 * Enter closes a polygon, Backspace removes its last vertex, Delete deletes the selection.
 */
export function AnnotationLayer2D({
  transform,
  items,
  selectedId,
  tool,
  onSelect,
  onCreate,
  onChange,
  onDelete,
}: AnnotationLayer2DProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const { viewport, image, view } = transform;

  // A polygon in progress belongs to the polygon tool.
  const activeDraft = draft && (draft.type === 'drag' || tool === 'POLYGON') ? draft : null;

  /** Event position in image pixels (the layer covers the viewer, so its box is the viewer's). */
  const imagePoint = (e: { clientX: number; clientY: number }): Point2 => {
    const rect = svgRef.current?.getBoundingClientRect();
    const local = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    const p = screenToImage(viewport, local);
    return [p.x, p.y];
  };
  const toScreen = ([x, y]: Point2) => imageToScreen(viewport, { x, y });
  const screenDistance = (a: Point2, b: Point2) => {
    const pa = toScreen(a);
    const pb = toScreen(b);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
  };

  /** Focuses the layer (for its keys) and keeps the pointer's moves coming to `element`. */
  const capture = (element: Element, pointerId: number) => {
    svgRef.current?.focus({ preventScroll: true });
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // synthetic events (tests) have no active pointer to capture
    }
  };

  // Clicking empty space in select mode clears the selection. That click goes to the viewer's
  // canvas (the layer lets it through so the viewer pans), so it is observed on the container.
  const clearSelection = useEffectEvent((target: EventTarget | null) => {
    if (tool || !selectedId) return;
    if (target instanceof Element && target.closest('.annotation-shape')) return;
    onSelect(null);
  });
  useEffect(() => {
    const container = svgRef.current?.parentElement;
    if (!container) return;
    const listener = (e: PointerEvent) => {
      if (e.button === 0) clearSelection(e.target);
    };
    container.addEventListener('pointerdown', listener);
    return () => container.removeEventListener('pointerdown', listener);
  }, []);

  const finishPolygon = (points: Point2[]) => {
    setDraft(null);
    if (points.length >= POLYGON_MIN_POINTS) onCreate({ kind: 'POLYGON', geometry: { points } });
  };

  // ---- background (only hit while a drawing tool is active): draw
  const onBackgroundDown = (e: ReactPointerEvent<SVGRectElement>) => {
    if (e.button !== 0 || !tool) return; // pan / W/L stay with the viewer
    e.stopPropagation();
    e.preventDefault();
    const p = clampPoint(imagePoint(e), image);
    svgRef.current?.focus({ preventScroll: true });
    if (tool === 'POLYGON') {
      const points = activeDraft?.type === 'polygon' ? activeDraft.points : [];
      const first = points[0];
      if (first && points.length >= POLYGON_MIN_POINTS && screenDistance(first, p) <= CLOSE_PX) {
        finishPolygon(points);
        return;
      }
      const next = [...points, p];
      if (next.length >= POLYGON_MAX_POINTS) finishPolygon(next);
      else setDraft({ type: 'polygon', points: next, hover: p });
      return;
    }
    if (selectedId) onSelect(null);
    capture(e.currentTarget, e.pointerId);
    setDraft({ type: 'drag', kind: tool, pointerId: e.pointerId, start: p, end: p });
  };

  // ---- shapes: select, then move (body) or reshape (handle) the user's own
  const onShapeDown = (item: LayerItem, handle: number | null) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || tool) return; // while drawing, clicks go to the drawing
    e.stopPropagation();
    e.preventDefault();
    onSelect(item.id);
    capture(e.currentTarget, e.pointerId);
    if (!item.editable) return;
    const start = imagePoint(e);
    setEdit({
      pointerId: e.pointerId,
      id: item.id,
      handle,
      start,
      original: item.shape,
      preview: item.shape,
    });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (edit && e.pointerId === edit.pointerId) {
      e.stopPropagation();
      const p = imagePoint(e);
      const preview =
        edit.handle === null
          ? translateShape(edit.original, p[0] - edit.start[0], p[1] - edit.start[1], image)
          : moveHandle(edit.original, edit.handle, p, image);
      setEdit({ ...edit, preview });
      return;
    }
    if (activeDraft?.type === 'drag' && e.pointerId === activeDraft.pointerId) {
      e.stopPropagation();
      setDraft({ ...activeDraft, end: clampPoint(imagePoint(e), image) });
      return;
    }
    if (activeDraft?.type === 'polygon') {
      setDraft({ ...activeDraft, hover: clampPoint(imagePoint(e), image) });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (edit && e.pointerId === edit.pointerId) {
      e.stopPropagation();
      setEdit(null);
      if (edit.preview !== edit.original) onChange(edit.id, edit.preview);
      return;
    }
    if (activeDraft?.type === 'drag' && e.pointerId === activeDraft.pointerId) {
      e.stopPropagation();
      setDraft(null);
      const end = clampPoint(imagePoint(e), image);
      if (screenDistance(activeDraft.start, end) >= MIN_DRAG_PX) {
        onCreate(shapeFromDrag(activeDraft.kind, activeDraft.start, end, image));
      }
    }
  };

  const onPointerCancel = () => {
    setEdit(null);
    if (activeDraft?.type === 'drag') setDraft(null);
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (!tool) return;
    e.stopPropagation(); // no "reset view" while drawing
    if (activeDraft?.type !== 'polygon') return;
    // The two clicks of the double-click each added a vertex at the same place: drop the repeat.
    const points = [...activeDraft.points];
    const last = points[points.length - 1];
    const before = points[points.length - 2];
    if (last && before && screenDistance(last, before) <= MIN_DRAG_PX) points.pop();
    finishPolygon(points);
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      if (activeDraft || edit) {
        setDraft(null);
        setEdit(null);
        handled();
      } else if (selectedId) {
        onSelect(null);
        handled();
      }
      return;
    }
    if (activeDraft?.type === 'polygon') {
      if (e.key === 'Enter') {
        finishPolygon(activeDraft.points);
        handled();
      } else if (e.key === 'Backspace') {
        const points = activeDraft.points.slice(0, -1);
        setDraft(points.length > 0 ? { ...activeDraft, points } : null);
        handled();
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      const item = items.find((i) => i.id === selectedId);
      if (item?.editable) {
        onDelete(item.id);
        handled();
      }
    }
  };

  return (
    <svg
      ref={svgRef}
      className={`annotation-layer${tool ? ' annotation-layer--drawing' : ''}`}
      width={view.width}
      height={view.height}
      tabIndex={0}
      role="group"
      aria-label={t('annotations.layerLabel')}
      aria-roledescription={t('annotations.layerRole')}
      data-testid="annotation-layer"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <rect
        className="annotation-layer__background"
        width={view.width}
        height={view.height}
        fill="transparent"
        style={{ pointerEvents: tool ? 'all' : 'none', cursor: 'crosshair' }}
        onPointerDown={onBackgroundDown}
      />

      {items.map((item) => {
        const shape = edit?.id === item.id ? edit.preview : item.shape;
        const s = toScreenShape(shape, viewport);
        const selected = item.id === selectedId;
        const color = selected
          ? ANNOTATION_COLORS.selected
          : item.editable
            ? ANNOTATION_COLORS.own
            : ANNOTATION_COLORS.other;
        const outline = path(s.points, s.closed);
        const tip = s.points[1];
        return (
          <g
            key={item.id}
            className="annotation-shape"
            data-annotation-id={item.id}
            data-kind={shape.kind}
            data-selected={selected}
            stroke={color}
          >
            <path d={outline} fill="none" strokeWidth={selected ? 2.5 : 2} />
            {s.arrowHead && tip && (
              <path
                d={path([s.arrowHead[0], tip, s.arrowHead[1]], false)}
                fill="none"
                strokeWidth={2}
              />
            )}
            {s.endTicks.map(([a, b], i) => (
              <path key={i} d={path([a, b], false)} strokeWidth={2} />
            ))}
            {/* Wide invisible stroke: easy to hit, leaves the inside free for panning. */}
            <path
              className="annotation-shape__hit"
              d={outline}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
              style={{ cursor: tool ? undefined : item.editable ? 'move' : 'pointer' }}
              onPointerDown={onShapeDown(item, null)}
            />
            {item.text && (
              <text
                className="annotation-shape__text"
                x={s.labelAt.x}
                y={s.labelAt.y}
                fill={color}
                stroke="rgba(0,0,0,0.75)"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {item.text}
              </text>
            )}
            {selected &&
              item.editable &&
              !tool &&
              s.handles.map((h, i) => (
                <rect
                  key={i}
                  className="annotation-shape__handle"
                  data-handle={i}
                  x={h.x - 5}
                  y={h.y - 5}
                  width={10}
                  height={10}
                  fill="#0b2333"
                  strokeWidth={2}
                  style={{ cursor: 'crosshair' }}
                  onPointerDown={onShapeDown(item, i)}
                />
              ))}
          </g>
        );
      })}

      {activeDraft && <DraftShape draft={activeDraft} transform={transform} />}
    </svg>
  );
}

function DraftShape({ draft, transform }: { draft: Draft; transform: ViewerTransform }) {
  const color = ANNOTATION_COLORS.draft;
  if (draft.type === 'drag') {
    const shape = shapeFromDrag(draft.kind, draft.start, draft.end, transform.image);
    const s = toScreenShape(shape, transform.viewport);
    const tip = s.points[1];
    return (
      <g
        className="annotation-draft"
        stroke={color}
        fill="none"
        strokeDasharray="6 4"
        strokeWidth={2}
      >
        <path d={path(s.points, s.closed)} />
        {s.arrowHead && tip && <path d={path([s.arrowHead[0], tip, s.arrowHead[1]], false)} />}
      </g>
    );
  }
  const points = draft.points.map(([x, y]) => imageToScreen(transform.viewport, { x, y }));
  const hover = draft.hover
    ? imageToScreen(transform.viewport, { x: draft.hover[0], y: draft.hover[1] })
    : null;
  const first = points[0];
  return (
    <g className="annotation-draft" stroke={color} fill="none" strokeWidth={2}>
      <path d={path(hover ? [...points, hover] : points, false)} strokeDasharray="6 4" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === 0 ? 5 : 3} fill={i === 0 ? color : 'none'} />
      ))}
      {first && points.length >= POLYGON_MIN_POINTS && (
        <circle cx={first.x} cy={first.y} r={CLOSE_PX} strokeOpacity={0.5} />
      )}
    </g>
  );
}
