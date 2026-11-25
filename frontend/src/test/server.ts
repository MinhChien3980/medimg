import { setupServer } from 'msw/node';

/** Shared MSW server. Each test registers its own handlers with `server.use(...)`. */
export const server = setupServer();

/** Matches any origin, so relative axios/fetch URLs in jsdom are intercepted. */
export const API = '*/api/v1';
