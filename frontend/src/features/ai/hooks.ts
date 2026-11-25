import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelsApi, predictionsApi, studiesApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import type { PredictionDto, Uuid } from '@/api/types';
import { newUuid } from '@/shared/lib/format';

export function useImageModels() {
  return useQuery({
    queryKey: queryKeys.models.list('IMAGE_2D'),
    queryFn: () => modelsApi.list('IMAGE_2D'),
    staleTime: 5 * 60_000,
  });
}

export function useStudyPredictions(studyId: Uuid | null) {
  return useQuery({
    queryKey: queryKeys.studies.predictions(studyId ?? ''),
    queryFn: () => studiesApi.predictions(studyId ?? ''),
    enabled: !!studyId,
  });
}

export interface RunPredictionInput {
  studyId: Uuid;
  seriesId: Uuid;
  modelCode: string;
  threshold: number;
}

/** `POST /predictions` with a fresh Idempotency-Key per click. */
export function useRunPrediction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ studyId, seriesId, modelCode, threshold }: RunPredictionInput) =>
      predictionsApi.create({ studyId, seriesId, modelCode, params: { threshold } }, newUuid()),
    onSuccess: (_res, input) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.studies.predictions(input.studyId),
      });
    },
  });
}

/** Retry / cancel return the updated PredictionDto: write it straight into the cache. */
export function usePredictionAction(kind: 'retry' | 'cancel') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: Uuid) =>
      kind === 'retry' ? predictionsApi.retry(jobId) : predictionsApi.cancel(jobId),
    onSuccess: (p: PredictionDto) => {
      queryClient.setQueryData(queryKeys.predictions.detail(p.jobId), p);
      void queryClient.invalidateQueries({ queryKey: queryKeys.studies.predictions(p.studyId) });
    },
  });
}
