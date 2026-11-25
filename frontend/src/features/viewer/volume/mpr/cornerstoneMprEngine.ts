import {
  cache,
  Enums,
  eventTarget,
  imageLoader,
  init as initCore,
  RenderingEngine,
  setVolumesForViewports,
  utilities,
  volumeLoader,
  type Types,
} from '@cornerstonejs/core';
import {
  addTool,
  annotation as annotationApi,
  CrosshairsTool,
  EllipticalROITool,
  Enums as ToolEnums,
  init as initTools,
  LengthTool,
  PanTool,
  RectangleROITool,
  segmentation,
  StackScrollTool,
  SynchronizerManager,
  synchronizers,
  ToolGroupManager,
  utilities as toolUtilities,
  WindowLevelTool,
  ZoomTool,
  type Types as ToolTypes,
} from '@cornerstonejs/tools';
import {
  cornerstoneNiftiImageLoader,
  createNiftiImageIdsAndCacheMetadata,
} from '@cornerstonejs/nifti-volume-loader';
import type { Vec3 } from '@/api/types';
import { absoluteUrl } from './niftiUrl';
import { fromVoiRange, toVoiRange, type CtWindow } from '../../lib/ctWindow';
import type { Rgba } from '../structures';
import {
  displayKey,
  fromCornerstoneAnnotation,
  hasStats,
  kindOfTool,
  toCornerstoneAnnotation,
  type CsAnnotation,
  type MprAnnotationInput,
} from './annotationConverters';
import {
  MPR_ORIENTATIONS,
  type MprElements,
  type MprEngine,
  type MprEngineEvents,
  type MprEngineFactory,
  type MprLabelmap,
  type MprOrientation,
  type MprTool,
  type VolumeStats,
} from './MprEngine';

const NIFTI_SCHEME = 'nifti';
const VOLUME_LOADER = 'cornerstoneStreamingImageVolume';

const ORIENTATION_AXIS: Record<MprOrientation, Enums.OrientationAxis> = {
  axial: Enums.OrientationAxis.AXIAL,
  coronal: Enums.OrientationAxis.CORONAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
};

/** Reference-line colours (the usual MPR convention: axial red, coronal green, sagittal yellow). */
const LINE_COLOR: Record<MprOrientation, string> = {
  axial: 'rgb(239, 83, 80)',
  coronal: 'rgb(102, 187, 106)',
  sagittal: 'rgb(255, 202, 40)',
};

const TOOL_NAME: Record<MprTool, string> = {
  crosshairs: CrosshairsTool.toolName as string,
  windowLevel: WindowLevelTool.toolName as string,
  pan: PanTool.toolName as string,
  zoom: ZoomTool.toolName as string,
  rectangleRoi: RectangleROITool.toolName,
  ellipseRoi: EllipticalROITool.toolName,
  length: LengthTool.toolName,
};

/** Bindings each tool keeps when it is not the left-button tool. */
const SECONDARY_BINDINGS: Record<MprTool, ToolTypes.IToolBinding[]> = {
  crosshairs: [],
  windowLevel: [{ mouseButton: ToolEnums.MouseBindings.Secondary }],
  pan: [{ mouseButton: ToolEnums.MouseBindings.Auxiliary }],
  zoom: [],
  // Passive when not selected: existing measurements stay editable (handles), none is drawn.
  rectangleRoi: [],
  ellipseRoi: [],
  length: [],
};

const ANNOTATION_TOOLS = [RectangleROITool, EllipticalROITool, LengthTool];

/** Quiet time after the last change of an annotation before it is reported. */
const ANNOTATION_SETTLE_MS = 250;
/** How many times a report waits for an ROI's statistics before going without them. */
const STATS_ATTEMPTS = 8;

interface AnnotationEventDetail {
  annotation?: CsAnnotation;
  renderingEngineId?: string;
  changeType?: string;
}

let initialised: Promise<void> | null = null;

