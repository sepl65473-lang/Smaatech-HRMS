import { describe, it, expect, vi } from 'vitest';
import { isInternalPath, navigateInternal } from './safeNavigate';

// React Router has a live open-redirect advisory for targets that look like a
// path to a naive check and like an absolute URL to the browser. The bell menu
// navigates to a value that travelled through the database, so these are the
// shapes that must not get through.
describe('isInternalPath', () => {
  it('accepts ordinary in-app routes', () => {
    for (const path of ['/payroll', '/employees/507f1f77bcf86cd799439011', '/leave?tab=pending', '/']) {
      expect(isInternalPath(path), path).toBe(true);
    }
  });

  it('refuses protocol-relative targets', () => {
    for (const path of ['//evil.example', '//evil.example/payroll', '/\\evil.example', '/\\/evil.example']) {
      expect(isInternalPath(path), path).toBe(false);
    }
  });

  it('refuses absolute URLs and scheme tricks', () => {
    for (const path of [
      'https://evil.example',
      'http://evil.example/payroll',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(isInternalPath(path), path).toBe(false);
    }
  });

  it('refuses backslashes anywhere, which some browsers normalise to slashes', () => {
    expect(isInternalPath('/payroll\\..\\..\\evil.example')).toBe(false);
  });

  it('refuses control characters that URL parsing would strip', () => {
    expect(isInternalPath('/\n/evil.example')).toBe(false);
    expect(isInternalPath('/\tpayroll')).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(isInternalPath(value)).toBe(false);
    }
  });
});

describe('navigateInternal', () => {
  it('navigates to an internal path and reports that it did', () => {
    const navigate = vi.fn();
    expect(navigateInternal(navigate, '/payroll')).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/payroll');
  });

  it('does NOT navigate to an external target', () => {
    const navigate = vi.fn();
    expect(navigateInternal(navigate, '//evil.example')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing when there is no target at all', () => {
    const navigate = vi.fn();
    expect(navigateInternal(navigate, '')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
