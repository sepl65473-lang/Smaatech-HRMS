import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';

/**
 * RECRUITMENT → OFFER → HIRE, through the real UI.
 *
 * Recruitment used to end at a "Hired" column: nothing turned the candidate
 * into an employee, so somebody re-typed their details into the employee form
 * and the link between the applicant and the person was lost — along with any
 * record of what they had been offered.
 *
 * What this drives: a candidate is created, an offer is issued and answered,
 * and the accepted offer becomes an employee record carrying the SAME salary,
 * joining date and department.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

const RUN = Date.now().toString().slice(-6);
const CANDIDATE = {
  name: `E2E Applicant ${RUN}`,
  title: 'Platform Engineer',
  email: `e2e.applicant.${RUN}@example.com`,
};
const OFFER = { salary: 140000, joiningDate: '2026-12-01' };

let candidateId = null;
let hiredEmployeeId = null;

async function openRecruitment(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /recruitment|hiring/i }).first().click();
  await expect(page.locator('.kanban-col').first()).toBeVisible({ timeout: 20_000 });
}

const offerDialog = (page) => page.locator('.modal[role="dialog"]');

test.describe('a candidate reaches the offer stage', () => {
  test('HR creates a candidate', async ({ page }) => {
    await openRecruitment(page, 'admin');
    const created = await apiAs(page, 'POST', '/recruitment', {
      title: CANDIDATE.title,
      candidate: CANDIDATE.name,
      stage: 'Interview',
      dept: 'Engineering',
      loc: 'Bengaluru',
    });
    expect(created.status).toBe(201);
    candidateId = created.body.id;
    expect(created.body.offer.status).toBe('draft');
  });

  test('an offer is issued through the real form', async ({ page }) => {
    await openRecruitment(page, 'admin');

    const card = page.locator('.kanban-card', { hasText: CANDIDATE.name });
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Move Interview -> Offer through the board.
    await card.getByRole('button', { name: 'Next' }).click();

    await page.locator('.kanban-card', { hasText: CANDIDATE.name })
      .getByRole('button', { name: 'Offer' }).click();

    const modal = offerDialog(page);
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await modal.locator('#offer-email').fill(CANDIDATE.email);
    await modal.locator('#offer-salary').fill(String(OFFER.salary));
    await modal.locator('#offer-joining').fill(OFFER.joiningDate);

    const issued = page.waitForResponse(
      (r) => r.url().includes(`/recruitment/${candidateId}/offer`) && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: /Record offer/i }).click();
    expect((await issued).status()).toBe(201);

    const candidates = await apiAs(page, 'GET', '/recruitment');
    const stored = candidates.body.find((c) => c.id === candidateId);
    expect(stored.offer.status).toBe('sent');
    expect(stored.offer.salary).toBe(OFFER.salary);
    expect(stored.offer.joiningDate).toBe(OFFER.joiningDate);
    expect(stored.email).toBe(CANDIDATE.email);
  });

  test('an offer cannot be forged through an ordinary PATCH', async ({ page }) => {
    await openRecruitment(page, 'admin');
    await apiAs(page, 'PATCH', `/recruitment/${candidateId}`, {
      offer: { status: 'accepted', salary: 9999999 },
      employeeId: '507f1f77bcf86cd799439011',
    });

    const candidates = await apiAs(page, 'GET', '/recruitment');
    const stored = candidates.body.find((c) => c.id === candidateId);
    expect(stored.offer.status).toBe('sent');
    expect(stored.offer.salary).toBe(OFFER.salary);
    expect(stored.employeeId).toBeFalsy();
  });

  test('hiring is refused while the offer is unanswered', async ({ page }) => {
    await openRecruitment(page, 'admin');
    const res = await apiAs(page, 'POST', `/recruitment/${candidateId}/hire`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OFFER_NOT_ACCEPTED');
  });
});

test.describe('acceptance and hiring', () => {
  test('the acceptance is recorded from the UI', async ({ page }) => {
    await openRecruitment(page, 'admin');
    await page.locator('.kanban-card', { hasText: CANDIDATE.name })
      .getByRole('button', { name: 'Offer' }).click();

    const modal = offerDialog(page);
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const answered = page.waitForResponse(
      (r) => r.url().includes(`/recruitment/${candidateId}/offer/response`), { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: /Candidate accepted/i }).click();
    expect((await answered).status()).toBe(200);

    const candidates = await apiAs(page, 'GET', '/recruitment');
    expect(candidates.body.find((c) => c.id === candidateId).offer.status).toBe('accepted');
  });

  test('the accepted offer becomes an employee record, from the UI', async ({ page }) => {
    await openRecruitment(page, 'admin');
    await page.locator('.kanban-card', { hasText: CANDIDATE.name })
      .getByRole('button', { name: /Offer|Hire/ }).click();

    const modal = offerDialog(page);
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const hired = page.waitForResponse(
      (r) => r.url().includes(`/recruitment/${candidateId}/hire`), { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: /Create employee record/i }).click();
    const response = await hired;
    expect(response.status()).toBe(201);

    const body = await response.json();
    hiredEmployeeId = body.employee.id;

    // The employee carries what was OFFERED — not something re-typed.
    expect(body.employee.name).toBe(CANDIDATE.name);
    expect(body.employee.role).toBe(CANDIDATE.title);
    expect(body.employee.salary).toBe(OFFER.salary);
    expect(body.employee.joinDate).toBe(OFFER.joiningDate);
    expect(body.employee.email).toBe(CANDIDATE.email);
    expect(body.employee.employmentStage).toBe('Probation');
    expect(body.employee.probationEndDate).toBeTruthy();
  });

  test('the new employee is in the directory and the candidate links to them', async ({ page }) => {
    await openRecruitment(page, 'admin');

    const employees = await apiAs(page, 'GET', '/employees');
    const hired = employees.body.find((e) => e.id === hiredEmployeeId);
    expect(hired).toBeTruthy();
    expect(hired.dept).toBe('Engineering');

    const candidates = await apiAs(page, 'GET', '/recruitment');
    const candidate = candidates.body.find((c) => c.id === candidateId);
    expect(candidate.stage).toBe('Hired');
    expect(candidate.employeeId).toBe(hiredEmployeeId);
  });

  test('the hire is on the employment history from day one', async ({ page }) => {
    await openRecruitment(page, 'admin');
    const events = await apiAs(page, 'GET', `/lifecycle/events?empId=${hiredEmployeeId}`);
    expect(events.status).toBe(200);
    const started = events.body.find((e) => e.type === 'probation-started');
    expect(started).toBeTruthy();
    expect(started.effectiveDate).toBe(OFFER.joiningDate);
    expect(started.note).toMatch(/Hired from recruitment/);
  });

  test('hiring twice returns the SAME employee, never a duplicate person', async ({ page }) => {
    await openRecruitment(page, 'admin');
    const again = await apiAs(page, 'POST', `/recruitment/${candidateId}/hire`);
    expect(again.status).toBe(200);
    expect(again.body.alreadyHired).toBe(true);
    expect(again.body.employee.id).toBe(hiredEmployeeId);

    const employees = await apiAs(page, 'GET', '/employees');
    expect(employees.body.filter((e) => e.name === CANDIDATE.name)).toHaveLength(1);
  });
});

test.describe('who may hire', () => {
  test('an ordinary employee can neither see candidates nor hire', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    // Candidate data is personal information about people who do not work here.
    const list = await apiAs(page, 'GET', '/recruitment');
    expect(list.body).toEqual([]);

    const res = await apiAs(page, 'POST', `/recruitment/${candidateId}/hire`);
    expect(res.status).toBe(403);
  });
});
