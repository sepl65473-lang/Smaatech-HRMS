import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';

/**
 * Logical backup and restore for the HRMS database.
 *
 * Deliberately built on the Mongo driver rather than `mongodump`: Render's
 * runtime has no MongoDB tooling installed, so a backup procedure that shells
 * out to mongodump is a procedure that does not run where it is needed. This
 * works anywhere Node and a connection string are available — a scheduled job,
 * a laptop, CI.
 *
 * Format: one gzipped JSON-Lines file per collection, plus a manifest holding
 * each file's document count and SHA-256. The manifest is what makes a restore
 * verifiable rather than hopeful: a truncated or altered dump is detected
 * BEFORE anything is written to the target database.
 *
 * Extended JSON (relaxed: false) is used so ObjectIds, Dates and Decimals
 * survive the round trip as their real types instead of degrading to strings.
 */

const MANIFEST = 'manifest.json';

function toExtendedJson(doc) {
  return mongoose.mongo.BSON.EJSON.stringify(doc, { relaxed: false });
}

function fromExtendedJson(line) {
  return mongoose.mongo.BSON.EJSON.parse(line, { relaxed: false });
}

/** Collections that are pure derived/ephemeral state and need no backup. */
const SKIP_COLLECTIONS = new Set(['sharedstates']);

/**
 * Writes a full backup of the connected database into `destDir`.
 * Returns the manifest.
 */
export async function backupDatabase(destDir, { skip = SKIP_COLLECTIONS } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('backupDatabase: not connected to MongoDB.');

  fs.mkdirSync(destDir, { recursive: true });

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((name) => !name.startsWith('system.') && !skip.has(name))
    .sort();

  const manifest = {
    createdAt: new Date().toISOString(),
    database: db.databaseName,
    format: 'jsonl.gz/ejson-canonical',
    collections: [],
  };

  for (const name of collections) {
    const file = `${name}.jsonl.gz`;
    const target = path.join(destDir, file);
    const hash = crypto.createHash('sha256');
    let count = 0;

    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(target);
    const finished = pipeline(gzip, out);

    // eslint-disable-next-line no-await-in-loop
    const cursor = db.collection(name).find({});
    // Streamed, not loaded into memory: a backup must not fall over on the
    // one collection that has grown large.
    // eslint-disable-next-line no-restricted-syntax
    for await (const doc of cursor) {
      const line = `${toExtendedJson(doc)}\n`;
      hash.update(line);
      count += 1;
      if (!gzip.write(line)) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => gzip.once('drain', resolve));
      }
    }
    gzip.end();
    // eslint-disable-next-line no-await-in-loop
    await finished;

    manifest.collections.push({ name, file, count, sha256: hash.digest('hex') });
  }

  manifest.totalDocuments = manifest.collections.reduce((sum, c) => sum + c.count, 0);
  fs.writeFileSync(path.join(destDir, MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Reads a backup's manifest. */
export function readManifest(dir) {
  const file = path.join(dir, MANIFEST);
  if (!fs.existsSync(file)) throw new Error(`No ${MANIFEST} in ${dir} — this is not a backup directory.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function eachLine(file, onLine) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  // eslint-disable-next-line no-restricted-syntax
  for await (const line of rl) {
    if (line.trim()) await onLine(line);
  }
}

/**
 * Verifies a backup against its own manifest WITHOUT touching any database.
 *
 * This is the step that makes a backup trustworthy: an untested dump is a
 * guess. Returns { ok, collections: [...], problems: [...] }.
 */
export async function verifyBackup(dir) {
  const manifest = readManifest(dir);
  const problems = [];
  const results = [];

  for (const entry of manifest.collections) {
    const file = path.join(dir, entry.file);
    if (!fs.existsSync(file)) {
      problems.push(`${entry.name}: file missing (${entry.file})`);
      // eslint-disable-next-line no-continue
      continue;
    }
    const hash = crypto.createHash('sha256');
    let count = 0;
    let parseError = null;
    // eslint-disable-next-line no-await-in-loop
    await eachLine(file, (line) => {
      hash.update(`${line}\n`);
      count += 1;
      if (!parseError) {
        try { fromExtendedJson(line); } catch (err) { parseError = err.message; }
      }
    });

    const sha256 = hash.digest('hex');
    if (count !== entry.count) problems.push(`${entry.name}: expected ${entry.count} documents, found ${count}`);
    if (sha256 !== entry.sha256) problems.push(`${entry.name}: checksum mismatch — the dump has been altered or truncated`);
    if (parseError) problems.push(`${entry.name}: unreadable document (${parseError})`);

    results.push({ name: entry.name, count, sha256, ok: count === entry.count && sha256 === entry.sha256 && !parseError });
  }

  return { ok: problems.length === 0, manifest, collections: results, problems };
}

/**
 * Restores a verified backup into the CONNECTED database.
 *
 * Refuses to run unless the caller has opted in explicitly, because a restore
 * overwrites live data. `drop: true` replaces each restored collection;
 * without it, existing documents with the same _id are left alone (`_id`
 * conflicts are skipped, not overwritten) so a restore can be used to fill
 * gaps without clobbering newer rows.
 */
export async function restoreDatabase(dir, { drop = false, confirm = false, batchSize = 500 } = {}) {
  if (!confirm) {
    throw new Error('restoreDatabase: refusing to write without an explicit confirmation — a restore overwrites live data.');
  }
  const db = mongoose.connection.db;
  if (!db) throw new Error('restoreDatabase: not connected to MongoDB.');

  // Never restore a dump we have not checked. This is the whole reason the
  // manifest carries checksums.
  const verification = await verifyBackup(dir);
  if (!verification.ok) {
    throw new Error(`restoreDatabase: backup failed verification — ${verification.problems.join('; ')}`);
  }

  const result = { database: db.databaseName, collections: [], restored: 0, skipped: 0 };

  for (const entry of verification.manifest.collections) {
    const collection = db.collection(entry.name);
    if (drop) {
      // eslint-disable-next-line no-await-in-loop
      await collection.deleteMany({});
    }

    let batch = [];
    let inserted = 0;
    let skipped = 0;

    const flush = async () => {
      if (!batch.length) return;
      try {
        // ordered:false so one pre-existing _id does not abandon the rest of
        // the batch.
        const res = await collection.insertMany(batch, { ordered: false });
        inserted += res.insertedCount;
      } catch (err) {
        // Duplicate-key errors are expected in a non-dropping restore: those
        // documents are already present.
        const dupes = (err.writeErrors || []).filter((e) => e.err?.code === 11000).length;
        inserted += err.result?.insertedCount ?? err.insertedCount ?? 0;
        skipped += dupes;
        const other = (err.writeErrors || []).filter((e) => e.err?.code !== 11000);
        if (other.length) throw err;
      }
      batch = [];
    };

    // eslint-disable-next-line no-await-in-loop
    await eachLine(path.join(dir, entry.file), async (line) => {
      batch.push(fromExtendedJson(line));
      if (batch.length >= batchSize) await flush();
    });
    // eslint-disable-next-line no-await-in-loop
    await flush();

    result.collections.push({ name: entry.name, expected: entry.count, inserted, skipped });
    result.restored += inserted;
    result.skipped += skipped;
  }

  return result;
}
