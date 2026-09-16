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
        {mustChange ? (
          /* The server refuses every ordinary endpoint until this is done, so
             rendering the app behind the modal only showed empty screens and a
             "failed to load" message. Say what is actually required instead. */
          <div className="page-wrap active">
            <div className="card" style={{ maxWidth: 560, margin: '48px auto', textAlign: 'center' }}>
              <div className="card-title">Choose a new password</div>
              <div className="card-sub" style={{ marginTop: 8 }}>
                You signed in with a temporary password. Set your own password to finish
                signing in — the rest of the workspace opens as soon as you do.
              </div>
            </div>
          </div>
        ) : (
          loading
            ? <div className="page-wrap active"><div className="loading"><div className="spinner" /><span>Loading workspace…</span></div></div>
            : <Outlet />
        )}
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
