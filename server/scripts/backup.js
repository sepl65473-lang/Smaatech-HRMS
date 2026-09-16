#!/usr/bin/env node
/**
 * Operator CLI for database backup, verification and restore.
 *
 *   npm --prefix server run backup -- --out ./backups/2026-09-14
 *   npm --prefix server run backup:verify -- --in ./backups/2026-09-14
 *   npm --prefix server run backup:restore -- --in ./backups/2026-09-14 \
 *       --uri "mongodb+srv://.../restore_drill" --confirm --drop
 *
 * Restore deliberately takes its OWN --uri and refuses to reuse MONGODB_URI:
 * the common way to destroy production during a drill is to restore over the
 * live database because the target defaulted to it. Naming the target is the
 * operator's decision, every time.
 */
import 'dotenv/config';
import path from 'node:path';
import mongoose from 'mongoose';
import { backupDatabase, verifyBackup, restoreDatabase, readManifest } from '../src/lib/backup.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const has = (name) => process.argv.includes(`--${name}`);

async function connect(uri) {
  if (!uri) throw new Error('No MongoDB URI. Set MONGODB_URI or pass --uri.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection;
}

async function main() {
  const mode = process.argv[2];

  if (mode === 'verify') {
    const dir = path.resolve(String(arg('in') || ''));
    const verdict = await verifyBackup(dir);
    const manifest = readManifest(dir);
    console.log(`Backup of "${manifest.database}" taken ${manifest.createdAt}`);
    for (const c of verdict.collections) {
      console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(28)} ${String(c.count).padStart(8)} docs`);
    }
    if (!verdict.ok) {
      console.error('\nPROBLEMS:');
      for (const problem of verdict.problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nVerified: ${manifest.totalDocuments} documents across ${verdict.collections.length} collections.`);
    return;
  }

  if (mode === 'restore') {
    const dir = path.resolve(String(arg('in') || ''));
    const uri = arg('uri');
    if (uri === true || !uri) {
      throw new Error('Restore needs an explicit --uri naming the TARGET database. It is never taken from MONGODB_URI.');
    }
    if (uri === process.env.MONGODB_URI && !has('force-same-target')) {
      throw new Error('Refusing to restore over the database in MONGODB_URI. Pass --force-same-target if that is genuinely what you want.');
    }
    if (!has('confirm')) {
      throw new Error('Restore overwrites data. Re-run with --confirm once you are sure of the target.');
    }

    await connect(uri);
    console.log(`Restoring "${dir}" into "${mongoose.connection.name}"${has('drop') ? ' (dropping existing documents)' : ''}…`);
    const result = await restoreDatabase(dir, { confirm: true, drop: has('drop') });
    for (const c of result.collections) {
      console.log(`  ${c.name.padEnd(28)} ${String(c.inserted).padStart(8)} restored${c.skipped ? `, ${c.skipped} already present` : ''}`);
    }
    console.log(`\nRestored ${result.restored} documents into ${result.database}.`);
    return;
  }

  // Default: take a backup.
  const out = path.resolve(String(arg('out') || `./backups/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`));
  await connect(arg('uri') === true ? null : (arg('uri') || process.env.MONGODB_URI));
  console.log(`Backing up "${mongoose.connection.name}" to ${out} …`);
  const manifest = await backupDatabase(out);
  for (const c of manifest.collections) {
    console.log(`  ${c.name.padEnd(28)} ${String(c.count).padStart(8)} docs`);
  }
  console.log(`\nWrote ${manifest.totalDocuments} documents across ${manifest.collections.length} collections.`);

  // A backup is only worth something if it verifies, so never hand back one
  // that has not been checked.
  const verdict = await verifyBackup(out);
  if (!verdict.ok) {
    console.error('\nTHIS BACKUP DID NOT VERIFY:');
    for (const problem of verdict.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('Verified against its own manifest.');
}

main()
  .catch((err) => {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  });
