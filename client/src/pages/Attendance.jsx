import { useMemo, useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import RosterPlanner from '../components/RosterPlanner';
import {
  IconInfo, IconPresent, IconCalendar, IconX, IconLeave,
} from '../components/Icons';
import { todayISO } from '../lib/helpers';
import { resolveShiftForToday } from '../lib/shifts';
import { downloadCSV } from '../lib/exportCsv';
import { ATTENDANCE_STATUS as STATUS } from '../lib/attendanceStatus';

const EXPORT_COLUMNS = [
  { key: 'name', label: 'Employee' },
  { key: 'dept', label: 'Department' },
  { key: 'shift', label: 'Shift' },
  { key: 'checkIn', label: 'Check-in' },
  { key: 'checkOut', label: 'Check-out' },
  { key: 'status', label: 'Status' },
];

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
    attendance, settings, checkIn, checkOut, setAttendanceStatus, refreshAttendance,
    attendanceCorrections, requestCorrection, approveCorrection, rejectCorrection, currentUser, employees, toast,
    getMasterValues, getQrToken,
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

  const filtered = useMemo(() => attendance.filter((a) => {
    const deptMatch = dept === 'All' || a.dept === dept;
    const statusMatch = status === 'all' || a.status === status;
    return deptMatch && statusMatch;
  }), [attendance, dept, status]);

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
      name: a.name,
      dept: a.dept,
      shift: shiftNameFor(a.empId),
      checkIn: a.checkIn || '—',
      checkOut: a.checkOut || '—',
      status: STATUS[a.status]?.label || a.status,
    })),
    [filtered, shiftNameFor],
  );

  const exportCsv = () => downloadCSV('attendance-roster', exportRows, EXPORT_COLUMNS);
  const exportXlsx = async () => {
    const { downloadXLSX } = await import('../lib/exportXlsx');
    downloadXLSX('attendance-roster', exportRows, EXPORT_COLUMNS);
  };
  const exportPdf = async () => {
    const { downloadPDF } = await import('../lib/exportPdf');
    downloadPDF('attendance-roster', 'Attendance Roster', exportRows, EXPORT_COLUMNS);
  };

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
    <div className="page-wrap active">
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

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div className="card-title">Today’s roster</div>
                <div className="card-sub">{filtered.length} of {attendance.length} people shown</div>
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

            <div className="list-toolbar">
              <div className="filter-chips">
                {['All', ...departments].map((d) => (
                  <button key={d} className={`chip ${dept === d ? 'active' : ''}`} onClick={() => setDept(d)}>{d}</button>
                ))}
              </div>
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
                    <th>Employee</th><th>Department</th><th>Shift</th><th>Check-in</th>
                    <th>Check-out</th><th>Status</th>
                    {isHR && <th style={{ textAlign: 'right' }}>Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
                    const s = STATUS[a.status] || STATUS.absent;
                    return (
                      <tr key={a.id}>
                        <td>
                          <div className="emp-cell">
                            <Avatar name={a.name} size={30} />
                            <div className="emp-name">{a.name}</div>
                          </div>
                        </td>
                        <td>{a.dept}</td>
                        <td className="muted-text">{shiftNameFor(a.empId)}</td>
                        <td className="mono">
                          {a.checkIn || '—'}
                          {(a.checkIn || a.checkOut) && (
                            <button
                              className="icon-btn sm"
                              title="View check-in/out details"
                              style={{ marginLeft: 6 }}
                              onClick={() => setDetailsRow(a)}
                            >
                              <IconInfo width="13" height="13" />
                            </button>
                          )}
                          {a.anomalyFlags?.length > 0 && (
                            <span className="status-dot status-late" title={`Flagged: ${a.anomalyFlags.join(', ')}`} style={{ marginLeft: 6 }} />
                          )}
                        </td>
                        <td className="mono">{a.checkOut || '—'}</td>
                        <td>
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
                        {isHR && (
                          <td style={{ textAlign: 'right' }}>
                            {a.status === 'leave' ? (
                              <span className="muted-text">—</span>
                            ) : !a.checkIn ? (
                              <button className="mini-btn approve" onClick={() => checkIn(a.id)}>Check in</button>
                            ) : !a.checkOut ? (
                              <button className="mini-btn" onClick={() => checkOut(a.id)}>Check out</button>
                            ) : (
                              <span className="muted-text">Done</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
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
                              <button className="btn btn-compact btn-ghost" style={{ color: 'var(--declined)' }} onClick={() => rejectCorrection(c.id)}>Reject</button>
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
                    <div><strong>Coordinates:</strong> {detailsRow[`${cap}Loc`] || '—'} {detailsRow[`${cap}Accuracy`] != null ? `(±${Math.round(detailsRow[`${cap}Accuracy`])}m)` : ''}</div>
                    <div><strong>Address:</strong> {detailsRow[`${cap}Address`] || 'Not available'}</div>
                    <div><strong>Device:</strong> {device ? `${device.name} · ${device.browser} · ${device.os}` : '—'}</div>
                    <div><strong>IP address:</strong> {detailsRow[`${cap}Ip`] || '—'}</div>
                    <div><strong>Device ID:</strong> {detailsRow[`${cap}DeviceId`] || '—'}</div>
                    <div><strong>Face match confidence:</strong> {detailsRow[`${cap}FaceConfidence`] != null ? `${Math.round(detailsRow[`${cap}FaceConfidence`])}%` : 'Not available yet'}</div>
                  </div>
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
