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
  CrosshairsTool,
  Enums as ToolEnums,
  init as initTools,
  PanTool,
  segmentation,
  StackScrollTool,
  SynchronizerManager,
  synchronizers,
  ToolGroupManager,
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
import { DEFAULT_CT_WINDOW, fromVoiRange, toVoiRange, type CtWindow } from '../../lib/ctWindow';
import type { Rgba } from '../structures';
import {
  MPR_ORIENTATIONS,
  type MprElements,
  type MprEngine,
  type MprEngineEvents,
  type MprEngineFactory,
  type MprLabelmap,
  type MprOrientation,
  type MprTool,
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
};

/** Bindings each tool keeps when it is not the left-button tool. */
const SECONDARY_BINDINGS: Record<MprTool, ToolTypes.IToolBinding[]> = {
  crosshairs: [],
  windowLevel: [{ mouseButton: ToolEnums.MouseBindings.Secondary }],
  pan: [{ mouseButton: ToolEnums.MouseBindings.Auxiliary }],
  zoom: [],
};

let initialised: Promise<void> | null = null;

/** Initialises Cornerstone3D core, tools and the NIfTI loader once per page. */
export function initCornerstone(): Promise<void> {
  initialised ??= Promise.resolve()
    .then(() => {
      initCore();
      initTools();
      imageLoader.registerImageLoader(NIFTI_SCHEME, cornerstoneNiftiImageLoader);
      for (const tool of [CrosshairsTool, StackScrollTool, WindowLevelTool, PanTool, ZoomTool]) {
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
  private window: CtWindow = DEFAULT_CT_WINDOW;
  private tool: MprTool = 'crosshairs';
  private opacity = 0.5;
  private lut: Rgba[] = [];
  private hidden: number[] = [];
  private readonly listeners: Array<() => void> = [];
  private pointerDown = false;
  private volumeCounter = 0;
  private reapplyScheduled = false;
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

  loadVolume(url: string): Promise<void> {
    return this.enqueue(async () => {
      const volume = await this.createVolume(url, 'ct');
      this.volumeId = volume.volumeId;
      await setVolumesForViewports(
        this.renderingEngine,
        [{ volumeId: volume.volumeId }],
        Object.values(this.viewportIds),
      );
      this.assertAlive();
      this.applyWindow();
      this.applyTool();
      this.renderingEngine.render();
    });
  }

  setLabelmap(labelmap: MprLabelmap | null): Promise<void> {
    return this.enqueue(async () => {
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
    });
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
    if (window.width === this.window.width && window.center === this.window.center) return;
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

  reset(): void {
    if (!this.volumeId || this.destroyed) return;
    for (const id of Object.values(this.viewportIds)) {
      this.renderingEngine.getViewport(id).resetCamera();
    }
    this.window = DEFAULT_CT_WINDOW;
    this.applyWindow();
    this.events.onWindowChange?.(this.window);
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
    this.removeLabelmap();
    ToolGroupManager.destroyToolGroup(this.toolGroupId);
    SynchronizerManager.destroySynchronizer(this.voiSyncId);
    this.renderingEngine.destroy();
    for (const volume of this.volumes.splice(0)) uncache(volume);
  }

  // ---------- internals ----------

  /** Runs operations one after another, so a labelmap never races its volume. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => {
      this.assertAlive();
      return operation();
    });
    this.queue = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      if (error instanceof EngineDestroyedError) return;
      throw error;
    });
  }

  private assertAlive(): void {
    if (this.destroyed) throw new EngineDestroyedError();
  }

  private async createVolume(url: string, kind: 'ct' | 'labelmap'): Promise<CachedVolume> {
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
    for (const id of Object.values(this.viewportIds)) {
      const viewport = this.renderingEngine.getViewport<Types.IVolumeViewport>(id);
      viewport.setProperties({ voiRange: toVoiRange(this.window) });
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
      if (!range) return;
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
  }
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
