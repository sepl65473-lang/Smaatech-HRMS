import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../auth/AuthContext';
import { analyticsApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Card, ErrorState, Loading, SectionTitle, Stat, layout } from '../../components/ui';
import { colors, radius, spacing, type } from '../../theme';
import { formatMonth, monthKeyIST, monthRange, shiftMonth, todayIST } from '../../utils/date';
import { formatINR } from '../../utils/format';

export function MonthSwitcher({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const isCurrent = month >= monthKeyIST();
  return (
    <View style={styles.monthBar}>
      <Pressable onPress={() => onChange(shiftMonth(month, -1))} hitSlop={12} accessibilityRole="button" accessibilityLabel="Previous month">
        <Ionicons name="chevron-back" size={22} color={colors.ink} />
      </Pressable>
      <Text style={type.heading}>{formatMonth(month)}</Text>
      <Pressable onPress={() => onChange(shiftMonth(month, 1))} disabled={isCurrent} hitSlop={12} accessibilityRole="button" accessibilityLabel="Next month">
        <Ionicons name="chevron-forward" size={22} color={isCurrent ? colors.border : colors.ink} />
      </Pressable>
    </View>
  );
}

// Monthly summary from GET /analytics/overview. Exports and the detailed
// analytics charts stay on the web.
export function ReportsScreen() {
  const { caps } = useSession();
  const [month, setMonth] = useState(monthKeyIST());
  const range = monthRange(month);
  const to = range.to > todayIST() ? todayIST() : range.to;
  const overview = useQuery({
    queryKey: keys.overview(range.from, to),
    queryFn: () => analyticsApi.overview(range.from, to),
    staleTime: 5 * 60_000,
  });
  const data = overview.data;

  return (
    <ScrollView style={layout.screen} contentContainerStyle={layout.content} refreshControl={<RefreshControl refreshing={overview.isRefetching} onRefresh={() => void overview.refetch()} colors={[colors.primary]} />}>
      <MonthSwitcher month={month} onChange={setMonth} />
      {overview.isLoading ? <Loading /> : overview.isError || !data ? (
        <ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />
      ) : (
        <>
          <SectionTitle title="Workforce" />
          <View style={[layout.statRow, { marginBottom: spacing.md }]}>
            <Stat label="Headcount" value={data.headcount.total} />
            <Stat label="Active" value={data.headcount.active} tone="success" />
            <Stat label="Attendance" value={data.attendance.ratePct != null ? `${data.attendance.ratePct}%` : '—'} tone="success" />
          </View>

          <SectionTitle title="Attendance records" />
          <View style={[layout.statRow, { marginBottom: spacing.md }]}>
            <Stat label="Present" value={data.attendance.present} tone="success" />
            <Stat label="Late" value={data.attendance.late} tone="warning" />
            <Stat label="Absent" value={data.attendance.absent} tone="danger" />
            <Stat label="On leave" value={data.attendance.onLeave} tone="info" />
          </View>

          <SectionTitle title="Leave" />
          <View style={[layout.statRow, { marginBottom: spacing.md }]}>
            <Stat label="Pending" value={data.leave.pending} tone="warning" />
            <Stat label="Approved" value={data.leave.approved} tone="success" />
            <Stat label="Rejected" value={data.leave.declined} tone="danger" />
            <Stat label="Days taken" value={data.leave.approvedDays} tone="info" />
          </View>

          {caps.viewAllPayroll ? (
            <>
              <SectionTitle title="Payroll" />
              <Card>
                <Money label="Gross" value={data.payroll.gross} />
                <Money label="Deductions" value={data.payroll.deductions} />
                <Money label="Net payout" value={data.payroll.net} bold />
                <Text style={[type.caption, { marginTop: spacing.sm }]}>{data.payroll.paid} of {data.payroll.payslips} payslips paid</Text>
              </Card>
            </>
          ) : null}

          <SectionTitle title="By department" />
          {data.departments.map((dept) => (
            <Card key={dept.dept} style={{ paddingVertical: spacing.md }}>
              <View style={layout.rowBetween}>
                <Text style={[type.body, { fontWeight: '600', flex: 1 }]} numberOfLines={1}>{dept.dept}</Text>
                <Text style={[type.body, { fontWeight: '700', color: colors.success }]}>{dept.ratePct != null ? `${dept.ratePct}%` : '—'}</Text>
              </View>
              <View style={styles.bar}>
                <View style={[styles.barFill, { width: `${Math.min(100, Math.max(0, dept.ratePct ?? 0))}%` }]} />
              </View>
              <Text style={type.caption}>
                {dept.headcount} people · {dept.late} late · {dept.absent} absent · {dept.onLeave} on leave
              </Text>
            </Card>
          ))}
        </>
      )}
    </ScrollView>
  );
}

function Money({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <View style={[layout.rowBetween, { paddingVertical: 6 }]}>
      <Text style={{ color: colors.inkSoft, fontWeight: bold ? '700' : '400' }}>{label}</Text>
      <Text style={{ color: colors.ink, fontWeight: bold ? '700' : '500', fontSize: bold ? 17 : 15 }}>{formatINR(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  bar: { height: 6, borderRadius: radius.pill, backgroundColor: colors.neutralSoft, marginVertical: spacing.sm, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: radius.pill, backgroundColor: colors.success },
});