/** Initialises Cornerstone3D core, tools and the NIfTI loader once per page. */
export function initCornerstone(): Promise<void> {
  initialised ??= Promise.resolve()
    .then(() => {
      initCore();
      initTools();
      imageLoader.registerImageLoader(NIFTI_SCHEME, cornerstoneNiftiImageLoader);
      for (const tool of [
        CrosshairsTool,
        StackScrollTool,
        WindowLevelTool,
        PanTool,
        ZoomTool,
        ...ANNOTATION_TOOLS,
      ]) {
        addTool(tool);
      }
    })
    .catch((error: unknown) => {
      initialised = null;
      throw error;
    });
  return initialised;
}

/** Lazy entry point: the only export the viewer imports (dynamically). */
export async function loadCornerstoneMprEngine(): Promise<MprEngineFactory> {
  await initCornerstone();
  return (elements, events) => new CornerstoneMprEngine(elements, events);
}

class EngineDestroyedError extends Error {
  constructor() {
    super('MPR engine destroyed');
    this.name = 'EngineDestroyedError';
  }
}

let instanceCounter = 0;

/** `BaseStreamingImageVolume.load` reports completion through its callback. */
interface StreamingVolume {
  load(callback: (...args: unknown[]) => void): void;
}

interface CachedVolume {
  volumeId: string;
  imageIds: string[];
}

