import { lazy, Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import ToastHost from './ToastHost';
import LoginScreen from './LoginScreen';
import { useHRMS } from '../context/HRMSContext';

// Mounted globally (the Topbar "+ Add Employee" quick-action works from any
// page) but only actually needed once someone opens it — lazy-loading keeps
// its weight out of every page's initial bundle.
const EmployeeForm = lazy(() => import('./EmployeeForm'));
const ChangePasswordModal = lazy(() => import('./ChangePasswordModal'));

export default function Layout() {
  const { addEmployee, loading, isAuthenticated, booting, currentUser } = useHRMS();
  const [addOpen, setAddOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (booting) {
    return (
      <div className="page-wrap active">
        <div className="loading"><div className="spinner" /><span>Loading workspace…</span></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <LoginScreen />
        <ToastHost />
      </>
    );
  }

  const mustChange = Boolean(currentUser?.mustChangePassword);

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <Sidebar onNavigate={() => setSidebarOpen(false)} />
      <button
        className="mobile-scrim"
        aria-label="Close navigation"
        onClick={() => setSidebarOpen(false)}
      />
      <main>
        <Topbar onMenu={() => setSidebarOpen(true)} onAddEmployee={() => setAddOpen(true)} />
        {mustChange && (
          <div style={{ background: '#fffbe6', borderBottom: '1px solid #ffe58f', padding: '12px 24px', color: '#873800', fontWeight: 600, fontSize: '13px' }}>
            ⚠️ <strong>Security Requirement:</strong> You logged in using a temporary password. You must change your password below to access HRMS.
          </div>
        )}
        {loading
          ? <div className="page-wrap active"><div className="loading"><div className="spinner" /><span>Loading workspace…</span></div></div>
          : <Outlet />}
      </main>

      {mustChange && (
        <Suspense fallback={null}>
          <ChangePasswordModal open={true} onClose={() => {}} />
        </Suspense>
      )}

      <ToastHost />

      {addOpen && (
        <Suspense fallback={null}>
          <EmployeeForm
            open={addOpen}
            employee={null}
            onClose={() => setAddOpen(false)}
            onSave={async (data) => { await addEmployee(data); setAddOpen(false); }}
          />
        </Suspense>
      )}
    </div>
  );
}
