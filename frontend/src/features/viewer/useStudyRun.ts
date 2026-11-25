import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import type { Uuid } from '@/api/types';
import { useStudyPredictions } from '@/features/ai/hooks';
import { usePrediction } from '@/features/ai/usePredictionLive';

/** Selected AI run of a study: `?job=…`, or the latest run. */
export function useStudyRun(studyId: Uuid) {
  const [params, setParams] = useSearchParams();
  const history = useStudyPredictions(studyId);
  const jobId = params.get('job') ?? history.data?.[0]?.jobId ?? null;
  const prediction = usePrediction(jobId);

  const selectJob = useCallback(
    (id: Uuid) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('job', id);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return { jobId, selectJob, prediction };
}
