import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import i18n from '@/i18n';
import { server } from './server';

// ---- jsdom gaps used by Ant Design ----
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        // Legacy listener API is still called by some libraries; the polyfill must provide it.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        addListener: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

window.scrollTo = () => undefined;

// jsdom does not implement pseudo-element styles (antd asks for them); ignore the argument.
const originalGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element: Element) => originalGetComputedStyle(element);

// Tests read English strings.
void i18n.changeLanguage('en');

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
  useAuthStore.getState().clear();
  localStorage.clear();
});

afterAll(() => server.close());
