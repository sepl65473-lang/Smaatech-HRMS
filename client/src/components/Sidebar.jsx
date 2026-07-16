import { NavLink } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import { canAccess } from '../lib/permissions';
import {
  IconDashboard, IconEmployees, IconCalendar, IconLeave, IconPayroll,
  IconCake, IconRecruit, IconPerformance, IconDocs, IconAnalytics, IconSettings, IconLogOut,
} from './Icons';

function Item({ to, icon: Icon, label, badge, badgeTone, onNavigate, role }) {
  if (!canAccess(role, to)) return null;
  return (
    <NavLink to={to} onClick={onNavigate} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <Icon className="nav-icon" />
      {label}
      {badge != null && <span className={`nav-badge ${badgeTone ? `tone-${badgeTone}` : ''}`}>{badge}</span>}
    </NavLink>
  );
}

export default function Sidebar({ onNavigate }) {
  const { employees, pendingLeaves, celebrations, currentUser, settings, logout } = useHRMS();
  const orgName = settings.orgName || 'Smaatech';

  return (
    <aside>
      <div className="brand">
        <div className="brand-mark"><img src="/logo.jpg" alt={orgName} /></div>
        <div>
          <div className="brand-name">{orgName}</div>
          <div className="brand-sub">HR · v4.2</div>
        </div>
      </div>

      <div className="nav-section">
        <Item to="/" icon={IconDashboard} label="Dashboard" role={currentUser.role} onNavigate={onNavigate} />
      </div>

      <div className="nav-section">
        <div className="nav-label">Workspace</div>
        <Item to="/employees" icon={IconEmployees} label="Employees" role={currentUser.role} badge={employees.length} onNavigate={onNavigate} />
        <Item to="/org-chart" icon={IconEmployees} label="Org chart" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/attendance" icon={IconCalendar} label="Attendance" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/leave" icon={IconLeave} label="Leave" role={currentUser.role} badge={pendingLeaves.length || null} badgeTone="gold" onNavigate={onNavigate} />
        <Item to="/holidays" icon={IconCalendar} label="Holidays" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/payroll" icon={IconPayroll} label="Payroll" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/celebrations" icon={IconCake} label="Celebrations" role={currentUser.role} badge={celebrations.length} onNavigate={onNavigate} />
      </div>

      <div className="nav-section">
        <div className="nav-label">Operations</div>
        <Item to="/recruitment" icon={IconRecruit} label="Recruitment" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/performance" icon={IconPerformance} label="Performance" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/documents" icon={IconDocs} label="Documents" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/expenses" icon={IconPayroll} label="Expenses" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/assets" icon={IconDocs} label="Assets" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/analytics" icon={IconAnalytics} label="Analytics" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/integrations" icon={IconSettings} label="Integrations" role={currentUser.role} onNavigate={onNavigate} />
      </div>

      <div className="nav-section">
        <div className="nav-label">Account</div>
        <Item to="/workflows" icon={IconSettings} label="Approval workflows" role={currentUser.role} onNavigate={onNavigate} />
        <Item to="/settings" icon={IconSettings} label="Settings" role={currentUser.role} onNavigate={onNavigate} />
      </div>

      <div className="user-card">
        <div className="avatar">{currentUser.initials}</div>
        <div>
          <div className="user-name">{currentUser.name}</div>
          <div className="user-role">{currentUser.role}</div>
        </div>
        <button className="icon-btn sm" title="Sign out" onClick={logout}>
          <IconLogOut width="14" height="14" />
        </button>
      </div>
    </aside>
  );
}
