// Regression test for the uploads-directory containment guard: a bare
// `resolved.startsWith(UPLOADS_ROOT)` string check would wrongly accept a
// sibling directory like "uploads-evil" (its path also starts with the
// "uploads" prefix) — this locks in the path-separator-aware fix.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { savePhoto, readPhoto, deleteFileRef } from './photoStorage.js';

const UPLOADS_ROOT = path.resolve(import.meta.dirname, '../../uploads');
const TEST_SUBDIR = 'test-photoStorage';

afterAll(() => {
  fs.rmSync(path.join(UPLOADS_ROOT, TEST_SUBDIR), { recursive: true, force: true });
});

describe('photoStorage containment guard', () => {
  it('saves, reads, and deletes a file within the uploads root', () => {
    const ref = savePhoto(TEST_SUBDIR, 'a.txt', Buffer.from('hello'));
    expect(readPhoto(ref).toString()).toBe('hello');
    expect(deleteFileRef(ref)).toBe(true);
    expect(readPhoto(ref)).toBeNull();
  });

  it('refuses to read a ref that escapes into a sibling directory', () => {
    // A sibling like "uploads-evil" also starts with the "uploads" prefix —
    // the old bare startsWith(UPLOADS_ROOT) check would wrongly allow this.
    expect(readPhoto('../uploads-evil/secret.txt')).toBeNull();
  });

  it('refuses to save a ref that escapes the uploads root', () => {
    expect(() => savePhoto('../../etc', 'passwd', Buffer.from('x'))).toThrow();
  });

  it('deleteFileRef is a no-op for an out-of-bounds ref', () => {
    expect(deleteFileRef('../uploads-evil/secret.txt')).toBe(false);
  });
});
