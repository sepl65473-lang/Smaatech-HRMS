import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { payrollApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { PayslipSheet } from '../employee/PayslipsScreen';
import { MonthSwitcher } from './ReportsScreen';
import { Card, Chip, EmptyState, ErrorState, Loading, Stat, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { formatMonth, monthKeyIST } from '../../utils/date';
import { formatINR, payrollStatus } from '../../utils/format';
import type { Payroll } from '../../types';

// Payroll rows for one cycle (GET /payroll?cycle=), for the roles the server
// lets see all payroll. Read-only: running, editing, paying and unlocking
// payroll are deliberate desk tasks and stay on the web.
export function PayrollOverviewScreen() {
  const [cycle, setCycle] = useState(monthKeyIST());
  const [selected, setSelected] = useState<Payroll | null>(null);

  const list = useInfiniteQuery({
    queryKey: keys.payroll(cycle),
    queryFn: ({ pageParam }) => payrollApi.list({ page: pageParam, cycle }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.rows) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  const loadedNet = rows.reduce((sum, row) => sum + (row.net || 0), 0);
  const paid = rows.filter((row) => row.status === 'paid').length;

  return (
    <View style={layout.screen}>
      <FlatList
        contentContainerStyle={layout.content}
        data={rows}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} colors={[colors.primary]} />}
        onEndReached={() => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={(
          <View>
            <MonthSwitcher month={cycle} onChange={setCycle} />
            {rows.length ? (
              <>
                <View style={[layout.statRow, { marginBottom: spacing.sm }]}>
                  <Stat label="Payslips" value={total} />
                  <Stat label={list.hasNextPage ? 'Paid (loaded)' : 'Paid'} value={paid} tone="success" />
                  <Stat label={list.hasNextPage ? 'Net (loaded)' : 'Net payout'} value={formatINR(loadedNet)} tone="info" />
                </View>
                {list.hasNextPage ? <Text style={[type.caption, { marginBottom: spacing.md }]}>Totals cover the {rows.length} rows loaded so far. Scroll to load the rest.</Text> : <View style={{ height: spacing.sm }} />}
              </>
            ) : null}
          </View>
        )}
        renderItem={({ item }) => {
          const status = payrollStatus(item.status);
          return (
            <Card onPress={() => setSelected(item)} style={{ paddingVertical: spacing.md }}>
              <View style={layout.rowBetween}>
                <Text style={[type.body, { fontWeight: '600', flex: 1, marginRight: spacing.sm }]} numberOfLines={1}>{item.name}</Text>
                <Chip label={status.label} tone={status.tone} />
              </View>
              <View style={[layout.rowBetween, { marginTop: spacing.sm }]}>
                <Text style={type.caption} numberOfLines={1}>{item.dept || 'Unassigned'}</Text>
                <Text style={{ fontWeight: '700', color: colors.ink }}>{formatINR(item.net)}</Text>
              </View>
            </Card>
          );
        }}
        ListEmptyComponent={
          list.isLoading ? <Loading />
            : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
            : <EmptyState icon="wallet-outline" title="No payroll for this month" message={`Payroll for ${formatMonth(cycle)} has not been run.`} />
        }
      />
      <PayslipSheet slip={selected} onClose={() => setSelected(null)} />
    </View>
  );
}
