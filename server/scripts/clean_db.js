import 'dotenv/config';
import { connectDB } from '../src/db.js';
import Employee from '../src/models/Employee.js';
import User from '../src/models/User.js';
import Attendance from '../src/models/Attendance.js';
import Payroll from '../src/models/Payroll.js';
import Leave from '../src/models/Leave.js';
import Review from '../src/models/Review.js';

async function cleanup() {
  await connectDB();
  console.log('--- STARTING SAFE DB CLEANUP ---');

  const users = await User.find({});
  const validEmpIds = [];

  for (const user of users) {
    let emp = null;
    if (user.employeeId) {
      emp = await Employee.findById(user.employeeId);
    }
    if (!emp) {
      // Find employee by email or name or create one
      emp = await Employee.findOne({ email: user.email }) || await Employee.findOne({ name: user.name });
      if (!emp) {
        emp = await Employee.create({
          name: user.name,
          role: user.role,
          dept: 'Finance & HR',
          loc: 'Bengaluru',
          email: user.email,
          phone: '+91 9876543210',
          status: 'active',
          joinDate: new Date().toISOString().slice(0, 10),
          salary: 150000,
          company: user.company || 'Smaatech',
        });
      }
      user.employeeId = emp._id;
      await user.save();
    }
    validEmpIds.push(emp._id);
    console.log('Preserved User:', user.email, '=> Employee:', emp.name, '(', emp._id, ')');
  }

  // Delete all fake employees not linked to any active real user account
  const deletedEmps = await Employee.deleteMany({ _id: { $nin: validEmpIds } });
  console.log('Deleted fake employees:', deletedEmps.deletedCount);

  // Delete orphaned related records
  const deletedAtt = await Attendance.deleteMany({ empId: { $nin: validEmpIds } });
  console.log('Deleted orphaned attendance records:', deletedAtt.deletedCount);

  const deletedPay = await Payroll.deleteMany({ empId: { $nin: validEmpIds } });
  console.log('Deleted orphaned payroll records:', deletedPay.deletedCount);

  const deletedLeaves = await Leave.deleteMany({ empId: { $nin: validEmpIds } });
  console.log('Deleted orphaned leave records:', deletedLeaves.deletedCount);

  const deletedReviews = await Review.deleteMany({ empId: { $nin: validEmpIds } });
  console.log('Deleted orphaned review records:', deletedReviews.deletedCount);

  const remainingEmps = await Employee.find({});
  console.log('--- CLEANUP COMPLETE ---');
  console.log('Remaining Real Employees:', remainingEmps.length);
  remainingEmps.forEach(e => console.log(' -', e.name, '(', e.role, '|', e.dept, '|', e.email, ')'));

  process.exit(0);
}

cleanup().catch(err => {
  console.error('Cleanup error:', err);
  process.exit(1);
});
