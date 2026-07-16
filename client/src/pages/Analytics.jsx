import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import { DEPARTMENTS, formatINR } from '../lib/helpers';
import { downloadCSV } from '../lib/exportCsv';
import {
  IconWorkforce, IconPresent, IconPerformance, IconPayroll,
} from '../components/Icons';

const REPORT_DATASETS = {
  employees: {
    label: 'Employees',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'dept', label: 'Department' },
      { key: 'role', label: 'Role' }, { key: 'status', label: 'Status' },
      { key: 'loc', label: 'Location' }, { key: 'salary', label: 'Monthly salary' },
      { key: 'rating', label: 'Rating' }, { key: 'joinDate', label: 'Join date' },
    ],
  },
  attendance: {
    label: 'Attendance',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'dept', label: 'Department' },
      { key: 'date', label: 'Date' }, { key: 'checkIn', label: 'Check-in' },
      { key: 'checkOut', label: 'Check-out' }, { key: 'status', label: 'Status' },
    ],
  },
  leave: {
    label: 'Leave requests',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'dept', label: 'Department' },
      { key: 'type', label: 'Type' }, { key: 'start', label: 'Start' },
      { key: 'end', label: 'End' }, { key: 'status', label: 'Status' },
    ],
  },
  payroll: {
    label: 'Payroll',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'dept', label: 'Department' },
      { key: 'cycle', label: 'Cycle' }, { key: 'gross', label: 'Gross' },
      { key: 'deductions', label: 'Deductions' }, { key: 'net', label: 'Net' },
      { key: 'status', label: 'Status' },
    ],
  },
};

