import * as Notifications from 'expo-notifications';
import { getReminderPreference, setReminderPreference } from '../storage/secure';
import type { AppNotification } from '../types';

// The HRMS backend delivers notifications in-app and by email; it has no push
// provider. This module therefore only raises LOCAL notifications: one when
// the app discovers new HRMS notifications, and an optional daily check-in
// reminder scheduled on the device. Nothing here contacts a push service.
const CHANNEL_HRMS = 'hrms-updates';
const CHANNEL_REMINDER = 'attendance-reminder';
const REMINDER_ID = 'daily-check-in-reminder';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function setupChannels() {
  await Notifications.setNotificationChannelAsync(CHANNEL_HRMS, {
    name: 'HRMS updates',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  await Notifications.setNotificationChannelAsync(CHANNEL_REMINDER, {
    name: 'Attendance reminder',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

export async function hasPermission(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

export async function requestPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

// Ids already seen in this app session, so a refresh never re-announces them.
let knownIds: Set<string> | null = null;

/** Announces unread notifications that appeared since the previous fetch. */
export async function announceNew(list: AppNotification[]) {
  const first = knownIds === null;
  const previous = knownIds ?? new Set<string>();
  knownIds = new Set(list.map((n) => n.id));
  // The first load after sign-in is the existing inbox, not news.
  if (first) return;
  const fresh = list.filter((n) => !n.read && !previous.has(n.id));
  if (!fresh.length || !(await hasPermission())) return;
  const latest = fresh[0]!;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: fresh.length > 1 ? `${fresh.length} new HRMS notifications` : latest.title,
      body: fresh.length > 1 ? latest.title : latest.message,
    },
    trigger: { channelId: CHANNEL_HRMS },
  });
}

export function resetAnnounced() {
  knownIds = null;
}

export async function getReminderTime(): Promise<string | null> {
  return getReminderPreference();
}

/** Schedules (or with null, removes) the daily local check-in reminder. `time` is HH:MM device-local. */
export async function setReminderTime(time: string | null): Promise<boolean> {
  await Notifications.cancelScheduledNotificationAsync(REMINDER_ID).catch(() => undefined);
  if (!time) {
    await setReminderPreference(null);
    return true;
  }
  if (!(await requestPermission())) return false;
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  await Notifications.scheduleNotificationAsync({
    identifier: REMINDER_ID,
    content: { title: 'Time to check in', body: 'Open Smaatech HRMS to record your attendance.' },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: CHANNEL_REMINDER },
  });
  await setReminderPreference(time);
  return true;
}
