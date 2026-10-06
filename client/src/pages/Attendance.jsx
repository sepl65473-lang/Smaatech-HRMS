import { useMemo, useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import RosterPlanner from '../components/RosterPlanner';
import {
  IconInfo, IconPresent, IconCalendar, IconX, IconLeave,
} from '../components/Icons';
import { todayISO, leaveTagLabel } from '../lib/helpers';
import { resolveShiftForToday } from '../lib/shifts';
import { downloadCSV } from '../lib/exportCsv';
import { formatWorkedMinutes } from '../lib/workingHours';
import { ATTENDANCE_STATUS as STATUS } from '../lib/attendanceStatus';
import { apiFetchBlob } from '../lib/apiClient';
import { attendanceApi } from '../data/store';
import { buildMonthlyTimesheet, monthBounds, shiftMinutes, FULL_MONTH_NAMES } from '../lib/timesheet';

function AttendancePhotoPreview({ attendanceId, which }) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    setLoading(true);
    setError(false);

    apiFetchBlob(`/files/attendance/${attendanceId}/${which}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attendanceId, which]);

  if (loading) {
    return (
      <div style={{ fontSize: '12px', color: 'var(--muted)', padding: '10px 0', textAlign: 'center' }}>
        📷 Loading captured face selfie…
      </div>
    );
  }

  if (error || !url) {
    return (
      <div style={{ fontSize: '12px', color: 'var(--muted)', padding: '4px 0', fontStyle: 'italic' }}>
        No face photo captured (e.g. HR Manual / QR Punch).
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, textAlign: 'center' }}>
      <img
        src={url}
        alt="Captured Selfie Evidence"
        style={{
          maxWidth: '100%',
          maxHeight: 220,
          borderRadius: 10,
          border: '2px solid var(--accent, #3b7ddd)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.12)',
          objectFit: 'cover',
        }}
      />
      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: 4 }}>
        🔒 Verified Captured Face Snapshot
      </div>
    </div>
  );
}

const EXPORT_COLUMNS = [
  // Date first. The export carried none at all, which was survivable while it
  // only ever held one day's roster, but became actively misleading once it
  // covered a real date range: every row looked alike and nothing said which
  // day it belonged to. Caught by the multi-month browser export spec.
  { key: 'date', label: 'Date' },
  { key: 'name', label: 'Employee' },
  { key: 'dept', label: 'Department' },
  { key: 'shift', label: 'Shift' },
  { key: 'checkIn', label: 'Check-in' },
  { key: 'checkOut', label: 'Check-out' },
  { key: 'workedHours', label: 'Working Hours' },
  { key: 'status', label: 'Status' },
  { key: 'leaveType', label: 'Leave Type' },
  { key: 'location', label: 'Location' },
];

function cleanLocationText(text) {
  if (!text) return '—';
  // Formats raw display_name like "Saheednagar, Khordha, Odisha, 751025, India" -> "Saheednagar, Khordha, Odisha - 751025"
  return text
    .replace(/,\s*(\d{5,8})\s*(?:,\s*India)?$/i, (match, pin) => ` - ${pin}`)
    .replace(/,\s*India$/i, '');
}

// The readable address recorded for one punch ('checkIn' | 'checkOut'), for
// the Admin/HR location display. Only reverse-geocoded address text is used,
// never the stored coordinates: a punch with no resolved address reads
// "Address unavailable", and a punch that has not happened returns null.
function punchAddress(row, dir) {
  if (!row[dir]) return null;
  const structured = row[`${dir}Location`];
  const text = row[`${dir}Address`]
    || (structured?.fullAddress
      ? (structured.pincode ? `${structured.fullAddress} - ${structured.pincode}` : structured.fullAddress)
      : null);
  return text ? cleanLocationText(text) : 'Address unavailable';
}

// The exact position recorded for one punch, for "Open location". It is that
// attendance record's own latitude/longitude and nothing else: never the
// company site, a default, or a position derived from the address text.
function punchCoordinates(row, dir) {
  if (!row?.[dir]) return null;
  const structured = row[`${dir}Location`];
  let lat = Number(structured?.lat);
  let lng = Number(structured?.lng);
  if (structured?.lat == null || structured?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    const parts = String(row[`${dir}Loc`] || '').split(',').map((part) => Number(part.trim()));
    if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null;
    [lat, lng] = parts;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Page numbers for the records pager: first, last and the pages around the
// current one, with gaps shown as null (rendered as an ellipsis).
const RECORDS_PER_PAGE = 20;
function pagerItems(current, total) {
  const wanted = new Set([1, total, current - 1, current, current + 1].filter((n) => n >= 1 && n <= total));
  if (total <= 7) for (let n = 1; n <= total; n += 1) wanted.add(n);
  const pages = [...wanted].sort((a, b) => a - b);
  const items = [];
  pages.forEach((n, i) => {
    if (i > 0 && n - pages[i - 1] > 1) items.push(null);
    items.push(n);
  });
  return items;
}

function LiveIndicator({ lastSyncedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsAgo = Math.max(0, Math.round((now - lastSyncedAt) / 1000));
  const label = secondsAgo < 2 ? 'just now' : secondsAgo < 60 ? `${secondsAgo}s ago` : `${Math.round(secondsAgo / 60)}m ago`;
  return (
    <span className="muted-text" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} title="Refreshes from the server automatically every 15 seconds.">
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--sage)', display: 'inline-block', animation: 'pulse 1.6s ease-in-out infinite' }} />
      Live · updated {label}
    </span>
  );
}

export default function Attendance() {
  const {
    attendance, leaves, settings, checkIn, checkOut, setAttendanceStatus, refreshAttendance,
    attendanceCorrections, requestCorrection, approveCorrection, rejectCorrection, currentUser, employees, toast,
    getMasterValues, getQrToken, holidays,
  } = useHRMS();

  // Real "who's in office now" freshness — polls the attendance list on an
  // interval instead of only refreshing on full-app reload / same-browser
  // tab events (no WebSocket/SSE layer exists in this app; a short poll is
  // the pragmatic way to get this without adding a whole new transport).
  const [lastPolledAt, setLastPolledAt] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      refreshAttendance().then(() => setLastPolledAt(Date.now()));
    }, 15000);
    return () => clearInterval(id);
  }, [refreshAttendance]);

  const departments = getMasterValues('departments');
  const [dept, setDept] = useState('All');
  const [status, setStatus] = useState('all');
  // Historical reporting. Empty = today's roster exactly as before; set a
  // date and the page reads that period from the server's paged endpoint
  // instead of the (capped) hydrated list.
  const [range, setRange] = useState({ from: '', to: '' });
  const [periodRows, setPeriodRows] = useState(null); // null = use the live list
  const [periodTotal, setPeriodTotal] = useState(0);
  const [periodPage, setPeriodPage] = useState(0);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [periodError, setPeriodError] = useState('');
  const [tab, setTab] = useState('roster');
  const [detailsRow, setDetailsRow] = useState(null);

  // Office QR display state — qrData is a real, server-issued/validated
  // token (see GET /attendance/qr-token), not a client-only decorative one.
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrData, setQrData] = useState(null); // { token, expiresAt } | null
  const [qrSecondsLeft, setQrSecondsLeft] = useState(0);

  // Correction Modal States
  const [corrModalOpen, setCorrModalOpen] = useState(false);
  const [corrForm, setCorrForm] = useState({ date: '', checkIn: '', checkOut: '', reason: '' });

  const isHR = ['HR Director', 'HR Manager'].includes(currentUser.role);

  // Fetches a fresh, real, short-TTL token from the server every 10s while
  // the display is open (the previous token is left to expire server-side —
  // it's single-use anyway, so there's nothing to explicitly revoke).
  useEffect(() => {
    if (!qrModalOpen) { setQrData(null); return undefined; }
    let cancelled = false;
    const fetchToken = () => {
      getQrToken().then((data) => { if (!cancelled) setQrData(data); }).catch(() => {});
    };
    fetchToken();
    const interval = setInterval(fetchToken, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [qrModalOpen, getQrToken]);

  useEffect(() => {
    if (!qrData) return undefined;
    const tick = () => setQrSecondsLeft(Math.max(0, Math.round((qrData.expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [qrData]);

  const rangeActive = Boolean(range.from || range.to);
  const PERIOD_PAGE_SIZE = 200;

  const loadPeriodPage = useCallback(async (page) => {
    setPeriodLoading(true);
    setPeriodError('');
    try {
      const { rows, total } = await attendanceApi.page({
        from: range.from || undefined,
        to: range.to || undefined,
        page,
        limit: PERIOD_PAGE_SIZE,
      });
      setPeriodRows((prev) => (page === 1 ? rows : [...(prev || []), ...rows]));
      setPeriodTotal(total);
      setPeriodPage(page);
    } catch (err) {
      setPeriodError(err?.message || 'Could not load that period.');
    } finally {
      setPeriodLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    if (!rangeActive) {
      setPeriodRows(null);
      setPeriodTotal(0);
      setPeriodPage(0);
      setPeriodError('');
      return;
    }
    loadPeriodPage(1);
  }, [rangeActive, loadPeriodPage]);

  // Everything below reads this one list, so filters, counts, the table and
  // the exports all stay in step whichever source is in use.
  const sourceRows = periodRows ?? attendance;
  const hasMorePeriodRows = Boolean(periodRows) && periodRows.length < periodTotal;

  // Leave type for a row that is on leave, from the leave records already
  // loaded — nothing new is fetched and no leave data is changed.
  const leaveTypeFor = useCallback((row) => {
    if (row.status !== 'leave') return '';
    const match = (leaves || []).find((l) => String(l.empId) === String(row.empId)
      && l.status === 'approved'
      && String(l.start) <= row.date && String(l.end) >= row.date);
    return match ? leaveTagLabel(match.type) : '';
  }, [leaves]);

  const filtered = useMemo(() => sourceRows.filter((a) => {
    const deptMatch = dept === 'All' || a.dept === dept;
    const statusMatch = status === 'all' || a.status === status;
    return deptMatch && statusMatch;
  }), [sourceRows, dept, status]);

  // "Attendance records" (the date-range view) is shown 20 rows at a time.
  // This only decides which of the already filtered rows are on screen:
  // nothing is fetched, filtered, sorted or counted differently, and today's
  // roster is left as it was.
  const [recordsPage, setRecordsPage] = useState(1);
  useEffect(() => { setRecordsPage(1); }, [dept, status, range.from, range.to]);
  const recordsPageCount = Math.max(1, Math.ceil(filtered.length / RECORDS_PER_PAGE));
  const currentRecordsPage = Math.min(recordsPage, recordsPageCount);
  const visibleRows = useMemo(
    () => (rangeActive
      ? filtered.slice((currentRecordsPage - 1) * RECORDS_PER_PAGE, currentRecordsPage * RECORDS_PER_PAGE)
      : filtered),
    [rangeActive, filtered, currentRecordsPage],
  );

  const counts = useMemo(() => {
    const c = { present: 0, late: 0, absent: 0, leave: 0 };
    filtered.forEach((a) => {
      const st = a.status === 'early-exit' ? 'late' : a.status;
      c[st] = (c[st] || 0) + 1;
    });
    return c;
  }, [filtered]);

  const shiftNameFor = useCallback(
    (empId) => resolveShiftForToday(empId, settings)?.name || '—',
    [settings],
  );

  const exportRows = useMemo(
    () => filtered.map((a) => ({
      workedHours: formatWorkedMinutes(a.workedMinutes),
      leaveType: leaveTypeFor(a),
      date: a.date,
      name: a.name,
      dept: a.dept,
      shift: shiftNameFor(a.empId),
      checkIn: a.checkIn || '—',
      checkOut: a.checkOut || '—',
      status: STATUS[a.status]?.label || a.status,
      location: cleanLocationText(a.checkInAddress || a.checkOutAddress),
    })),
    [filtered, shiftNameFor, leaveTypeFor],
  );

  const [exporting, setExporting] = useState(false);

  // Exports pull the FULL result set from the server rather than reusing the
  // hydrated list. That list comes from the uncapped-looking GET /attendance,
  // which the server limits to 100 rows to protect itself - so with 100
  // employees a single day filled it and every export silently lost people.
  // Nothing is trimmed quietly any more: if the safety valve is ever reached
  // the user is told.
  const collectExportRows = useCallback(async () => {
    // The export asks the server for exactly the selected period, so an old
    // month can be downloaded without pulling the whole history.
    const { rows, truncated } = await attendanceApi.listAll({
      from: range.from || undefined,
      to: range.to || undefined,
    });
    if (truncated) {
      toast('error', 'This export is too large to build in the browser. Narrow the date range and try again.');
      return null;
    }
    const scoped = rows.filter((a) => {
      const deptMatch = dept === 'All' || a.dept === dept;
      const statusMatch = status === 'all' || a.status === status;
      return deptMatch && statusMatch;
    });
    return scoped.map((a) => ({
      workedHours: formatWorkedMinutes(a.workedMinutes),
      leaveType: leaveTypeFor(a),
      date: a.date,
      name: a.name,
      dept: a.dept,
      shift: shiftNameFor(a.empId),
      checkIn: a.checkIn || '—',
      checkOut: a.checkOut || '—',
      status: STATUS[a.status]?.label || a.status,
      location: cleanLocationText(a.checkInAddress || a.checkOutAddress),
    }));
  }, [dept, status, shiftNameFor, toast, leaveTypeFor, range.from, range.to]);

  const runExport = useCallback(async (build) => {
    if (exporting) return;
    setExporting(true);
    try {
      const rows = await collectExportRows();
      if (rows) await build(rows);
    } catch (err) {
      // Say what actually went wrong; the API client now classifies this
      // properly instead of reporting every failure as a network error.
      toast('error', err?.message || 'The export could not be generated.');
    } finally {
      setExporting(false);
    }
  }, [collectExportRows, exporting, toast]);

  const exportCsv = () => runExport((rows) => downloadCSV('attendance-roster', rows, EXPORT_COLUMNS));
  const exportXlsx = () => runExport(async (rows) => {
    const { downloadXLSX } = await import('../lib/exportXlsx');
    downloadXLSX('attendance-roster', rows, EXPORT_COLUMNS);
  });
  const exportPdf = () => runExport(async (rows) => {
    const { downloadPDF } = await import('../lib/exportPdf');
    downloadPDF('attendance-roster', 'Attendance Roster', rows, EXPORT_COLUMNS);
  });

  // ── Monthly Employee Timesheet (HR) ────────────────────────────────────
  // A separate download from the roster exports above: one employee or all of
  // them, for one whole calendar month. It reads the same attendance API, the
  // leave records and the holiday list already in use; nothing is recalculated
  // except the report's own regular / overtime split of the server's hours.
  const [sheetEmployee, setSheetEmployee] = useState('all');
  const [sheetMonth, setSheetMonth] = useState(() => Number(todayISO().slice(5, 7)));
  const [sheetYear, setSheetYear] = useState(() => Number(todayISO().slice(0, 4)));
  const sheetEmployees = useMemo(
    () => [...(employees || [])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    [employees],
  );
  const sheetYears = useMemo(() => {
    const thisYear = Number(todayISO().slice(0, 4));
    return Array.from({ length: 6 }, (_, i) => thisYear + 1 - i);
  }, []);

  const downloadTimesheet = useCallback(async (format) => {
    if (exporting) return;
    setExporting(true);
    try {
      const { from, to } = monthBounds(sheetYear, sheetMonth);
      const { rows, truncated } = await attendanceApi.listAll({ from, to });
      if (truncated) {
        toast('error', 'That month is too large to build in the browser. Choose one employee and try again.');
        return;
      }
      let people;
      let label;
      if (sheetEmployee === 'all') {
        // Everyone in the employee list, plus anyone who has attendance in the
        // month but is no longer in that list, so no recorded day is dropped.
        const known = new Map(sheetEmployees.map((e) => [String(e.id), { id: String(e.id), name: e.name }]));
        rows.forEach((r) => { if (!known.has(String(r.empId))) known.set(String(r.empId), { id: String(r.empId), name: r.name }); });
        people = [...known.values()];
        label = 'All Employees';
      } else {
        const one = sheetEmployees.find((e) => String(e.id) === String(sheetEmployee));
        if (!one) { toast('error', 'Choose an employee for the timesheet.'); return; }
        people = [{ id: String(one.id), name: one.name }];
        label = one.name;
      }
      const sheet = buildMonthlyTimesheet({
        year: sheetYear, month: sheetMonth, employees: people, employeeLabel: label,
        attendance: rows, leaves: leaves || [], holidays: holidays || [], today: todayISO(),
        // Regular hours stop at the length of the employee's configured shift.
        regularMinutesFor: (empId) => shiftMinutes(resolveShiftForToday(empId, settings)),
      });
      if (format === 'pdf') {
        const { downloadTimesheetPdf } = await import('../lib/timesheetPdf');
        downloadTimesheetPdf(sheet);
      } else {
        const { downloadTimesheetExcel } = await import('../lib/timesheetExcel');
        await downloadTimesheetExcel(sheet);
      }
    } catch (err) {
      toast('error', err?.message || 'The timesheet could not be generated.');
    } finally {
      setExporting(false);
    }
  }, [exporting, sheetYear, sheetMonth, sheetEmployee, sheetEmployees, leaves, holidays, settings, toast]);

  const handleRequestCorrection = async () => {
    if (!corrForm.date || !corrForm.checkIn || !corrForm.checkOut || !corrForm.reason) {
      toast('error', 'Please fill in all details.');
      return;
    }
    const emp = employees.find(e => e.id === currentUser.empId);
    if (!emp) return;

    await requestCorrection({
      employeeId: emp.id,
      employeeName: emp.name,
      date: corrForm.date,
      requestedCheckIn: corrForm.checkIn,
      requestedCheckOut: corrForm.checkOut,
      reason: corrForm.reason,
    });

    setCorrForm({ date: '', checkIn: '', checkOut: '', reason: '' });
    setCorrModalOpen(false);
  };

  const myCorrections = useMemo(() => {
    if (isHR) return attendanceCorrections;
    return attendanceCorrections.filter(c => c.employeeId === currentUser.empId);
  }, [attendanceCorrections, isHR, currentUser.empId]);

  return (
    <div className="page-wrap active attendance-page">
      <div className="list-toolbar" style={{ marginBottom: 4 }}>
        <div className="filter-chips">
          <button className={`chip ${tab === 'roster' ? 'active' : ''}`} onClick={() => setTab('roster')}>Today's roster</button>
          {isHR && (
            <button className={`chip ${tab === 'planning' ? 'active' : ''}`} onClick={() => setTab('planning')}>Shifts & planning</button>
          )}
          <button className={`chip ${tab === 'corrections' ? 'active' : ''}`} onClick={() => setTab('corrections')}>
            Corrections ({myCorrections.filter(c => c.status === 'Pending').length} pending)
          </button>
        </div>
        <LiveIndicator lastSyncedAt={lastPolledAt} />
      </div>

      {tab === 'planning' && isHR && (
        <RosterPlanner />
      )}

      {tab === 'roster' && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-icon tone-sage"><IconPresent width="16" height="16" /></div>
              <div className="stat-label">Present</div><div className="stat-value">{counts.present}</div><div className="stat-meta">checked in on time</div>
            </div>
            <div className="stat">
              <div className="stat-icon tone-gold"><IconCalendar width="16" height="16" /></div>
              <div className="stat-label">Late</div><div className="stat-value">{counts.late}</div><div className="stat-meta">past shift start + grace</div>
            </div>
            <div className="stat">
              <div className="stat-icon tone-red"><IconX width="16" height="16" /></div>
              <div className="stat-label">Absent</div><div className="stat-value">{counts.absent}</div><div className="stat-meta">no check-in yet</div>
            </div>
            <div className="stat">
              <div className="stat-icon tone-teal"><IconLeave width="16" height="16" /></div>
              <div className="stat-label">On leave</div><div className="stat-value">{counts.leave}</div><div className="stat-meta">approved leave</div>
            </div>
          </div>

          {/* The roster card (heading, exports, table) is for Admin/HR; users
              with the Employee role do not see it. They still request
              corrections from the Corrections tab. */}
          {currentUser.role !== 'Employee' && (
          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div className="card-title">{rangeActive ? 'Attendance records' : 'Today’s roster'}</div>
                <div className="card-sub">
                  {rangeActive
                    ? `${filtered.length} of ${periodTotal} record${periodTotal === 1 ? '' : 's'} loaded${range.from ? ` · from ${range.from}` : ''}${range.to ? ` · to ${range.to}` : ''}`
                    : `${filtered.length} of ${attendance.length} people shown`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost" onClick={exportCsv}>Export CSV</button>
                <button type="button" className="btn btn-ghost" onClick={exportXlsx}>Export Excel</button>
                <button type="button" className="btn btn-ghost" onClick={exportPdf}>Export PDF</button>
                {isHR && (
                  <button type="button" className="btn" onClick={() => setQrModalOpen(true)}>
                    Display Office QR
                  </button>
                )}
                {!isHR && (
                  <button type="button" className="btn" onClick={() => setCorrModalOpen(true)}>
                    Request Correction
                  </button>
                )}
              </div>
            </div>

            {isHR && (
              <div className="list-toolbar" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>Monthly timesheet</strong>
                <label className="inline-select">
                  <span>Employee</span>
                  <select className="input" value={sheetEmployee} onChange={(e) => setSheetEmployee(e.target.value)} aria-label="Timesheet employee">
                    <option value="all">All Employees</option>
                    {sheetEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </label>
                <label className="inline-select">
                  <span>Month</span>
                  <select className="input" value={sheetMonth} onChange={(e) => setSheetMonth(Number(e.target.value))} aria-label="Timesheet month">
                    {FULL_MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
                  </select>
                </label>
                <label className="inline-select">
                  <span>Year</span>
                  <select className="input" value={sheetYear} onChange={(e) => setSheetYear(Number(e.target.value))} aria-label="Timesheet year">
                    {sheetYears.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </label>
                <button type="button" className="btn btn-ghost" disabled={exporting} onClick={() => downloadTimesheet('pdf')}>Timesheet PDF</button>
                <button type="button" className="btn btn-ghost" disabled={exporting} onClick={() => downloadTimesheet('xlsx')}>Timesheet Excel</button>
              </div>
            )}

            <div className="list-toolbar">
              <div className="filter-chips">
                {['All', ...departments].map((d) => (
                  <button key={d} className={`chip ${dept === d ? 'active' : ''}`} onClick={() => setDept(d)}>{d}</button>
                ))}
              </div>
              <label className="inline-select">
                <span>From</span>
                <input
                  type="date"
                  className="input"
                  value={range.from}
                  max={range.to || todayISO()}
                  onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                />
              </label>
              <label className="inline-select">
                <span>To</span>
                <input
                  type="date"
                  className="input"
                  value={range.to}
                  min={range.from || undefined}
                  max={todayISO()}
                  onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                />
              </label>
              {rangeActive && (
                <button type="button" className="btn btn-ghost" onClick={() => setRange({ from: '', to: '' })}>
                  Clear dates
                </button>
              )}
              <label className="inline-select">
                <span>Status</span>
                <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="all">All</option>
                  <option value="present">Present</option>
                  <option value="late">Late</option>
                  <option value="absent">Absent</option>
                  <option value="leave">On leave</option>
                  <option value="half-day">Half day</option>
                  <option value="holiday">Holiday</option>
                </select>
              </label>
            </div>

            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    {rangeActive && <th style={{ whiteSpace: 'nowrap' }}>Date</th>}
                    <th style={{ whiteSpace: 'nowrap' }}>Employee</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Department</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Shift</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Check-in</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Check-out</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Status</th>
                    <th style={{ whiteSpace: 'nowrap', maxWidth: 240 }}>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((a) => {
                    const s = STATUS[a.status] || STATUS.absent;
                    const inAddress = punchAddress(a, 'checkIn');
                    const outAddress = punchAddress(a, 'checkOut');
                    return (
                      <tr key={a.id}>
                        {rangeActive && <td className="mono" style={{ whiteSpace: 'nowrap' }}>{a.date}</td>}
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <div className="emp-cell" style={{ whiteSpace: 'nowrap' }}>
                            <Avatar name={a.name} size={30} />
                            <div className="emp-name" style={{ whiteSpace: 'nowrap' }}>{a.name}</div>
                          </div>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{a.dept}</td>
                        <td className="muted-text" style={{ whiteSpace: 'nowrap' }}>{shiftNameFor(a.empId)}</td>
                        <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                          {a.checkIn || '—'}
                          {a.checkIn && (
                            <button
                              className="icon-btn sm"
                              title="View captured check-in selfie & details"
                              style={{ marginLeft: 6, fontSize: 13 }}
                              onClick={() => setDetailsRow(a)}
                            >
                              📸
                            </button>
                          )}
                          {a.anomalyFlags?.length > 0 && (
                            <span className="status-dot status-late" title={`Flagged: ${a.anomalyFlags.join(', ')}`} style={{ marginLeft: 6 }} />
                          )}
                        </td>
                        <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                          {a.checkOut || '—'}
                          {a.checkOut && (
                            <button
                              className="icon-btn sm"
                              title="View captured check-out selfie & details"
                              style={{ marginLeft: 6, fontSize: 13 }}
                              onClick={() => setDetailsRow(a)}
                            >
                              📸
                            </button>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {isHR ? (
                            <label className="status-control">
                              <span className={`status-dot ${s.cls}`} />
                              <select
                                className="input compact"
                                value={a.status}
                                onChange={(e) => setAttendanceStatus(a.id, e.target.value)}
                              >
                                <option value="present">Present</option>
                                <option value="late">Late</option>
                                <option value="absent">Absent</option>
                                <option value="leave">On leave</option>
                                <option value="half-day">Half day</option>
                              </select>
                            </label>
                          ) : (
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <span className={`status-dot ${s.cls}`} />
                              <span style={{ fontSize: 13, textTransform: 'capitalize' }}>{a.status}</span>
                            </div>
                          )}
                        </td>
                        <td
                          className="muted-text"
                          style={{
                            maxWidth: 240,
                            fontSize: 12,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          title={[inAddress && `In: ${inAddress}`, outAddress && `Out: ${outAddress}`].filter(Boolean).join('\n') || undefined}
                        >
                          {inAddress || outAddress ? (
                            <>
                              {inAddress && (
                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>📍 In: {inAddress}</div>
                              )}
                              {outAddress && (
                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>📍 Out: {outAddress}</div>
                              )}
                            </>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {rangeActive && filtered.length > 0 && (
              <div className="pager" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }} aria-label="Attendance records pages">
                <span className="pager-meta">
                  Showing {(currentRecordsPage - 1) * RECORDS_PER_PAGE + 1}–{Math.min(currentRecordsPage * RECORDS_PER_PAGE, filtered.length)} of {filtered.length} record{filtered.length === 1 ? '' : 's'}
                </span>
                {recordsPageCount > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" className="mini-btn" disabled={currentRecordsPage <= 1} onClick={() => setRecordsPage(currentRecordsPage - 1)}>Previous</button>
                    {pagerItems(currentRecordsPage, recordsPageCount).map((n, i) => (n == null
                      ? <span key={`gap-${i}`} className="pager-meta" aria-hidden="true">…</span>
                      : (
                        <button
                          key={n}
                          type="button"
                          className={`mini-btn ${n === currentRecordsPage ? 'approve' : ''}`}
                          aria-current={n === currentRecordsPage ? 'page' : undefined}
                          aria-label={`Page ${n}`}
                          onClick={() => setRecordsPage(n)}
                        >
                          {n}
                        </button>
                      )))}
                    <button type="button" className="mini-btn" disabled={currentRecordsPage >= recordsPageCount} onClick={() => setRecordsPage(currentRecordsPage + 1)}>Next</button>
                  </div>
                )}
              </div>
            )}

            {(periodError || periodLoading || hasMorePeriodRows) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 4px 2px' }}>
                {periodError && <span className="login-error">{periodError}</span>}
                {!periodError && periodLoading && <span className="muted-text">Loading records…</span>}
                {!periodError && !periodLoading && hasMorePeriodRows && (
                  <>
                    <button type="button" className="btn btn-ghost" onClick={() => loadPeriodPage(periodPage + 1)}>
                      Load more
                    </button>
                    <span className="muted-text">
                      {periodRows.length} of {periodTotal} loaded — exports always cover the whole period.
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          )}
        </>
      )}

      {tab === 'corrections' && (
        <div className="card">
          <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="card-title">Attendance Correction Requests</div>
              <div className="card-sub">{isHR ? 'Review and approve manual attendance corrections' : 'My submitted requests'}</div>
            </div>
            {!isHR && (
              <button className="btn" onClick={() => setCorrModalOpen(true)}>Request Correction</button>
            )}
          </div>

          {myCorrections.length === 0 ? (
            <div className="empty">No correction requests found.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Employee</th><th>Date</th><th>Requested Times</th><th>Reason</th><th>Status</th>
                    {isHR && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {myCorrections.map(c => (
                    <tr key={c.id}>
                      <td><strong>{c.employeeName}</strong></td>
                      <td className="mono">{c.date}</td>
                      <td>
                        <span className="state-badge approved" style={{ marginRight: 6 }}>In: {c.requestedCheckIn}</span>
                        <span className="state-badge approved">Out: {c.requestedCheckOut}</span>
                      </td>
                      <td><span style={{ fontStyle: 'italic', fontSize: 13 }}>"{c.reason}"</span></td>
                      <td>
                        <span className={`state-badge ${c.status === 'Approved' ? 'approved' : c.status === 'Rejected' ? 'declined' : 'pending'}`}>
                          {c.status}
                        </span>
                      </td>
                      {isHR && (
                        <td style={{ textAlign: 'right' }}>
                          {c.status === 'Pending' ? (
                            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                              <button className="btn btn-compact approve" onClick={() => approveCorrection(c.id)}>Approve</button>
                              <button className="btn btn-compact btn-ghost" style={{ color: 'var(--declined)' }} onClick={() => { const note = window.prompt('Reason for rejecting this correction request?'); if (note !== null) rejectCorrection(c.id, note); }}>Reject</button>
                            </div>
                          ) : (
                            <span className="muted-text">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Office QR Code Modal */}
      <Modal
        open={qrModalOpen}
        title="Office Wall QR Code"
        subtitle="Point your camera at this screen from the employee self-service dashboard to check in or out"
        onClose={() => setQrModalOpen(false)}
        width={420}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, padding: '10px 0' }}>
          <div style={{
            padding: 16,
            background: '#fff',
            borderRadius: 16,
            boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
            border: '1px solid #eee',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            width: 220,
            height: 220,
          }}>
            {qrData
              ? <QRCodeSVG value={`SEPL-ATT:${qrData.token}`} size={220} level="M" />
              : <span className="muted-text">Loading…</span>}
          </div>
          <div style={{ width: '100%', maxWidth: '250px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666', marginBottom: 6 }}>
              <span>Rotating secure token — server-issued</span>
              <span className="mono" style={{ fontWeight: 600 }}>{qrSecondsLeft}s</span>
            </div>
            <div style={{ width: '100%', height: '5px', background: '#eee', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, (qrSecondsLeft / 12) * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 1s linear' }} />
            </div>
          </div>
        </div>
      </Modal>

      {/* Attendance Detail Info Modal */}
      <Modal
        open={Boolean(detailsRow)}
        title={detailsRow ? `${detailsRow.name} — attendance detail` : ''}
        subtitle={detailsRow?.date}
        onClose={() => setDetailsRow(null)}
        width={520}
      >
        {detailsRow && (
          <div className="form-grid" style={{ gap: 14 }}>
            {detailsRow.anomalyFlags?.length > 0 && (
              <div style={{ padding: '8px 12px', background: 'rgba(220,53,69,0.08)', borderRadius: 8, fontSize: 12.5, color: '#dc3545' }}>
                Flagged for review: {detailsRow.anomalyFlags.join(', ')}
              </div>
            )}
            {['checkIn', 'checkOut'].map((dir) => {
              const label = dir === 'checkIn' ? 'Check-in' : 'Check-out';
              const time = detailsRow[dir];
              if (!time) return null;
              const cap = dir === 'checkIn' ? 'CheckIn' : 'CheckOut';
              const device = detailsRow[`${cap}Device`];
              return (
                <div key={dir} className="card" style={{ padding: 14 }}>
                  <div className="card-title" style={{ fontSize: 13, marginBottom: 8 }}>{label} · {time}</div>
                  <div className="muted-text" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                    <div><strong>Method:</strong> {detailsRow[`${cap}Details`] || '—'}</div>
                    {dir === 'checkOut' && detailsRow.earlyCheckoutReason && (
                      <div><strong>Early check-out reason:</strong> {detailsRow.earlyCheckoutReason}</div>
                    )}
                    <div><strong>Current location:</strong> {punchAddress(detailsRow, dir)} {detailsRow[`${cap}Accuracy`] != null ? `(±${Math.round(detailsRow[`${cap}Accuracy`])}m)` : ''}</div>
                    {punchCoordinates(detailsRow, dir) && (
                      <div>
                        <strong>Exact position:</strong> {punchCoordinates(detailsRow, dir).lat.toFixed(6)}, {punchCoordinates(detailsRow, dir).lng.toFixed(6)}{' '}
                        <a
                          href={`https://www.google.com/maps?q=${punchCoordinates(detailsRow, dir).lat},${punchCoordinates(detailsRow, dir).lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open location
                        </a>
                      </div>
                    )}
                    <div><strong>Device:</strong> {device ? `${device.name} · ${device.browser} · ${device.os}` : '—'}</div>
                    <div><strong>IP address:</strong> {detailsRow[`${cap}Ip`] || '—'}</div>
                    <div><strong>Device ID:</strong> {detailsRow[`${cap}DeviceId`] || '—'}</div>
                    <div><strong>Face match confidence:</strong> {detailsRow[`${cap}FaceConfidence`] != null ? `${Math.round(detailsRow[`${cap}FaceConfidence`])}%` : 'Not available yet'}</div>
                  </div>
                  <AttendancePhotoPreview attendanceId={detailsRow.id} which={dir} />
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {/* Attendance Correction Modal */}
      <Modal
        open={corrModalOpen}
        title="Request Attendance Correction"
        subtitle="Submit manual punch overrides for HR approval"
        onClose={() => setCorrModalOpen(false)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setCorrModalOpen(false)}>Cancel</button>
            <button className="btn approve" onClick={handleRequestCorrection}>Submit Request</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Date to Correct</span>
            <input type="date" className="input" max={todayISO()} value={corrForm.date} onChange={(e) => setCorrForm(prev => ({ ...prev, date: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Check-in Time (24h)</span>
            <input type="time" className="input" value={corrForm.checkIn} onChange={(e) => setCorrForm(prev => ({ ...prev, checkIn: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Check-out Time (24h)</span>
            <input type="time" className="input" value={corrForm.checkOut} onChange={(e) => setCorrForm(prev => ({ ...prev, checkOut: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Reason / Justification</span>
            <textarea
              placeholder="e.g. Forgot check-in due to client visit"
              className="input"
              value={corrForm.reason}
              onChange={(e) => setCorrForm(prev => ({ ...prev, reason: e.target.value }))}
              style={{ height: 80, padding: 8 }}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
