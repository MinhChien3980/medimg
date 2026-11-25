import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelsApi, predictionsApi, studiesApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import type { InputType, PredictionDto, PredictionParams, Uuid } from '@/api/types';
import { newUuid } from '@/shared/lib/format';

/** Models that accept the given study input type (`GET /models?inputType=`). */
export function useModels(inputType: InputType) {
  return useQuery({
    queryKey: queryKeys.models.list(inputType),
    queryFn: () => modelsApi.list(inputType),
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
  /** `{ threshold }` for classification; segmentation takes none (`{}`). */
  params: PredictionParams;
}

/** `POST /predictions` with a fresh Idempotency-Key per click. */
export function useRunPrediction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ studyId, seriesId, modelCode, params }: RunPredictionInput) =>
      predictionsApi.create({ studyId, seriesId, modelCode, params }, newUuid()),
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
