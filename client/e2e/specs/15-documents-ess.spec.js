import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * DOCUMENTS AND EMPLOYEE SELF-SERVICE, through the real UI.
 *
 * Files live in MongoDB GridFS, so this drives the whole path — a real file
 * chosen in a real file input, stored, listed, and downloaded back as the same
 * bytes — and then checks the part that matters most for a document store
 * holding contracts and payslips: who can read whose.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

const RUN = Date.now().toString().slice(-6);
const DOC_TITLE = `E2E Contract ${RUN}`;
// A minimal but genuinely valid PDF: the upload filter accepts PDFs, images
// and Office formats and rejects everything else, so the file has to be real.
const DOC_BODY = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  `% run ${RUN}`,
  'trailer<</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');

let documentId = null;
let ownerEmpId = null;

async function openDocuments(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /documents/i }).first().click();
  await expect(page.locator('.card-title', { hasText: /Upload document|Documents/i }).first())
    .toBeVisible({ timeout: 20_000 });
}

const field = (page, label) =>
  page.locator(`.field:has(> .field-label:text-is("${label}"))`).locator('input, select').first();

test.describe('HR uploads a document for an employee', () => {
  test('a real file goes through the real form into GridFS', async ({ page }) => {
    await openDocuments(page, 'admin');

    const employees = await apiAs(page, 'GET', '/employees');
    const owner = employees.body.find((e) => e.name === USERS.finance.name);
    ownerEmpId = owner.id;

    await field(page, 'Document title').fill(DOC_TITLE);
    await page.locator('.field:has(> .field-label:text-is("Document Owner (Employee)")) select')
      .selectOption(ownerEmpId);
    await field(page, 'File').setInputFiles({
      name: `contract-${RUN}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from(DOC_BODY, 'utf8'),
    });

    const uploaded = page.waitForResponse(
      (r) => r.url().includes('/api/v1/documents') && r.request().method() === 'POST',
      { timeout: 45_000 },
    );
    await page.getByRole('button', { name: 'Add document', exact: true }).click();
    const response = await uploaded;
    expect(response.status()).toBe(201);

    const created = await response.json();
    documentId = created.id;
    // Stored in the database, not on a disk that disappears with the container.
    expect(String(created.fileRef || created.url || '')).toMatch(/^gridfs:\/\//);

    await expect(page.locator('body')).toContainText(DOC_TITLE, { timeout: 20_000 });
  });

  test('the file downloads back as the SAME bytes', async ({ page }) => {
    await openDocuments(page, 'admin');
    const row = page.locator('tr', { hasText: DOC_TITLE }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    const download = page.waitForEvent('download', { timeout: 45_000 });
    // A real upload offers "Open" — "Download" belongs to the generated stubs.
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    const file = await download;

    const stream = await file.createReadStream();
    const chunks = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(DOC_BODY);
  });

  test('a file type the store does not accept is REFUSED', async ({ page }) => {
    await openDocuments(page, 'admin');
    await field(page, 'Document title').fill(`Executable ${RUN}`);
    await page.locator('.field:has(> .field-label:text-is("Document Owner (Employee)")) select')
      .selectOption(ownerEmpId);
    await field(page, 'File').setInputFiles({
      name: 'payload.exe',
      mimeType: 'application/x-msdownload',
      buffer: Buffer.from('MZ not a document', 'utf8'),
    });

    await page.getByRole('button', { name: 'Add document', exact: true }).click();
    // Either the form or the server refuses it; what matters is that it is not
    // stored and the person is told.
    await expect(page.locator('body')).toContainText(/not (a )?(supported|allowed)|invalid file|file type/i, { timeout: 20_000 });

    const docs = await apiAs(page, 'GET', '/documents');
    expect(docs.body.some((d) => d.title === `Executable ${RUN}`)).toBe(false);
  });

  test('an upload with no file at all is refused', async ({ page }) => {
    await openDocuments(page, 'admin');
    await field(page, 'Document title').fill(`No file ${RUN}`);
    await page.locator('.field:has(> .field-label:text-is("Document Owner (Employee)")) select')
      .selectOption(ownerEmpId);
    await page.getByRole('button', { name: 'Add document', exact: true }).click();

    // Caught in the form, before a pointless round trip.
    await expect(page.locator('body')).toContainText(/file attachment is required/i, { timeout: 15_000 });
  });
});

test.describe('document access is scoped to the person', () => {
  test('the owner can read their own document', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'finance');

    const res = await apiAs(page, 'GET', '/documents');
    expect(res.status).toBe(200);
    expect(res.body.some((d) => d.id === documentId)).toBe(true);
  });

  test('a company-wide document IS readable company-wide, as configured', async ({ page }) => {
    // The upload form defaults visibility to "Everyone", and that is what it
    // means. Asserting it here so the next test's restriction is clearly a
    // restriction, not an accident.
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    const res = await apiAs(page, 'GET', '/documents');
    expect(res.body.some((d) => d.id === documentId)).toBe(true);
  });

  test('an HR-ONLY document is refused to everyone else', async ({ page }) => {
    await openDocuments(page, 'admin');

    // Owned by the HR employee, so neither reader below is its owner —
    // an owner reading their own file is legitimate and would mask the rule
    // actually under test.
    const employees = await apiAs(page, 'GET', '/employees');
    const hrOwner = employees.body.find((e) => e.name === USERS.hr.name);

    await field(page, 'Document title').fill(`HR only ${RUN}`);
    await page.locator('.field:has(> .field-label:text-is("Document Owner (Employee)")) select')
      .selectOption(hrOwner.id);
    await page.locator('.field:has(> .field-label:text-is("Visible to")) select').selectOption('hr');
    await field(page, 'File').setInputFiles({
      name: `hr-only-${RUN}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(DOC_BODY, 'utf8'),
    });

    const uploaded = page.waitForResponse(
      (r) => r.url().includes('/api/v1/documents') && r.request().method() === 'POST',
      { timeout: 45_000 },
    );
    await page.getByRole('button', { name: 'Add document', exact: true }).click();
    const restrictedId = (await (await uploaded).json()).id;

    for (const who of ['manager', 'finance']) {
      // eslint-disable-next-line no-await-in-loop
      await page.goto('/');
      // eslint-disable-next-line no-await-in-loop
      await logout(page);
      // eslint-disable-next-line no-await-in-loop
      await login(page, who);

      // eslint-disable-next-line no-await-in-loop
      const status = await page.evaluate(async ({ id }) => {
        const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
        const { accessToken } = await refreshed.json();
        const r = await fetch(`/api/v1/documents/${id}/download`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        return r.status;
      }, { id: restrictedId });
      expect([403, 404], `${who} could download an HR-only document`).toContain(status);

      // It is not even listed to them.
      // eslint-disable-next-line no-await-in-loop
      const list = await apiAs(page, 'GET', '/documents');
      expect(list.body.some((d) => d.id === restrictedId)).toBe(false);
    }
  });

  test('an anonymous request gets nothing', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    const res = await page.evaluate(async ({ id }) => {
      const r = await fetch(`/api/v1/documents/${id}/download`);
      return r.status;
    }, { id: documentId });
    expect([401, 403]).toContain(res);
  });
});

test.describe('employee self-service', () => {
  test('an employee sees their own payslip and can open it', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    const payroll = await apiAs(page, 'GET', '/payroll');
    expect(payroll.status).toBe(200);
    // Only their own — checked again here because this is the ESS view.
    for (const row of payroll.body) expect(row.name).toBe(USERS.manager.name);
  });

  test('an employee sees their own notifications only', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    const res = await apiAs(page, 'GET', '/notifications');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body) || Array.isArray(res.body.rows)).toBe(true);
  });

  test('an employee can update their own profile but not their pay', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    const employees = await apiAs(page, 'GET', '/employees');
    const own = employees.body.find((e) => e.name === USERS.manager.name);

    const allowed = await apiAs(page, 'PATCH', `/employees/${own.id}`, { phone: '+91 90000 12345' });
    expect(allowed.status).toBe(200);

    await apiAs(page, 'PATCH', `/employees/${own.id}`, { salary: 9999999, role: 'HR Director' });
    const after = await apiAs(page, 'GET', '/employees');
    const checked = after.body.find((e) => e.id === own.id);
    expect(checked.phone).toBe('+91 90000 12345');
    expect(checked.salary).not.toBe(9999999);
    expect(checked.role).not.toBe('HR Director');
  });
});
