import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useSession } from '../../auth/AuthContext';
import { analyticsApi, attendanceApi, correctionsApi, leaveApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { TodayCard } from '../../components/TodayCard';
import { ProfileHeader, Quick } from '../employee/HomeScreen';
import { Card, Row, SectionTitle, Stat, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { formatMonth, monthKeyIST, monthRange, todayIST } from '../../utils/date';
import { formatINR } from '../../utils/format';
import type { RootNav, TabParamList } from '../../navigation/types';

type Nav = CompositeNavigationProp<BottomTabNavigationProp<TabParamList, 'Home'>, RootNav>;

/** Home for HR Manager, HR Director (Admin) and Finance Lead. */
export function WorkspaceHomeScreen({ navigation }: { navigation: Nav }) {
  const { caps } = useSession();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const today = todayIST();
  const month = monthKeyIST();
  const { from, to } = monthRange(month);

  const roster = useQuery({
    queryKey: keys.attendanceDay(today),
    queryFn: () => attendanceApi.byDate(today),
    enabled: caps.manageWorkforce,
    staleTime: 2 * 60_000,
  });
  const pendingLeave = useQuery({
    queryKey: keys.leaves('pending'),
    queryFn: () => leaveApi.list({ page: 1, status: 'pending' }),
    enabled: caps.manageWorkforce,
  });
  const corrections = useQuery({ queryKey: keys.corrections, queryFn: correctionsApi.list, enabled: caps.manageWorkforce });
  const overview = useQuery({
    queryKey: keys.overview(from, to),
    queryFn: () => analyticsApi.overview(from, to),
    enabled: caps.viewReports,
    staleTime: 5 * 60_000,
  });

  const counts = useMemo(() => {
    const rows = roster.data?.rows ?? [];
    const by = (status: string) => rows.filter((row) => row.status === status).length;
    return {
      total: roster.data?.total ?? 0,
      present: by('present') + by('late') + by('half-day') + by('early-exit'),
      late: by('late'),
      leave: by('leave'),
      // 'absent' is also the state of a row nobody has punched yet.
      notIn: rows.filter((row) => row.status === 'absent' && !row.checkIn).length,
      flagged: rows.filter((row) => (row.anomalyFlags?.length ?? 0) > 0 || (row.failedVerificationCount ?? 0) > 0).length,
    };
  }, [roster.data]);

  const pendingCorrections = corrections.data?.filter((c) => c.status === 'Pending').length ?? 0;
  const pendingLeaves = pendingLeave.data?.total ?? 0;

  const refresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={layout.screen} edges={['top']}>
      <ScrollView contentContainerStyle={layout.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} />}>
        <ProfileHeader />
        {caps.hasEmployeeProfile ? <TodayCard /> : null}

        {caps.manageWorkforce ? (
          <>
            <SectionTitle title="Workforce today" action="View all" onAction={() => navigation.navigate('TeamAttendance')} />
            <Card onPress={() => navigation.navigate('TeamAttendance')}>
              {roster.isError ? <Text style={type.caption}>{errorMessage(roster.error)}</Text> : (
                <>
                  <View style={layout.statRow}>
                    <Stat label="Checked in" value={roster.isLoading ? '…' : counts.present} tone="success" />
                    <Stat label="Late" value={roster.isLoading ? '…' : counts.late} tone="warning" />
                    <Stat label="Not in" value={roster.isLoading ? '…' : counts.notIn} tone="danger" />
                    <Stat label="On leave" value={roster.isLoading ? '…' : counts.leave} tone="info" />
                  </View>
                  {counts.flagged > 0 ? (
                    <Text style={[type.caption, { color: colors.danger, marginTop: spacing.md }]}>
                      {counts.flagged} record{counts.flagged === 1 ? '' : 's'} with a verification exception
                    </Text>
                  ) : null}
                </>
              )}
            </Card>

            <SectionTitle title="Waiting for a decision" />
            <Card style={{ paddingVertical: 0 }}>
              <Row icon="calendar-outline" title="Leave requests" subtitle={pendingLeave.isLoading ? 'Loading…' : `${pendingLeaves} pending`} onPress={() => navigation.navigate('Approvals')} />
              <Row icon="create-outline" title="Attendance corrections" subtitle={corrections.isLoading ? 'Loading…' : `${pendingCorrections} pending`} onPress={() => navigation.navigate('Approvals')} />
            </Card>
          </>
        ) : null}

        {caps.viewReports ? (
          <>
            <SectionTitle title={formatMonth(month)} action="Reports" onAction={() => navigation.navigate('Reports')} />
            <Card onPress={() => navigation.navigate('Reports')}>
              {overview.isError ? <Text style={type.caption}>{errorMessage(overview.error)}</Text> : (
                <View style={layout.statRow}>
                  <Stat label="Headcount" value={overview.data?.headcount.total ?? '…'} />
                  <Stat label="Attendance" value={overview.data ? (overview.data.attendance.ratePct != null ? `${overview.data.attendance.ratePct}%` : '—') : '…'} tone="success" />
                  {caps.viewAllPayroll ? <Stat label="Net payroll" value={overview.data ? formatINR(overview.data.payroll.net) : '…'} tone="info" /> : null}
                </View>
              )}
            </Card>
          </>
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {caps.hasEmployeeProfile ? <Quick icon="airplane-outline" label="My leave" onPress={() => navigation.navigate('MyLeave')} /> : null}
          {caps.hasEmployeeProfile ? <Quick icon="wallet-outline" label="Payslips" onPress={() => navigation.navigate('Payslips')} /> : null}
          <Quick icon="document-text-outline" label="Documents" onPress={() => navigation.navigate('Documents')} />
          <Quick icon="sunny-outline" label="Holidays" onPress={() => navigation.navigate('Holidays')} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
