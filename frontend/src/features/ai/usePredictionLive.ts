import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { predictionsApi } from '@/api/endpoints';
import { streamPrediction } from '@/api/predictionStream';
import { queryKeys } from '@/api/queryKeys';
import { isTerminalPrediction, type PredictionDto, type Uuid } from '@/api/types';

/** Poll interval used when the SSE stream cannot be kept open. */
export const PREDICTION_POLL_MS = 2000;

export type LiveTransport = 'sse' | 'polling' | 'idle';

/** Plain (non-live) read of one prediction; shares the cache entry with `usePredictionLive`. */
export function usePrediction(jobId: Uuid | null) {
  return useQuery({
    queryKey: queryKeys.predictions.detail(jobId ?? ''),
    queryFn: () => predictionsApi.get(jobId ?? ''),
    enabled: !!jobId,
  });
}

/**
 * Prediction state kept live while the job is QUEUED/RUNNING:
 * SSE first (progress → patch cache, done/failed → replace cache); if the stream gives up,
 * poll `GET /predictions/{id}` every 2 s until a terminal status.
 */
export function usePredictionLive(jobId: Uuid | null) {
  const queryClient = useQueryClient();
  const [pollingJobs, setPollingJobs] = useState<ReadonlySet<string>>(() => new Set());
  const polling = !!jobId && pollingJobs.has(jobId);

  const query = useQuery({
    queryKey: queryKeys.predictions.detail(jobId ?? ''),
    queryFn: () => predictionsApi.get(jobId ?? ''),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const data = q.state.data;
      return polling && data && !isTerminalPrediction(data.status) ? PREDICTION_POLL_MS : false;
    },
  });

  const status = query.data?.status;
  const studyId = query.data?.studyId;
  const needsLive = !!status && !isTerminalPrediction(status);

  useEffect(() => {
    if (!jobId || !needsLive || polling) return;
    const key = queryKeys.predictions.detail(jobId);
    const controller = new AbortController();
    const finish = (p: PredictionDto) => queryClient.setQueryData(key, p);

    streamPrediction(
      jobId,
      {
        // Re-sync after (re)connecting: events emitted while disconnected are not replayed.
        onOpen: () => void queryClient.invalidateQueries({ queryKey: key }),
        onProgress: (e) =>
          queryClient.setQueryData<PredictionDto>(key, (old) =>
            old ? { ...old, status: e.status, progress: e.progress } : old,
          ),
        onDone: finish,
        onFailed: finish,
      },
      { signal: controller.signal },
    ).catch(() => {
      if (controller.signal.aborted) return;
      setPollingJobs((prev) => new Set(prev).add(jobId));
    });

    return () => controller.abort();
  }, [jobId, needsLive, polling, queryClient]);

  // When the job settles, refresh the study's run history.
  const terminal = !!status && isTerminalPrediction(status);
  useEffect(() => {
    if (terminal && studyId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.studies.predictions(studyId) });
    }
  }, [terminal, studyId, queryClient]);

  const transport: LiveTransport = !needsLive ? 'idle' : polling ? 'polling' : 'sse';
  return { ...query, prediction: query.data, transport };
}
