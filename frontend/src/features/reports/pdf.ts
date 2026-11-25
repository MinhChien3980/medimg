import { reportsApi } from '@/api/endpoints';
import type { ReportDto } from '@/api/types';
import { downloadBlob } from '@/shared/lib/format';

/** How long a preview's object URL stays valid (the new tab has loaded it long before). */
const PREVIEW_URL_TTL_MS = 60_000;

export function reportFileName(report: Pick<ReportDto, 'version' | 'studyId'>, draft: boolean) {
  return `report-${report.studyId.slice(0, 8)}-v${report.version}${draft ? '-draft' : ''}.pdf`;
}

/**
 * Draft preview: the endpoint needs the access token, so the PDF is fetched as a blob and opened
 * from an object URL in a new tab. When the browser blocks the tab, it is downloaded instead.
 * Resolves with how it was shown.
 */
export async function openPreviewPdf(report: ReportDto): Promise<'tab' | 'download'> {
  const blob = await reportsApi.previewPdf(report.id);
  const pdf =
    blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
  const url = URL.createObjectURL(pdf);
  const tab = window.open(url, '_blank');
  if (!tab) {
    URL.revokeObjectURL(url);
    downloadBlob(pdf, reportFileName(report, true));
    return 'download';
  }
  window.setTimeout(() => URL.revokeObjectURL(url), PREVIEW_URL_TTL_MS);
  return 'tab';
}

/** Signed PDF of a FINAL report: a presigned same-origin URL, downloaded or opened as is. */
export async function finalPdfUrl(report: ReportDto): Promise<string> {
  const { url } = await reportsApi.pdfLink(report.id);
  return url;
}

export function downloadUrl(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
