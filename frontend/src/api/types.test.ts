import { describe, expect, it } from 'vitest';
import { hasHounsfieldUnits, isVolumeInput, type InputType } from './types';

describe('input types', () => {
  it.each<[InputType, boolean]>([
    ['IMAGE_2D', false],
    ['DICOM_2D', false],
    ['NIFTI', true],
    ['DICOM_SERIES', true],
    ['IMAGE_STACK', true],
  ])('%s is a volume: %s', (inputType, volume) => {
    expect(isVolumeInput(inputType)).toBe(volume);
  });

  it('only a CT read from DICOM or NIfTI is in Hounsfield units', () => {
    expect(hasHounsfieldUnits('NIFTI', 'CT')).toBe(true);
    expect(hasHounsfieldUnits('DICOM_SERIES', 'ct')).toBe(true);
    expect(hasHounsfieldUnits('DICOM_SERIES', 'MR')).toBe(false);
    expect(hasHounsfieldUnits('IMAGE_STACK', 'CT')).toBe(false);
    expect(hasHounsfieldUnits('IMAGE_STACK', 'OT')).toBe(false);
  });
});
