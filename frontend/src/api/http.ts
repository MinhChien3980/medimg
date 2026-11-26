import axios, { AxiosHeaders, isAxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/features/auth/authStore';
import { isPasswordChangeRequired, parseBlobBody } from './problem';
import type { TokenResponse } from './types';

export const API_BASE = '/api/v1';

/** Authenticated client used by every API module. */
export const http = axios.create({ baseURL: API_BASE, timeout: 30_000 });

/**
 * Client for `/auth/*` (login, refresh, logout). It has no interceptors, so it never sends a
 * possibly expired access token and a 401 from these endpoints never triggers a refresh.
 */
export const authHttp = axios.create({ baseURL: API_BASE, timeout: 15_000 });

/** Thrown when the session cannot be renewed; the store has been cleared (→ /login). */
export class SessionExpiredError extends Error {
  constructor(cause?: unknown) {
    super('Session expired', { cause });
    this.name = 'SessionExpiredError';
  }
}

let refreshInFlight: { refreshToken: string; promise: Promise<string> } | null = null;

async function doRefresh(refreshToken: string): Promise<string> {
  const isCurrentSession = () => useAuthStore.getState().refreshToken === refreshToken;
  try {
    const { data } = await authHttp.post<TokenResponse>('/auth/refresh', { refreshToken });
    // Signed out (or in as someone else) while the refresh was in flight: keep that state.
    if (!isCurrentSession()) throw new SessionExpiredError();
    useAuthStore.getState().setSession(data);
    return data.accessToken;
  } catch (error) {
    // The server answered (expired / revoked / rotated refresh token) → session over.
    // A pure network error keeps the session so the user can retry once back online.
    if (isAxiosError(error) && error.response) {
      if (isCurrentSession()) useAuthStore.getState().expire();
      throw new SessionExpiredError(error);
    }
    throw error;
  }
}

/**
 * Single-flight token refresh: concurrent callers share one `/auth/refresh` request
 * (refresh tokens rotate, so two parallel refreshes would invalidate each other).
 * The shared request is tied to the refresh token it was started with, so a new session
 * never reuses a refresh started for an old one.
 */
export function refreshAccessToken(): Promise<string> {
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return Promise.reject(new SessionExpiredError());
  if (refreshInFlight?.refreshToken !== refreshToken) {
    const promise = doRefresh(refreshToken).finally(() => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    });
    refreshInFlight = { refreshToken, promise };
  }
  return refreshInFlight.promise;
}

/** Current access token, refreshing first if only a refresh token is available. */
export async function getValidAccessToken(): Promise<string | null> {
  const { accessToken, refreshToken } = useAuthStore.getState();
  if (accessToken) return accessToken;
  if (refreshToken) return refreshAccessToken();
  return null;
}

type RetriableConfig = InternalAxiosRequestConfig & { _authRetried?: boolean };

function setBearer(config: InternalAxiosRequestConfig, token: string): void {
  const headers = AxiosHeaders.from(config.headers);
  headers.set('Authorization', `Bearer ${token}`);
  config.headers = headers;
}

http.interceptors.request.use(async (config) => {
  // After a reload only the refresh token is known: renew before sending, instead of
  // spending a guaranteed 401 round-trip.
  const token = await getValidAccessToken().catch(() => null);
  if (token) setBearer(config, token);
  return config;
});

http.interceptors.response.use(undefined, async (error: unknown) => {
  if (isAxiosError(error) && error.response) {
    // Blob requests (CSV, PDF) get their ProblemDetail as a Blob: parse it, so callers and the
    // check below see the same JSON as for any other request.
    error.response.data = await parseBlobBody(error.response.data);
    if (isPasswordChangeRequired(error.response.status, error.response.data)) {
      // Whatever the page, the route guard now sends the user to the password page.
      useAuthStore.getState().requirePasswordChange();
    }
  }
  if (!isAxiosError(error) || error.response?.status !== 401 || !error.config) {
    throw error;
  }
  const config = error.config as RetriableConfig;
  if (config._authRetried) throw error;
  config._authRetried = true;

  const sent = AxiosHeaders.from(config.headers).get('Authorization');
  const current = useAuthStore.getState().accessToken;
  // Another request already refreshed while this one was in flight: just replay it.
  const token = current && sent !== `Bearer ${current}` ? current : await refreshAccessToken();
  setBearer(config, token);
  return http(config);
});
