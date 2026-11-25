import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { SessionExpiredError } from '@/api/http';

/** Do not retry client errors (4xx) or an expired session; retry network/5xx twice. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof SessionExpiredError) return false;
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status !== undefined && status >= 400 && status < 500) return false;
  }
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
