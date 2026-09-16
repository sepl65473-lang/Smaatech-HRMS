import fs from 'node:fs';
import path from 'node:path';
import { backupDatabase, verifyBackup, readManifest } from './backup.js';
import logger from './logger.js';

/**
 * The scheduled backup: take it, verify it, prune old ones, record the outcome.
 *
 * WHAT THIS IS HONESTLY WORTH. A backup written to the same host that runs the
 * application protects against the failure people actually hit most often — a
 * bad migration, a mistaken bulk update, a dropped collection — and against
 * nothing else. It is NOT disaster recovery: if the host or the provider is
 * lost, so is the backup. Getting a copy off the host needs a destination this
 * codebase cannot invent (an object store, another server, a managed backup
 * service), so the job is deliberately opt-in via BACKUP_DIR and says what it
 * is in its own status record rather than implying more.
 *
 * On Render's default filesystem this means the schedule is only useful when
 * BACKUP_DIR points at a persistent disk. Left unset, the job does not run and
 * says so at startup, instead of writing to a directory that disappears.
 */

const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 14);
const BACKUP_DIR = process.env.BACKUP_DIR || '';

export function backupDestination() {
  return BACKUP_DIR;
}

export function isScheduledBackupConfigured() {
  return Boolean(BACKUP_DIR);
}

/** Directory name for one run: sorts chronologically and is filesystem-safe. */
function runDirName(now = new Date()) {
  return now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/**
 * Removes runs older than the retention window.
 *
 * Deliberately refuses to delete the ONLY backup, whatever its age: an expired
 * last copy is still better than none, and a clock problem must not be able to
 * empty the whole directory.
 */
export function pruneOldBackups(root, { retentionDays = RETENTION_DAYS, now = Date.now() } = {}) {
  if (!fs.existsSync(root)) return { kept: 0, removed: [] };

  const runs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      let takenAt = null;
      try {
        takenAt = Date.parse(readManifest(dir).createdAt);
      } catch {
        takenAt = null; // not a backup directory, or an unfinished one
      }
      return { name: entry.name, dir, takenAt };
    })
    .filter((run) => run.takenAt !== null)
    .sort((a, b) => b.takenAt - a.takenAt);

  const cutoff = now - retentionDays * 86400000;
  const removed = [];

  // index 0 is the newest and is never a candidate.
  for (const run of runs.slice(1)) {
    if (run.takenAt >= cutoff) continue;
    fs.rmSync(run.dir, { recursive: true, force: true });
    removed.push(run.name);
  }

  return { kept: runs.length - removed.length, removed };
}

/** The most recent run's outcome, for the health endpoint. */
let lastRun = null;

export function lastBackupStatus() {
  const configured = isScheduledBackupConfigured();
  return {
    configured,
    destination: BACKUP_DIR || null,
    retentionDays: RETENTION_DAYS,
    // Always reported, even when the schedule is off: a backup taken by hand
    // still answers "when was the last one, and did it work?", which is the
    // question this exists for.
    lastRun,
    ...(configured
      ? {}
      : { note: 'Scheduled backups are off. Set BACKUP_DIR to a persistent path to enable them.' }),
  };
}

/**
 * Runs one scheduled backup. Never throws: a failed backup must be recorded
 * and alerted on, not crash the process that is serving the application.
 */
export async function runScheduledBackup({ root = BACKUP_DIR, now = new Date() } = {}) {
  if (!root) {
    return { skipped: true, reason: 'BACKUP_DIR is not set' };
  }

  const started = Date.now();
  const dir = path.join(root, runDirName(now));

  try {
    const manifest = await backupDatabase(dir);
    const verdict = await verifyBackup(dir);

    if (!verdict.ok) {
      // A dump that does not verify is worse than none, because it looks like
      // protection. Remove it and treat the run as failed.
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`backup failed verification: ${verdict.problems.join('; ')}`);
    }

    const pruned = pruneOldBackups(root, { now: now.getTime() });

    lastRun = {
      ok: true,
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      directory: dir,
      documents: manifest.totalDocuments,
      collections: manifest.collections.length,
      prunedRuns: pruned.removed,
      retainedRuns: pruned.kept,
    };
    logger.info('[backup] %d documents across %d collections verified into %s (%d old run(s) pruned)',
      manifest.totalDocuments, manifest.collections.length, dir, pruned.removed.length);
    return lastRun;
  } catch (err) {
    lastRun = {
      ok: false,
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      directory: dir,
      error: err.message,
    };
    // Loud, because a silent backup failure is discovered at the worst moment.
    logger.error('[backup] SCHEDULED BACKUP FAILED: %s', err.message);
    return lastRun;
  }
}
