import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSession } from '../auth/AuthContext';
import { useSettings, useTodayAttendance } from '../hooks/queries';
import { errorMessage } from '../services/api';
import { Button, Card, Chip, layout } from './ui';
import { colors, spacing, type } from '../theme';
import { formatDay, formatTime, formatWorked, todayIST } from '../utils/date';
import { attendanceStatus, shiftForToday } from '../utils/format';
import type { RootNav } from '../navigation/types';

/**
 * Today's own attendance with the one action that applies right now. Used on
 * every role's home screen, because HR and Finance users punch in too and are
 * verified exactly like everyone else (routes/attendance.js isSelfService).
 */
export function TodayCard() {
  const navigation = useNavigation<RootNav>();
  const { user } = useSession();
  const today = useTodayAttendance(user.employeeId);
  const settings = useSettings();
  const shift = shiftForToday(user.employeeId, settings.data);
  const row = today.data;
  // A fresh row is stored as 'absent' until the first punch; that is not yet a verdict.
  const notStarted = Boolean(row && !row.checkIn && row.status === 'absent');

  const header = (
    <View style={[layout.rowBetween, { marginBottom: spacing.md }]}>
      <View>
        <Text style={type.heading}>Today</Text>
        <Text style={type.caption}>{formatDay(todayIST())} · {shift.name} {formatTime(shift.start)} – {formatTime(shift.end)}</Text>
      </View>
      {row ? (
        notStarted
          ? <Chip label="Not checked in" tone="neutral" />
          : <Chip label={attendanceStatus(row.status).label} tone={attendanceStatus(row.status).tone} />
      ) : null}
    </View>
  );

  if (today.isLoading) {
    return <Card>{header}<ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.lg }} /></Card>;
  }
  if (today.isError || !row) {
    return (
      <Card>
        {header}
        <Text style={[type.caption, { marginBottom: spacing.md }]}>
          {today.isError ? errorMessage(today.error) : "Today's attendance record is not available yet."}
        </Text>
        <Button label="Try again" variant="secondary" onPress={() => void today.refetch()} loading={today.isFetching} />
      </Card>
    );
  }

  const direction = !row.checkIn ? 'in' : !row.checkOut ? 'out' : null;
  // Same behaviour as the web dashboard: a leave or holiday day can still be
  // worked, and the server replaces the status when the punch is recorded.
  const overrides = direction === 'in' && (row.status === 'leave' || row.status === 'holiday');

  return (
    <Card>
      {header}
      <View style={{ flexDirection: 'row', marginBottom: spacing.lg }}>
        <Time label="Check in" value={formatTime(row.checkIn)} />
        <Time label="Check out" value={formatTime(row.checkOut)} />
        <Time label="Worked" value={formatWorked(row.workedMinutes)} />
      </View>
      {overrides ? (
        <Text style={[type.caption, { marginBottom: spacing.md }]}>
          Marked {attendanceStatus(row.status).label.toLowerCase()} today. Checking in will override that.
        </Text>
      ) : null}
      {direction ? (
        <Button
          label={direction === 'in' ? 'Check in' : 'Check out'}
          icon="scan-outline"
          variant={direction === 'in' ? 'primary' : 'secondary'}
          onPress={() => navigation.navigate('FaceCapture', { mode: direction, attendanceId: row.id })}
        />
      ) : (
        <Text style={type.caption}>Attendance for today is complete.</Text>
      )}
    </Card>
  );
}

function Time({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={type.caption}>{label}</Text>
      <Text style={{ fontSize: 17, fontWeight: '700', color: colors.ink, marginTop: 2 }}>{value}</Text>
    </View>
  );
}
