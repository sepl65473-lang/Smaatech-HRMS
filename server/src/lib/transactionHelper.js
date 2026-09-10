import mongoose from 'mongoose';

// Executes work inside a Mongoose ACID transaction if supported (Replica Set / Atlas),
// or safely falls back to standard execution if running on standalone dev MongoDB.
export async function runInTransaction(workFn) {
  let session = null;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await workFn(session);
    });
    return result;
  } catch (err) {
    // If standalone MongoDB instance without replica set, fallback gracefully
    if (err.message?.includes('replica set') || err.message?.includes('Transaction numbers')) {
      return await workFn(null);
    }
    throw err;
  } finally {
    if (session) {
      await session.endSession().catch(() => {});
    }
  }
}
