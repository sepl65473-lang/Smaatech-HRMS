import { describe, it, expect, vi } from 'vitest';

/**
 * These pin the error classification that replaced a single line:
 *
 *     const status = error.response?.status || 500;
 *     const message = ... || error.message || 'Request failed';
 *
 * When a request never reached the server, `error.response` is undefined, so
 * every transport failure was reported as an HTTP 500 carrying axios's literal
 * string "Network Error". That is what users kept seeing, and it told them
 * nothing: a timeout, an offline laptop, a sleeping server and a blocked
 * origin are four different problems with four different actions.
 */
let onError;

vi.mock('axios', () => ({
  default: {
    create: () => Object.assign(vi.fn(() => Promise.resolve({ data: {} })), {
      defaults: { headers: {} },
      interceptors: {
        request: { use: vi.fn() },
        // Capture the rejection handler so it can be driven directly.
        response: { use: vi.fn((_ok, err) => { onError = err; }) },
      },
    }),
  },
}));

const { ApiError } = await import('./apiClient');

const reject = async (err) => {
  try {
    await onError(err);
    throw new Error('expected a rejection');
  } catch (e) {
    return e;
  }
};

describe('server answered: the real status is preserved', () => {
  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'VALIDATION_ERROR'],
    [429, 'TOO_MANY_REQUESTS'],
    [500, 'SERVER_ERROR'],
    [503, 'UNAVAILABLE'],
  ])('keeps HTTP %i and the server error code', async (status, code) => {
    const err = await reject({
      config: { url: '/employees' },
      response: { status, data: { error: { code, message: 'from the server' } }, headers: {} },
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).toBe('from the server');
    expect(err.isTransport).toBe(false);
  });

  it('supplies a specific message when the body has no envelope', async () => {
    const err = await reject({
      config: { url: '/employees' },
      response: { status: 503, data: '<html>upstream</html>', headers: {} },
    });
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/starting up|unavailable/i);
    // The old code would have said "Request failed" here.
    expect(err.message).not.toBe('Request failed');
  });

  it('surfaces Retry-After on a 429 so the UI can say how long', async () => {
    const err = await reject({
      config: { url: '/auth/login' },
      response: {
        status: 429,
        data: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Slow down.' } },
        headers: { 'retry-after': '887' },
      },
    });
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(887);
  });
});

describe('no response: transport failures are told apart', () => {
  it('reports a timeout as a timeout, not a 500', async () => {
    const err = await reject({ config: { url: '/employees' }, code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' });
    expect(err.status).toBe(0);
    expect(err.code).toBe('TIMEOUT');
    expect(err.isTransport).toBe(true);
    expect(err.message).not.toMatch(/network error/i);
  });

  it('reports an unreachable server with an actionable message', async () => {
    const err = await reject({ config: { url: '/employees' }, code: 'ERR_NETWORK', message: 'Network Error' });
    expect(err.status).toBe(0);
    expect(err.code).toBe('UNREACHABLE');
    // The whole point: never hand the user axios's bare string.
    expect(err.message).not.toBe('Network Error');
    expect(err.message).toMatch(/try again/i);
  });

  it('never reports a transport failure as HTTP 500', async () => {
    const err = await reject({ config: { url: '/employees' }, code: 'ERR_NETWORK', message: 'Network Error' });
    expect(err.status).not.toBe(500);
  });

  it('distinguishes an offline device', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    try {
      const err = await reject({ config: { url: '/employees' }, code: 'ERR_NETWORK', message: 'Network Error' });
      expect(err.code).toBe('OFFLINE');
      expect(err.message).toMatch(/offline/i);
    } finally {
      // Must be restored unconditionally: leaving it false leaked into the
      // next test and made it fail for a reason unrelated to what it asserts.
      if (original) Object.defineProperty(globalThis.navigator, 'onLine', original);
      else delete globalThis.navigator.onLine;
    }
  });

  it('marks a cancelled request as cancelled rather than a failure to report', async () => {
    const err = await reject({ config: { url: '/employees' }, code: 'ERR_CANCELED', message: 'canceled' });
    expect(err.code).toBe('CANCELLED');
  });
});

describe('sleeping server: retried instead of surfaced', () => {
  it('replays a request that could not reach a waking server', async () => {
    vi.useFakeTimers();
    try {
      const pending = onError({ config: { url: '/employees', method: 'post' }, code: 'ERR_NETWORK', message: 'Network Error' });
      await vi.runAllTimersAsync();
      // The mocked instance resolves, so the replay's result is returned.
      await expect(pending).resolves.toEqual({ data: {} });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a timed-out POST, which the server may have already processed', async () => {
    const err = await reject({ config: { url: '/employees', method: 'post' }, code: 'ECONNABORTED', message: 'timeout' });
    expect(err.code).toBe('TIMEOUT');
  });
});
