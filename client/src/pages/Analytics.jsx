import { useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import { formatINR } from '../lib/helpers';
import { downloadCSV } from '../lib/exportCsv';
import { analyticsApi, fetchAllRows } from '../data/store';
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
  const { employees, attendance, leaves, payroll, recruitment, getMasterValues } = useHRMS();
  const departments = getMasterValues('departments');
  const [dept, setDept] = useState('All');

  const [reportKey, setReportKey] = useState('employees');
  const [reportCols, setReportCols] = useState(() => new Set(REPORT_DATASETS.employees.columns.map((c) => c.key)));

  const reportDef = REPORT_DATASETS[reportKey];
  const reportRows = useMemo(() => {
    const rows = { employees, attendance, leave: leaves, payroll }[reportKey] || [];
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

  // The preview below shows what the app shell happens to hold; the EXPORT
  // pages through the API for the full dataset. A CSV that quietly contained
  // only the first 100 attendance rows looked exactly like a complete one.
  const [exporting, setExporting] = useState(false);
  const exportReport = async () => {
    const cols = reportDef.columns.filter((c) => reportCols.has(c.key));
    const resource = { employees: 'employees', attendance: 'attendance', leave: 'leaves', payroll: 'payroll' }[reportKey];
    setExporting(true);
    try {
      const all = await fetchAllRows(resource);
      const rows = dept === 'All' ? all : all.filter((r) => r.dept === dept);
      downloadCSV(`${reportDef.label.toLowerCase().replace(/\s+/g, '-')}-report`, rows, cols);
    } catch (err) {
      // Better to say nothing was exported than to hand over a partial file.
      window.alert(err.message || 'Could not export the full dataset. Nothing was downloaded.');
    } finally {
      setExporting(false);
    }
  };

  const scopedEmployees = useMemo(
    () => employees.filter((e) => dept === 'All' || e.dept === dept),
    [employees, dept],
  );
  const scopedIds = useMemo(() => new Set(scopedEmployees.map((e) => e.id)), [scopedEmployees]);
  const scopedLeaves = leaves.filter((l) => scopedIds.has(l.empId));

  // The headline figures and the department table come from the SERVER, which
  // aggregates the whole collection for the chosen window. They used to be
  // derived here from the app shell's hydrated lists — and GET /attendance caps
  // an unpaged response at the 100 most recent rows, so for any company with
  // more than a handful of people the attendance rate shown was computed from a
  // day or two of data and was simply wrong.
  const [range, setRange] = useState(() => {
    const now = new Date();
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
    };
  });
  const [report, setReport] = useState(null);
  const [workforce, setWorkforce] = useState(null);
  const [reportError, setReportError] = useState('');
  const [loadingReport, setLoadingReport] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingReport(true);
    // Hiring and attrition span the company, so they ignore the department
    // chip — a department's "attrition rate" out of three people is noise.
    analyticsApi.workforce({ from: range.from, to: range.to })
      .then((data) => { if (!cancelled) setWorkforce(data); })
      .catch(() => { if (!cancelled) setWorkforce(null); });

    analyticsApi.overview({ from: range.from, to: range.to, dept })
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setReportError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setReport(null);
        setReportError(err.message || 'Could not load reporting figures.');
      })
      .finally(() => { if (!cancelled) setLoadingReport(false); });
    return () => { cancelled = true; };
  }, [range.from, range.to, dept]);

  const headcount = report?.headcount.total ?? scopedEmployees.length;
  // null means "nothing was marked in this window" — which is not 0%.
  const attendanceRate = report?.attendance.ratePct;
  const presentCount = report?.attendance.present ?? 0;
  const netPayout = report?.payroll.net ?? 0;
  const avgRating = scopedEmployees.length
    ? (scopedEmployees.reduce((sum, e) => sum + Number(e.rating || 0), 0) / scopedEmployees.length).toFixed(1)
    : '0.0';
  const openRoles = new Set(recruitment.filter((r) => r.stage !== 'Hired').map((r) => r.title)).size;

  const deptRows = (report?.departments || []).map((row) => ({
    name: row.dept,
    people: row.headcount,
    attendanceRate: row.ratePct,
    present: row.present,
    absent: row.absent,
    onLeave: row.onLeave,
    marked: row.marked,
  }));

  return (
    <div className="page-wrap active">
      <div className="list-toolbar" style={{ marginBottom: 12 }}>
        <label className="inline-select">
          <span>From</span>
          <input
            type="date" className="input" value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </label>
        <label className="inline-select">
          <span>To</span>
          <input
            type="date" className="input" value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </label>
      </div>

      <div className="filter-chips" style={{ marginBottom: 18 }}>
        {['All', ...departments].map((d) => (
          <button key={d} className={`chip ${dept === d ? 'active' : ''}`} onClick={() => setDept(d)}>{d}</button>
        ))}
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-icon tone-accent"><IconWorkforce width="16" height="16" /></div>
          <div className="stat-label">Headcount</div><div className="stat-value">{headcount}</div><div className="stat-meta">{dept} workforce</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-sage"><IconPresent width="16" height="16" /></div>
          <div className="stat-label">Attendance</div>
          <div className="stat-value">{attendanceRate == null ? '—' : `${attendanceRate}%`}</div>
          <div className="stat-meta">
            {attendanceRate == null
              ? 'nothing marked in this window'
              : `${presentCount} of ${report.attendance.marked} marked present`}
          </div>
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

      {workforce && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Workforce movement</div>
              <div className="card-sub">
                Company-wide · {workforce.range.from} to {workforce.range.to}
              </div>
            </div>
          </div>
          <div className="stats">
            <div className="stat">
              <div className="stat-label">Joined</div>
              <div className="stat-value">{workforce.hiring.joined}</div>
              <div className="stat-meta">new employees in this window</div>
            </div>
            <div className="stat">
              <div className="stat-label">Left</div>
              <div className="stat-value">{workforce.attrition.exits}</div>
              <div className="stat-meta">
                {workforce.attrition.inNoticePeriod} currently in notice period
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Attrition</div>
              <div className="stat-value">
                {workforce.attrition.ratePct == null ? '\u2014' : `${workforce.attrition.ratePct}%`}
              </div>
              <div className="stat-meta">
                of {workforce.headcount.average} average headcount
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Offer acceptance</div>
              <div className="stat-value">
                {workforce.hiring.offerAcceptanceRatePct == null
                  ? '\u2014'
                  : `${workforce.hiring.offerAcceptanceRatePct}%`}
              </div>
              <div className="stat-meta">
                {workforce.hiring.offersAccepted} accepted · {workforce.hiring.offersDeclined} declined
              </div>
            </div>
          </div>

          {workforce.hiring.joiners.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 14 }}>
              <table className="table">
                <thead>
                  <tr><th>Joined</th><th>Name</th><th>Department</th><th>Role</th></tr>
                </thead>
                <tbody>
                  {workforce.hiring.joiners.map((person) => (
                    <tr key={person.id}>
                      <td className="mono">{person.joinDate}</td>
                      <td><strong>{person.name}</strong></td>
                      <td>{person.dept}</td>
                      <td>{person.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="grid">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Department health</div>
              <div className="card-sub">
                {loadingReport ? 'Loading…' : `Server-aggregated · ${range.from} to ${range.to}`}
              </div>
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => downloadCSV('department-health-report', deptRows, [
                { key: 'name', label: 'Department' }, { key: 'people', label: 'People' },
                { key: 'marked', label: 'Days marked' }, { key: 'present', label: 'Present' },
                { key: 'absent', label: 'Absent' }, { key: 'onLeave', label: 'On leave' },
                { key: 'attendanceRate', label: 'Attendance %' },
              ])}
            >
              Export CSV
            </button>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Department</th><th>People</th><th>Attendance</th><th>Present</th><th>Absent</th><th style={{ textAlign: 'right' }}>On leave</th>
                </tr>
              </thead>
              <tbody>
                {reportError && (
                  <tr><td colSpan={6}>{reportError}</td></tr>
                )}
                {!reportError && deptRows.length === 0 && (
                  <tr><td colSpan={6}>{loadingReport ? 'Loading…' : 'No attendance marked in this window.'}</td></tr>
                )}
                {deptRows.map((row) => (
                  <tr key={row.name}>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.people}</td>
                    <td>
                      <div className="rating-bar" style={{ maxWidth: 140 }}>
                        <div className="rating-fill" style={{ width: `${row.attendanceRate ?? 0}%` }} />
                      </div>
                      <span className="mono">{row.attendanceRate == null ? '—' : `${row.attendanceRate}%`}</span>
                    </td>
                    <td>{row.present}</td>
                    <td>{row.absent}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{row.onLeave}</td>
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
            <div className="card-sub">
              preview of {reportRows.length} rows · {dept} · {reportCols.size} of {reportDef.columns.length} columns · the export covers every row
            </div>
          </div>
          <button className="btn" disabled={reportCols.size === 0 || exporting} onClick={exportReport}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
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
