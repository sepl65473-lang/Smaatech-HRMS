import React, { useEffect, useLayoutEffect } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { notificationsApi } from '../../services/endpoints';
import { errorMessage } from '../../services/api';
import { keys, useNotifications } from '../../hooks/queries';
import { requestPermission } from '../../notifications/local';
import { EmptyState, ErrorState, Loading, layout } from '../../components/ui';
import { colors, radius, spacing, type } from '../../theme';
import { timeAgo } from '../../utils/date';
import type { AppNotification } from '../../types';

const ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  leave: 'calendar-outline',
  payroll: 'wallet-outline',
  celebration: 'gift-outline',
  system: 'information-circle-outline',
};

// The HRMS in-app inbox (GET /notifications): items addressed to this user
// plus company-wide announcements.
export function NotificationsScreen() {
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const list = useNotifications();
  const unread = list.data?.some((n) => !n.read) ?? false;

  const setRead = (ids: string[] | 'all') => {
    queryClient.setQueryData<AppNotification[]>(keys.notifications, (current) =>
      current?.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)));
  };

  const markOne = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onMutate: (id) => setRead([id]),
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });
  const markAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onMutate: () => setRead('all'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });

  // Asked here, where its purpose is obvious, rather than at first launch.
  useEffect(() => {
    void requestPermission();
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (unread ? (
        <Pressable onPress={() => markAll.mutate()} hitSlop={10} style={{ marginRight: spacing.lg }} accessibilityRole="button">
          <Text style={{ color: colors.primary, fontWeight: '600' }}>Mark all read</Text>
        </Pressable>
      ) : null),
    });
  }, [navigation, unread, markAll]);

  return (
    <FlatList
      style={layout.screen}
      contentContainerStyle={layout.content}
      data={list.data ?? []}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} colors={[colors.primary]} />}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => { if (!item.read) markOne.mutate(item.id); }}
          style={[styles.item, !item.read && styles.unread]}
          accessibilityRole="button"
          accessibilityLabel={`${item.read ? '' : 'Unread. '}${item.title}. ${item.message}`}
        >
          <Ionicons name={ICONS[item.type] ?? 'notifications-outline'} size={22} color={colors.primary} style={{ marginTop: 2 }} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={[type.body, { fontWeight: item.read ? '500' : '700' }]}>{item.title}</Text>
            <Text style={[type.caption, { marginTop: 2, lineHeight: 18 }]}>{item.message}</Text>
            <Text style={[type.caption, { marginTop: 4 }]}>{timeAgo(item.createdAt)}</Text>
          </View>
          {!item.read ? <View style={styles.dot} /> : null}
        </Pressable>
      )}
      ListEmptyComponent={
        list.isLoading ? <Loading />
          : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
          : <EmptyState icon="notifications-off-outline" title="You're all caught up" message="Leave decisions, payroll updates and announcements appear here." />
      }
    />
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, padding: spacing.lg, marginBottom: spacing.sm,
  },
  unread: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginLeft: spacing.sm, marginTop: 6 },
});