export default function Analytics() {
  const { employees, attendance, leaves, payroll, recruitment, settings } = useHRMS();
  const departments = settings.departments?.length ? settings.departments : DEPARTMENTS;
  const [dept, setDept] = useState('All');

  const DATA_SOURCE = { employees, attendance, leave: leaves, payroll };
  const [reportKey, setReportKey] = useState('employees');
  const [reportCols, setReportCols] = useState(() => new Set(REPORT_DATASETS.employees.columns.map((c) => c.key)));

  const reportDef = REPORT_DATASETS[reportKey];
  const reportRows = useMemo(() => {
    const rows = DATA_SOURCE[reportKey] || [];
    return dept === 'All' ? rows : rows.filter((r) => r.dept === dept);
  }, [reportKey, dept, employees, attendance, leaves, payroll]);

  const selectDataset = (key) => {
    setReportKey(key);
    setReportCols(new Set(REPORT_DATASETS[key].columns.map((c) => c.key)));
  };

  const toggleCol = (key) => setReportCols((set) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const exportReport = () => {
    const cols = reportDef.columns.filter((c) => reportCols.has(c.key));
    downloadCSV(`${reportDef.label.toLowerCase().replace(/\s+/g, '-')}-report`, reportRows, cols);
  };

  const scopedEmployees = useMemo(
    () => employees.filter((e) => dept === 'All' || e.dept === dept),
    [employees, dept],
  );
  const scopedIds = useMemo(() => new Set(scopedEmployees.map((e) => e.id)), [scopedEmployees]);

  const scopedAttendance = attendance.filter((a) => scopedIds.has(a.empId));
  const scopedLeaves = leaves.filter((l) => scopedIds.has(l.empId));
  const scopedPayroll = payroll.filter((p) => scopedIds.has(p.empId));

  const present = scopedAttendance.filter((a) => a.status === 'present' || a.status === 'late').length;
  const attendanceRate = scopedEmployees.length ? Math.round((present / scopedEmployees.length) * 100) : 0;
  const avgRating = scopedEmployees.length
    ? (scopedEmployees.reduce((sum, e) => sum + Number(e.rating || 0), 0) / scopedEmployees.length).toFixed(1)
    : '0.0';
  const netPayout = scopedPayroll.reduce((sum, p) => sum + Number(p.net || 0), 0);
  const openRoles = new Set(recruitment.filter((r) => r.stage !== 'Hired').map((r) => r.title)).size;

  const deptRows = departments.map((name) => {
    const people = employees.filter((e) => e.dept === name);
    const ids = new Set(people.map((e) => e.id));
    const att = attendance.filter((a) => ids.has(a.empId));
    const presentCount = att.filter((a) => a.status === 'present' || a.status === 'late').length;
    const pay = payroll.filter((p) => ids.has(p.empId)).reduce((sum, p) => sum + p.net, 0);
    const rating = people.length
      ? (people.reduce((sum, e) => sum + e.rating, 0) / people.length).toFixed(1)
      : '0.0';
    return {
      name,
      people: people.length,
      attendanceRate: people.length ? Math.round((presentCount / people.length) * 100) : 0,
      pendingLeaves: leaves.filter((l) => ids.has(l.empId) && l.status === 'pending').length,
      payout: pay,
      rating,
    };
  });

  return (
    <div className="page-wrap active">
      <div className="filter-chips" style={{ marginBottom: 18 }}>
        {['All', ...departments].map((d) => (
          <button key={d} className={`chip ${dept === d ? 'active' : ''}`} onClick={() => setDept(d)}>{d}</button>
        ))}
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-icon tone-accent"><IconWorkforce width="16" height="16" /></div>
          <div className="stat-label">Headcount</div><div className="stat-value">{scopedEmployees.length}</div><div className="stat-meta">{dept} workforce</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-sage"><IconPresent width="16" height="16" /></div>
          <div className="stat-label">Attendance</div><div className="stat-value">{attendanceRate}%</div><div className="stat-meta">{present} present today</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-gold"><IconPerformance width="16" height="16" /></div>
          <div className="stat-label">Avg rating</div><div className="stat-value">{avgRating}</div><div className="stat-meta">performance score</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-teal"><IconPayroll width="16" height="16" /></div>
          <div className="stat-label">Net payout</div><div className="stat-value mono" style={{ fontSize: 22 }}>{formatINR(netPayout)}</div><div className="stat-meta">{openRoles} open roles overall</div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Department health</div>
              <div className="card-sub">Live from employees, attendance, leave and payroll</div>
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => downloadCSV('department-health-report', deptRows, [
                { key: 'name', label: 'Department' }, { key: 'people', label: 'People' },
                { key: 'attendanceRate', label: 'Attendance %' }, { key: 'pendingLeaves', label: 'Pending leave' },
                { key: 'rating', label: 'Avg rating' }, { key: 'payout', label: 'Net payout' },
              ])}
            >
              Export CSV
            </button>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Department</th><th>People</th><th>Attendance</th><th>Pending leave</th><th>Rating</th><th style={{ textAlign: 'right' }}>Net payout</th>
                </tr>
              </thead>
              <tbody>
                {deptRows.map((row) => (
                  <tr key={row.name}>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.people}</td>
                    <td>
                      <div className="rating-bar" style={{ maxWidth: 140 }}>
                        <div className="rating-fill" style={{ width: `${row.attendanceRate}%` }} />
                      </div>
                      <span className="mono">{row.attendanceRate}%</span>
                    </td>
                    <td>{row.pendingLeaves}</td>
                    <td>{row.rating}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{formatINR(row.payout)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Leave mix</div>
              <div className="card-sub">{scopedLeaves.length} records in current filter</div>
            </div>
          </div>
          {['pending', 'approved', 'declined'].map((status) => {
            const count = scopedLeaves.filter((l) => l.status === status).length;
            const pct = scopedLeaves.length ? Math.round((count / scopedLeaves.length) * 100) : 0;
            return (
              <div className="goal-item" key={status}>
                <div className="goal-head">
                  <div className="goal-title">{status[0].toUpperCase() + status.slice(1)}</div>
                  <div className="goal-pct">{count} / {scopedLeaves.length}</div>
                </div>
                <div className="rating-bar">
                  <div className="rating-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Custom report builder</div>
            <div className="card-sub">{reportRows.length} rows · {dept} · {reportCols.size} of {reportDef.columns.length} columns</div>
          </div>
          <button className="btn" disabled={reportCols.size === 0} onClick={exportReport}>Export CSV</button>
        </div>

        <div className="filter-chips" style={{ marginBottom: 12 }}>
          {Object.entries(REPORT_DATASETS).map(([key, def]) => (
            <button key={key} className={`chip ${reportKey === key ? 'active' : ''}`} onClick={() => selectDataset(key)}>
              {def.label}
            </button>
          ))}
        </div>

        <div className="filter-chips">
          {reportDef.columns.map((c) => (
            <button
              key={c.key}
              className={`chip ${reportCols.has(c.key) ? 'active' : ''}`}
              onClick={() => toggleCol(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {reportRows.length === 0 && <div className="empty" style={{ marginTop: 12 }}>No rows for this dataset/department.</div>}
      </div>
    </div>
  );
}
