import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../auth/AuthContext';
import { attendanceApi, correctionsApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { TodayCard } from '../../components/TodayCard';
import { Banner, Card, Chip, EmptyState, ErrorState, Loading, Segmented, Stat, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { formatDay, formatMonth, formatTime, formatWorked, monthKeyIST, monthRange, shiftMonth, todayIST } from '../../utils/date';
import { attendanceStatus, correctionTone } from '../../utils/format';
import type { RootNav } from '../../navigation/types';
import type { Attendance, AttendanceCorrection } from '../../types';

type View_ = 'history' | 'corrections';

export function AttendanceScreen() {
  const navigation = useNavigation<RootNav>();
  const { user, caps } = useSession();
  const [view, setView] = useState<View_>('history');
  const [month, setMonth] = useState(monthKeyIST());
  const isCurrentMonth = month === monthKeyIST();

  const history = useQuery({
    queryKey: keys.attendanceMonth(month),
    queryFn: async () => {
      const { from, to } = monthRange(month);
      const result = await attendanceApi.forEmployee(user.employeeId!, from, to);
      return { ...result, rows: result.rows.filter((row) => row.date <= todayIST()) };
    },
    enabled: caps.hasEmployeeProfile,
  });

  const corrections = useQuery({
    queryKey: keys.corrections,
    queryFn: correctionsApi.list,
    enabled: caps.hasEmployeeProfile && view === 'corrections',
    select: (rows) => rows.filter((row) => row.employeeId === user.employeeId),
  });

  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of history.data?.rows ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, [history.data]);

  if (!caps.hasEmployeeProfile) {
    return <View style={layout.screen}><EmptyState icon="person-outline" title="No employee profile" message="Your login is not linked to an employee record. Ask HR to link it." /></View>;
  }

  const header = (
    <View>
      <TodayCard />
      <Segmented<View_>
        value={view}
        onChange={setView}
        options={[{ value: 'history', label: 'History' }, { value: 'corrections', label: 'Correction requests' }]}
      />
      {view === 'history' ? (
        <>
          <View style={styles.monthBar}>
            <Pressable onPress={() => setMonth((m) => shiftMonth(m, -1))} hitSlop={12} accessibilityRole="button" accessibilityLabel="Previous month">
              <Ionicons name="chevron-back" size={22} color={colors.ink} />
            </Pressable>
            <Text style={type.heading}>{formatMonth(month)}</Text>
            <Pressable onPress={() => setMonth((m) => shiftMonth(m, 1))} disabled={isCurrentMonth} hitSlop={12} accessibilityRole="button" accessibilityLabel="Next month">
              <Ionicons name="chevron-forward" size={22} color={isCurrentMonth ? colors.border : colors.ink} />
            </Pressable>
          </View>
          <View style={[layout.statRow, { marginBottom: spacing.md }]}>
            <Stat label="Present" value={(summary.present ?? 0) + (summary.late ?? 0)} tone="success" />
            <Stat label="Late" value={summary.late ?? 0} tone="warning" />
            <Stat label="Half day" value={summary['half-day'] ?? 0} tone="warning" />
            <Stat label="Absent" value={summary.absent ?? 0} tone="danger" />
          </View>
          {history.data?.partial ? <Banner tone="warning" message="Only part of this month could be loaded. Open the web HRMS for the complete record." /> : null}
        </>
      ) : (
        <Pressable onPress={() => navigation.navigate('Correction')} style={styles.newCorrection} accessibilityRole="button">
          <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
          <Text style={{ color: colors.primary, fontWeight: '600', marginLeft: spacing.sm }}>Request a correction</Text>
        </Pressable>
      )}
    </View>
  );

  const active = view === 'history' ? history : corrections;

  return (
    <FlatList<Attendance | AttendanceCorrection>
      style={layout.screen}
      contentContainerStyle={layout.content}
      data={(view === 'history' ? history.data?.rows : corrections.data) ?? []}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={active.isRefetching} onRefresh={() => void active.refetch()} colors={[colors.primary]} />}
      renderItem={({ item }) => ('requestedCheckIn' in item
        ? <CorrectionRow item={item} />
        : <DayRow row={item} onCorrect={() => navigation.navigate('Correction', { date: item.date })} />)}
      ListEmptyComponent={
        active.isLoading ? <Loading />
          : active.isError ? <ErrorState message={errorMessage(active.error)} onRetry={() => void active.refetch()} />
          : view === 'history'
            ? <EmptyState icon="calendar-outline" title="No attendance yet" message={`Nothing is recorded for ${formatMonth(month)}.`} />
            : <EmptyState icon="create-outline" title="No correction requests" message="Ask for a correction when a check-in or check-out was missed or recorded wrongly." />
      }
    />
  );
}

function DayRow({ row, onCorrect }: { row: Attendance; onCorrect: () => void }) {
  const status = attendanceStatus(row.status);
  const correctable = !['leave', 'holiday'].includes(row.status);
  return (
    <Card style={{ paddingVertical: spacing.md }}>
      <View style={layout.rowBetween}>
        <Text style={[type.body, { fontWeight: '600' }]}>{formatDay(row.date)}</Text>
        <Chip label={status.label} tone={status.tone} />
      </View>
      <View style={[layout.rowBetween, { marginTop: spacing.sm }]}>
        <Text style={type.caption}>
          {row.checkIn ? `${formatTime(row.checkIn)} – ${formatTime(row.checkOut)}` : 'No punches'}
          {row.workedMinutes != null ? `  ·  ${formatWorked(row.workedMinutes)}` : ''}
        </Text>
        {correctable ? (
          <Pressable onPress={onCorrect} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Request correction for ${formatDay(row.date)}`}>
            <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600' }}>Correct</Text>
          </Pressable>
        ) : null}
      </View>
    </Card>
  );
}

function CorrectionRow({ item }: { item: AttendanceCorrection }) {
  return (
    <Card style={{ paddingVertical: spacing.md }}>
      <View style={layout.rowBetween}>
        <Text style={[type.body, { fontWeight: '600' }]}>{formatDay(item.date)}</Text>
        <Chip label={item.status} tone={correctionTone(item.status)} />
      </View>
      <Text style={[type.caption, { marginTop: spacing.sm }]}>
        Requested {formatTime(item.requestedCheckIn)} – {formatTime(item.requestedCheckOut)}
      </Text>
      <Text style={[type.caption, { marginTop: 2 }]} numberOfLines={3}>{item.reason}</Text>
      {item.status === 'Rejected' && item.reviewNote ? <Banner tone="danger" message={`Reason: ${item.reviewNote}`} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: spacing.md },
  newCorrection: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, minHeight: 48 },
});
