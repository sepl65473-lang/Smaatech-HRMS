import { useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import {
  formatINR, formatDate, daysBetween, leaveTagClass, leaveTagLabel, todayISO,
} from '../lib/helpers';

const STATUS_LABEL = { active: 'Active', remote: 'Remote', 'on-leave': 'On leave' };
const LEAVE_BADGE = { pending: 'pending', approved: 'approved', declined: 'declined' };

export default function EmployeeProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    employees, leaves, attendance, payroll, assets, expenses, settings,
  } = useHRMS();

  const emp = employees.find((e) => e.id === id);

  const manager = useMemo(
    () => (emp?.managerId ? employees.find((e) => e.id === emp.managerId) : null),
    [employees, emp],
  );

  const reports = useMemo(
    () => employees.filter((e) => e.managerId === emp?.id),
    [employees, emp],
  );

  const myLeaves = useMemo(
    () => leaves.filter((l) => l.empId === emp?.id || l.name === emp?.name),
    [leaves, emp],
  );

  const myAttendance = useMemo(
    () => attendance
      .filter((a) => a.empId === emp?.id || a.name === emp?.name)
      .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [attendance, emp],
  );

  const myPayroll = useMemo(
    () => payroll.filter((p) => p.empId === emp?.id || p.name === emp?.name),
    [payroll, emp],
  );

  const myAssets = useMemo(
    () => assets.filter((a) => a.assignedToEmpId === emp?.id),
    [assets, emp],
  );

  const myExpenses = useMemo(
    () => expenses.filter((x) => x.empId === emp?.id || x.name === emp?.name),
    [expenses, emp],
  );

  const leaveBalance = useMemo(() => {
    const total = Number(settings.totalLeaveDays || 24);
    const used = myLeaves
      .filter((l) => l.status === 'approved')
      .reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    const pending = myLeaves
      .filter((l) => l.status === 'pending')
      .reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    return { total, used, pending, remaining: Math.max(0, total - used) };
  }, [myLeaves, settings.totalLeaveDays]);

  const tenure = useMemo(() => {
    if (!emp?.joinDate) return '—';
    const years = (Date.now() - new Date(emp.joinDate).getTime()) / (365.25 * 86400000);
    return years >= 1 ? `${years.toFixed(1)} yrs` : `${Math.max(1, Math.round(years * 12))} mo`;
  }, [emp]);

  const todayRecord = myAttendance.find((a) => a.date === todayISO());

  if (!emp) {
    return (
      <div className="page-wrap active">
        <div className="card">
          <div className="card-title">Employee not found</div>
          <p className="muted-text" style={{ marginTop: 8 }}>
            This record may have been removed. <Link to="/employees">Back to directory</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-wrap active">
      {/* Header card */}
      <div className="card">
        <div className="card-head" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', minWidth: 0 }}>
            <Avatar name={emp.name} photo={emp.photo} size={64} />
            <div style={{ minWidth: 0 }}>
              <div className="card-title" style={{ fontSize: 22 }}>{emp.name}</div>
              <div className="card-sub">{emp.role} · {emp.dept} · 📍 {emp.loc}</div>
              <div className="card-sub mono" style={{ marginTop: 4 }}>
                {emp.email}{emp.phone ? ` · ${emp.phone}` : ''}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={`status-pill status-${emp.status}`}>{STATUS_LABEL[emp.status] || emp.status}</span>
            <button className="btn btn-ghost" onClick={() => navigate('/employees')}>← Directory</button>
          </div>
        </div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Joined {formatDate(emp.joinDate)} · Reports to{' '}
          {manager
            ? <Link to={`/employees/${manager.id}`}>{manager.name}</Link>
            : <span>—</span>}
          {reports.length > 0 && <> · {reports.length} direct report{reports.length > 1 ? 's' : ''}</>}
        </div>
      </div>

      {/* Stats */}
      <div className="stats">
        <div className="stat">
          <div className="stat-label">Leave balance</div>
          <div className="stat-value">{leaveBalance.remaining}<small style={{ fontSize: 14 }}> / {leaveBalance.total} days</small></div>
          <div className="stat-meta">{leaveBalance.used} used · {leaveBalance.pending} pending</div>
        </div>
        <div className="stat">
          <div className="stat-label">Today</div>
          <div className="stat-value" style={{ textTransform: 'capitalize' }}>{todayRecord?.status || 'No record'}</div>
          <div className="stat-meta">{todayRecord?.checkIn ? `In at ${todayRecord.checkIn}` : 'Not checked in'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Performance</div>
          <div className="stat-value">{emp.rating ? `${emp.rating} ★` : '—'}</div>
          <div className="stat-meta">latest rating</div>
        </div>
        <div className="stat">
          <div className="stat-label">Tenure</div>
          <div className="stat-value">{tenure}</div>
          <div className="stat-meta">monthly gross {formatINR(emp.salary)}</div>
        </div>
      </div>

      <div className="grid" style={{ alignItems: 'start' }}>
        {/* Leave history */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Leave history</div>
              <div className="card-sub">{myLeaves.length} request{myLeaves.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          {myLeaves.length === 0 ? (
            <div className="empty">No leave requests yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {myLeaves.map((l) => (
                    <tr key={l.id}>
                      <td><span className={`tag ${leaveTagClass(l.type)}`}>{leaveTagLabel(l.type)}</span></td>
                      <td>{formatDate(l.start)} – {formatDate(l.end)}</td>
                      <td>{daysBetween(l.start, l.end)}</td>
                      <td><span className={`state-badge ${LEAVE_BADGE[l.status] || 'pending'}`}>{l.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Payroll records */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Payroll</div>
              <div className="card-sub">salary records by cycle</div>
            </div>
          </div>
          {myPayroll.length === 0 ? (
            <div className="empty">No payroll records.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>Cycle</th><th>Gross</th><th>Deductions</th><th>Net</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {myPayroll.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.cycle}</td>
                      <td className="mono">{formatINR(p.gross)}</td>
                      <td className="mono">{formatINR(p.deductions)}</td>
                      <td className="mono"><strong>{formatINR(p.net)}</strong></td>
                      <td><span className={`state-badge ${p.status === 'paid' ? 'approved' : 'pending'}`}>{p.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Assets */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Assigned assets</div>
              <div className="card-sub">{myAssets.length} item{myAssets.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          {myAssets.length === 0 ? (
            <div className="empty">No assets assigned.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>Asset</th><th>Category</th><th>Serial</th><th>Since</th></tr>
                </thead>
                <tbody>
                  {myAssets.map((a) => (
                    <tr key={a.id}>
                      <td><strong>{a.name}</strong></td>
                      <td>{a.category}</td>
                      <td className="mono">{a.serialNumber}</td>
                      <td>{formatDate(a.assignedDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Expenses */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Expense claims</div>
              <div className="card-sub">{myExpenses.length} claim{myExpenses.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          {myExpenses.length === 0 ? (
            <div className="empty">No expense claims.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>Category</th><th>Amount</th><th>Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {myExpenses.map((x) => (
                    <tr key={x.id}>
                      <td>{x.category}</td>
                      <td className="mono">{formatINR(x.amount)}</td>
                      <td>{formatDate(x.date)}</td>
                      <td><span className={`state-badge ${x.status === 'approved' ? 'approved' : x.status === 'declined' ? 'declined' : 'pending'}`}>{x.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
