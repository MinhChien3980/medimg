import { http as mock, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/** Matches any origin, so relative axios/fetch URLs in jsdom are intercepted. */
export const API = '*/api/v1';

/**
 * Study-level lists every viewer asks for (slice 3): empty unless a test says otherwise, so tests
 * of earlier features need not know about them.
 */
const defaults = [
  mock.get(`${API}/studies/:id/findings`, () => HttpResponse.json([])),
  mock.get(`${API}/studies/:id/annotations`, () => HttpResponse.json([])),
  mock.get(`${API}/studies/:id/reports`, () => HttpResponse.json([])),
];

/** Shared MSW server. Each test registers its own handlers with `server.use(...)`. */
export const server = setupServer(...defaults);
