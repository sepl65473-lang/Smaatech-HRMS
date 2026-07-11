import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import ToastHost from './ToastHost';
import EmployeeForm from './EmployeeForm';
import LoginScreen from './LoginScreen';
import { useHRMS } from '../context/HRMSContext';

export default function Layout() {
  const { addEmployee, loading, isAuthenticated, booting } = useHRMS();
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
        {loading
          ? <div className="page-wrap active"><div className="loading"><div className="spinner" /><span>Loading workspace…</span></div></div>
          : <Outlet />}
      </main>

      <ToastHost />

      <EmployeeForm
        open={addOpen}
        employee={null}
        onClose={() => setAddOpen(false)}
        onSave={async (data) => { await addEmployee(data); setAddOpen(false); }}
      />
    </div>
  );
}
