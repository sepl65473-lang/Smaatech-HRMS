import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../auth/AuthContext';
import { roleLabel } from '../../auth/permissions';
import { faceApi } from '../../services/endpoints';
import { keys, useMyEmployee } from '../../hooks/queries';
import { getReminderTime, setReminderTime } from '../../notifications/local';
import { Avatar, Banner, Button, Card, Chip, Row, SectionTitle, layout } from '../../components/ui';
import { colors, spacing, type } from '../../theme';
import { APP_VERSION } from '../../config/env';
import { formatDate, formatTime, toHHMM } from '../../utils/date';
import { dateAt, pickTime } from '../../utils/pickers';
import type { RootNav } from '../../navigation/types';

// The "Profile" tab for employees and the "More" tab for HR, Admin and
// Finance, who reach their own self-service screens from here.
export function ProfileScreen() {
  const navigation = useNavigation<RootNav>();
  const { user, caps, signOut } = useSession();
  const me = useMyEmployee(user.employeeId);
  const face = useQuery({ queryKey: keys.faceStatus, queryFn: faceApi.status, enabled: caps.hasEmployeeProfile });
  const [reminder, setReminder] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const employee = me.data;
  const selfService = caps.workspace !== 'employee' && caps.hasEmployeeProfile;

  useEffect(() => {
    void getReminderTime().then(setReminder);
  }, []);

  const changeReminder = async (time: string | null) => {
    const ok = await setReminderTime(time);
    if (ok) {
      setReminder(time);
      setNotice(null);
    } else {
      setNotice('Notifications are turned off for this app. Enable them in Android settings to get a reminder.');
    }
  };

  const confirmSignOut = () => {
    Alert.alert('Sign out?', 'You will need your password to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          setSigningOut(true);
          void signOut();
        },
      },
    ]);
  };

  return (
    <ScrollView style={layout.screen} contentContainerStyle={layout.content}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Avatar name={user.name} photo={employee?.photo} size={60} />
          <View style={{ flex: 1, marginLeft: spacing.lg }}>
            <Text style={type.title} numberOfLines={1}>{user.name}</Text>
            <Text style={type.caption} numberOfLines={1}>{user.email}</Text>
            <View style={{ marginTop: 6 }}><Chip label={roleLabel(user.role)} tone="primary" /></View>
          </View>
        </View>
      </Card>

      {notice ? <Banner tone="warning" message={notice} /> : null}

      {employee ? (
        <>
          <SectionTitle title="Employment" />
          <Card style={{ paddingVertical: spacing.sm }}>
            <Detail label="Designation" value={employee.role} />
            <Detail label="Department" value={employee.dept} />
            <Detail label="Location" value={employee.loc} />
            <Detail label="Employment type" value={employee.employmentType} />
            <Detail label="Stage" value={employee.employmentStage} />
            <Detail label="Joined" value={employee.joinDate ? formatDate(employee.joinDate) : undefined} />
            <Detail label="Phone" value={employee.phone} />
            <Detail label="Emergency contact" value={[employee.emergencyContact?.name, employee.emergencyContact?.phone].filter(Boolean).join(' · ')} />
          </Card>
          <Text style={[type.caption, { marginBottom: spacing.md }]}>To change these details, contact HR or use the web HRMS.</Text>
        </>
      ) : null}

      {selfService ? (
        <>
          <SectionTitle title="My self-service" />
          <Card style={{ paddingVertical: 0 }}>
            <Row icon="finger-print-outline" title="My attendance" onPress={() => navigation.navigate('MyAttendance')} />
            <Row icon="calendar-outline" title="My leave" onPress={() => navigation.navigate('MyLeave')} />
          </Card>
        </>
      ) : null}

      <SectionTitle title={caps.workspace === 'employee' ? 'My records' : 'Records'} />
      <Card style={{ paddingVertical: 0 }}>
        {caps.hasEmployeeProfile ? <Row icon="wallet-outline" title="My payslips" onPress={() => navigation.navigate('Payslips')} /> : null}
        <Row icon="document-text-outline" title="Documents" onPress={() => navigation.navigate('Documents')} />
        <Row icon="sunny-outline" title="Holidays" onPress={() => navigation.navigate('Holidays')} />
        {caps.viewReports ? <Row icon="bar-chart-outline" title="Reports" onPress={() => navigation.navigate('Reports')} /> : null}
        {caps.workspace === 'hr' && caps.viewAllPayroll ? <Row icon="cash-outline" title="Payroll overview" onPress={() => navigation.navigate('PayrollOverview')} /> : null}
      </Card>

      {caps.hasEmployeeProfile ? (
        <>
          <SectionTitle title="Attendance" />
          <Card style={{ paddingVertical: 0 }}>
            <Row
              icon="scan-outline"
              title="Face verification"
              subtitle={face.isLoading ? 'Checking…' : face.data?.enrolled
                ? (face.data.canEnrol ? 'Enrolled · HR has allowed you to re-verify' : 'Enrolled · ask HR to allow re-verification')
                : 'Not enrolled yet · required to check in'}
              onPress={face.data?.canEnrol ? () => navigation.navigate('FaceCapture', { mode: 'enroll' }) : undefined}
              right={face.data && !face.data.canEnrol ? <Chip label="Enrolled" tone="success" /> : undefined}
            />
            <Row
              icon="alarm-outline"
              title="Daily check-in reminder"
              subtitle={reminder ? `Every day at ${formatTime(reminder)}` : 'Off'}
              onPress={reminder ? () => pickTime({ value: dateAt(reminder), onPick: (d) => void changeReminder(toHHMM(d)) }) : undefined}
              right={(
                <Switch
                  value={Boolean(reminder)}
                  onValueChange={(on) => void changeReminder(on ? '08:45' : null)}
                  trackColor={{ true: colors.primary }}
                  accessibilityLabel="Daily check-in reminder"
                />
              )}
            />
          </Card>
        </>
      ) : null}

      <SectionTitle title="Account" />
      <Card style={{ paddingVertical: 0 }}>
        <Row icon="key-outline" title="Change password" onPress={() => navigation.navigate('ChangePassword')} />
      </Card>

      <Button label="Sign out" variant="secondary" icon="log-out-outline" onPress={confirmSignOut} loading={signingOut} style={{ marginTop: spacing.sm }} />
      <Text style={[type.caption, { textAlign: 'center', marginTop: spacing.lg }]}>Smaatech HRMS · Version {APP_VERSION}</Text>
    </ScrollView>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={[layout.rowBetween, { paddingVertical: 10 }]}>
      <Text style={type.caption}>{label}</Text>
      <Text style={[type.body, { flex: 1, textAlign: 'right', marginLeft: spacing.lg }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}
