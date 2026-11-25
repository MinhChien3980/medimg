import { describe, expect, it } from 'vitest';
import { checkUploadFile, classifyFile, MAX_UPLOAD_BYTES } from './fileValidation';

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
  ])('%s (type "%s") is a %s sent as %s', (name, type, kind, contentType) => {
    expect(classifyFile(file(name, type))).toEqual({ kind, contentType });
  });

  it.each(['scan.dcm', 'archive.tar.gz', 'notes.gz', 'volume.nrrd'])('rejects %s', (name) => {
    expect(checkUploadFile(file(name))).toEqual({ ok: false, problem: 'type', kind: null });
  });

  it('allows 500 MB for a volume but 50 MB for an image', () => {
    expect(MAX_UPLOAD_BYTES).toEqual({ image: 50 * 1024 * 1024, volume: 500 * 1024 * 1024 });
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
