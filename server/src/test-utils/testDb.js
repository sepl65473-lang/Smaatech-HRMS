// Spins up a real, fully isolated in-memory MongoDB for integration tests —
// never touches the shared Atlas cluster local dev and production both use.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod;

export async function startTestDB() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

export async function stopTestDB() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

export async function clearTestDB() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
