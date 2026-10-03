import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { attendanceApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Banner, Card, Chip, EmptyState, ErrorState, Loading, Segmented, layout } from '../../components/ui';
import { colors, radius, spacing, type } from '../../theme';
import { formatTime, formatWorked, todayIST } from '../../utils/date';
import { attendanceStatus } from '../../utils/format';
import type { StackProps } from '../../navigation/types';
import type { Attendance } from '../../types';

type Filter = 'all' | 'in' | 'late' | 'notIn' | 'leave' | 'flagged';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'notIn', label: 'Not in' }, { value: 'late', label: 'Late' },
  { value: 'in', label: 'Checked in' }, { value: 'leave', label: 'On leave' }, { value: 'flagged', label: 'Exceptions' },
];

const isFlagged = (row: Attendance) => (row.anomalyFlags?.length ?? 0) > 0 || (row.failedVerificationCount ?? 0) > 0;

const MATCHES: Record<Filter, (row: Attendance) => boolean> = {
  all: () => true,
  in: (row) => Boolean(row.checkIn),
  late: (row) => row.status === 'late',
  notIn: (row) => row.status === 'absent' && !row.checkIn,
  leave: (row) => row.status === 'leave',
  flagged: isFlagged,
};

// Today's company attendance for HR (GET /attendance?date=). Monitoring only:
// manual overrides and the verification dossier stay on the web.
export function TeamAttendanceScreen({ navigation }: StackProps<'TeamAttendance'>) {
  const today = todayIST();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const roster = useQuery({ queryKey: keys.attendanceDay(today), queryFn: () => attendanceApi.byDate(today), staleTime: 2 * 60_000 });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (roster.data?.rows ?? [])
      .filter(MATCHES[filter])
      .filter((row) => !needle || `${row.name ?? ''} ${row.dept ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [roster.data, filter, search]);

  const truncated = roster.data ? roster.data.total > roster.data.rows.length : false;

  return (
    <FlatList
      style={layout.screen}
      contentContainerStyle={layout.content}
      data={rows}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={roster.isRefetching} onRefresh={() => void roster.refetch()} colors={[colors.primary]} />}
      ListHeaderComponent={(
        <View style={{ marginBottom: spacing.md }}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name or department"
            placeholderTextColor={colors.muted}
            accessibilityLabel="Search name or department"
            style={{ minHeight: 46, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, color: colors.ink, marginBottom: spacing.sm }}
          />
          <Segmented value={filter} onChange={setFilter} options={FILTERS} />
          {truncated ? <View style={{ marginTop: spacing.sm }}><Banner tone="warning" message={`Showing the first ${roster.data?.rows.length} of ${roster.data?.total} records. Use the web HRMS for the full roster.`} /></View> : null}
        </View>
      )}
      renderItem={({ item }) => {
        const notIn = item.status === 'absent' && !item.checkIn;
        const status = attendanceStatus(item.status);
        return (
          <Card onPress={() => navigation.navigate('EmployeeDetail', { id: item.empId })} style={{ paddingVertical: spacing.md }}>
            <View style={layout.rowBetween}>
              <Text style={[type.body, { fontWeight: '600', flex: 1, marginRight: spacing.sm }]} numberOfLines={1}>{item.name}</Text>
              <Chip label={notIn ? 'Not in' : status.label} tone={notIn ? 'danger' : status.tone} />
            </View>
            <Text style={[type.caption, { marginTop: 4 }]} numberOfLines={1}>
              {item.dept || 'Unassigned'}
              {item.checkIn ? `  ·  ${formatTime(item.checkIn)} – ${formatTime(item.checkOut)}` : ''}
              {item.workedMinutes != null ? `  ·  ${formatWorked(item.workedMinutes)}` : ''}
            </Text>
            {item.checkInAddress ? <Text style={[type.caption, { marginTop: 2 }]} numberOfLines={1}>{item.checkInAddress}</Text> : null}
            {isFlagged(item) ? (
              <Text style={[type.caption, { color: colors.danger, marginTop: 4 }]}>
                {[
                  item.anomalyFlags?.includes('shared-device') ? 'Device shared with another employee' : null,
                  item.failedVerificationCount ? `${item.failedVerificationCount} failed verification attempt(s)` : null,
                ].filter(Boolean).join(' · ') || 'Verification exception'}
              </Text>
            ) : null}
          </Card>
        );
      }}
      ListEmptyComponent={
        roster.isLoading ? <Loading />
          : roster.isError ? <ErrorState message={errorMessage(roster.error)} onRetry={() => void roster.refetch()} />
          : <EmptyState icon="people-outline" title="Nobody matches" message="Try another filter or search." />
      }
    />
  );
}
