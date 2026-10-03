import React, { useEffect, useState } from 'react';
import { FlatList, RefreshControl, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { employeesApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Avatar, Card, EmptyState, ErrorState, Loading, Row, layout } from '../../components/ui';
import { colors, radius, spacing } from '../../theme';
import type { RootNav } from '../../navigation/types';

// The people directory (GET /employees, server-side search and paging).
// Creating and editing employees stays on the web.
export function PeopleScreen() {
  const navigation = useNavigation<RootNav>();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');

  // One request per pause in typing, not per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 350);
    return () => clearTimeout(timer);
  }, [input]);

  const list = useInfiniteQuery({
    queryKey: keys.people(search),
    queryFn: ({ pageParam }) => employeesApi.search({ page: pageParam, search: search || undefined }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
    staleTime: 2 * 60_000,
  });
  const rows = list.data?.pages.flatMap((page) => page.rows) ?? [];

  return (
    <View style={layout.screen}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Search name, designation, department"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Search employees"
          autoCorrect={false}
          returnKeyType="search"
          style={{ minHeight: 46, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, color: colors.ink }}
        />
      </View>
      <FlatList
        contentContainerStyle={layout.content}
        data={rows}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} colors={[colors.primary]} />}
        onEndReached={() => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); }}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <Card style={{ paddingVertical: 0 }} onPress={() => navigation.navigate('EmployeeDetail', { id: item.id })}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Avatar name={item.name} photo={item.photo} size={40} />
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <Row title={item.name} subtitle={[item.role, item.dept].filter(Boolean).join(' · ')} right={null} />
              </View>
            </View>
          </Card>
        )}
        ListFooterComponent={list.isFetchingNextPage ? <Loading label="Loading more…" /> : null}
        ListEmptyComponent={
          list.isLoading ? <Loading />
            : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
            : <EmptyState icon="search-outline" title="No employees found" message={search ? `Nothing matches "${search}".` : undefined} />
        }
      />
    </View>
  );
}
