import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import { greeting, formatLongDate, formatINR } from '../lib/helpers';
import {
  IconBell, IconMenu, IconPlus, IconMail, IconHelp, IconChevronDown, IconLogOut,
} from './Icons';
import Avatar from './Avatar';

const TITLES = {
  '/': null, // special-cased to greeting
  '/ess': ['My dashboard', 'Employee self-service'],
  '/employees': ['People directory', 'All employees'],
  '/org-chart': ['Org chart', 'Reporting structure'],
  '/attendance': ['Attendance', 'Today across the org'],
  '/leave': ['Leave management', 'Requests & balances'],
  '/holidays': ['Holidays', 'Company calendar'],
  '/payroll': ['Payroll', 'Current cycle'],
  '/celebrations': ['Celebrations', 'Birthdays & milestones'],
  '/recruitment': ['Recruitment', 'Hiring pipeline'],
  '/performance': ['Performance', 'Ratings & reviews'],
  '/documents': ['Documents', 'Company files'],
  '/analytics': ['Analytics', 'Workforce insights'],
  '/settings': ['Settings', 'Workspace preferences'],
  '/integrations': ['Integrations', 'Devices & exports'],
  '/expenses': ['Expenses', 'Claims & reimbursements'],
  '/assets': ['Assets', 'Company inventory'],
  '/workflows': ['Approval workflows', 'Multi-level approvals'],
};

