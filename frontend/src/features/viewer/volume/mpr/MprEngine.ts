import type { Measurement, Vec3, VolumeAnnotationKind, VolumeGeometry } from '@/api/types';
import type { CtWindow } from '../../lib/ctWindow';
import type { Rgba } from '../structures';
import type { MprAnnotationInput } from './annotationConverters';

export type { MprAnnotationInput } from './annotationConverters';

/**
 * What the MPR view needs from a rendering library. The Cornerstone3D implementation lives in
 * `cornerstoneMprEngine.ts` (lazy chunk); tests use an in-memory fake, since jsdom has no WebGL.
 *
 * Setters record the desired state and apply it as soon as it can be (e.g. a window set before the
 * volume has loaded is applied when it has), so callers never have to sequence calls.
 */
export type MprOrientation = 'axial' | 'coronal' | 'sagittal';
export const MPR_ORIENTATIONS: readonly MprOrientation[] = ['axial', 'coronal', 'sagittal'];

/** Navigation tools, then the measurement tools that draw annotations. */
export type MprTool =
  'crosshairs' | 'windowLevel' | 'pan' | 'zoom' | 'rectangleRoi' | 'ellipseRoi' | 'length';

export const MPR_ANNOTATION_TOOLS = ['rectangleRoi', 'ellipseRoi', 'length'] as const;
export type MprAnnotationTool = (typeof MPR_ANNOTATION_TOOLS)[number];

export const KIND_OF_TOOL: Record<MprAnnotationTool, VolumeAnnotationKind> = {
  rectangleRoi: 'RECTANGLE_ROI',
  ellipseRoi: 'ELLIPSE_ROI',
  length: 'LENGTH',
};

/**
 * The user finished drawing or editing an annotation (reported once the pointer is released and
 * its statistics are known, not on every drag step).
 */
export interface MprAnnotationChange {
  /** The engine's id of the annotation (the API id for one loaded with `setAnnotations`). */
  uid: string;
  kind: VolumeAnnotationKind;
  geometry: VolumeGeometry;
  measurement: Measurement | null;
}

export interface MprLabelmap {
  /** Presigned URL of the labelmap NIfTI (same grid as the volume). */
  url: string;
  /** Entry `v` colours voxel value `v` (RGBA 0..255); entry 0 is the background. */
  colorLut: Rgba[];
  /** Voxel values to hide. */
  hidden: number[];
}

export interface MprEngineEvents {
  /** Crosshair centre moved (LPS mm). */
  onCrosshairChange?: (point: Vec3) => void;
  /** Window changed by dragging. */
  onWindowChange?: (window: CtWindow) => void;
  /** An annotation was drawn (new uid) or moved / reshaped by the user. */
  onAnnotationChange?: (change: MprAnnotationChange) => void;
  /**
   * An annotation the engine had reported or been given disappeared from the views by an action
   * of the rendering library itself (not by `setAnnotations`).
   */
  onAnnotationRemove?: (uid: string) => void;
  /** The user clicked an annotation in a view (null: selection cleared). */
  onAnnotationSelect?: (uid: string | null) => void;
}

/** What the engine learnt about a loaded volume. */
export interface VolumeStats {
  /** Lowest and highest voxel value. */
  range: [number, number];
}

export interface MprEngine {
  /** Resolves once the volume is displayed; rejects when it cannot be loaded. */
  loadVolume(url: string): Promise<VolumeStats>;
  /** Resolves once the labelmap is displayed (or removed, for null). */
  setLabelmap(labelmap: MprLabelmap | null): Promise<void>;
  /** Colours and visibility of the current labelmap, without reloading it. */
  styleLabelmap(colorLut: Rgba[], hidden: number[]): void;
  /** 0..1, applied on top of the per-structure opacity. */
  setLabelmapOpacity(opacity: number): void;
  /** Until a window is set the volume shows with Cornerstone's own default VOI. */
  setWindow(window: CtWindow): void;
  setTool(tool: MprTool): void;
  /** Moves the crosshair (and the slice of every view) to a point in LPS mm. */
  jumpTo(point: Vec3): void;
  /** Scrolls one view by whole slices. */
  scroll(orientation: MprOrientation, delta: number): void;
  /**
   * Annotations to show: those missing are added, those gone removed, changed ones redrawn. Does
   * not report them back through `onAnnotationChange`. Applied once the volume is loaded.
   */
  setAnnotations(annotations: readonly MprAnnotationInput[]): void;
  /** Highlights one annotation (null: none). */
  selectAnnotation(uid: string | null): void;
  /** PNG of one view as displayed (image, labelmap and annotations), or null. */
  capture(orientation: MprOrientation): Promise<Blob | null>;
  /** Camera and crosshair back to their initial state (the window is the caller's to reset). */
  reset(): void;
  resize(): void;
  /** Releases the rendering engine, tools and cached volumes. Idempotent. */
  destroy(): void;
}

export type MprElements = Record<MprOrientation, HTMLDivElement>;

export type MprEngineFactory = (elements: MprElements, events: MprEngineEvents) => MprEngine;