class CornerstoneMprEngine implements MprEngine {
  private readonly prefix: string;
  private readonly renderingEngine: RenderingEngine;
  private readonly toolGroupId: string;
  private readonly voiSyncId: string;
  private readonly segmentationId: string;
  private readonly viewportIds: Record<MprOrientation, string>;
  private readonly volumes: CachedVolume[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private destroyed = false;
  private volumeId: string | null = null;
  private labelmapVolume: CachedVolume | null = null;
  private colorLutIndex: number | null = null;
  private window: CtWindow | null = null;
  private tool: MprTool = 'crosshairs';
  private opacity = 0.5;
  private lut: Rgba[] = [];
  private hidden: number[] = [];
  private readonly listeners: Array<() => void> = [];
  private pointerDown = false;
  private volumeCounter = 0;
  private reapplyScheduled = false;
  private frameOfReferenceUID: string | null = null;
  /** Annotations to show (applied once the volume is loaded). */
  private wanted: readonly MprAnnotationInput[] = [];
  /** Annotations given by `setAnnotations` or reported by `onAnnotationChange`. */
  private readonly owned = new Set<string>();
  /** What is displayed for each owned annotation (`displayKey`). */
  private readonly shown = new Map<string, string>();
  /** Changed by the user, not reported yet → number of waits for statistics. */
  private readonly dirty = new Map<string, number>();
  /** Being removed by the engine itself: its REMOVED event is not reported. */
  private readonly removing = new Set<string>();
  private settleTimer: number | null = null;
  private readonly elements: MprElements;
  private readonly events: MprEngineEvents;

  constructor(elements: MprElements, events: MprEngineEvents) {
    this.elements = elements;
    this.events = events;
    instanceCounter += 1;
    this.prefix = `medimg-mpr-${instanceCounter}`;
    this.toolGroupId = `${this.prefix}-tools`;
    this.voiSyncId = `${this.prefix}-voi`;
    this.segmentationId = `${this.prefix}-labelmap`;
    this.viewportIds = {
      axial: `${this.prefix}-axial`,
      coronal: `${this.prefix}-coronal`,
      sagittal: `${this.prefix}-sagittal`,
    };

    this.renderingEngine = new RenderingEngine(this.prefix);
    this.renderingEngine.setViewports(
      MPR_ORIENTATIONS.map((o) => ({
        viewportId: this.viewportIds[o],
        type: Enums.ViewportType.ORTHOGRAPHIC,
        element: elements[o],
        defaultOptions: { orientation: ORIENTATION_AXIS[o], background: [0, 0, 0] as Types.RGB },
      })),
    );
    this.createTools();
    this.listen();
  }

  loadVolume(url: string): Promise<VolumeStats> {
    return this.enqueue(async () => {
      const volume = await this.createVolume(url, 'volume');
      this.volumeId = volume.volumeId;
      await setVolumesForViewports(
        this.renderingEngine,
        [{ volumeId: volume.volumeId }],
        Object.values(this.viewportIds),
      );
      this.assertAlive();
      this.frameOfReferenceUID =
        this.renderingEngine.getViewport(this.viewportIds.axial).getFrameOfReferenceUID() ?? null;
      this.applyWindow();
      this.applyTool();
      this.applyAnnotations();
      this.renderingEngine.render();
      return { range: scalarRange(cache.getVolume(volume.volumeId)) };
    }, NO_STATS);
  }

  setLabelmap(labelmap: MprLabelmap | null): Promise<void> {
    return this.enqueue<void>(async () => {
      this.removeLabelmap();
      if (!labelmap || !this.volumeId) return;
      this.lut = labelmap.colorLut;
      this.hidden = labelmap.hidden;
      const volume = await this.createVolume(labelmap.url, 'labelmap');
      this.labelmapVolume = volume;
      segmentation.addSegmentations([
        {
          segmentationId: this.segmentationId,
          representation: {
            type: ToolEnums.SegmentationRepresentations.Labelmap,
            data: { volumeId: volume.volumeId },
          },
        },
      ]);
      this.colorLutIndex = segmentation.config.color.addColorLUT(
        this.lut.map((rgba): Types.Color => [...rgba]),
      );
      const input = [
        {
          segmentationId: this.segmentationId,
          type: ToolEnums.SegmentationRepresentations.Labelmap,
          config: { colorLUTOrIndex: this.colorLutIndex },
        },
      ];
      segmentation.addLabelmapRepresentationToViewportMap(
        Object.fromEntries(Object.values(this.viewportIds).map((id) => [id, input])),
      );
      this.applyLabelmapStyle();
      this.renderingEngine.render();
    }, undefined);
  }

  styleLabelmap(colorLut: Rgba[], hidden: number[]): void {
    this.lut = colorLut;
    this.hidden = hidden;
    if (this.labelmapVolume && !this.destroyed) this.applyLabelmapStyle();
  }

  setLabelmapOpacity(opacity: number): void {
    this.opacity = opacity;
    if (this.labelmapVolume && !this.destroyed) this.applyLabelmapStyle();
  }

  setWindow(window: CtWindow): void {
    if (window.width === this.window?.width && window.center === this.window.center) return;
    this.window = window;
    if (this.volumeId && !this.destroyed) {
      this.applyWindow();
      this.renderingEngine.render();
    }
  }

  setTool(tool: MprTool): void {
    this.tool = tool;
    if (this.volumeId && !this.destroyed) this.applyTool();
  }

  jumpTo(point: Vec3): void {
    if (!this.volumeId || this.destroyed) return;
    this.crosshairs()?.setToolCenter([...point]);
  }

  scroll(orientation: MprOrientation, delta: number): void {
    if (!this.volumeId || this.destroyed) return;
    const viewport = this.renderingEngine.getViewport(this.viewportIds[orientation]);
    utilities.scroll(viewport, { delta, volumeId: this.volumeId });
  }

  setAnnotations(annotations: readonly MprAnnotationInput[]): void {
    this.wanted = annotations;
    if (this.volumeId && !this.destroyed) this.applyAnnotations();
  }

  selectAnnotation(uid: string | null): void {
    if (this.destroyed) return;
    const { selection } = annotationApi;
    if (uid && annotationApi.state.getAnnotation(uid)) {
      if (!selection.isAnnotationSelected(uid)) selection.setAnnotationSelected(uid, true);
    } else if (selection.getAnnotationsSelectedCount() > 0) {
      selection.deselectAnnotation();
    }
    this.renderAnnotations();
  }

  async capture(orientation: MprOrientation): Promise<Blob | null> {
    if (this.destroyed || !this.volumeId) return null;
    const viewport = this.renderingEngine.getViewport(this.viewportIds[orientation]);
    const canvas = viewport.canvas;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0);
    const imageOnly = await toPngBlob(out);
    // The measurements are an SVG layer over the canvas: draw it on top when the browser allows
    // reading the result back (an SVG image without foreignObject does not taint the canvas).
    const svg = this.elements[orientation].querySelector('svg');
    if (!svg) return imageOnly;
    try {
      const layer = await svgImage(svg, canvas.clientWidth, canvas.clientHeight);
      ctx.drawImage(layer, 0, 0, out.width, out.height);
      return (await toPngBlob(out)) ?? imageOnly;
    } catch {
      return imageOnly;
    }
  }

