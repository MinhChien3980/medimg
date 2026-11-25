import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';
import { findingsApi } from '@/api/endpoints';
import { errorMessage, toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type {
  CreateFindingRequest,
  FindingDto,
  PredictionDto,
  ReviewDecision,
  Uuid,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { applyReview, replaceFinding, reviewRequest } from './reviewModel';

/** Cache prefix of single runs (`queryKeys.predictions.detail`). */
const RUNS = ['predictions'] as const;

/** AI findings of every finished run of the study plus its MANUAL findings. */
export function useStudyFindings(studyId: Uuid) {
  return useQuery({
    queryKey: queryKeys.studies.findings(studyId),
    queryFn: () => findingsApi.forStudy(studyId),
    enabled: !!studyId,
  });
}

export interface ReviewInput {
  finding: FindingDto;
  decision: ReviewDecision;
  label?: string;
  note?: string;
}

/**
 * Reviews a finding optimistically in both places it is cached (its run, and the study's findings
 * used by the report). On failure both are restored; on a 409 (reviewed by someone else since it
 * was loaded) both are refetched and the user is told.
 */
export function useReviewFinding(studyId: Uuid) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const studyKey = queryKeys.studies.findings(studyId);

  return useMutation({
    mutationFn: ({ finding, decision, label, note }: ReviewInput) =>
      findingsApi.review(finding.id, reviewRequest(finding, decision, { label, note })),
    onMutate: async ({ finding, decision, label, note }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: RUNS }),
        queryClient.cancelQueries({ queryKey: studyKey }),
      ]);
      const user = useAuthStore.getState().user;
      const optimistic = applyReview(
        finding,
        reviewRequest(finding, decision, { label, note }),
        { id: user?.id ?? '', fullName: user?.fullName ?? '' },
        new Date().toISOString(),
      );
      // The finding is cached in its run (found by id: the DTO does not name its run).
      const previousRuns = queryClient
        .getQueriesData<PredictionDto>({ queryKey: RUNS })
        .filter(([, run]) => run?.findings.some((f) => f.id === finding.id));
      const previousStudy = queryClient.getQueryData<FindingDto[]>(studyKey);
      writeFinding(optimistic);
      return { previousRuns, previousStudy };
    },
    onSuccess: (saved) => writeFinding(saved),
    onError: (error, _input, context) => {
      for (const [key, run] of context?.previousRuns ?? []) queryClient.setQueryData(key, run);
      if (context) queryClient.setQueryData(studyKey, context.previousStudy);
      if (toAppError(error).status === 409) {
        void message.warning(t('review.conflict'));
        for (const [key] of context?.previousRuns ?? []) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
        void queryClient.invalidateQueries({ queryKey: studyKey });
      } else {
        void message.error(errorMessage(error));
      }
    },
  });

  function writeFinding(finding: FindingDto) {
    queryClient.setQueriesData<PredictionDto>({ queryKey: RUNS }, (run) =>
      run?.findings.some((f) => f.id === finding.id)
        ? { ...run, findings: replaceFinding(run.findings, finding) }
        : run,
    );
    queryClient.setQueryData<FindingDto[]>(studyKey, (old) =>
      old ? replaceFinding(old, finding) : old,
    );
  }
}

export function useAddFinding(studyId: Uuid) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFindingRequest) => findingsApi.create(studyId, body),
    onSuccess: (created) => {
      queryClient.setQueryData<FindingDto[]>(queryKeys.studies.findings(studyId), (old) =>
        old ? [...old, created] : [created],
      );
    },
  });
}

export function useDeleteFinding(studyId: Uuid) {
  const queryClient = useQueryClient();
  const key = queryKeys.studies.findings(studyId);
  return useMutation({
    mutationFn: (id: Uuid) => findingsApi.remove(id),
    onSuccess: (_void, id) => {
      queryClient.setQueryData<FindingDto[]>(key, (old) => old?.filter((f) => f.id !== id));
    },
  });
}
