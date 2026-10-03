import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

export type TabParamList = {
  Home: undefined;
  Attendance: undefined;
  Leave: undefined;
  People: undefined;
  Approvals: undefined;
  Payroll: undefined;
  Alerts: undefined;
  Profile: undefined;
};

export type RootStackParamList = {
  Login: undefined;
  ForgotPassword: undefined;
  ForcePasswordChange: undefined;
  Tabs: undefined;
  FaceCapture: { mode: 'in' | 'out' | 'enroll'; attendanceId?: string };
  Correction: { date?: string } | undefined;
  ApplyLeave: undefined;
  Payslips: undefined;
  Documents: undefined;
  Holidays: undefined;
  ChangePassword: undefined;
  MyAttendance: undefined;
  MyLeave: undefined;
  TeamAttendance: undefined;
  EmployeeDetail: { id: string };
  Reports: undefined;
  PayrollOverview: undefined;
};

export type RootNav = NativeStackNavigationProp<RootStackParamList>;
export type StackProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
