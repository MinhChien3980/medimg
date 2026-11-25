/** Client-side checks before an upload (the server re-validates magic bytes and size). */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg']);

export const ACCEPT_ATTRIBUTE = '.png,.jpg,.jpeg,image/png,image/jpeg';

export type FileProblem = 'type' | 'size' | 'empty';

/** Content type sent to `uploads/init` and on the S3 PUT; falls back to the extension. */
export function resolveContentType(file: Pick<File, 'name' | 'type'>): string | null {
  if (ACCEPTED_TYPES.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? null;
}

export function validateImageFile(file: Pick<File, 'name' | 'type' | 'size'>): FileProblem | null {
  if (!resolveContentType(file)) return 'type';
  if (file.size === 0) return 'empty';
  if (file.size > MAX_UPLOAD_BYTES) return 'size';
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
