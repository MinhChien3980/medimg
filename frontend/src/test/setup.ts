import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import i18n from '@/i18n';
import { server } from './server';

// `findBy*` / `waitFor` resolve as soon as their condition holds; the limit only decides how long
// a real failure waits. 1 s (the default) is too tight for Ant Design's animated modals when every
// CPU core runs a test file, as on CI.
configure({ asyncUtilTimeout: 5000 });

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

// jsdom has no object URLs (used for previews of captured images and PDFs).
if (typeof URL.createObjectURL !== 'function') {
  let next = 0;
  URL.createObjectURL = () => `blob:jsdom/${(next += 1)}`;
  URL.revokeObjectURL = () => undefined;
}

// jsdom matches every stylesheet rule on each getComputedStyle call, and Ant Design injects a few
// hundred kB of CSS. Role queries call it for every element and each of its ancestors, so one
// `getByRole(…, { name })` took seconds and timed out on slower CI runners. Styles only change
// through DOM mutations (classes, inline styles, <style> tags), so cache them per element and drop
// the cache as soon as any mutation is pending. `takeRecords()` is synchronous, so a style is never
// read stale, even right after a synchronous DOM change.
// jsdom does not implement pseudo-element styles either (antd asks for them): the argument is ignored.
const originalGetComputedStyle = window.getComputedStyle.bind(window);
let computedStyles = new WeakMap<Element, CSSStyleDeclaration>();
const domChanges = new MutationObserver(() => {
  computedStyles = new WeakMap();
});
domChanges.observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
});
window.getComputedStyle = (element: Element) => {
  if (domChanges.takeRecords().length > 0) computedStyles = new WeakMap();
  let style = computedStyles.get(element);
  if (!style) {
    style = originalGetComputedStyle(element);
    computedStyles.set(element, style);
  }
  return style;
};

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
