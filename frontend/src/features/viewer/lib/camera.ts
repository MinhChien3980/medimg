import type { Vec3 } from '@/api/types';
import type { Bounds } from './clipping';

export interface CameraFit {
  target: Vec3;
  position: Vec3;
  /** Patient superior (+z in LPS) is up on screen. */
  up: Vec3;
  near: number;
  far: number;
}

/**
 * Camera that frames `bounds` from the patient's front (anterior is -y in LPS), so the patient's
 * left (+x) appears on the right of the screen, as when facing the patient.
 * `fovDeg` is the vertical field of view; a narrow viewport (aspect < 1) limits the horizontal one.
 */
export function fitCamera(
  bounds: Bounds,
  fovDeg: number,
  aspect: number,
  margin = 1.15,
): CameraFit {
  const target: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius = Math.max(
    1,
    Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ) / 2,
  );
  const vertical = (fovDeg * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 1e-3));
  const distance = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * margin;
  return {
    target,
    position: [target[0], target[1] - distance, target[2]],
    up: [0, 0, 1],
    near: Math.max(0.1, distance - radius * 2),
    far: distance + radius * 4,
  };
}
