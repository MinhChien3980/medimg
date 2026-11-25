import { describe, expect, it } from 'vitest';
import { absoluteUrl } from './niftiUrl';

describe('absoluteUrl', () => {
  it('resolves a same-origin presigned path and keeps the signed query verbatim', () => {
    const url =
      '/medimg/studies/s/series/v/volume.nii.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=a%2Fb';
    const resolved = absoluteUrl(url, 'http://localhost:8088/studies/s');
    expect(resolved).toBe(`http://localhost:8088${url}`);
    expect(new URL(resolved).pathname.endsWith('.gz')).toBe(true);
  });

  it('leaves an absolute URL unchanged', () => {
    expect(absoluteUrl('https://cdn.example/x.nii?sig=1', 'http://localhost/')).toBe(
      'https://cdn.example/x.nii?sig=1',
    );
  });
});
