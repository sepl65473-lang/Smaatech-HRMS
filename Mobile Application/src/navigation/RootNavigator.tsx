import React from 'react';
import { View } from 'react-native';
import { DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { colors } from '../theme';
import { ErrorState, Loading } from '../components/ui';
import { useNotifications } from '../hooks/queries';
import type { RootStackParamList, TabParamList } from './types';

import { LoginScreen } from '../screens/auth/LoginScreen';
import { ForgotPasswordScreen } from '../screens/auth/ForgotPasswordScreen';
import { ChangePasswordScreen } from '../screens/auth/ChangePasswordScreen';
import { HomeScreen } from '../screens/employee/HomeScreen';
import { AttendanceScreen } from '../screens/employee/AttendanceScreen';
import { FaceCaptureScreen } from '../screens/employee/FaceCaptureScreen';
import { CorrectionScreen } from '../screens/employee/CorrectionScreen';
import { LeaveScreen } from '../screens/employee/LeaveScreen';
import { ApplyLeaveScreen } from '../screens/employee/ApplyLeaveScreen';
import { PayslipsScreen } from '../screens/employee/PayslipsScreen';
import { DocumentsScreen } from '../screens/common/DocumentsScreen';
import { HolidaysScreen } from '../screens/common/HolidaysScreen';
import { NotificationsScreen } from '../screens/common/NotificationsScreen';
import { ProfileScreen } from '../screens/common/ProfileScreen';
import { WorkspaceHomeScreen } from '../screens/hr/WorkspaceHomeScreen';
import { PeopleScreen } from '../screens/hr/PeopleScreen';
import { EmployeeDetailScreen } from '../screens/hr/EmployeeDetailScreen';
import { TeamAttendanceScreen } from '../screens/hr/TeamAttendanceScreen';
import { ApprovalsScreen } from '../screens/hr/ApprovalsScreen';
import { ReportsScreen } from '../screens/hr/ReportsScreen';
import { PayrollOverviewScreen } from '../screens/hr/PayrollOverviewScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

const theme: Theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: colors.primary, background: colors.background, card: colors.surface, text: colors.ink, border: colors.border },
};

const TAB_ICONS: Record<keyof TabParamList, React.ComponentProps<typeof Ionicons>['name']> = {
  Home: 'home-outline',
  Attendance: 'finger-print-outline',
  Leave: 'calendar-outline',
  People: 'people-outline',
  Approvals: 'checkmark-done-outline',
  Payroll: 'wallet-outline',
  Alerts: 'notifications-outline',
  Profile: 'person-circle-outline',
};

// The tab set is chosen from the signed-in role. Hiding a tab is presentation
// only: the API refuses anything the role may not do.
function Tabs() {
  const { caps } = useAuth();
  const notifications = useNotifications();
  const unread = notifications.data?.filter((n) => !n.read).length ?? 0;
  const workspace = caps?.workspace ?? 'employee';

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerTitleStyle: { fontWeight: '700', color: colors.ink },
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 11.5, fontWeight: '600' },
        tabBarHideOnKeyboard: true,
        tabBarIcon: ({ color, size }) => <Ionicons name={TAB_ICONS[route.name]} size={size} color={color} />,
      })}
    >
      {workspace === 'employee' ? (
        <>
          <Tab.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
          <Tab.Screen name="Attendance" component={AttendanceScreen} />
          <Tab.Screen name="Leave" component={LeaveScreen} />
        </>
      ) : (
        <>
          <Tab.Screen name="Home" component={WorkspaceHomeScreen} options={{ headerShown: false }} />
          {workspace === 'hr' ? (
            <>
              <Tab.Screen name="People" component={PeopleScreen} />
              <Tab.Screen name="Approvals" component={ApprovalsScreen} />
            </>
          ) : (
            <Tab.Screen name="Payroll" component={PayrollOverviewScreen} />
          )}
        </>
      )}
      <Tab.Screen name="Alerts" component={NotificationsScreen} options={{ title: 'Notifications', tabBarLabel: 'Alerts', tabBarBadge: unread ? (unread > 99 ? '99+' : unread) : undefined }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarLabel: workspace === 'employee' ? 'Profile' : 'More' }} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  const { status, user, retryRestore } = useAuth();

  if (status === 'restoring') {
    return <View style={{ flex: 1, backgroundColor: colors.background }}><Loading label="Restoring your session…" /></View>;
  }
  if (status === 'unreachable') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ErrorState message="Could not reach the HRMS server. Check your connection and try again." onRetry={retryRestore} />
      </View>
    );
  }

  const stackOptions = {
    headerShadowVisible: false,
    headerStyle: { backgroundColor: colors.background },
    headerTitleStyle: { fontWeight: '700' as const, color: colors.ink },
    headerTintColor: colors.ink,
    contentStyle: { backgroundColor: colors.background },
  };

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={stackOptions}>
        {status !== 'signedIn' || !user ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
            <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} options={{ title: 'Reset password' }} />
          </>
        ) : user.mustChangePassword ? (
          // The API refuses everything else until the temporary password is
          // replaced (middleware/auth.js), so nothing else is reachable here.
          <Stack.Screen name="ForcePasswordChange" component={ChangePasswordScreen} options={{ title: 'Set a new password' }} />
        ) : (
          <>
            <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
            <Stack.Screen name="FaceCapture" component={FaceCaptureScreen} options={{ headerShown: false, animation: 'slide_from_bottom', gestureEnabled: false }} />
            <Stack.Screen name="Correction" component={CorrectionScreen} options={{ title: 'Attendance correction' }} />
            <Stack.Screen name="ApplyLeave" component={ApplyLeaveScreen} options={{ title: 'Apply for leave' }} />
            <Stack.Screen name="Payslips" component={PayslipsScreen} options={{ title: 'Payslips' }} />
            <Stack.Screen name="Documents" component={DocumentsScreen} options={{ title: 'Documents' }} />
            <Stack.Screen name="Holidays" component={HolidaysScreen} options={{ title: 'Holidays' }} />
            <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} options={{ title: 'Change password' }} />
            <Stack.Screen name="MyAttendance" component={AttendanceScreen} options={{ title: 'My attendance' }} />
            <Stack.Screen name="MyLeave" component={LeaveScreen} options={{ title: 'My leave' }} />
            <Stack.Screen name="TeamAttendance" component={TeamAttendanceScreen} options={{ title: 'Attendance today' }} />
            <Stack.Screen name="EmployeeDetail" component={EmployeeDetailScreen} options={{ title: 'Employee' }} />
            <Stack.Screen name="Reports" component={ReportsScreen} options={{ title: 'Reports' }} />
            <Stack.Screen name="PayrollOverview" component={PayrollOverviewScreen} options={{ title: 'Payroll' }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
