/**
 * The Cornerstone3D NIfTI loader parses the URL with `new URL(url)` (so it must be absolute),
 * detects compression from the path suffix (`.gz`), keeps the URL verbatim in its image ids
 * (`nifti:<url>?frame=n`) and fetches exactly that URL. Presigned URLs are same-origin paths:
 * they are made absolute here, and the signed query string is left untouched.
 */
export function absoluteUrl(url: string, base: string = window.location.href): string {
  return new URL(url, base).href;
}
