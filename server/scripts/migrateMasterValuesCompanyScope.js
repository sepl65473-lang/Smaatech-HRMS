// One-off, idempotent migration: tags every existing (currently global)
// MasterValue with a company, then ports any HR-added settings.departments
// entries into scoped MasterValue rows. Safe to re-run — Phase A only
// matches untagged docs, Phase B upserts on (company, categoryId, value).
//
// Run with: node scripts/migrateMasterValuesCompanyScope.js [--dry-run]
import 'dotenv/config';
import { connectDB } from '../src/db.js';
import MasterCategory from '../src/models/MasterCategory.js';
import MasterValue from '../src/models/MasterValue.js';
import Settings from '../src/models/Settings.js';

const DEFAULT_COMPANY = 'Smaatech';
const dryRun = process.argv.includes('--dry-run');

async function run() {
  await connectDB();

  const untagged = await MasterValue.countDocuments({ company: { $exists: false } });
  console.log(`Phase A: ${untagged} untagged MasterValue doc(s) found.`);
  if (untagged > 0) {
    if (dryRun) {
      console.log(`  [dry-run] would set company: '${DEFAULT_COMPANY}' on all ${untagged}.`);
    } else {
      const result = await MasterValue.updateMany(
        { company: { $exists: false } },
        { $set: { company: DEFAULT_COMPANY } },
      );
      console.log(`  Backfilled ${result.modifiedCount} doc(s) with company: '${DEFAULT_COMPANY}'.`);
    }
  }

  const deptCategory = await MasterCategory.findOne({ code: 'departments' });
  if (!deptCategory) {
    console.log('Phase B: no "departments" MasterCategory found — skipping.');
  } else {
    const settingsDocs = await Settings.find({});
    let inserted = 0;
    let skipped = 0;
    for (const doc of settingsDocs) {
      const company = doc._id;
      for (const dept of doc.departments || []) {
        const value = String(dept).trim();
        if (!value) continue;
        const existing = await MasterValue.findOne({ company, categoryId: deptCategory._id, value });
        if (existing) {
          skipped += 1;
          continue;
        }
        if (dryRun) {
          console.log(`  [dry-run] would insert department "${value}" for company "${company}".`);
        } else {
          await MasterValue.findOneAndUpdate(
            { company, categoryId: deptCategory._id, value },
            { $setOnInsert: { company, categoryId: deptCategory._id, value, active: true } },
            { upsert: true },
          );
        }
        inserted += 1;
      }
    }
    console.log(`Phase B: ${inserted} department value(s) ${dryRun ? 'would be inserted' : 'inserted'}, ${skipped} already present.`);
  }

  console.log('Done.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
