import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guards the export-truncation defect.
 *
 * GET /attendance with no paging is capped server-side at 100 rows to protect
 * the process from a large dataset. The Attendance page exported whatever was
 * in that hydrated list, so with 100 employees one working day already filled
 * the cap and every export after that silently lost people - no error, no
 * warning. The existing browser export test could not catch it, because its
 * tenant holds fewer rows than the cap, so the truncated export and the
 * complete one looked identical.
 *
 * listAll() must page through the server's real paginated branch instead.
 */
const apiFetchMock = vi.fn();

// Mock the API client rather than axios: what matters here is the request
// PATHS listAll asks for and how it assembles the pages, not axios internals.
vi.mock('../lib/apiClient', () => ({
  apiFetch: (...args) => apiFetchMock(...args),
  apiFetchBlob: vi.fn(),
  setAccessToken: vi.fn(),
  ApiError: class ApiError extends Error {},
  axiosInstance: { interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } },
}));

const { attendanceApi } = await import('./store');

/** A server holding `total` rows, answering the paged branch honestly. */
function serverWith(total, pageSize = 200) {
  apiFetchMock.mockImplementation((path) => {
    const url = new URL(path, 'http://x');
    const page = Number(url.searchParams.get('page')) || 1;
    const limit = Number(url.searchParams.get('limit')) || pageSize;
    const start = (page - 1) * limit;
    const rows = Array.from(
      { length: Math.max(0, Math.min(limit, total - start)) },
      (_, i) => ({ id: `row-${start + i}`, name: `Employee ${start + i}` }),
    );
    return Promise.resolve({ rows, total, page, limit });
  });
}

const paths = () => apiFetchMock.mock.calls.map((c) => c[0]);

beforeEach(() => apiFetchMock.mockReset());

describe('attendanceApi.listAll', () => {
  it('returns every row when the dataset exceeds the unpaged 100-row cap', async () => {
    serverWith(250);
    const { rows, total, truncated } = await attendanceApi.listAll();
    expect(total).toBe(250);
    expect(rows).toHaveLength(250);
    expect(truncated).toBe(false);
    // The defect this exists for: stopping at the cap.
    expect(rows.length).toBeGreaterThan(100);
  });

  it('never requests the unpaged branch, which is the capped one', async () => {
    serverWith(250);
    await attendanceApi.listAll();
    for (const path of paths()) {
      expect(path).toMatch(/[?&]page=\d+/);
      expect(path).toMatch(/[?&]limit=\d+/);
    }
  });

  it('stops after one page when everything fits', async () => {
    serverWith(12);
    const { rows } = await attendanceApi.listAll();
    expect(rows).toHaveLength(12);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles an exact multiple of the page size without looping forever', async () => {
    serverWith(400);
    const { rows } = await attendanceApi.listAll({ pageSize: 200 });
    expect(rows).toHaveLength(400);
  });

  it('passes a date range through to the server', async () => {
    serverWith(5);
    await attendanceApi.listAll({ from: '2026-01-01', to: '2026-01-31' });
    const url = paths()[0];
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-01-31');
  });

  it('REPORTS truncation instead of trimming silently', async () => {
    serverWith(5000);
    const { rows, truncated } = await attendanceApi.listAll({ pageSize: 200, hardLimit: 400 });
    expect(truncated).toBe(true);
    expect(rows.length).toBeLessThan(5000);
    // The caller is told, so the UI can say so rather than handing over a
    // quietly incomplete file.
  });

  it('copes with a server that answers the legacy array shape', async () => {
    apiFetchMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const { rows, total } = await attendanceApi.listAll();
    expect(rows).toHaveLength(2);
    expect(total).toBe(2);
  });
});
