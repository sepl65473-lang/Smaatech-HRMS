// READ-ONLY database snapshot. Counts documents per collection and writes
// NOTHING. Used to prove, before and after any run against a live database,
// that no records were lost.
//
// Deliberately separate from scripts/seed.js, which does deleteMany({}) on
// every collection and must never be run against real data.
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set.');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
const cols = await mongoose.connection.db.listCollections().toArray();
const counts = {};
for (const c of cols.sort((a, b) => a.name.localeCompare(b.name))) {
  counts[c.name] = await mongoose.connection.db.collection(c.name).countDocuments();
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ database: mongoose.connection.name, total, counts }, null, 2));
await mongoose.disconnect();
