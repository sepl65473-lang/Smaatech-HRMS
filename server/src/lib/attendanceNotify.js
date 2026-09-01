import Employee from '../models/Employee.js';
import User from '../models/User.js';
import Settings from '../models/Settings.js';
import { sendNotification, resolveChannels } from './notificationService.js';

async function getSettings(company) {
  let doc = await Settings.findById(company);
  if (!doc) doc = await Settings.create({ _id: company });
  return doc;
}

// Notifies the employee and, if they have one, their manager — used for both
// a late check-in (event-driven, from handlePunch) and an unexplained
// absence (checked once daily, see attendanceDailyJob.js). Never throws — a
// notification failure must not block the attendance action that triggered it.
export async function notifyAttendanceEvent({ empId, title, message, company, actionUrl = '/attendance' }) {
  try {
    const settingsDoc = await getSettings(company);
    const channels = resolveChannels(settingsDoc, 'attendance');
    const recipientIds = new Set();

    const empUser = await User.findOne({ employeeId: empId });
    if (empUser) recipientIds.add(String(empUser._id));

    const employee = await Employee.findById(empId);
    if (employee?.managerId) {
      const managerUser = await User.findOne({ employeeId: employee.managerId });
      if (managerUser) recipientIds.add(String(managerUser._id));
    }

    for (const recipientId of recipientIds) {
      // eslint-disable-next-line no-await-in-loop
      await sendNotification({ recipientId, title, message, type: 'system', actionUrl, channels, company });
    }
  } catch (err) {
    console.error('[attendanceNotify] failed:', err.message);
  }
}
