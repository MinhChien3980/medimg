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

/** Integer or decimal count in the UI language ("1.234" in Vietnamese, "1,234" in English). */
export function formatNumber(value: number, language: string, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(numberLocale(language), { maximumFractionDigits }).format(value);
}

/** 0..1 → "87.3%" / "87,3%"; null → "—". */
export function formatRate(fraction: number | null | undefined, language: string): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—';
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(fraction);
}

/** Milliseconds as "812 ms", "1.2 s", "1 min 35 s"; null → "—". */
export function formatDurationMs(ms: number | null | undefined, language: string): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${formatNumber(Math.round(ms), language)} ms`;
  if (ms < 60_000) return `${formatNumber(ms / 1000, language, 1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0
    ? `${formatNumber(minutes, language)} min`
    : `${formatNumber(minutes, language)} min ${seconds} s`;
}

/**
 * A calendar day `YYYY-MM-DD` (no time zone: the server already counted it in its zone), read as
 * a local date so it never shifts by a day in a time zone west of UTC.
 */
export function formatDay(
  day: string,
  language: string,
  style: 'short' | 'medium' = 'short',
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    ...(style === 'medium' ? { year: 'numeric' } : {}),
  }).format(date);
}
