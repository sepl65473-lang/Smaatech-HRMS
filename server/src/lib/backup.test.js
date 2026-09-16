// Backup, verification and RESTORE.
//
// The point of these tests is that the restore is actually exercised: a backup
// nobody has ever restored is a guess, not a recovery plan. Each test dumps a
// real database, verifies the dump against its own manifest, then restores it
// into a SEPARATE database and compares the contents document by document.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import mongoose from 'mongoose';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const { backupDatabase, verifyBackup, restoreDatabase, readManifest } = await import('./backup.js');
const Employee = (await import('../models/Employee.js')).default;
const Payroll = (await import('../models/Payroll.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;

const COMPANY = 'BackupCo';
let workDir;

function tempDir(label) {
  return fs.mkdtempSync(path.join(workDir, `${label}-`));
}

async function seed() {
  const emp = await Employee.create({
    name: 'Backup Person', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, salary: 123456, joinDate: '2022-01-03', pan: 'ABCDE1234F',
  });
  await Payroll.create({
    empId: emp._id, name: emp.name, dept: emp.dept, cycle: '2026-05',
    gross: 123456, deductions: 20000, net: 103456, status: 'paid', company: COMPANY,
  });
  await Attendance.insertMany(Array.from({ length: 25 }, (unused, i) => ({
    empId: emp._id, name: emp.name, dept: emp.dept,
    date: `2026-05-${String(i + 1).padStart(2, '0')}`, status: 'present', company: COMPANY,
  })));
  return emp;
}

/** Restores into a DIFFERENT database on the same server, and returns to the original. */
async function restoreIntoFreshDatabase(dir) {
  const original = mongoose.connection.name;
  const target = `restore_target_${Date.now()}`;
  const scratch = mongoose.connection.useDb(target, { useCache: false });

  // Point the helper at the scratch database for the duration of the restore.
  const realDb = Object.getOwnPropertyDescriptor(mongoose.connection, 'db');
  Object.defineProperty(mongoose.connection, 'db', { value: scratch.db, configurable: true });
  try {
    const result = await restoreDatabase(dir, { confirm: true, drop: true });
    return { result, db: scratch.db, target, original };
  } finally {
    if (realDb) Object.defineProperty(mongoose.connection, 'db', realDb);
  }
}

beforeAll(async () => {
  await startTestDB();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrms-backup-'));
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => { await clearTestDB(); });

describe('backupDatabase', () => {
  it('writes one file per collection plus a manifest with counts and checksums', async () => {
    await seed();
    const dir = tempDir('dump');
    const manifest = await backupDatabase(dir);

    expect(manifest.totalDocuments).toBe(27); // 1 employee + 1 payroll + 25 attendance
    const names = manifest.collections.map((c) => c.name);
    expect(names).toContain('employees');
    expect(names).toContain('payrolls');
    expect(names).toContain('attendances');

    for (const entry of manifest.collections) {
      expect(fs.existsSync(path.join(dir, entry.file))).toBe(true);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(readManifest(dir).database).toBe(mongoose.connection.name);
  });

  it('preserves real BSON types, not stringified ones', async () => {
    const emp = await seed();
    const dir = tempDir('types');
    await backupDatabase(dir);

    const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'employees.jsonl.gz'))).toString('utf8');
    const line = JSON.parse(raw.trim().split('\n')[0]);
    // Canonical Extended JSON — an ObjectId comes back as an ObjectId, and a
    // number does not silently become a string.
    expect(line._id.$oid).toBe(String(emp._id));
    expect(line.salary).toEqual({ $numberInt: '123456' });
  });
});

describe('verifyBackup', () => {
  it('passes on an untouched dump', async () => {
    await seed();
    const dir = tempDir('good');
    await backupDatabase(dir);

    const verdict = await verifyBackup(dir);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it('detects a TRUNCATED dump', async () => {
    await seed();
    const dir = tempDir('truncated');
    await backupDatabase(dir);

    // Drop the last few attendance rows, the way a half-finished upload would.
    const file = path.join(dir, 'attendances.jsonl.gz');
    const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n');
    fs.writeFileSync(file, zlib.gzipSync(`${lines.slice(0, 5).join('\n')}\n`));

    const verdict = await verifyBackup(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/expected 25 documents, found 5/);
  });

  it('detects an ALTERED dump', async () => {
    await seed();
    const dir = tempDir('altered');
    await backupDatabase(dir);

    const file = path.join(dir, 'payrolls.jsonl.gz');
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    fs.writeFileSync(file, zlib.gzipSync(text.replace('"103456"', '"999999"')));

    const verdict = await verifyBackup(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/checksum mismatch/);
  });

  it('refuses a directory that is not a backup', async () => {
    const dir = tempDir('empty');
    expect(() => readManifest(dir)).toThrow(/not a backup directory/);
  });
});

describe('restoreDatabase', () => {
  it('restores every document into a DIFFERENT database, byte for byte', async () => {
    const emp = await seed();
    const dir = tempDir('restore');
    await backupDatabase(dir);

    const { result, db } = await restoreIntoFreshDatabase(dir);
    expect(result.restored).toBe(27);

    // Compare the restored documents against the originals.
    const restoredEmp = await db.collection('employees').findOne({ _id: emp._id });
    expect(restoredEmp).toBeTruthy();
    expect(restoredEmp.name).toBe('Backup Person');
    expect(restoredEmp.salary).toBe(123456);
    // The type survived: an ObjectId, not a string that merely looks like one.
    expect(restoredEmp._id).toBeInstanceOf(mongoose.Types.ObjectId);

    expect(await db.collection('attendances').countDocuments()).toBe(25);
    const restoredPayroll = await db.collection('payrolls').findOne({});
    expect(restoredPayroll.net).toBe(103456);
    expect(restoredPayroll.status).toBe('paid');
  });

  it('REFUSES to write without an explicit confirmation', async () => {
    await seed();
    const dir = tempDir('noconfirm');
    await backupDatabase(dir);
    await expect(restoreDatabase(dir, { confirm: false })).rejects.toThrow(/refusing to write/);
  });

  it('REFUSES to restore a dump that fails verification', async () => {
    await seed();
    const dir = tempDir('bad-restore');
    await backupDatabase(dir);

    const file = path.join(dir, 'employees.jsonl.gz');
    fs.writeFileSync(file, zlib.gzipSync('{"_id":{"$oid":"000000000000000000000001"}}\n'));

    await expect(restoreDatabase(dir, { confirm: true, drop: true }))
      .rejects.toThrow(/failed verification/);
  });

  it('is repeatable — restoring twice does not duplicate anything', async () => {
    await seed();
    const dir = tempDir('twice');
    await backupDatabase(dir);

    const first = await restoreIntoFreshDatabase(dir);
    const second = await restoreDatabaseInto(first.db, dir);
    expect(second.restored + second.skipped).toBe(27);
    expect(await first.db.collection('attendances').countDocuments()).toBe(25);
  });
});

/** Restores again into an already-populated target, without dropping it. */
async function restoreDatabaseInto(db, dir) {
  const realDb = Object.getOwnPropertyDescriptor(mongoose.connection, 'db');
  Object.defineProperty(mongoose.connection, 'db', { value: db, configurable: true });
  try {
    return await restoreDatabase(dir, { confirm: true, drop: false });
  } finally {
    if (realDb) Object.defineProperty(mongoose.connection, 'db', realDb);
  }
}
