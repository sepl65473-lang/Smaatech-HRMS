import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Placeholder from './pages/Placeholder';
import { useHRMS } from './context/HRMSContext';
import { canAccess } from './lib/permissions';

// Code-split every page so the initial bundle stays small.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const MyDashboard = lazy(() => import('./pages/MyDashboard'));
const Employees = lazy(() => import('./pages/Employees'));
const EmployeeProfile = lazy(() => import('./pages/EmployeeProfile'));
const OrgChart = lazy(() => import('./pages/OrgChart'));
const Attendance = lazy(() => import('./pages/Attendance'));
const Leave = lazy(() => import('./pages/Leave'));
const Holidays = lazy(() => import('./pages/Holidays'));
const Payroll = lazy(() => import('./pages/Payroll'));
const Celebrations = lazy(() => import('./pages/Celebrations'));
const Recruitment = lazy(() => import('./pages/Recruitment'));
const Performance = lazy(() => import('./pages/Performance'));
const Documents = lazy(() => import('./pages/Documents'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Settings = lazy(() => import('./pages/Settings'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Assets = lazy(() => import('./pages/Assets'));
const Workflows = lazy(() => import('./pages/Workflows'));

function PageLoader() {
  return (
    <div className="page-wrap active">
      <div className="card" style={{ textAlign: 'center', padding: 48 }}>
        <div className="card-sub">Loading…</div>
      </div>
    </div>
  );
}

function Guard({ path, children }) {
  const { currentUser } = useHRMS();
  if (!canAccess(currentUser.role, path)) {
    return (
      <Placeholder
        title="Access restricted"
        note="This workspace profile does not have access to this area."
      />
    );
  }
  return children;
}

function Home() {
  const { currentUser } = useHRMS();
  return currentUser.role === 'Employee' ? <MyDashboard /> : <Dashboard />;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="ess" element={<Guard path="/ess"><MyDashboard /></Guard>} />
          <Route path="employees" element={<Guard path="/employees"><Employees /></Guard>} />
          <Route path="employees/:id" element={<Guard path="/employees"><EmployeeProfile /></Guard>} />
          <Route path="org-chart" element={<Guard path="/org-chart"><OrgChart /></Guard>} />
          <Route path="attendance" element={<Guard path="/attendance"><Attendance /></Guard>} />
          <Route path="leave" element={<Guard path="/leave"><Leave /></Guard>} />
          <Route path="holidays" element={<Guard path="/holidays"><Holidays /></Guard>} />
          <Route path="payroll" element={<Guard path="/payroll"><Payroll /></Guard>} />
          <Route path="celebrations" element={<Guard path="/celebrations"><Celebrations /></Guard>} />
          <Route path="recruitment" element={<Guard path="/recruitment"><Recruitment /></Guard>} />
          <Route path="performance" element={<Guard path="/performance"><Performance /></Guard>} />
          <Route path="documents" element={<Guard path="/documents"><Documents /></Guard>} />
          <Route path="analytics" element={<Guard path="/analytics"><Analytics /></Guard>} />
          <Route path="settings" element={<Guard path="/settings"><Settings /></Guard>} />
          <Route path="integrations" element={<Guard path="/integrations"><Integrations /></Guard>} />
          <Route path="expenses" element={<Guard path="/expenses"><Expenses /></Guard>} />
          <Route path="assets" element={<Guard path="/assets"><Assets /></Guard>} />
          <Route path="workflows" element={<Guard path="/workflows"><Workflows /></Guard>} />
          <Route path="*" element={<Placeholder title="Not found" note="This page doesn’t exist yet." />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
