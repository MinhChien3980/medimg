import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import viVN from 'antd/locale/vi_VN';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/features/auth/authStore';
import { ErrorBoundary } from '@/shared/components/ErrorBoundary';
import { createQueryClient } from './queryClient';
import { theme } from './theme';

interface AppProvidersProps {
  children: ReactNode;
  /** Injected in tests. */
  queryClient?: QueryClient;
}

export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const { i18n } = useTranslation();

  // Drop cached server data whenever the session ends (logout or failed refresh).
  useEffect(
    () =>
      useAuthStore.subscribe((state, prev) => {
        if (prev.user && !state.user) client.clear();
      }),
    [client],
  );

  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <ConfigProvider locale={i18n.language === 'en' ? enUS : viVN} theme={theme}>
          <AntApp>{children}</AntApp>
        </ConfigProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