  reset(): void {
    if (!this.volumeId || this.destroyed) return;
    for (const id of Object.values(this.viewportIds)) {
      this.renderingEngine.getViewport(id).resetCamera();
    }
    this.crosshairs()?.resetCrosshairs();
    this.renderingEngine.render();
  }

  resize(): void {
    if (!this.destroyed) this.renderingEngine.resize(true, true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.listeners.splice(0)) off();
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    // The annotation state is global to the page: leave nothing behind for the next viewer.
    for (const uid of this.owned) annotationApi.state.removeAnnotation(uid);
    this.owned.clear();
    this.removeLabelmap();
    ToolGroupManager.destroyToolGroup(this.toolGroupId);
    SynchronizerManager.destroySynchronizer(this.voiSyncId);
    this.renderingEngine.destroy();
    for (const volume of this.volumes.splice(0)) uncache(volume);
  }

  // ---------- internals ----------

  /**
   * Runs operations one after another, so a labelmap never races its volume. An operation cut
   * short by `destroy` resolves with `whenDestroyed` (nobody is left to care about its result).
   */
  private enqueue<T>(operation: () => Promise<T>, whenDestroyed: T): Promise<T> {
    const run = this.queue.then(() => {
      this.assertAlive();
      return operation();
    });
    this.queue = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      if (error instanceof EngineDestroyedError) return whenDestroyed;
      throw error;
    });
  }

  private assertAlive(): void {
    if (this.destroyed) throw new EngineDestroyedError();
  }

  private async createVolume(url: string, kind: 'volume' | 'labelmap'): Promise<CachedVolume> {
    const absolute = absoluteUrl(url);
    await assertReachable(absolute);
    this.assertAlive();
    const imageIds = (await createNiftiImageIdsAndCacheMetadata({ url: absolute })) as
      string[] | undefined;
    this.assertAlive();
    if (!imageIds?.length) throw new Error(`Not a valid NIfTI file: ${artifactPath(url)}`);
    this.volumeCounter += 1;
    const volumeId = `${VOLUME_LOADER}:${this.prefix}-${kind}-${this.volumeCounter}`;
    const entry: CachedVolume = { volumeId, imageIds };
    this.volumes.push(entry);
    const volume = (await volumeLoader.createAndCacheVolume(volumeId, {
      imageIds,
    })) as unknown as StreamingVolume;
    this.assertAlive();
    await new Promise<void>((resolve, reject) => {
      volume.load((...args: unknown[]) => {
        const result = args[0] as { success?: boolean } | undefined;
        if (result?.success === false) reject(new Error(`Could not load ${artifactPath(url)}`));
        else resolve();
      });
    });
    this.assertAlive();
    return entry;
  }

  private removeLabelmap(): void {
    if (!this.labelmapVolume) return;
    for (const id of Object.values(this.viewportIds)) {
      segmentation.removeSegmentationRepresentations(id, { segmentationId: this.segmentationId });
    }
    segmentation.removeSegmentation(this.segmentationId);
    if (this.colorLutIndex !== null) segmentation.state.removeColorLUT(this.colorLutIndex);
    this.colorLutIndex = null;
    const index = this.volumes.indexOf(this.labelmapVolume);
    if (index >= 0) this.volumes.splice(index, 1);
    uncache(this.labelmapVolume);
    this.labelmapVolume = null;
  }

  private createTools(): void {
    const group = ToolGroupManager.createToolGroup(this.toolGroupId);
    if (!group) throw new Error('Could not create the MPR tool group');
    group.addTool(StackScrollTool.toolName as string, { loop: false });
    group.addTool(WindowLevelTool.toolName as string);
    group.addTool(PanTool.toolName as string);
    group.addTool(ZoomTool.toolName as string);
    for (const tool of ANNOTATION_TOOLS) group.addTool(tool.toolName);
    const orientationOf = (viewportId: string) =>
      MPR_ORIENTATIONS.find((o) => this.viewportIds[o] === viewportId) ?? 'axial';
    group.addTool(CrosshairsTool.toolName as string, {
      getReferenceLineColor: (viewportId: string) => LINE_COLOR[orientationOf(viewportId)],
      getReferenceLineControllable: () => true,
      getReferenceLineDraggableRotatable: () => false,
      getReferenceLineSlabThicknessControlsOn: () => false,
    });
    for (const id of Object.values(this.viewportIds)) group.addViewport(id, this.prefix);
    group.setToolActive(StackScrollTool.toolName as string, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
    });

    const sync = synchronizers.createVOISynchronizer(this.voiSyncId, {
      syncInvertState: false,
      syncColormap: false,
    });
    for (const id of Object.values(this.viewportIds)) {
      sync.add({ renderingEngineId: this.prefix, viewportId: id });
    }
  }

  private applyTool(): void {
    const group = ToolGroupManager.getToolGroup(this.toolGroupId);
    if (!group) return;
    for (const tool of Object.keys(TOOL_NAME) as MprTool[]) {
      group.setToolPassive(TOOL_NAME[tool], { removeAllBindings: true });
    }
    for (const tool of Object.keys(TOOL_NAME) as MprTool[]) {
      const bindings = [...SECONDARY_BINDINGS[tool]];
      if (tool === this.tool) bindings.push({ mouseButton: ToolEnums.MouseBindings.Primary });
      if (bindings.length > 0) group.setToolActive(TOOL_NAME[tool], { bindings });
    }
  }

  private applyWindow(): void {
    const window = this.window;
    if (!window) return;
    for (const id of Object.values(this.viewportIds)) {
      const viewport = this.renderingEngine.getViewport<Types.IVolumeViewport>(id);
      viewport.setProperties({ voiRange: toVoiRange(window) });
    }
  }

  private applyLabelmapStyle(): void {
    if (this.colorLutIndex === null) return;
    // Update the registered LUT in place (re-adding an index only logs a warning and replaces it).
    const registered = segmentation.state.getColorLUT(this.colorLutIndex);
    if (registered) {
      registered.length = 0;
      registered.push(...this.lut.map((rgba): Types.Color => [...rgba]));
    }
    const type = ToolEnums.SegmentationRepresentations.Labelmap;
    const hidden = new Set(this.hidden);
    for (const id of Object.values(this.viewportIds)) {
      segmentation.config.color.setColorLUT(id, this.segmentationId, this.colorLutIndex);
      for (let value = 1; value < this.lut.length; value += 1) {
        segmentation.config.visibility.setSegmentIndexVisibility(
          id,
          { segmentationId: this.segmentationId, type },
          value,
          !hidden.has(value),
        );
      }
    }
    segmentation.config.style.setStyle(
      { type },
      {
        renderFill: true,
        renderOutline: true,
        fillAlpha: this.opacity,
        fillAlphaInactive: this.opacity,
        outlineOpacity: Math.min(1, this.opacity + 0.3),
        outlineOpacityInactive: Math.min(1, this.opacity + 0.3),
      },
    );
    this.renderingEngine.render();
  }

  // ---------- annotations ----------

  private isOurs(annotation: CsAnnotation | undefined): annotation is CsAnnotation {
    return (
      !!annotation?.annotationUID &&
      kindOfTool(annotation.metadata.toolName) !== null &&
      !!this.frameOfReferenceUID &&
      annotation.metadata.FrameOfReferenceUID === this.frameOfReferenceUID
    );
  }

  /** Makes the displayed annotations match `wanted` (see `MprEngine.setAnnotations`). */
  private applyAnnotations(): void {
    const frameOfReferenceUID = this.frameOfReferenceUID;
    if (!frameOfReferenceUID) return;
    const { state, locking } = annotationApi;
    const wanted = new Map(this.wanted.map((a) => [a.uid, a]));
    for (const uid of [...this.owned]) {
      if (wanted.has(uid) || this.dirty.has(uid)) continue;
      this.removeOwned(uid);
    }
    for (const input of this.wanted) {
      const key = displayKey(input);
      const existing = stateAnnotation(input.uid);
      if (existing && (this.shown.get(input.uid) === key || this.dirty.has(input.uid))) {
        // Same shape (or being edited right now): only the label and the lock may change.
        existing.data.label = input.label ?? '';
        locking.setAnnotationLocked(input.uid, input.locked);
        this.owned.add(input.uid);
        continue;
      }
      if (existing) this.removeOwned(input.uid);
      const created = toCornerstoneAnnotation(input, frameOfReferenceUID);
      state.addAnnotation(created as unknown as ToolTypes.Annotation, this.elements.axial);
      locking.setAnnotationLocked(input.uid, input.locked);
      this.owned.add(input.uid);
      this.shown.set(input.uid, key);
    }
    this.renderAnnotations();
  }

  private removeOwned(uid: string): void {
    this.removing.add(uid);
    annotationApi.state.removeAnnotation(uid);
    this.removing.delete(uid);
    this.owned.delete(uid);
    this.shown.delete(uid);
  }

  private renderAnnotations(): void {
    toolUtilities.triggerAnnotationRenderForViewportIds(Object.values(this.viewportIds));
  }

  private markDirty(uid: string): void {
    if (!this.dirty.has(uid)) this.dirty.set(uid, 0);
    this.scheduleSettle();
  }

  private scheduleSettle(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), ANNOTATION_SETTLE_MS);
  }

  /** Reports the annotations changed by the user, once the pointer is up and stats are known. */
  private settle(): void {
    this.settleTimer = null;
    if (this.destroyed || this.dirty.size === 0) return;
    if (this.pointerDown) return; // pointer up schedules the next attempt
    let waiting = false;
    for (const [uid, attempts] of [...this.dirty]) {
      const annotation = stateAnnotation(uid);
      if (!annotation) {
        this.dirty.delete(uid);
        continue;
      }
      if (!hasStats(annotation) && attempts < STATS_ATTEMPTS) {
        this.dirty.set(uid, attempts + 1);
        waiting = true;
        continue;
      }
      this.dirty.delete(uid);
      const converted = fromCornerstoneAnnotation(annotation, {
        hounsfield: true,
        fallback: this.cameraFor(annotation),
      });
      if (!converted) continue;
      this.owned.add(uid);
      this.shown.set(
        uid,
        displayKey({ uid, ...converted, label: annotation.data.label ?? null, locked: false }),
      );
      this.events.onAnnotationChange?.({ uid, ...converted });
    }
    if (waiting) this.scheduleSettle();
  }

  /** View plane of the view an annotation was drawn on, when its metadata lacks it. */
  private cameraFor(annotation: CsAnnotation): { viewPlaneNormal: Vec3; viewUp: Vec3 } | undefined {
    const normal = annotation.metadata.viewPlaneNormal;
    for (const id of Object.values(this.viewportIds)) {
      const camera = this.renderingEngine.getViewport(id).getCamera();
      const n = camera.viewPlaneNormal;
      const up = camera.viewUp;
      if (!n || !up) continue;
      const parallel =
        !normal ||
        Math.abs(n[0] * (normal[0] ?? 0) + n[1] * (normal[1] ?? 0) + n[2] * (normal[2] ?? 0)) >
          0.999;
      if (parallel) return { viewPlaneNormal: [n[0], n[1], n[2]], viewUp: [up[0], up[1], up[2]] };
    }
    return undefined;
  }

  private listenToAnnotations(): void {
    const detailOf = (evt: Event) => (evt as CustomEvent<AnnotationEventDetail>).detail;
    const onCompleted = (evt: Event) => {
      const { annotation } = detailOf(evt);
      if (this.isOurs(annotation) && annotation.annotationUID) {
        this.markDirty(annotation.annotationUID);
      }
    };
    const onModified = (evt: Event) => {
      const { annotation, renderingEngineId, changeType } = detailOf(evt);
      if (renderingEngineId !== this.prefix || !this.isOurs(annotation)) return;
      const uid = annotation.annotationUID ?? '';
      if (changeType === ToolEnums.ChangeTypes.StatsUpdated) {
        if (this.dirty.has(uid)) this.scheduleSettle();
        return;
      }
      // Moved or reshaped by the user (drawing in progress counts too; it settles on release).
      if (!this.removing.has(uid)) this.markDirty(uid);
    };
    const onRemoved = (evt: Event) => {
      const uid = detailOf(evt).annotation?.annotationUID;
      if (!uid || this.removing.has(uid)) return;
      this.dirty.delete(uid);
      if (!this.owned.delete(uid)) return;
      this.shown.delete(uid);
      this.events.onAnnotationRemove?.(uid);
    };
    const onSelection = (evt: Event) => {
      const selection = (evt as CustomEvent<{ selection?: string[] }>).detail.selection ?? [];
      const mine = selection.filter((uid) => this.owned.has(uid));
      this.events.onAnnotationSelect?.(mine[mine.length - 1] ?? null);
    };
    const pairs: Array<[string, (evt: Event) => void]> = [
      [ToolEnums.Events.ANNOTATION_COMPLETED, onCompleted],
      [ToolEnums.Events.ANNOTATION_MODIFIED, onModified],
      [ToolEnums.Events.ANNOTATION_REMOVED, onRemoved],
      [ToolEnums.Events.ANNOTATION_SELECTION_CHANGE, onSelection],
    ];
    for (const [type, listener] of pairs) {
      eventTarget.addEventListener(type, listener);
      this.listeners.push(() => eventTarget.removeEventListener(type, listener));
    }
  }

  private crosshairs(): CrosshairsTool | undefined {
    return ToolGroupManager.getToolGroup(this.toolGroupId)?.getToolInstance(
      CrosshairsTool.toolName as string,
    ) as CrosshairsTool | undefined;
  }

  private listen(): void {
    const onCenter = (evt: Event) => {
      const detail = (evt as CustomEvent<{ toolGroupId: string; toolCenter: Types.Point3 }>).detail;
      if (detail.toolGroupId !== this.toolGroupId) return;
      const [x, y, z] = detail.toolCenter;
      this.events.onCrosshairChange?.([x, y, z]);
    };
    eventTarget.addEventListener(ToolEnums.Events.CROSSHAIR_TOOL_CENTER_CHANGED, onCenter);
    this.listeners.push(() =>
      eventTarget.removeEventListener(ToolEnums.Events.CROSSHAIR_TOOL_CENTER_CHANGED, onCenter),
    );

    const onVoi = (evt: Event) => {
      const range = (evt as CustomEvent<{ range?: Types.VOIRange }>).detail.range;
      // No window chosen yet: Cornerstone's default stands until the view sets one.
      if (!range || !this.window) return;
      const next = fromVoiRange(range);
      if (
        Math.abs(next.width - this.window.width) < 0.5 &&
        Math.abs(next.center - this.window.center) < 0.5
      ) {
        return;
      }
      if (this.pointerDown) {
        // Dragged by the user (window/level tool): adopt it.
        this.window = next;
        this.events.onWindowChange?.(next);
      } else if (!this.reapplyScheduled) {
        // Reset by Cornerstone itself (e.g. its default range once the data has loaded): keep ours.
        this.reapplyScheduled = true;
        requestAnimationFrame(() => {
          this.reapplyScheduled = false;
          if (this.destroyed || !this.volumeId) return;
          this.applyWindow();
          this.renderingEngine.render();
        });
      }
    };
    const onDown = () => {
      this.pointerDown = true;
    };
    const onUp = () => {
      this.pointerDown = false;
      if (this.dirty.size > 0) this.scheduleSettle();
    };
    for (const element of Object.values(this.elements)) {
      element.addEventListener(Enums.Events.VOI_MODIFIED, onVoi);
      element.addEventListener('pointerdown', onDown, true);
      this.listeners.push(() => {
        element.removeEventListener(Enums.Events.VOI_MODIFIED, onVoi);
        element.removeEventListener('pointerdown', onDown, true);
      });
    }
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    this.listeners.push(() => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    });
    this.listenToAnnotations();
  }
}

