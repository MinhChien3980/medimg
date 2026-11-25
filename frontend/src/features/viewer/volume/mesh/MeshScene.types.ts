import type { Bounds, ClipPlane } from '../../lib/clipping';

export interface SceneStructure {
  label: string;
  /** Presigned GLB URL (vertices in LPS mm). */
  url: string;
  /** `#rrggbb` */
  color: string;
  /** 0..1 */
  opacity: number;
  visible: boolean;
}

export interface MeshSceneProps {
  structures: readonly SceneStructure[];
  clipPlanes: readonly ClipPlane[];
  /** Bounds of every loaded mesh (hidden ones too), or null before the first has loaded. */
  onBoundsChange: (bounds: Bounds | null) => void;
  onPick: (label: string) => void;
  onLoadError: (label: string) => void;
  /** Changing it refits the camera to all meshes. */
  fitSignal: number;
  ariaLabel: string;
}
