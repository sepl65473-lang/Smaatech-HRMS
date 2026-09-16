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
    // mongodb-memory-server gives a new mongod 10 seconds to come up. On a
    // loaded machine — the whole suite on one worker, each file starting its
    // own instance — that is occasionally not enough, and the file fails to
    // load with "Instance failed to start" while every test inside it is
    // reported as skipped. Nothing to do with the code under test.
    instance: { launchTimeout: Number(process.env.MONGOMS_LAUNCH_TIMEOUT || 60000) },
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
