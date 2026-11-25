import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { authApi } from '@/api/endpoints';
import type { LoginRequest, Role } from '@/api/types';
import { useAuthStore } from './authStore';

export const DEMO_PASSWORD = 'Demo@12345';
export const DEMO_ACCOUNTS = [
  { username: 'doctor', role: 'DOCTOR' },
  { username: 'tech', role: 'TECHNICIAN' },
  { username: 'admin', role: 'ADMIN' },
  { username: 'researcher', role: 'RESEARCHER' },
] as const satisfies ReadonlyArray<{ username: string; role: Role }>;

export function useLogin() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: (body: LoginRequest) => authApi.login(body),
    onSuccess: (tokens) => setSession(tokens),
  });
}

/**
 * Clears the local session first, so logging out never depends on the network, then revokes
 * the refresh token server-side (best effort) and goes to /login.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    const { refreshToken, clear } = useAuthStore.getState();
    clear();
    queryClient.clear();
    const revoke = refreshToken ? authApi.logout(refreshToken).catch(() => undefined) : null;
    await navigate('/login', { replace: true });
    await revoke;
  }, [navigate, queryClient]);
}
