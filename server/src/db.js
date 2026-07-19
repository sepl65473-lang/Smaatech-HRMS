import mongoose from 'mongoose';
import logger from './lib/logger.js';

export async function connectDB() {
  if (mongoose.connection.readyState === 1) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — configure it in your environment (.env locally, or the host\'s dashboard in production).');
  }

  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    logger.info('[db] connected to MongoDB');
  } catch (err) {
    logger.warn('[db] connection attempt failed (%s), retrying with a longer timeout...', err.message);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
    logger.info('[db] connected to MongoDB');
  }
}

