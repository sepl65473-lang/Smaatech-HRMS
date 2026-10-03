import React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { holidaysApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Card, Chip, EmptyState, ErrorState, Loading, Row, layout } from '../../components/ui';
import { colors } from '../../theme';

export function HolidaysScreen() {
  const holidays = useQuery({ queryKey: keys.holidays, queryFn: holidaysApi.list, staleTime: 60 * 60_000 });

  return (
    <FlatList
      style={layout.screen}
      contentContainerStyle={layout.content}
      data={holidays.data ?? []}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={holidays.isRefetching} onRefresh={() => void holidays.refetch()} colors={[colors.primary]} />}
      renderItem={({ item }) => (
        <Card style={{ paddingVertical: 0 }}>
          {/* Holiday.date is the display string the web stores, e.g. "7 Jun, Sun". */}
          <Row icon="sunny-outline" title={item.name} subtitle={item.date} right={<Chip label={item.type} tone="primary" />} />
        </Card>
      )}
      ListEmptyComponent={
        holidays.isLoading ? <Loading />
          : holidays.isError ? <ErrorState message={errorMessage(holidays.error)} onRetry={() => void holidays.refetch()} />
          : <EmptyState icon="sunny-outline" title="No holidays listed" />
      }
    />
  );
}
