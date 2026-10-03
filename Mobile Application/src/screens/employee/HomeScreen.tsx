import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../auth/AuthContext';
import { keys, useLeaveBalance, useMyEmployee, useNotifications } from '../../hooks/queries';
import { leaveApi } from '../../services/endpoints';
import { TodayCard } from '../../components/TodayCard';
import { Avatar, Banner, Card, Row, SectionTitle, layout } from '../../components/ui';
import { colors, radius, spacing, type } from '../../theme';
import { greeting, timeAgo } from '../../utils/date';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { RootNav, TabParamList } from '../../navigation/types';

type Nav = CompositeNavigationProp<BottomTabNavigationProp<TabParamList, 'Home'>, RootNav>;

export function ProfileHeader() {
  const { user } = useSession();
  const me = useMyEmployee(user.employeeId);
  const employee = me.data;
  return (
    <View style={styles.header}>
      <Avatar name={user.name} photo={employee?.photo} size={52} />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text style={type.caption}>{greeting()}</Text>
        <Text style={type.title} numberOfLines={1}>{user.name}</Text>
        <Text style={type.caption} numberOfLines={1}>
          {[employee?.role || user.role, employee?.dept].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </View>
  );
}

export function LeaveBalanceStrip() {
  const { user } = useSession();
  const balance = useLeaveBalance(user.employeeId);
  const tracked = balance.data?.balances.filter((b) => b.balanceTracked) ?? [];
  if (!tracked.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}>
      {tracked.map((b) => (
        <View key={b.type} style={styles.balance}>
          <Text style={styles.balanceValue}>{b.available}</Text>
          <Text style={type.caption} numberOfLines={1}>{b.name}</Text>
          {b.pending > 0 ? <Text style={[type.caption, { color: colors.warning }]}>{b.pending} pending</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}

export function HomeScreen({ navigation }: { navigation: Nav }) {
  const { user, caps } = useSession();
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const pending = useQuery({
    queryKey: keys.leaves('pending'),
    queryFn: () => leaveApi.list({ page: 1, status: 'pending' }),
    enabled: caps.hasEmployeeProfile,
  });
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  };

  const myPending = pending.data?.rows.filter((l) => l.empId === user.employeeId).length ?? 0;
  // A reporting manager also receives their direct reports' requests.
  const teamPending = (pending.data?.rows.length ?? 0) - myPending;
  const latest = notifications.data?.filter((n) => !n.read).slice(0, 3) ?? [];

  return (
    <SafeAreaView style={layout.screen} edges={['top']}>
      <ScrollView contentContainerStyle={layout.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} />}>
        <ProfileHeader />

        {!caps.hasEmployeeProfile ? (
          <Banner tone="warning" message="Your login is not linked to an employee profile, so attendance, leave and payslips are unavailable. Ask HR to link your account." />
        ) : (
          <>
            <TodayCard />

            <SectionTitle title="Leave balance" action="Apply" onAction={() => navigation.navigate('ApplyLeave')} />
            <LeaveBalanceStrip />

            {myPending > 0 || teamPending > 0 ? (
              <Card onPress={() => navigation.navigate('Leave')}>
                {myPending > 0 ? <Row icon="hourglass-outline" title={`${myPending} leave request${myPending === 1 ? '' : 's'} awaiting approval`} /> : null}
                {teamPending > 0 ? <Row icon="people-outline" title={`${teamPending} team request${teamPending === 1 ? '' : 's'} need your decision`} /> : null}
              </Card>
            ) : null}

            <View style={styles.quick}>
              <Quick icon="wallet-outline" label="Payslips" onPress={() => navigation.navigate('Payslips')} />
              <Quick icon="document-text-outline" label="Documents" onPress={() => navigation.navigate('Documents')} />
              <Quick icon="sunny-outline" label="Holidays" onPress={() => navigation.navigate('Holidays')} />
              <Quick icon="create-outline" label="Correction" onPress={() => navigation.navigate('Correction')} />
            </View>
          </>
        )}

        {latest.length ? (
          <>
            <SectionTitle title="New for you" action="See all" onAction={() => navigation.navigate('Alerts')} />
            <Card>
              {latest.map((n) => (
                <Row key={n.id} icon="notifications-outline" title={n.title} subtitle={`${n.message}\n${timeAgo(n.createdAt)}`} />
              ))}
            </Card>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Quick({ icon, label, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.quickItem} android_ripple={{ color: colors.neutralSoft }} accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name={icon} size={24} color={colors.primary} />
      <Text style={[type.caption, { color: colors.inkSoft, marginTop: 6, fontWeight: '600' }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg, marginTop: spacing.sm },
  balance: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, minWidth: 124, maxWidth: 170,
  },
  balanceValue: { fontSize: 22, fontWeight: '700', color: colors.primaryDark },
  quick: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  quickItem: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', paddingVertical: spacing.md, minHeight: 76, justifyContent: 'center', overflow: 'hidden',
  },
});
