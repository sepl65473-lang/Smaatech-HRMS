// The web sign-in location report: fire-and-forget, sends raw coordinates or
// the reason there are none, and can never throw into the sign-in flow.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./apiClient', () => ({ apiFetch: vi.fn(async () => ({ recorded: true })) }));

const { apiFetch } = await import('./apiClient');
const { reportLoginLocation } = await import('./loginLocation');

const original = navigator.geolocation;
const setGeolocation = (value) => Object.defineProperty(navigator, 'geolocation', { value, configurable: true });

beforeEach(() => apiFetch.mockClear());
afterEach(() => setGeolocation(original));

describe('reportLoginLocation', () => {
  it('sends a fresh high-accuracy position as raw coordinates, with no address', async () => {
    const getCurrentPosition = vi.fn((ok) => ok({ coords: { latitude: 20.27332, longitude: 85.87775, accuracy: 14 }, timestamp: 1700000000000 }));
    setGeolocation({ getCurrentPosition });
    await reportLoginLocation();

    expect(getCurrentPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    expect(apiFetch).toHaveBeenCalledWith('/auth/login-location', {
      method: 'POST',
      body: { lat: 20.27332, lng: 85.87775, accuracy: 14, timestamp: 1700000000000 },
    });
  });

  it('reports a refusal as denied', async () => {
    setGeolocation({ getCurrentPosition: (_ok, fail) => fail({ code: 1 }) });
    await reportLoginLocation();
    expect(apiFetch).toHaveBeenCalledWith('/auth/login-location', { method: 'POST', body: { status: 'denied' } });
  });

  it('reports a timeout or missing GPS as unavailable', async () => {
    setGeolocation({ getCurrentPosition: (_ok, fail) => fail({ code: 3 }) });
    await reportLoginLocation();
    expect(apiFetch).toHaveBeenCalledWith('/auth/login-location', { method: 'POST', body: { status: 'unavailable' } });

    apiFetch.mockClear();
    setGeolocation(undefined);
    await reportLoginLocation();
    expect(apiFetch).toHaveBeenCalledWith('/auth/login-location', { method: 'POST', body: { status: 'unavailable' } });
  });

  it('never throws, even when the server call fails', async () => {
    setGeolocation({ getCurrentPosition: (ok) => ok({ coords: { latitude: 1, longitude: 2, accuracy: 5 }, timestamp: 1 }) });
    apiFetch.mockRejectedValueOnce(new Error('network down'));
    await expect(reportLoginLocation()).resolves.toBeUndefined();
  });
});
