// The 24-hour attendance photo cleanup is registered with the scheduler, every
// fifteen minutes, pointing at the real job.
import { describe, it, expect, vi } from 'vitest';

const registered = vi.hoisted(() => []);
vi.mock('./scheduler.js', () => ({
  isSchedulerOwner: () => true,
  registeredJobs: () => registered.map((job) => job.name),
  scheduleJob: (name, expression, task) => { registered.push({ name, expression, task }); },
}));

const { startSchedulers } = await import('./jobs.js');
const { purgeExpiredAttendancePhotos } = await import('./attendancePhotoExpiry.js');

describe('scheduler registration', () => {
  it('runs purgeExpiredAttendancePhotos every 15 minutes, once', () => {
    vi.useFakeTimers(); // the boot-time attendance-row run is not under test here
    try {
      startSchedulers();
    } finally {
      vi.useRealTimers();
    }
    const jobs = registered.filter((job) => job.name === 'attendance:purge-expired-photos');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].expression).toBe('*/15 * * * *');
    expect(jobs[0].task).toBe(purgeExpiredAttendancePhotos);
    // The jobs that were already scheduled are still scheduled.
    for (const name of ['attendance:create-daily-rows', 'attendance:same-day-reminders', 'documents:expiry-reminders', 'notifications:retry-failed']) {
      expect(registered.some((job) => job.name === name), name).toBe(true);
    }
  });
});
