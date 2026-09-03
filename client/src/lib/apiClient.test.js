import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the `axios` package itself so we can inspect exactly what config
// apiFetch() constructs and hands off — isolated from axios's own internal
// header-merging/transformRequest/adapter pipeline (whose FormData-boundary
// behavior is real-browser-specific and was verified separately via a
// Playwright test against actual Chromium, not this Node/jsdom test env).
// What matters here is apiFetch's own contract: it must not itself inject
// an explicit Content-Type for a FormData body, since that's what strips
// the boundary in the first place.
const requestMock = vi.fn(() => Promise.resolve({ data: {} }));

vi.mock('axios', () => ({
  default: {
    create: () => Object.assign(requestMock, {
      defaults: { headers: {} },
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}));

const { apiFetch } = await import('./apiClient');

describe('apiFetch Content-Type handling', () => {
  beforeEach(() => {
    requestMock.mockClear();
  });

  it('does not include a Content-Type override for a FormData body', async () => {
    const form = new FormData();
    form.append('photo', new Blob(['x'], { type: 'image/jpeg' }), 'checkin.jpg');

    await apiFetch('/attendance/1/check-in', { method: 'POST', body: form });

    const config = requestMock.mock.calls[0][0];
    expect(config.headers).toBeUndefined();
  });

  it('still passes through explicit headers for a plain JSON body', async () => {
    await apiFetch('/auth/login', { method: 'POST', body: { email: 'a@b.com' }, headers: { 'X-Test': '1' } });

    const config = requestMock.mock.calls[0][0];
    expect(config.headers).toEqual({ 'X-Test': '1' });
  });
});
