// Spins up a real, fully isolated in-memory MongoDB for integration tests —
// never touches the shared Atlas cluster local dev and production both use.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

export const TEST_DB_HOOK_TIMEOUT = 600000;

let mongod;

export async function startTestDB() {
  if (mongod) return mongod;
  mongod = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
  });
  await mongoose.connect(mongod.getUri());
  return mongod;
}

export async function stopTestDB() {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

export async function clearTestDB() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
