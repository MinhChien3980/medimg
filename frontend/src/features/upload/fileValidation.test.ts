import { describe, expect, it } from 'vitest';
import {
  checkSliceSpacing,
  checkUploadFile,
  classifyFile,
  MAX_UPLOAD_BYTES,
} from './fileValidation';

const file = (name: string, type = '', size = 1024) => ({ name, type, size });

describe('upload file checks', () => {
  it.each([
    ['ct.nii', '', 'volume', 'application/octet-stream'],
    ['ct.nii', 'application/octet-stream', 'volume', 'application/octet-stream'],
    ['CT.NII.GZ', 'application/x-gzip', 'volume', 'application/gzip'],
    ['ct.nii.gz', '', 'volume', 'application/gzip'],
    ['series.zip', 'application/x-zip-compressed', 'volume', 'application/zip'],
    ['series.zip', 'application/zip', 'volume', 'application/zip'],
    ['chest.png', 'image/png', 'image', 'image/png'],
    ['chest.JPG', '', 'image', 'image/jpeg'],
    ['photo', 'image/jpeg', 'image', 'image/jpeg'],
    // Browsers report DICOM as `application/dicom`, `application/octet-stream` or nothing.
    ['chest.dcm', '', 'dicom', 'application/dicom'],
    ['CHEST.DCM', 'application/octet-stream', 'dicom', 'application/dicom'],
    ['chest.dcm', 'application/dicom', 'dicom', 'application/dicom'],
  ])('%s (type "%s") is a %s sent as %s', (name, type, kind, contentType) => {
    expect(classifyFile(file(name, type))).toEqual({ kind, contentType });
  });

  it.each(['scan.dicom', 'archive.tar.gz', 'notes.gz', 'volume.nrrd'])('rejects %s', (name) => {
    expect(checkUploadFile(file(name))).toEqual({ ok: false, problem: 'type', kind: null });
  });

  it('allows 500 MB for a volume but 50 MB for an image or a DICOM X-ray', () => {
    expect(MAX_UPLOAD_BYTES).toEqual({
      image: 50 * 1024 * 1024,
      dicom: 50 * 1024 * 1024,
      volume: 500 * 1024 * 1024,
    });
    expect(checkUploadFile(file('x.dcm', '', MAX_UPLOAD_BYTES.dicom + 1))).toEqual({
      ok: false,
      problem: 'size',
      kind: 'dicom',
    });
    expect(checkUploadFile(file('ct.nii.gz', '', MAX_UPLOAD_BYTES.volume)).ok).toBe(true);
    expect(checkUploadFile(file('ct.nii.gz', '', MAX_UPLOAD_BYTES.volume + 1))).toEqual({
      ok: false,
      problem: 'size',
      kind: 'volume',
    });
    expect(checkUploadFile(file('x.png', 'image/png', MAX_UPLOAD_BYTES.image + 1))).toEqual({
      ok: false,
      problem: 'size',
      kind: 'image',
    });
  });

  it('rejects empty files', () => {
    expect(checkUploadFile(file('ct.nii', '', 0))).toEqual({
      ok: false,
      problem: 'empty',
      kind: 'volume',
    });
  });
});

describe('slice spacing of an image stack', () => {
  it('is optional: three empty inputs leave it to the server (1 mm assumed)', () => {
    expect(checkSliceSpacing([null, null, null])).toEqual({ ok: true, spacing: null });
  });

  it('accepts three values between 0.01 and 20 mm', () => {
    expect(checkSliceSpacing([0.7, 0.7, 2.5])).toEqual({ ok: true, spacing: [0.7, 0.7, 2.5] });
    expect(checkSliceSpacing([0.01, 20, 1])).toEqual({ ok: true, spacing: [0.01, 20, 1] });
  });

  it.each([
    [[0.009, 1, 1]],
    [[1, 20.01, 1]],
    [[1, 1, 0]],
    [[-1, 1, 1]],
    [[Number.NaN, 1, 1]],
    [[25, null, null]],
  ] as const)('refuses %j as out of range', (input) => {
    expect(checkSliceSpacing(input)).toEqual({ ok: false, problem: 'range' });
  });

  it('refuses a partial entry instead of completing it with 1 mm', () => {
    expect(checkSliceSpacing([0.8, 0.8, null])).toEqual({ ok: false, problem: 'incomplete' });
    expect(checkSliceSpacing([null, null, 3])).toEqual({ ok: false, problem: 'incomplete' });
  });
});
