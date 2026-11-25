/** CT window presets and the DICOM linear VOI mapping (PS3.3 C.11.2.1.2) used by Cornerstone3D. */

export interface CtWindow {
  /** Window width in HU. */
  width: number;
  /** Window centre (level) in HU. */
  center: number;
}

export type CtPresetId = 'softTissue' | 'lung' | 'bone';

export const CT_WINDOW_PRESETS: ReadonlyArray<{ id: CtPresetId } & CtWindow> = [
  { id: 'softTissue', width: 400, center: 40 },
  { id: 'lung', width: 1500, center: -600 },
  { id: 'bone', width: 1800, center: 400 },
];

export const DEFAULT_CT_WINDOW: CtWindow = { width: 400, center: 40 };

export interface VoiRange {
  lower: number;
  upper: number;
}

/** Same formula as Cornerstone's `windowLevel.toLowHighRange` (LINEAR). */
export function toVoiRange({ width, center }: CtWindow): VoiRange {
  return {
    lower: center - 0.5 - (width - 1) / 2,
    upper: center - 0.5 + (width - 1) / 2,
  };
}

export function fromVoiRange({ lower, upper }: VoiRange): CtWindow {
  return { width: upper - lower + 1, center: (lower + upper + 1) / 2 };
}

/** Preset matching a window (after rounding to whole HU), or null for a custom window. */
export function matchPreset(window: CtWindow): CtPresetId | null {
  const w = Math.round(window.width);
  const c = Math.round(window.center);
  return CT_WINDOW_PRESETS.find((p) => p.width === w && p.center === c)?.id ?? null;
}

/**
 * Window showing the whole intensity range `[min, max]` of a volume, for data that is not in
 * Hounsfield units (e.g. an image stack, 0..255): the VOI range is exactly that range.
 */
export function windowFromRange([min, max]: readonly [number, number]): CtWindow {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { width: 256, center: 128 };
  if (max <= min) return { width: 1, center: min + 0.5 };
  return fromVoiRange({ lower: min, upper: max });
}
