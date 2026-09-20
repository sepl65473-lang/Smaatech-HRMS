// What a historical HR report depends on, at the layer the browser actually
// calls: the selected period must reach the server, a period must page
// through every record rather than stopping at the display cap, and the
// login-activity export must page too.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../lib/apiClient', () => ({
  apiFetch: (...args) => apiFetch(...args),
  apiFetchBlob: vi.fn(),
  setAccessToken: vi.fn(),
  axiosInstance: { interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } },
}));

const { attendanceApi, fetchAllLoginActivity } = await import('./store');

const rows = (n, date = '2026-09-21') => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, date }));

beforeEach(() => {
  apiFetch.mockReset();
});

describe('attendanceApi.page', () => {
  it('asks the server for exactly the selected period', async () => {
    apiFetch.mockResolvedValueOnce({ rows: rows(2), total: 2, page: 1, limit: 200 });

    const res = await attendanceApi.page({ from: '2026-09-21', to: '2026-10-20', page: 1, limit: 200 });

    const url = apiFetch.mock.calls[0][0];
    expect(url).toContain('from=2026-09-21');
    expect(url).toContain('to=2026-10-20');
    expect(url).toContain('page=1');
    expect(res.total).toBe(2);
  });

  it('survives the legacy array shape', async () => {
    apiFetch.mockResolvedValueOnce(rows(3));
    const res = await attendanceApi.page({ page: 1 });
    expect(res.rows).toHaveLength(3);
    expect(res.total).toBe(3);
  });
});

describe('attendanceApi.listAll — what an export downloads', () => {
  it('pages through an entire month rather than stopping at the 100-row display cap', async () => {
    // 520 rows is one month for 20 employees.
    apiFetch
      .mockResolvedValueOnce({ rows: rows(200), total: 520 })
      .mockResolvedValueOnce({ rows: rows(200), total: 520 })
      .mockResolvedValueOnce({ rows: rows(120), total: 520 });

    const { rows: all, truncated } = await attendanceApi.listAll({ from: '2026-09-21', to: '2026-10-20' });

    expect(all).toHaveLength(520);
    expect(truncated).toBe(false);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    for (const [url] of apiFetch.mock.calls) {
      expect(url).toContain('from=2026-09-21');
      expect(url).toContain('to=2026-10-20');
    }
  });

  it('reports truncation instead of handing over a short file', async () => {
    apiFetch.mockResolvedValue({ rows: rows(200), total: 100000 });
    const { truncated } = await attendanceApi.listAll({ hardLimit: 400 });
    expect(truncated).toBe(true);
  });
});

describe('fetchAllLoginActivity', () => {
  it('pages the audit log for the period and keeps only sign-in events', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { action: 'User signed in', subject: 'a@example.com', createdAt: '2026-09-21T04:00:00Z', ip: '1.2.3.4', actor: { role: 'Employee' } },
          { action: 'Employee updated', subject: 'someone', createdAt: '2026-09-21T05:00:00Z' },
        ],
        total: 3,
      })
      .mockResolvedValueOnce({
        rows: [{ action: 'Failed sign-in attempt', subject: 'b@example.com', createdAt: '2026-09-21T06:00:00Z', details: 'Invalid email or password' }],
        total: 3,
      });

    const out = await fetchAllLoginActivity(search, {
      from: '2026-09-21', to: '2026-10-20',
      actions: ['User signed in', 'Failed sign-in attempt'],
      pageSize: 2,
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0][0]).toMatchObject({ from: '2026-09-21', to: '2026-10-20', page: 1 });
    expect(out.map((r) => r.action)).toEqual(['User signed in', 'Failed sign-in attempt']);
    expect(out[0].user).toBe('a@example.com');
    expect(out[0].ip).toBe('1.2.3.4');
    expect(out[0].when).not.toBe('');
  });
});