const NO_STATS: VolumeStats = { range: [0, 0] };

interface RangeSource {
  getRange?: () => [number, number];
  getMinMax?: () => { min: unknown; max: unknown };
}

/**
 * Lowest and highest voxel value of a loaded volume. The voxel manager of a streamed volume keeps
 * the range of every slice image (cheap); a full scan of the voxels is the fallback.
 */
function scalarRange(volume: { voxelManager?: unknown } | undefined): [number, number] {
  const voxels = volume?.voxelManager as RangeSource | undefined;
  const fast = voxels?.getRange?.();
  if (fast && Number.isFinite(fast[0]) && Number.isFinite(fast[1]) && fast[1] > fast[0]) {
    return [fast[0], fast[1]];
  }
  const scanned = voxels?.getMinMax?.();
  if (typeof scanned?.min === 'number' && typeof scanned.max === 'number') {
    return [scanned.min, scanned.max];
  }
  return fast ?? NO_STATS.range;
}

/** An annotation of the global annotation state, seen through the fields the converters use. */
function stateAnnotation(uid: string): CsAnnotation | undefined {
  return annotationApi.state.getAnnotation(uid) as unknown as CsAnnotation | undefined;
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(resolve, 'image/png');
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** The SVG layer of a view as an image of `width` × `height` CSS pixels. */
async function svgImage(
  svg: SVGSVGElement,
  width: number,
  height: number,
): Promise<HTMLImageElement> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));
  const markup = new XMLSerializer().serializeToString(copy);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  return image;
}

/** Object path of a presigned URL, for error messages (the signature is not logged). */
function artifactPath(url: string): string {
  return url.split('?')[0] ?? url;
}

/**
 * The NIfTI loader reads the header from a fetch whose failure it does not propagate (the returned
 * promise would never settle), so an expired or missing URL is detected first: the response status
 * is checked and the body download cancelled.
 */
async function assertReachable(url: string): Promise<void> {
  const controller = new AbortController();
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${artifactPath(url)}`);
  } finally {
    controller.abort();
  }
}

/** Drops a volume and its slice images from the cache (which also frees the loader's buffer). */
function uncache({ volumeId, imageIds }: CachedVolume): void {
  cache.removeVolumeLoadObject(volumeId);
  for (const imageId of imageIds) {
    if (cache.getImageLoadObject(imageId)) cache.removeImageLoadObject(imageId, { force: true });
  }
}
