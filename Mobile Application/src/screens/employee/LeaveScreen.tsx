import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../auth/AuthContext';
import { leaveApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { LeaveBalanceStrip } from './HomeScreen';
import { LeaveDecisionSheet } from '../../components/LeaveDecisionSheet';
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Loading, Segmented, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { formatRange } from '../../utils/date';
import { leaveStatus, titleCase } from '../../utils/format';
import type { RootNav } from '../../navigation/types';
import type { Leave } from '../../types';

type Filter = 'all' | 'pending' | 'approved' | 'declined';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' }, { value: 'declined', label: 'Rejected' },
];

const OWN_SCAN_PAGES = 8;

export function LeaveScreen() {
  const navigation = useNavigation<RootNav>();
  const { user, caps } = useSession();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [deciding, setDeciding] = useState<Leave | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: keys.leaves(`mine-${filter}`),
    queryFn: ({ pageParam }) => leaveApi.list({ page: pageParam, status: filter === 'all' ? undefined : filter }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
    enabled: caps.hasEmployeeProfile,
  });

  // For HR the list is the whole company and has no per-employee filter, so
  // their own requests may sit beyond the first page. Keep loading, within a
  // bound, instead of leaving them out of sight.
  const { hasNextPage, isFetching, fetchNextPage } = list;
  const loadedPages = list.data?.pages.length ?? 0;
  useEffect(() => {
    if (caps.manageWorkforce && hasNextPage && !isFetching && loadedPages < OWN_SCAN_PAGES) void fetchNextPage();
  }, [caps.manageWorkforce, hasNextPage, isFetching, loadedPages, fetchNextPage]);

  const refreshLeave = () => {
    void queryClient.invalidateQueries({ queryKey: ['leaves'] });
    void queryClient.invalidateQueries({ queryKey: ['leaveBalance'] });
  };

  const withdraw = useMutation({
    mutationFn: (id: string) => leaveApi.withdraw(id),
    onSuccess: () => { setActionError(null); refreshLeave(); },
    onError: (err) => setActionError(errorMessage(err)),
  });

  if (!caps.hasEmployeeProfile) {
    return <View style={layout.screen}><EmptyState icon="person-outline" title="No employee profile" message="Your login is not linked to an employee record. Ask HR to link it." /></View>;
  }

  // HR sees the whole company from this endpoint and reviews it under
  // Approvals; here it is the person's own leave plus, for a reporting
  // manager, their direct reports' requests.
  const rows = (list.data?.pages.flatMap((page) => page.rows) ?? [])
    .filter((leave) => !caps.manageWorkforce || leave.empId === user.employeeId);

  const confirmWithdraw = (leave: Leave) => {
    const approved = leave.status === 'approved';
    Alert.alert(
      approved ? 'Cancel this leave?' : 'Withdraw this request?',
      approved ? 'The days are returned to your balance and the leave is removed from your attendance.' : 'The reserved days are returned to your balance.',
      [{ text: 'Keep', style: 'cancel' }, { text: approved ? 'Cancel leave' : 'Withdraw', style: 'destructive', onPress: () => withdraw.mutate(leave.id) }],
    );
  };

  return (
    <View style={layout.screen}>
      <FlatList
        contentContainerStyle={[layout.content, { paddingBottom: 96 }]}
        data={rows}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={(
          <View>
            <LeaveBalanceStrip />
            {actionError ? <Banner message={actionError} /> : null}
            <View style={{ marginBottom: spacing.md }}><Segmented value={filter} onChange={setFilter} options={FILTERS} /></View>
          </View>
        )}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={refreshLeave} colors={[colors.primary]} />}
        onEndReached={() => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); }}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => {
          const own = item.empId === user.employeeId;
          return (
            <LeaveCard
              leave={item}
              showName={!own}
              action={own && ['pending', 'approved'].includes(item.status)
                ? { label: item.status === 'approved' ? 'Cancel leave' : 'Withdraw', onPress: () => confirmWithdraw(item) }
                : !own && item.status === 'pending' ? { label: 'Review', onPress: () => setDeciding(item) } : undefined}
            />
          );
        }}
        ListFooterComponent={list.isFetchingNextPage ? <Loading label="Loading more…" /> : null}
        ListEmptyComponent={
          list.isLoading ? <Loading />
            : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
            : <EmptyState icon="calendar-outline" title="No leave requests" message="Requests you file appear here with their status." />
        }
      />
      <Pressable style={styles.fab} onPress={() => navigation.navigate('ApplyLeave')} accessibilityRole="button" accessibilityLabel="Apply for leave" android_ripple={{ color: 'rgba(255,255,255,0.3)' }}>
        <Ionicons name="add" size={22} color="#FFFFFF" />
        <Text style={styles.fabLabel}>Apply</Text>
      </Pressable>
      <LeaveDecisionSheet leave={deciding} onClose={() => setDeciding(null)} onDecided={refreshLeave} />
    </View>
  );
}

export function LeaveCard({ leave, showName, action }: { leave: Leave; showName?: boolean; action?: { label: string; onPress: () => void } }) {
  const status = leaveStatus(leave.status);
  const stage = leave.status === 'pending' ? leave.approvalStages?.[leave.currentStage ?? 0] : undefined;
  return (
    <Card style={{ paddingVertical: spacing.md }}>
      <View style={layout.rowBetween}>
        <Text style={[type.body, { fontWeight: '600', flex: 1, marginRight: spacing.sm }]} numberOfLines={1}>
          {showName ? `${leave.name ?? 'Employee'} · ` : ''}{titleCase(leave.type)} leave
        </Text>
        <Chip label={status.label} tone={status.tone} />
      </View>
      <Text style={[type.caption, { marginTop: spacing.sm }]}>
        {formatRange(leave.start, leave.end)} · {leave.isHalfDay ? `Half day (${leave.halfDayTiming === 'second-half' ? 'second half' : 'first half'})` : `${leave.workingDays ?? 0} working day${leave.workingDays === 1 ? '' : 's'}`}
      </Text>
      {leave.reason ? <Text style={[type.caption, { marginTop: 2 }]} numberOfLines={3}>{leave.reason}</Text> : null}
      {stage ? <Text style={[type.caption, { marginTop: 2 }]}>Waiting for {stage}</Text> : null}
      {leave.status === 'declined' && leave.declineReason ? (
        <View style={{ marginTop: spacing.sm }}><Banner tone="danger" message={`Reason: ${leave.declineReason}`} /></View>
      ) : null}
      {action ? <Button label={action.label} variant="secondary" onPress={action.onPress} style={{ marginTop: spacing.md, minHeight: 42 }} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute', right: spacing.lg, bottom: spacing.lg, flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.primary, borderRadius: 28, paddingHorizontal: spacing.lg, height: 52, elevation: 4, overflow: 'hidden',
  },
  fabLabel: { color: '#FFFFFF', fontWeight: '700', marginLeft: 6, fontSize: 15 },
});