export default function Topbar({ onMenu, onAddEmployee }) {
  const {
    currentUser, search, setSearch, toast, settings, logout,
    employees, pendingLeaves, payroll, celebrations, recruitment,
  } = useHRMS();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const topbarRef = useRef(null);
  const searchInputRef = useRef(null);

  const entry = TITLES[pathname]
    || (pathname.startsWith('/employees/') ? ['Employee profile', 'Full record'] : undefined);
  const isHome = pathname === '/';
  const leaveAlertsOn = settings.notifyLeave !== false;
  const payrollAlertsOn = settings.notifyPayroll !== false;
  const birthdayAlertsOn = settings.notifyBirthday !== false;
  const pendingPayroll = payrollAlertsOn ? payroll.filter((p) => p.status === 'ready').length : 0;
  const unwished = birthdayAlertsOn ? celebrations.filter((c) => !c.wished).length : 0;
  const notificationCount = (leaveAlertsOn ? pendingLeaves.length : 0) + pendingPayroll + unwished;
  const notifications = useMemo(() => [
    ...(leaveAlertsOn ? pendingLeaves.slice(0, 4).map((l) => ({
      id: `leave-${l.id}`,
      title: `${l.name} leave approval`,
      meta: `${l.dept} - ${l.start} to ${l.end}`,
      to: '/leave',
    })) : []),
    ...(payrollAlertsOn ? payroll.filter((p) => p.status === 'ready').slice(0, 4).map((p) => ({
      id: `payroll-${p.id}`,
      title: `${p.name} salary ready`,
      meta: `${p.cycle} - ${formatINR(p.net)}`,
      to: '/payroll',
    })) : []),
    ...(birthdayAlertsOn ? celebrations.filter((c) => !c.wished).slice(0, 4).map((c) => ({
      id: `celebration-${c.id}`,
      title: `${c.name} ${c.type === 'birthday' ? 'birthday' : 'anniversary'}`,
      meta: c.detail,
      to: '/celebrations',
    })) : []),
  ].slice(0, 8), [pendingLeaves, payroll, celebrations, leaveAlertsOn, payrollAlertsOn, birthdayAlertsOn]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const match = (...values) => values.some((v) => String(v || '').toLowerCase().includes(q));

    return [
      ...employees.filter((e) => match(e.name, e.role, e.dept, e.loc, e.email)).slice(0, 4).map((e) => ({
        id: `emp-${e.id}`,
        label: e.name,
        meta: `${e.role} - ${e.dept}`,
        type: 'Employee',
        to: '/employees',
      })),
      ...pendingLeaves.filter((l) => match(l.name, l.dept, l.reason, l.type)).slice(0, 3).map((l) => ({
        id: `leave-${l.id}`,
        label: `${l.name} leave`,
        meta: `${l.status} - ${l.start}`,
        type: 'Leave',
        to: '/leave',
      })),
      ...payroll.filter((p) => match(p.name, p.dept, p.cycle, p.status)).slice(0, 3).map((p) => ({
        id: `pay-${p.id}`,
        label: `${p.name} payslip`,
        meta: `${p.cycle} - ${formatINR(p.net)}`,
        type: 'Payroll',
        to: '/payroll',
      })),
      ...recruitment.filter((r) => match(r.candidate, r.title, r.stage)).slice(0, 3).map((r) => ({
        id: `cand-${r.id}`,
        label: r.candidate,
        meta: `${r.title} - ${r.stage}`,
        type: 'Candidate',
        to: '/recruitment',
      })),
    ].slice(0, 8);
  }, [employees, pendingLeaves, payroll, recruitment, search]);

  useEffect(() => {
    const close = (event) => {
      if (!topbarRef.current?.contains(event.target)) {
        setSearchOpen(false);
        setNotificationsOpen(false);
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const showNotifications = () => {
    if (!notificationCount) {
      toast('info', 'No new notifications');
      return;
    }
    setNotificationsOpen((open) => !open);
    setSearchOpen(false);
    setProfileOpen(false);
  };
  const handleMail = () => toast('info', 'No new messages');
  const handleHelp = () => toast('info', 'Need help? Reach us at support@smaatech.co');
  const toggleProfile = () => {
    setProfileOpen((open) => !open);
    setSearchOpen(false);
    setNotificationsOpen(false);
  };

  return (
    <div className="topbar">
      <div>
        <div className="crumb">{formatLongDate()}</div>
        {isHome ? (
          <h1 className="page-title">
            {greeting()}, <em>{currentUser.name.split(' ')[0]}</em>
          </h1>
        ) : (
          <h1 className="page-title">{entry ? entry[0] : `${settings.orgName || 'Smaatech'} HRMS`}</h1>
        )}
      </div>
      <div className="topbar-actions" ref={topbarRef}>
        <button className="icon-btn menu-btn" title="Open navigation" onClick={onMenu}>
          <IconMenu width="17" height="17" />
        </button>
        <div className="topbar-popover-wrap">
        <input
          ref={searchInputRef}
          className="search"
          value={search}
          onFocus={() => setSearchOpen(Boolean(search.trim()))}
          onChange={(e) => {
            setSearch(e.target.value);
            setSearchOpen(Boolean(e.target.value.trim()));
            setNotificationsOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && search.trim()) {
              navigate(searchResults[0]?.to || '/employees');
              setSearchOpen(false);
            }
          }}
          placeholder="Search employees, policies, documents…"
        />
        {!search.trim() && <kbd className="search-kbd">Ctrl+K</kbd>}
        {searchOpen && (
          <div className="topbar-popover search-popover">
            {searchResults.length === 0 ? (
              <div className="popover-empty">No matching records</div>
            ) : searchResults.map((item) => (
              <button
                key={item.id}
                className="popover-row"
                onClick={() => {
                  navigate(item.to);
                  setSearchOpen(false);
                }}
              >
                <span className="popover-kicker">{item.type}</span>
                <span className="popover-title">{item.label}</span>
                <span className="popover-meta">{item.meta}</span>
              </button>
            ))}
          </div>
        )}
        </div>
        <div className="topbar-popover-wrap">
        <button className="icon-btn" title="Notifications" onClick={showNotifications}>
          <IconBell width="16" height="16" />
          {notificationCount > 0 && (
            <span className="notif-badge">{notificationCount > 99 ? '99+' : notificationCount}</span>
          )}
        </button>
        {notificationsOpen && (
          <div className="topbar-popover notification-popover">
            <div className="popover-head">
              <strong>{notificationCount}</strong> needs attention
            </div>
            {notifications.map((item) => (
              <button
                key={item.id}
                className="popover-row"
                onClick={() => {
                  navigate(item.to);
                  setNotificationsOpen(false);
                }}
              >
                <span className="popover-title">{item.title}</span>
                <span className="popover-meta">{item.meta}</span>
              </button>
            ))}
          </div>
        )}
        </div>
        <button className="icon-btn" title="Messages" onClick={handleMail}>
          <IconMail width="16" height="16" />
        </button>
        <button className="icon-btn" title="Help" onClick={handleHelp}>
          <IconHelp width="16" height="16" />
        </button>
        <div className="topbar-popover-wrap">
          <button className="profile-chip" onClick={toggleProfile}>
            <Avatar name={currentUser.name} size={32} />
            <div className="profile-chip-text">
              <div className="profile-chip-name">{currentUser.name}</div>
              <div className="profile-chip-role">{currentUser.role}</div>
            </div>
            <IconChevronDown width="14" height="14" />
          </button>
          {profileOpen && (
            <div className="topbar-popover profile-popover">
              <button className="popover-row" onClick={() => { navigate('/settings'); setProfileOpen(false); }}>
                <span className="popover-title">Settings</span>
              </button>
              <button className="popover-row" onClick={logout}>
                <span className="popover-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <IconLogOut width="13" height="13" /> Sign out
                </span>
              </button>
            </div>
          )}
        </div>
        <button className="btn" onClick={onAddEmployee}>
          <IconPlus width="14" height="14" /> Add Employee
        </button>
      </div>
    </div>
  );
}
