import { createContext, lazy, useContext, type ComponentType } from 'react';
import type { MeshSceneProps } from './mesh/MeshScene.types';
import type { MprEngineFactory } from './mpr/MprEngine';

/**
 * The two heavy rendering stacks, behind a seam: Cornerstone3D (MPR) and react-three-fiber (3D).
 * Both are loaded on first use, in their own chunks. Tests provide fakes through the context,
 * since jsdom has no WebGL.
 */
export interface VolumeBackends {
  /** Initialises Cornerstone3D once, then returns a factory for MPR engines. */
  loadMprEngine: () => Promise<MprEngineFactory>;
  /** Must be rendered inside `<Suspense>`. */
  MeshScene: ComponentType<MeshSceneProps>;
}

export const defaultVolumeBackends: VolumeBackends = {
  loadMprEngine: () =>
    import('./mpr/cornerstoneMprEngine').then((m) => m.loadCornerstoneMprEngine()),
  MeshScene: lazy(() => import('./mesh/MeshScene')),
};

export const VolumeBackendsContext = createContext<VolumeBackends>(defaultVolumeBackends);

export function useVolumeBackends(): VolumeBackends {
  return useContext(VolumeBackendsContext);
}
