import { useCallback, useRef } from 'react';

/** Presigned URLs expire after 15 min; refetching returns fresh ones. Cap retries per page. */
export const MAX_URL_REFRESHES = 3;

/**
 * Shared budget for "a presigned URL failed, refetch to get a fresh one": at most `max` refetches
 * until something loads again (`reset`), so a permanently broken object cannot loop.
 */
export function useRefreshBudget(max = MAX_URL_REFRESHES) {
  const used = useRef(0);
  const spend = useCallback(
    (refetch: () => unknown) => {
      if (used.current >= max) return;
      used.current += 1;
      void refetch();
    },
    [max],
  );
  const reset = useCallback(() => {
    used.current = 0;
  }, []);
  return { spend, reset };
}

export type RefreshBudget = ReturnType<typeof useRefreshBudget>;
