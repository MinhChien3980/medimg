import type { Vec3 } from '@/api/types';
import type { CtWindow } from '../../lib/ctWindow';
import type { Rgba } from '../structures';

/**
 * What the MPR view needs from a rendering library. The Cornerstone3D implementation lives in
 * `cornerstoneMprEngine.ts` (lazy chunk); tests use an in-memory fake, since jsdom has no WebGL.
 *
 * Setters record the desired state and apply it as soon as it can be (e.g. a window set before the
 * volume has loaded is applied when it has), so callers never have to sequence calls.
 */
export type MprOrientation = 'axial' | 'coronal' | 'sagittal';
export const MPR_ORIENTATIONS: readonly MprOrientation[] = ['axial', 'coronal', 'sagittal'];

export type MprTool = 'crosshairs' | 'windowLevel' | 'pan' | 'zoom';

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
}

export interface MprEngine {
  /** Resolves once the volume is displayed; rejects when it cannot be loaded. */
  loadVolume(url: string): Promise<void>;
  /** Resolves once the labelmap is displayed (or removed, for null). */
  setLabelmap(labelmap: MprLabelmap | null): Promise<void>;
  /** Colours and visibility of the current labelmap, without reloading it. */
  styleLabelmap(colorLut: Rgba[], hidden: number[]): void;
  /** 0..1, applied on top of the per-structure opacity. */
  setLabelmapOpacity(opacity: number): void;
  setWindow(window: CtWindow): void;
  setTool(tool: MprTool): void;
  /** Moves the crosshair (and the slice of every view) to a point in LPS mm. */
  jumpTo(point: Vec3): void;
  /** Scrolls one view by whole slices. */
  scroll(orientation: MprOrientation, delta: number): void;
  /** Camera, window and crosshair back to their initial state. */
  reset(): void;
  resize(): void;
  /** Releases the rendering engine, tools and cached volumes. Idempotent. */
  destroy(): void;
}

export type MprElements = Record<MprOrientation, HTMLDivElement>;

export type MprEngineFactory = (elements: MprElements, events: MprEngineEvents) => MprEngine;
