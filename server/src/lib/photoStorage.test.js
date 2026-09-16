// Covers the uploads-directory containment guard (a bare
// `resolved.startsWith(UPLOADS_ROOT)` check would wrongly accept a sibling
// directory like "uploads-evil"), plus the upload-hardening helpers the
// routes rely on: magic-byte sniffing, extension allow-listing, and the
// startup guard that refuses a storage driver which would discard uploads.
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  savePhoto, readPhoto, deleteFileRef,
  sniffImageType, safeExtension, randomFilename,
  assertStorageConfigured, isDurableStorage, storageDriver, contentTypeForRef,
} from './photoStorage.js';

const UPLOADS_ROOT = path.resolve(import.meta.dirname, '../../uploads');
const TEST_SUBDIR = 'test-photoStorage';

afterAll(() => {
  fs.rmSync(path.join(UPLOADS_ROOT, TEST_SUBDIR), { recursive: true, force: true });
});

describe('photoStorage containment guard', () => {
  it('saves, reads, and deletes a file within the uploads root', async () => {
    const ref = await savePhoto(TEST_SUBDIR, 'a.txt', Buffer.from('hello'));
    expect((await readPhoto(ref)).toString()).toBe('hello');
    expect(await deleteFileRef(ref)).toBe(true);
    expect(await readPhoto(ref)).toBeNull();
  });

  it('refuses to read a ref that escapes into a sibling directory', async () => {
    // A sibling like "uploads-evil" also starts with the "uploads" prefix —
    // the old bare startsWith(UPLOADS_ROOT) check would wrongly allow this.
    expect(await readPhoto('../uploads-evil/secret.txt')).toBeNull();
  });

  it('refuses to save a ref that escapes the uploads root', async () => {
    await expect(savePhoto('../../etc', 'passwd', Buffer.from('x'))).rejects.toThrow();
  });

  it('deleteFileRef is a no-op for an out-of-bounds ref', async () => {
    expect(await deleteFileRef('../uploads-evil/secret.txt')).toBe(false);
  });
});

describe('upload hardening helpers', () => {
  it('sniffs real JPEG/PNG/WebP magic bytes and rejects a disguised payload', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(webp)).toBe('image/webp');
    // An HTML/script payload sent with a Content-Type of image/jpeg.
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('too short'))).toBeNull();
  });

  it('only allows known extensions and never trusts the client filename', () => {
    expect(safeExtension('resume.pdf')).toBe('.pdf');
    expect(safeExtension('photo.JPEG')).toBe('.jpeg');
    // Anything not on the allow-list collapses to the caller's fallback.
    expect(safeExtension('payload.php')).toBe('.bin');
    expect(safeExtension('shell.sh', '.pdf')).toBe('.pdf');
    expect(safeExtension('../../etc/passwd', '.pdf')).toBe('.pdf');
    expect(safeExtension('')).toBe('.bin');
  });

  it('generates unguessable, non-colliding storage filenames', () => {
    const a = randomFilename('.jpg');
    const b = randomFilename('.jpg');
    expect(a).not.toBe(b);
    expect(a.endsWith('.jpg')).toBe(true);
    // 24 hex chars of entropy, so a stored ref can't be guessed from a timestamp.
    expect(/-[0-9a-f]{24}\.jpg$/.test(a)).toBe(true);
  });

  it('maps refs to real content types', () => {
    expect(contentTypeForRef('a/b.pdf')).toBe('application/pdf');
    expect(contentTypeForRef('a/b.png')).toBe('image/png');
    expect(contentTypeForRef('a/b.unknown')).toBe('application/octet-stream');
  });
});

describe('assertStorageConfigured', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.STORAGE_DRIVER;
    delete process.env.S3_BUCKET;
  });
  afterEach(() => {
    process.env.STORAGE_DRIVER = saved.STORAGE_DRIVER;
    process.env.S3_BUCKET = saved.S3_BUCKET;
  });

  it('reports the local driver as non-durable', () => {
    expect(assertStorageConfigured()).toEqual({ driver: 'local', durable: false });
    expect(storageDriver()).toBe('local');
    expect(isDurableStorage()).toBe(false);
  });

  it('REFUSES to start on STORAGE_DRIVER=s3 rather than silently discarding files', () => {
    // This project has no object-storage provider: the original code carried a
    // non-functional s3:// stub that returned a fabricated ref WITHOUT
    // uploading anything, and no S3 variables exist in render.yaml or .env.
    // Refusing to boot is the honest behaviour — adopting object storage is a
    // business decision, not a silent default.
    process.env.STORAGE_DRIVER = 's3';
    expect(() => assertStorageConfigured()).toThrow(/not implemented in this project/);
    expect(() => storageDriver()).toThrow(/not implemented in this project/);
  });

  it('accepts gridfs — the MongoDB this project already runs — as durable', () => {
    process.env.STORAGE_DRIVER = 'gridfs';
    expect(assertStorageConfigured()).toEqual({ driver: 'gridfs', durable: true });
    expect(isDurableStorage()).toBe(true);
  });
});
