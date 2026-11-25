import { useEffect } from 'react';
import type { Vec3 } from '@/api/types';
import type { Bounds } from '@/features/viewer/lib/clipping';
import type { VolumeBackends } from '@/features/viewer/volume/backends';
import type { MeshSceneProps } from '@/features/viewer/volume/mesh/MeshScene.types';
import type {
  MprEngine,
  MprEngineEvents,
  MprLabelmap,
  MprTool,
} from '@/features/viewer/volume/mpr/MprEngine';
import type { CtWindow } from '@/features/viewer/lib/ctWindow';
import type { Rgba } from '@/features/viewer/volume/structures';

/** In-memory MPR engine: records what the view asked for (jsdom has no WebGL). */
export class FakeMprEngine implements MprEngine {
  readonly loads: string[] = [];
  readonly labelmaps: Array<MprLabelmap | null> = [];
  readonly styles: Array<{ colorLut: Rgba[]; hidden: number[] }> = [];
  readonly windows: CtWindow[] = [];
  readonly tools: MprTool[] = [];
  readonly jumps: Vec3[] = [];
  readonly opacities: number[] = [];
  readonly scrolls: Array<[string, number]> = [];
  resets = 0;
  destroyed = 0;
  failLoad = false;
  readonly events: MprEngineEvents;

  constructor(events: MprEngineEvents) {
    this.events = events;
  }

  loadVolume(url: string): Promise<void> {
    this.loads.push(url);
    if (!this.failLoad) return Promise.resolve();
    this.failLoad = false;
    return Promise.reject(new Error('load failed'));
  }
  setLabelmap(labelmap: MprLabelmap | null): Promise<void> {
    this.labelmaps.push(labelmap);
    return Promise.resolve();
  }
  styleLabelmap(colorLut: Rgba[], hidden: number[]): void {
    this.styles.push({ colorLut, hidden });
  }
  setLabelmapOpacity(opacity: number): void {
    this.opacities.push(opacity);
  }
  setWindow(window: CtWindow): void {
    this.windows.push(window);
  }
  setTool(tool: MprTool): void {
    this.tools.push(tool);
  }
  jumpTo(point: Vec3): void {
    this.jumps.push(point);
    this.events.onCrosshairChange?.(point);
  }
  scroll(orientation: string, delta: number): void {
    this.scrolls.push([orientation, delta]);
  }
  reset(): void {
    this.resets += 1;
  }
  resize(): void {}
  destroy(): void {
    this.destroyed += 1;
  }
}

export const FAKE_BOUNDS: Bounds = { min: [-120.2, -40, -470.5], max: [110.7, 90.3, -380] };

/** Stand-in for the react-three-fiber scene: reports bounds and exposes one pick button each. */
function FakeMeshScene({ structures, clipPlanes, onBoundsChange, onPick }: MeshSceneProps) {
  useEffect(() => {
    onBoundsChange(FAKE_BOUNDS);
  }, [onBoundsChange]);
  return (
    <div data-testid="fake-scene" data-planes={JSON.stringify(clipPlanes)}>
      {structures.map((s) => (
        <button
          key={s.label}
          type="button"
          data-visible={s.visible}
          data-color={s.color}
          data-opacity={s.opacity}
          onClick={() => onPick(s.label)}
        >
          {`mesh ${s.label}`}
        </button>
      ))}
    </div>
  );
}

export function createFakeBackends({ failFirstLoad = false } = {}) {
  const engines: FakeMprEngine[] = [];
  const backends: VolumeBackends = {
    loadMprEngine: () =>
      Promise.resolve((_elements, events) => {
        const engine = new FakeMprEngine(events);
        engine.failLoad = failFirstLoad;
        engines.push(engine);
        return engine;
      }),
    MeshScene: FakeMeshScene,
  };
  return { backends, engines };
}
