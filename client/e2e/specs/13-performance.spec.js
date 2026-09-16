import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * PERFORMANCE REVIEWS, end to end.
 *
 * The module had two defects that a passing build would never have shown:
 * every rating and comment was stripped by a PATCH allow-list naming fields
 * the schema does not have — while the UI said "submitted" — and the employee's
 * own reporting manager could not write a manager review at all.
 *
 * So these assertions are about what SURVIVES the round trip, and about who is
 * allowed to write which half of a review.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

const CYCLE = `E2E Cycle ${Date.now().toString().slice(-6)}`;

let reviewId = null;
let subjectEmpId = null;

async function signIn(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
}

test.describe('HR starts a cycle', () => {
  test('a review is created for an employee, empty', async ({ page }) => {
    await signIn(page, 'admin');

    const employees = await apiAs(page, 'GET', '/employees');
    // The manager's own report — so the reporting-manager path can be driven.
    // The reportee, not the employee: the offboarding spec exits the employee
    // before this one runs, and an exited person cannot sign in to write a
    // self review.
    const subject = employees.body.find((e) => e.name === USERS.reportee.name);
    expect(subject, 'the seeded tenant should have a live employee with a manager').toBeTruthy();
    subjectEmpId = subject.id;

    const created = await apiAs(page, 'POST', '/reviews', {
      cycleName: CYCLE, empId: subjectEmpId, name: subject.name, dept: subject.dept,
      // Deliberately trying to pre-fill: a review must start empty.
      selfRating: 5, managerRating: 5, status: 'completed',
    });
    expect(created.status).toBe(201);
    reviewId = created.body.id;
    expect(created.body.selfRating).toBeNull();
    expect(created.body.managerRating).toBeNull();
    expect(created.body.status).toBe('pending');
  });

  test('starting the same cycle twice does not duplicate the review', async ({ page }) => {
    await signIn(page, 'admin');
    const again = await apiAs(page, 'POST', '/reviews', {
      cycleName: CYCLE, empId: subjectEmpId, name: 'x',
    });
    expect(again.status).toBe(409);

    const all = await apiAs(page, 'GET', `/reviews?cycleName=${encodeURIComponent(CYCLE)}`);
    expect(all.body.filter((r) => r.empId === subjectEmpId)).toHaveLength(1);
  });
});

test.describe('the employee writes their own half', () => {
  test('the self rating and comments SURVIVE the round trip', async ({ page }) => {
    await signIn(page, 'reportee');

    const res = await apiAs(page, 'PATCH', `/reviews/${reviewId}`, {
      selfRating: 4, selfComments: 'Delivered the attendance rewrite.',
    });
    expect(res.status).toBe(200);

    // This is the defect: they used to be silently stripped.
    const readBack = await apiAs(page, 'GET', `/reviews/${reviewId}`);
    expect(readBack.body.selfRating).toBe(4);
    expect(readBack.body.selfComments).toBe('Delivered the attendance rewrite.');
    expect(readBack.body.status).toBe('self-submitted');
  });

  test('an employee cannot write their own manager rating', async ({ page }) => {
    await signIn(page, 'reportee');
    const res = await apiAs(page, 'PATCH', `/reviews/${reviewId}`, {
      managerRating: 5, managerComments: 'Outstanding, obviously',
    });
    expect(res.status).toBe(403);

    const readBack = await apiAs(page, 'GET', `/reviews/${reviewId}`);
    expect(readBack.body.managerRating).toBeNull();
  });

  test('an employee cannot mark their own review completed', async ({ page }) => {
    await signIn(page, 'reportee');
    const res = await apiAs(page, 'PATCH', `/reviews/${reviewId}`, { status: 'completed' });
    expect(res.status).toBe(400);
  });
});

test.describe('the reporting manager writes the other half', () => {
  test('a manager sees their team review and completes it', async ({ page }) => {
    await signIn(page, 'manager');

    // Visible to them at all — it is their direct report's.
    const list = await apiAs(page, 'GET', '/reviews');
    expect(list.body.some((r) => r.id === reviewId)).toBe(true);

    const res = await apiAs(page, 'PATCH', `/reviews/${reviewId}`, {
      managerRating: 5, managerComments: 'Agreed — took on the hardest part of it.',
    });
    expect(res.status).toBe(200);
    expect(res.body.managerRating).toBe(5);
    expect(res.body.status).toBe('completed');
    // The self review is untouched by the manager's submission.
    expect(res.body.selfRating).toBe(4);
  });

  test('the appraisal rating reaches the employee record', async ({ page }) => {
    await signIn(page, 'admin');
    const employees = await apiAs(page, 'GET', '/employees');
    // The client used to do this with a second, privileged call that a manager
    // is refused — so the rating never landed.
    expect(employees.body.find((e) => e.id === subjectEmpId).rating).toBe(5);
  });

  test('a rating outside the scale is refused', async ({ page }) => {
    await signIn(page, 'admin');
    for (const managerRating of [0, 6, -2]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await apiAs(page, 'PATCH', `/reviews/${reviewId}`, { managerRating });
      expect(res.status, `accepted ${managerRating}`).toBe(400);
    }
  });
});

test.describe('review privacy', () => {
  test('one employee cannot read another review, even by id', async ({ page }) => {
    await signIn(page, 'admin');
    const employees = await apiAs(page, 'GET', '/employees');
    const other = employees.body.find((e) => (
      e.id !== subjectEmpId && e.name !== USERS.manager.name && e.status !== 'exited'
    ));
    const otherReview = await apiAs(page, 'POST', '/reviews', {
      cycleName: CYCLE, empId: other.id, name: other.name, dept: other.dept,
    });
    expect(otherReview.status).toBe(201);

    await signIn(page, 'reportee');
    const direct = await apiAs(page, 'GET', `/reviews/${otherReview.body.id}`);
    expect(direct.status).toBe(403);

    const list = await apiAs(page, 'GET', '/reviews');
    expect(list.body.every((r) => r.empId === subjectEmpId)).toBe(true);
  });

  test('an employee cannot start a review cycle', async ({ page }) => {
    await signIn(page, 'reportee');
    const res = await apiAs(page, 'POST', '/reviews', {
      cycleName: 'Self-serve cycle', empId: subjectEmpId, name: 'x',
    });
    expect(res.status).toBe(403);
  });
});
