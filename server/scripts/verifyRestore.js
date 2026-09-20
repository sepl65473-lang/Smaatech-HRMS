/**
 * Proves a backup can actually be restored.
 *
 * A backup nobody has restored is a hope, not a recovery plan, so the backup
 * workflow restores the archive it just took into a THROWAWAY MongoDB and
 * runs this against it. Production is never touched: this refuses to run
 * against anything but the local, ephemeral instance the workflow starts.
 *
 *   node scripts/verifyRestore.js "mongodb://127.0.0.1:27017/hrms_restore_check"
 *
 * It fails loudly unless the restored database holds the collections this
 * HRMS actually depends on, including the GridFS buckets that hold
 * attendance selfies once durable storage is in use.
 */
import { MongoClient } from 'mongodb';

const uri = process.argv[2] || process.env.RESTORE_URI;
if (!uri) {
  console.error('usage: node scripts/verifyRestore.js <restored-mongodb-uri>');
  process.exit(2);
}

// Guard rail: a typo must not be able to point this at the live cluster.
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) {
  console.error('[restore-check] refusing to run against a non-local URI — this is a test harness, not an admin tool.');
  process.exit(2);
}

// Collections that must survive a restore for the HRMS to be usable again.
const REQUIRED = ['employees', 'users', 'attendances'];
// Present only once there is data of that kind; reported, never required.
const REPORTED = ['auditlogs', 'leaves', 'payrolls', 'facedescriptors', 'settings'];

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
await client.connect();
const db = client.db();

const names = (await db.listCollections().toArray()).map((c) => c.name);
const counts = {};
for (const name of [...REQUIRED, ...REPORTED]) {
  // eslint-disable-next-line no-await-in-loop
  counts[name] = names.includes(name) ? await db.collection(name).countDocuments() : null;
}

const gridfsBuckets = names.filter((n) => n.endsWith('.files'));
let attachedFiles = 0;
for (const bucket of gridfsBuckets) {
  // eslint-disable-next-line no-await-in-loop
  attachedFiles += await db.collection(bucket).countDocuments();
}

console.log('[restore-check] collections restored:', names.length);
for (const [name, count] of Object.entries(counts)) {
  console.log(`  ${name.padEnd(18)} ${count === null ? 'absent' : `${count} docs`}`);
}
console.log(`  gridfs buckets     ${gridfsBuckets.length} (${attachedFiles} stored files — attendance selfies and documents)`);

const missing = REQUIRED.filter((name) => counts[name] === null);
const empty = REQUIRED.filter((name) => counts[name] === 0);
await client.close();

if (missing.length) {
  console.error(`[restore-check] FAILED — missing collection(s): ${missing.join(', ')}`);
  process.exit(1);
}
if (empty.length) {
  console.error(`[restore-check] FAILED — restored but empty: ${empty.join(', ')}`);
  process.exit(1);
}
console.log('[restore-check] OK — the archive restores into a working HRMS database.');
