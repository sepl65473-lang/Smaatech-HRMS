import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const SERVER_DIR = path.join(REPO_ROOT, 'server');

export const API_PORT = 4700;
export const WEB_PORT = 5199;
// Deliberately 'localhost', matching the web origin below.
//
// 'localhost' and '127.0.0.1' are DIFFERENT SITES to a browser, so mixing them
// makes the refresh cookie (sameSite: 'lax' outside production) ineligible on
// cross-site fetches and silently breaks session restore on reload. Production
// is genuinely cross-site (Vercel + Render) and correctly uses
// sameSite: 'none' + secure — see server/src/lib/tokens.js.
export const API_BASE = `http://localhost:${API_PORT}`;
export const WEB_BASE = `http://localhost:${WEB_PORT}`;

export const E2E_SECRET = 'e2e-isolated-test-secret-value-0123456789';
export const COMPANY = 'E2ECo';
export const PASSWORD = 'E2ETestPass123';

/**
 * The E2E accounts. Every one is a REAL account in the isolated database with
 * a real password hash and, where relevant, a real enrolled face template —
 * nothing about authorization is stubbed. Only the OTP delivery step and the
 * camera capture are substituted, and only because a headless browser has
 * neither an inbox nor a camera.
 */
export const USERS = {
  admin: { email: 'e2e.admin@example.com', role: 'HR Director', name: 'E2E Admin' },
  hr: { email: 'e2e.hr@example.com', role: 'HR Manager', name: 'E2E HR' },
  manager: { email: 'e2e.manager@example.com', role: 'Employee', name: 'E2E Manager' },
  employee: { email: 'e2e.employee@example.com', role: 'Employee', name: 'E2E Employee' },
  // A second ordinary employee, also reporting to the manager. The first one
  // is exited by the offboarding spec, so anything that needs a LIVE
  // employee-with-a-manager after that point uses this account.
  reportee: { email: 'e2e.reportee@example.com', role: 'Employee', name: 'E2E Reportee' },
  finance: { email: 'e2e.finance@example.com', role: 'Finance Lead', name: 'E2E Finance' },
};

export function waitForHttp(url, timeoutMs = 120000, { expectOk = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (!expectOk || res.ok) return true;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Timed out waiting for ${url}`);
  })();
}

export function spawnProcess(command, args, options = {}) {
  const { label, shell, ...rest } = options;
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Only npm needs a shell on Windows. Using one for node itself breaks on
    // the default install path — cmd splits "C:\Program Files\nodejs\node.exe"
    // at the space and reports 'C:\Program' is not recognized.
    shell: shell ?? false,
    ...rest,
  });
  child.stdout.on('data', (d) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${label || 'proc'}] ${d}`);
  });
  child.stderr.on('data', (d) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[${label || 'proc'}] ${d}`);
  });
  return child;
}
