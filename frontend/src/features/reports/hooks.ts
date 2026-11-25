import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { putToPresignedUrl, reportsApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import {
  KEY_IMAGE_MAX_BYTES,
  type CreateReportRequest,
  type ReportDto,
  type ReportSummaryDto,
  type Uuid,
} from '@/api/types';

/**
 * Every write to a report goes through this mutation scope, one at a time, and reads the row
 * version from the cache when it starts: a section save, a key image reorder and a signature fired
 * together never trip over each other's version.
 */
export const REPORT_SCOPE = { id: 'report-writes' };

/** Versions of the study's report, latest first (summaries). */
export function useStudyReports(studyId: Uuid, enabled = true) {
  return useQuery({
    queryKey: queryKeys.studies.reports(studyId),
    queryFn: () => reportsApi.forStudy(studyId),
    enabled: enabled && !!studyId,
  });
}

/** One full report (sections, key images, row version). */
export function useReport(id: Uuid | null) {
  return useQuery({
    queryKey: queryKeys.reports.detail(id ?? ''),
    queryFn: () => reportsApi.get(id ?? ''),
    enabled: !!id,
  });
}

/** Reads a report from the server and stores it (e.g. after a write that returns nothing). */
export async function reloadReport(queryClient: QueryClient, id: Uuid): Promise<ReportDto> {
  const fresh = await queryClient.query({
    queryKey: queryKeys.reports.detail(id),
    queryFn: () => reportsApi.get(id),
    staleTime: 0,
  });
  storeReport(queryClient, fresh);
  return fresh;
}

/** Writes a report returned by the server into the detail cache and the study's version list. */
export function storeReport(queryClient: QueryClient, report: ReportDto): void {
  queryClient.setQueryData(queryKeys.reports.detail(report.id), report);
  queryClient.setQueryData<ReportSummaryDto[]>(queryKeys.studies.reports(report.studyId), (old) => {
    if (!old) return [report];
    return old.some((r) => r.id === report.id)
      ? old.map((r) => (r.id === report.id ? { ...r, ...report } : r))
      : [report, ...old];
  });
}

/** Latest known row version of a report (the cache is updated by every write). */
export function cachedRowVersion(queryClient: QueryClient, report: ReportDto): number {
  return (
    queryClient.getQueryData<ReportDto>(queryKeys.reports.detail(report.id))?.rowVersion ??
    report.rowVersion
  );
}

export function useCreateReport(studyId: Uuid) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: REPORT_SCOPE,
    mutationFn: (body: CreateReportRequest) => reportsApi.create(studyId, body),
    onSuccess: (report) => storeReport(queryClient, report),
  });
}

/** Sign: the server renders the PDF and the report becomes FINAL (immutable). */
export function useFinalizeReport() {
  const queryClient = useQueryClient();
  return useMutation({
    scope: REPORT_SCOPE,
    mutationFn: (report: ReportDto) =>
      reportsApi.finalize(report.id, { rowVersion: cachedRowVersion(queryClient, report) }),
    onSuccess: (report) => {
      storeReport(queryClient, report);
      void queryClient.invalidateQueries({ queryKey: queryKeys.studies.findings(report.studyId) });
    },
  });
}

/** Technique and Findings of the draft written again by the server from the reviewed findings. */
export function useRefillReport() {
  const queryClient = useQueryClient();
  return useMutation({
    scope: REPORT_SCOPE,
    mutationFn: (report: ReportDto) =>
      reportsApi.refill(report.id, { rowVersion: cachedRowVersion(queryClient, report) }),
    onSuccess: (report) => storeReport(queryClient, report),
  });
}

/** New DRAFT (version + 1) copied from the latest FINAL report. */
export function useAmendReport() {
  const queryClient = useQueryClient();
  return useMutation({
    scope: REPORT_SCOPE,
    mutationFn: (report: ReportDto) => reportsApi.amend(report.id),
    onSuccess: (report) => storeReport(queryClient, report),
  });
}

export function useDeleteReport() {
  const queryClient = useQueryClient();
  return useMutation({
    scope: REPORT_SCOPE,
    mutationFn: (report: ReportDto) => reportsApi.remove(report.id),
    onSuccess: (_void, report) => {
      queryClient.removeQueries({ queryKey: queryKeys.reports.detail(report.id) });
      queryClient.setQueryData<ReportSummaryDto[]>(
        queryKeys.studies.reports(report.studyId),
        (old) => old?.filter((r) => r.id !== report.id),
      );
    },
  });
}

/** Removes a key image, then reads the report again (new order, row version). */
export function useRemoveKeyImage() {
  const queryClient = useQueryClient();
  return useMutation({
    scope: REPORT_SCOPE,
    mutationFn: async ({ report, imageId }: { report: ReportDto; imageId: Uuid }) => {
      await reportsApi.removeKeyImage(report.id, imageId);
      return reloadReport(queryClient, report.id);
    },
  });
}

export class KeyImageTooLargeError extends Error {
  constructor() {
    super('Key image larger than 5 MB');
    this.name = 'KeyImageTooLargeError';
  }
}

/** init → presigned PUT of the PNG (exactly the declared size) → complete → report read again. */
export async function uploadKeyImage(
  queryClient: QueryClient,
  reportId: Uuid,
  png: Blob,
  caption: string,
): Promise<ReportDto> {
  if (png.size > KEY_IMAGE_MAX_BYTES) throw new KeyImageTooLargeError();
  const init = await reportsApi.initKeyImage(reportId, {
    contentType: 'image/png',
    size: png.size,
    ...(caption ? { caption } : {}),
  });
  await putToPresignedUrl(init.putUrl, png, 'image/png');
  await reportsApi.completeKeyImage(reportId, init.imageId);
  return reloadReport(queryClient, reportId);
}

export function useAddKeyImage() {
  const queryClient = useQueryClient();
  return useMutation({
    scope: REPORT_SCOPE,
    mutationFn: ({ reportId, png, caption }: { reportId: Uuid; png: Blob; caption: string }) =>
      uploadKeyImage(queryClient, reportId, png, caption),
  });
}
