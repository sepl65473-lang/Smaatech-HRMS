import mongoose from 'mongoose';
import logger from './lib/logger.js';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — copy server/.env.example to server/.env and fill it in.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  logger.info('[db] connected to MongoDB');
}

