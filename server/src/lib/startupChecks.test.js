// The boot gate. These assert the exact misconfigurations that previously
// started a running-but-broken (or insecure) server.
import { describe, it, expect } from 'vitest';
import { runStartupChecks, generateSecret } from './startupChecks.js';

const STRONG_A = 'a'.repeat(64);
const STRONG_B = 'b'.repeat(64);

const validEnv = () => ({
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://mongo:27017/hrms',
  JWT_ACCESS_SECRET: STRONG_A,
  JWT_REFRESH_SECRET: STRONG_B,
  CLIENT_ORIGIN: 'https://hrms.example.com',
  BREVO_API_KEY: 'key',
  ALLOW_EPHEMERAL_STORAGE: '1',
});

describe('required configuration', () => {
  it('passes a fully configured production environment', () => {
    const result = runStartupChecks({ env: validEnv(), strict: true });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when MONGODB_URI is missing', () => {
    const env = validEnv();
    delete env.MONGODB_URI;
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/MONGODB_URI/);
  });

  it('fails when a JWT secret is missing', () => {
    const env = validEnv();
    delete env.JWT_REFRESH_SECRET;
    expect(runStartupChecks({ env, strict: true }).ok).toBe(false);
  });
});

describe('secret quality', () => {
  it("REJECTS the placeholder docker-compose.yml used to ship", () => {
    // docker-compose.yml previously hardcoded exactly this value, which meant
    // anyone who could read the repository could forge a valid login token.
    const env = { ...validEnv(), JWT_ACCESS_SECRET: 'production-jwt-secret-change-me' };
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/placeholder/i);
  });

  it('rejects a short secret in production', () => {
    const env = { ...validEnv(), JWT_ACCESS_SECRET: 'short' };
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/at least 32/);
  });

  it('rejects reusing one secret for both token classes', () => {
    const env = { ...validEnv(), JWT_REFRESH_SECRET: STRONG_A };
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/identical/);
  });

  it('generates a secret that passes its own checks', () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(96);
    const env = { ...validEnv(), JWT_ACCESS_SECRET: secret, JWT_REFRESH_SECRET: generateSecret() };
    expect(runStartupChecks({ env, strict: true }).ok).toBe(true);
  });
});

describe('deployment-shape checks', () => {
  it('fails production without CLIENT_ORIGIN, since CORS would block the client', () => {
    const env = validEnv();
    delete env.CLIENT_ORIGIN;
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/CLIENT_ORIGIN/);
  });

  it('warns (but does not fail) when transactional email is unconfigured', () => {
    const env = validEnv();
    delete env.BREVO_API_KEY;
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/BREVO_API_KEY/);
  });

  it('defaults production uploads to durable storage rather than the ephemeral disk', () => {
    // An unset STORAGE_DRIVER used to mean local disk, which on this host is
    // wiped on every deploy — attendance selfies vanished while the rows kept
    // pointing at them. Production now resolves to GridFS in the MongoDB this
    // service already runs, so nothing is lost by omission.
    const env = validEnv();
    delete env.ALLOW_EPHEMERAL_STORAGE;
    delete env.STORAGE_DRIVER;
    const result = runStartupChecks({ env, strict: true });
    expect(result.warnings.join(' ')).not.toMatch(/lost on redeploy/);
  });

  it('still warns when ephemeral storage is chosen deliberately', () => {
    const env = { ...validEnv(), STORAGE_DRIVER: 'local' };
    delete env.ALLOW_EPHEMERAL_STORAGE;
    const result = runStartupChecks({ env, strict: true });
    expect(result.warnings.join(' ')).toMatch(/lost on redeploy/);
  });

  it('REFUSES STORAGE_DRIVER=s3 — this project has no object-storage provider', () => {
    // The original code carried a non-functional s3:// branch that returned a
    // fabricated ref without uploading anything, and no S3 variables exist in
    // render.yaml or .env. Rather than re-implement a provider this project
    // does not use, the setting is refused outright — silently accepting it is
    // what destroyed uploads before.
    const env = { ...validEnv(), STORAGE_DRIVER: 's3' };
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not implemented in this project/);
  });

  it('accepts gridfs as durable storage with no ephemeral warning', () => {
    const env = { ...validEnv(), STORAGE_DRIVER: 'gridfs' };
    delete env.ALLOW_EPHEMERAL_STORAGE;
    const result = runStartupChecks({ env, strict: true });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).not.toMatch(/lost on redeploy/);
  });

  it('warns when clustering is on without a pinned scheduler worker', () => {
    const env = { ...validEnv(), ENABLE_CLUSTER: 'true' };
    const result = runStartupChecks({ env, strict: true });
    expect(result.warnings.join(' ')).toMatch(/SCHEDULER_WORKER_ID/);
  });

  it('is lenient outside production so local development still boots', () => {
    const result = runStartupChecks({
      env: { NODE_ENV: 'development', MONGODB_URI: 'mongodb://localhost/x', JWT_ACCESS_SECRET: 'dev-a', JWT_REFRESH_SECRET: 'dev-b' },
      strict: false,
    });
    expect(result.ok).toBe(true);
  });
});
