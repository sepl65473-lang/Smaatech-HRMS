import React, { useEffect, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSession } from '../../auth/AuthContext';
import { payrollApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Loading, Sheet, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { formatMonth } from '../../utils/date';
import { formatINR, payrollStatus } from '../../utils/format';
import { createPayslipPdf, openFile, shareFile } from '../../utils/files';
import type { Payroll } from '../../types';

const OWN_SCAN_PAGES = 6;

export function PayslipsScreen() {
  const { user, caps } = useSession();
  const [selected, setSelected] = useState<Payroll | null>(null);

  const list = useInfiniteQuery({
    queryKey: keys.payroll('mine'),
    queryFn: ({ pageParam }) => payrollApi.list({ page: pageParam, limit: caps.viewAllPayroll ? 100 : 25 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
    enabled: caps.hasEmployeeProfile,
  });

  // Roles that can see all payroll get every employee's rows back and there
  // is no per-employee filter, so keep loading, within a bound, to reach the
  // person's own recent payslips.
  const { hasNextPage, isFetching, fetchNextPage } = list;
  const loadedPages = list.data?.pages.length ?? 0;
  const scanning = caps.viewAllPayroll && Boolean(hasNextPage) && loadedPages < OWN_SCAN_PAGES;
  useEffect(() => {
    if (scanning && !isFetching) void fetchNextPage();
  }, [scanning, isFetching, fetchNextPage]);

  const rows = (list.data?.pages.flatMap((page) => page.rows) ?? [])
    .filter((row) => row.empId === user.employeeId)
    .sort((a, b) => b.cycle.localeCompare(a.cycle));

  if (!caps.hasEmployeeProfile) {
    return <View style={layout.screen}><EmptyState icon="person-outline" title="No employee profile" message="Payslips are available once HR links your login to an employee record." /></View>;
  }

  return (
    <View style={layout.screen}>
      <FlatList
        contentContainerStyle={layout.content}
        data={rows}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} colors={[colors.primary]} />}
        onEndReached={() => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); }}
        onEndReachedThreshold={0.4}
        ListFooterComponent={caps.viewAllPayroll && list.hasNextPage && !scanning && rows.length ? <Text style={[type.caption, { textAlign: 'center' }]}>Showing your recent payslips. Older ones are on the web HRMS.</Text> : null}
        renderItem={({ item }) => {
          const status = payrollStatus(item.status);
          return (
            <Card onPress={() => setSelected(item)} style={{ paddingVertical: spacing.md }}>
              <View style={layout.rowBetween}>
                <Text style={[type.body, { fontWeight: '600' }]}>{formatMonth(item.cycle)}</Text>
                <Chip label={status.label} tone={status.tone} />
              </View>
              <View style={[layout.rowBetween, { marginTop: spacing.sm }]}>
                <Text style={type.caption}>Net pay</Text>
                <Text style={{ fontSize: 17, fontWeight: '700', color: colors.ink }}>{formatINR(item.net)}</Text>
              </View>
            </Card>
          );
        }}
        ListEmptyComponent={
          list.isLoading || scanning ? <Loading />
            : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
            : <EmptyState icon="wallet-outline" title="No payslips yet" message="Your payslip appears here once payroll is processed." />
        }
      />
      <PayslipSheet slip={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

export function PayslipSheet({ slip, onClose }: { slip: Payroll | null; onClose: () => void }) {
  const [busy, setBusy] = useState<'open' | 'share' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: 'open' | 'share') => {
    if (!slip) return;
    setBusy(action);
    setError(null);
    try {
      const uri = await createPayslipPdf(slip);
      await (action === 'open' ? openFile(uri) : shareFile(uri));
    } catch {
      setError('Could not create the payslip PDF. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const earnings = slip?.components?.earnings?.length ? slip.components.earnings : slip ? [{ name: 'Gross salary', amount: slip.gross }] : [];
  const deductions = slip?.components?.deductions?.length ? slip.components.deductions : slip ? [{ name: 'Deductions', amount: slip.deductions }] : [];

  return (
    <Sheet visible={Boolean(slip)} title={slip ? `${formatMonth(slip.cycle)} payslip` : ''} onClose={onClose}>
      {slip ? (
        <View>
          {error ? <Banner message={error} /> : null}
          <Text style={type.label}>Earnings</Text>
          {earnings.map((e, i) => <Line key={`e${i}`} label={e.name || 'Earning'} value={formatINR(e.amount)} />)}
          <Line label="Gross" value={formatINR(slip.gross)} bold />
          <View style={{ height: spacing.md }} />
          <Text style={type.label}>Deductions</Text>
          {deductions.map((d, i) => <Line key={`d${i}`} label={d.name || 'Deduction'} value={formatINR(d.amount)} />)}
          {(slip.lopDays ?? 0) > 0 ? <Line label={`Loss of pay (${slip.lopDays} day${slip.lopDays === 1 ? '' : 's'})`} value={formatINR(slip.lopAmount)} /> : null}
          <Line label="Total deductions" value={formatINR(slip.deductions)} bold />
          <View style={{ height: spacing.md }} />
          <Line label="Net pay" value={formatINR(slip.net)} bold large />
          <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
            <Button label="Share" variant="secondary" icon="share-social-outline" onPress={() => void run('share')} loading={busy === 'share'} disabled={busy !== null} style={{ flex: 1 }} />
            <Button label="Open PDF" icon="document-outline" onPress={() => void run('open')} loading={busy === 'open'} disabled={busy !== null} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

function Line({ label, value, bold, large }: { label: string; value: string; bold?: boolean; large?: boolean }) {
  const weight = bold ? '700' as const : '400' as const;
  return (
    <View style={[layout.rowBetween, { paddingVertical: 6 }]}>
      <Text style={{ color: colors.inkSoft, fontWeight: weight, fontSize: large ? 16 : 14, flex: 1, marginRight: spacing.md }} numberOfLines={2}>{label}</Text>
      <Text style={{ color: colors.ink, fontWeight: weight, fontSize: large ? 18 : 14 }}>{value}</Text>
    </View>
  );
}
