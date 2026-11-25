import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@/i18n';
import { AppProviders } from '@/app/AppProviders';
import { createAppRouter } from '@/app/router';
import '@/app/global.css';

const router = createAppRouter();
const container = document.getElementById('root');
if (!container) throw new Error('#root element missing');

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
