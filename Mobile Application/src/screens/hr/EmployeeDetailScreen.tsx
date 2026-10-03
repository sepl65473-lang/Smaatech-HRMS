import React, { useMemo } from 'react';
import { Linking, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { attendanceApi, employeesApi, leaveApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Avatar, Button, Card, Chip, ErrorState, Loading, SectionTitle, Stat, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { formatDate, formatDay, formatMonth, formatTime, monthKeyIST, monthRange, todayIST } from '../../utils/date';
import { attendanceStatus, titleCase } from '../../utils/format';
import type { StackProps } from '../../navigation/types';

// One employee as HR sees them. The API decides which fields this role gets
// (routes/employees.js redactEmployee); nothing is unhidden here.
export function EmployeeDetailScreen({ route }: StackProps<'EmployeeDetail'>) {
  const { id } = route.params;
  const month = monthKeyIST();
  const employee = useQuery({ queryKey: keys.me(id), queryFn: () => employeesApi.get(id) });
  const balance = useQuery({ queryKey: keys.leaveBalance(id), queryFn: () => leaveApi.balance(id) });
  const attendance = useQuery({
    queryKey: ['attendance', 'employee', id, month],
    queryFn: () => { const { from, to } = monthRange(month); return attendanceApi.forEmployee(id, from, to); },
    staleTime: 5 * 60_000,
  });

  const summary = useMemo(() => {
    const rows = (attendance.data?.rows ?? []).filter((row) => row.date <= todayIST());
    const by = (status: string) => rows.filter((row) => row.status === status).length;
    return { present: by('present') + by('late'), late: by('late'), absent: by('absent'), leave: by('leave'), recent: rows.slice(0, 5) };
  }, [attendance.data]);

  if (employee.isLoading) return <View style={layout.screen}><Loading /></View>;
  if (employee.isError || !employee.data) {
    return <View style={layout.screen}><ErrorState message={errorMessage(employee.error)} onRetry={() => void employee.refetch()} /></View>;
  }
  const e = employee.data;
  const refetchAll = () => { void employee.refetch(); void balance.refetch(); void attendance.refetch(); };

  return (
    <ScrollView style={layout.screen} contentContainerStyle={layout.content} refreshControl={<RefreshControl refreshing={employee.isRefetching} onRefresh={refetchAll} colors={[colors.primary]} />}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Avatar name={e.name} photo={e.photo} size={60} />
          <View style={{ flex: 1, marginLeft: spacing.lg }}>
            <Text style={type.title} numberOfLines={2}>{e.name}</Text>
            <Text style={type.caption} numberOfLines={1}>{[e.role, e.dept].filter(Boolean).join(' · ')}</Text>
            {e.status ? <View style={{ marginTop: 6 }}><Chip label={titleCase(e.status)} tone={e.status === 'active' ? 'success' : 'neutral'} /></View> : null}
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
          {e.phone ? <Button label="Call" icon="call-outline" variant="secondary" style={{ flex: 1 }} onPress={() => void Linking.openURL(`tel:${e.phone}`)} /> : null}
          {e.email ? <Button label="Email" icon="mail-outline" variant="secondary" style={{ flex: 1 }} onPress={() => void Linking.openURL(`mailto:${e.email}`)} /> : null}
        </View>
      </Card>

      <SectionTitle title="Details" />
      <Card style={{ paddingVertical: spacing.sm }}>
        <Detail label="Email" value={e.email} />
        <Detail label="Phone" value={e.phone} />
        <Detail label="Location" value={e.loc} />
        <Detail label="Employment type" value={e.employmentType} />
        <Detail label="Stage" value={e.employmentStage} />
        <Detail label="Joined" value={e.joinDate ? formatDate(e.joinDate) : undefined} />
      </Card>

      <SectionTitle title={`Attendance · ${formatMonth(month)}`} />
      {attendance.isError ? <Text style={[type.caption, { marginBottom: spacing.md }]}>{errorMessage(attendance.error)}</Text> : (
        <>
          <View style={[layout.statRow, { marginBottom: spacing.md }]}>
            <Stat label="Present" value={attendance.isLoading ? '…' : summary.present} tone="success" />
            <Stat label="Late" value={attendance.isLoading ? '…' : summary.late} tone="warning" />
            <Stat label="Absent" value={attendance.isLoading ? '…' : summary.absent} tone="danger" />
            <Stat label="Leave" value={attendance.isLoading ? '…' : summary.leave} tone="info" />
          </View>
          {attendance.data?.partial ? <Text style={[type.caption, { marginBottom: spacing.md }]}>Only part of this month could be loaded.</Text> : null}
          {summary.recent.length ? (
            <Card style={{ paddingVertical: spacing.sm }}>
              {summary.recent.map((row) => (
                <View key={row.id} style={[layout.rowBetween, { paddingVertical: 8 }]}>
                  <View>
                    <Text style={type.body}>{formatDay(row.date)}</Text>
                    <Text style={type.caption}>{row.checkIn ? `${formatTime(row.checkIn)} – ${formatTime(row.checkOut)}` : 'No punches'}</Text>
                  </View>
                  <Chip label={attendanceStatus(row.status).label} tone={attendanceStatus(row.status).tone} />
                </View>
              ))}
            </Card>
          ) : null}
        </>
      )}

      <SectionTitle title="Leave balance" />
      <Card style={{ paddingVertical: spacing.sm }}>
        {balance.isLoading ? <Text style={type.caption}>Loading…</Text>
          : balance.isError ? <Text style={type.caption}>{errorMessage(balance.error)}</Text>
          : balance.data?.balances.filter((b) => b.balanceTracked).map((b) => (
            <Detail key={b.type} label={b.name} value={`${b.available} available · ${b.used} used${b.pending ? ` · ${b.pending} pending` : ''}`} />
          ))}
      </Card>
    </ScrollView>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={[layout.rowBetween, { paddingVertical: 10 }]}>
      <Text style={type.caption}>{label}</Text>
      <Text style={[type.body, { flex: 1, textAlign: 'right', marginLeft: spacing.lg }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}
