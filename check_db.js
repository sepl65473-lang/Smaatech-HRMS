import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from './server/src/models/User.js';

async function checkUsers() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set (check your .env).');
    console.log('Connecting to:', uri.replace(/:[^:@]+@/, ':****@'));
    await mongoose.connect(uri);
    console.log('Connected to MongoDB Atlas successfully.');

    const users = await User.find({}).lean();
    console.log(`Found ${users.length} users in database:`);
    for (const u of users) {
      const matchAdmin = await bcrypt.compare('Admin@123', u.passwordHash || '');
      const matchManager = await bcrypt.compare('Manager@123', u.passwordHash || '');
      const matchFinance = await bcrypt.compare('Finance@123', u.passwordHash || '');
      const matchEmp = await bcrypt.compare('Employee@123', u.passwordHash || '');
      console.log({
        id: u._id,
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active,
        matchAdmin,
        matchManager,
        matchFinance,
        matchEmp
      });
    }
  } catch (err) {
    console.error('Diagnostic error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

checkUsers();
