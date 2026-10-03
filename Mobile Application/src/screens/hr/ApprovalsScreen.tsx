import React, { useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../auth/AuthContext';
import { correctionsApi, leaveApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { LeaveCard } from '../employee/LeaveScreen';
import { LeaveDecisionSheet } from '../../components/LeaveDecisionSheet';
import { Banner, Button, Card, EmptyState, ErrorState, Field, Loading, Segmented, Sheet, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { formatDay, formatTime } from '../../utils/date';
import type { AttendanceCorrection, Leave } from '../../types';

type Tab = 'leave' | 'corrections';

// Pending leave requests and attendance corrections for HR. Each decision is
// one authenticated call; the server enforces who may decide which stage.
export function ApprovalsScreen() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('leave');
  const [leave, setLeave] = useState<Leave | null>(null);
  const [correction, setCorrection] = useState<AttendanceCorrection | null>(null);

  const leaves = useInfiniteQuery({
    queryKey: keys.leaves('approvals'),
    queryFn: ({ pageParam }) => leaveApi.list({ page: pageParam, status: 'pending' }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const corrections = useQuery({
    queryKey: keys.corrections,
    queryFn: correctionsApi.list,
    select: (rows) => rows.filter((row) => row.status === 'Pending'),
  });

  // Nobody approves their own request from here; another approver does.
  const leaveRows = (leaves.data?.pages.flatMap((page) => page.rows) ?? []).filter((row) => row.empId !== user.employeeId);

  const refreshLeave = () => {
    void queryClient.invalidateQueries({ queryKey: ['leaves'] });
    void queryClient.invalidateQueries({ queryKey: ['leaveBalance'] });
  };
  const refreshCorrections = () => {
    void queryClient.invalidateQueries({ queryKey: keys.corrections });
    void queryClient.invalidateQueries({ queryKey: ['attendance'] });
  };

  const header = (
    <View style={{ marginBottom: spacing.md }}>
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'leave', label: `Leave${leaves.data ? ` (${leaveRows.length}${leaves.hasNextPage ? '+' : ''})` : ''}` },
          { value: 'corrections', label: `Corrections${corrections.data ? ` (${corrections.data.length})` : ''}` },
        ]}
      />
    </View>
  );

  return (
    <View style={layout.screen}>
      {tab === 'leave' ? (
        <FlatList
          contentContainerStyle={layout.content}
          data={leaveRows}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          refreshControl={<RefreshControl refreshing={leaves.isRefetching && !leaves.isFetchingNextPage} onRefresh={refreshLeave} colors={[colors.primary]} />}
          onEndReached={() => { if (leaves.hasNextPage && !leaves.isFetchingNextPage) void leaves.fetchNextPage(); }}
          onEndReachedThreshold={0.4}
          renderItem={({ item }) => <LeaveCard leave={item} showName action={{ label: 'Review', onPress: () => setLeave(item) }} />}
          ListEmptyComponent={
            leaves.isLoading ? <Loading />
              : leaves.isError ? <ErrorState message={errorMessage(leaves.error)} onRetry={() => void leaves.refetch()} />
              : <EmptyState icon="checkmark-done-outline" title="No leave requests waiting" />
          }
        />
      ) : (
        <FlatList
          contentContainerStyle={layout.content}
          data={corrections.data ?? []}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          refreshControl={<RefreshControl refreshing={corrections.isRefetching} onRefresh={refreshCorrections} colors={[colors.primary]} />}
          renderItem={({ item }) => (
            <Card style={{ paddingVertical: spacing.md }}>
              <Text style={[type.body, { fontWeight: '600' }]}>{item.employeeName}</Text>
              <Text style={[type.caption, { marginTop: 4 }]}>
                {formatDay(item.date)} · {formatTime(item.requestedCheckIn)} – {formatTime(item.requestedCheckOut)}
              </Text>
              <Text style={[type.caption, { marginTop: 2 }]} numberOfLines={3}>{item.reason}</Text>
              <Button label="Review" variant="secondary" onPress={() => setCorrection(item)} style={{ marginTop: spacing.md, minHeight: 42 }} />
            </Card>
          )}
          ListEmptyComponent={
            corrections.isLoading ? <Loading />
              : corrections.isError ? <ErrorState message={errorMessage(corrections.error)} onRetry={() => void corrections.refetch()} />
              : <EmptyState icon="checkmark-done-outline" title="No corrections waiting" />
          }
        />
      )}
      <LeaveDecisionSheet leave={leave} onClose={() => setLeave(null)} onDecided={refreshLeave} />
      <CorrectionSheet correction={correction} onClose={() => setCorrection(null)} onDecided={refreshCorrections} />
    </View>
  );
}

function CorrectionSheet({ correction, onClose, onDecided }: { correction: AttendanceCorrection | null; onClose: () => void; onDecided: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decision === 'approve' ? correctionsApi.approve(correction!.id) : correctionsApi.reject(correction!.id, note.trim()),
    onSuccess: () => { setNote(''); setError(null); onDecided(); onClose(); },
    onError: (err) => { setError(errorMessage(err)); onDecided(); },
  });

  const reject = () => {
    if (note.trim().length < 3) return setError('Give a reason so the employee knows why it was rejected.');
    setError(null);
    decide.mutate('reject');
  };

  return (
    <Sheet visible={Boolean(correction)} title="Attendance correction" onClose={decide.isPending ? () => undefined : () => { setNote(''); setError(null); onClose(); }}>
      {correction ? (
        <View>
          <Text style={type.body}>{correction.employeeName}</Text>
          <Text style={[type.caption, { marginTop: 2 }]}>
            {formatDay(correction.date)} · {formatTime(correction.requestedCheckIn)} – {formatTime(correction.requestedCheckOut)}
          </Text>
          <Text style={[type.caption, { marginTop: spacing.sm, marginBottom: spacing.lg }]}>{correction.reason}</Text>
          <Text style={[type.caption, { marginBottom: spacing.lg }]}>
            Approving writes these times to the attendance record; the status is recalculated from the shift.
          </Text>
          {error ? <Banner message={error} /> : null}
          <Field label="Note (required to reject)" value={note} onChangeText={setNote} multiline maxLength={500} />
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Button label="Reject" variant="danger" onPress={reject} loading={decide.isPending && decide.variables === 'reject'} disabled={decide.isPending} style={{ flex: 1 }} />
            <Button label="Approve" onPress={() => { setError(null); decide.mutate('approve'); }} loading={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}
