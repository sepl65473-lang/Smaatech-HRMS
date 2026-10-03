import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

// Native Android date and time dialogs.
export function pickDate(opts: { value?: Date; min?: Date; max?: Date; onPick: (date: Date) => void }) {
  DateTimePickerAndroid.open({
    mode: 'date',
    value: opts.value ?? new Date(),
    minimumDate: opts.min,
    maximumDate: opts.max,
    onValueChange: (_event, date) => opts.onPick(date),
  });
}

export function pickTime(opts: { value?: Date; onPick: (date: Date) => void }) {
  DateTimePickerAndroid.open({
    mode: 'time',
    value: opts.value ?? new Date(),
    is24Hour: false,
    onValueChange: (_event, date) => opts.onPick(date),
  });
}

/** A Date at the given "HH:MM" today, as a starting value for the time dialog. */
export function dateAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date;
}

/** A local Date for a YYYY-MM-DD string. */
export function dateFromISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
