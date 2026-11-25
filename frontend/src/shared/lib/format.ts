/** Formatting helpers shared by features. Locale follows the active UI language. */

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

/** 0..1 → "87.3%" */
export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** RFC 4122 v4 UUID (used for Idempotency-Key). */
export function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (e.g. plain http on a LAN IP).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Triggers a browser download of `blob`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function numberLocale(language: string): string {
  return language === 'vi' ? 'vi-VN' : 'en-GB';
}

/** Volume in millilitres: one decimal under 10 ml, whole millilitres above ("1,520 ml"). */
export function formatVolumeMl(ml: number, language: string): string {
  const digits = Math.abs(ml) < 10 ? 1 : 0;
  const value = new Intl.NumberFormat(numberLocale(language), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(ml);
  return `${value} ml`;
}

/** LPS millimetres, one decimal: "12.3, -4.0, 101.5". */
export function formatPoint(point: readonly number[], language: string): string {
  const format = new Intl.NumberFormat(numberLocale(language), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return point
    .map((v) => format.format(Math.abs(v) < 0.05 ? 0 : v))
    .join(language === 'vi' ? '; ' : ', ');
}
