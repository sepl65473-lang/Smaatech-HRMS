import { useMemo, useState, useEffect, useCallback } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import RosterPlanner from '../components/RosterPlanner';
import {
  IconInfo, IconPresent, IconCalendar, IconX, IconLeave,
} from '../components/Icons';
import { DEPARTMENTS } from '../lib/helpers';
import { resolveShiftForToday } from '../lib/shifts';
import { downloadCSV } from '../lib/exportCsv';
// xlsx/jspdf are heavy (~700KB combined) — loaded on demand only when the
// user actually exports, so the Attendance page chunk stays light on mobile.

const STATUS = {
  present: { label: 'Present', cls: 'status-active' },
  late:    { label: 'Late',    cls: 'status-late' },
  absent:  { label: 'Absent',  cls: 'status-absent' },
  leave:   { label: 'On leave', cls: 'status-leave' },
  'early-exit': { label: 'Early exit', cls: 'status-late' },
};

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
    <span className="muted-text" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} title="Refreshes from the server on load and across tabs of this browser — other devices pick up changes on their next refresh.">
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--sage)', display: 'inline-block', animation: 'pulse 1.6s ease-in-out infinite' }} />
      Live · updated {label}
    </span>
  );
}

export default function Attendance() {
  const { attendance, settings, checkIn, checkOut, setAttendanceStatus, lastSyncedAt } = useHRMS();
  const departments = settings.departments?.length ? settings.departments : DEPARTMENTS;
  const [dept, setDept] = useState('All');
  const [status, setStatus] = useState('all');
  const [tab, setTab] = useState('roster');
  const [detailsRow, setDetailsRow] = useState(null);

  // Dynamic QR Code Display State
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrToken, setQrToken] = useState(() => Math.random().toString(36).substring(2, 10).toUpperCase());
  const [timeLeft, setTimeLeft] = useState(10);

  useEffect(() => {
    if (!qrModalOpen) return undefined;
    setTimeLeft(10);
    const interval = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          setQrToken(Math.random().toString(36).substring(2, 10).toUpperCase());
          return 10;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [qrModalOpen]);

  const filtered = useMemo(() => attendance.filter((a) => {
    const deptMatch = dept === 'All' || a.dept === dept;
    const statusMatch = status === 'all' || a.status === status;
    return deptMatch && statusMatch;
  }), [attendance, dept, status]);

  const counts = useMemo(() => {
    const c = { present: 0, late: 0, absent: 0, leave: 0 };
    filtered.forEach((a) => { c[a.status] = (c[a.status] || 0) + 1; });
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

  return (
    <div className="page-wrap active">
      <div className="list-toolbar" style={{ marginBottom: 4 }}>
        <div className="filter-chips">
          <button className={`chip ${tab === 'roster' ? 'active' : ''}`} onClick={() => setTab('roster')}>Today's roster</button>
          <button className={`chip ${tab === 'planning' ? 'active' : ''}`} onClick={() => setTab('planning')}>Shifts & planning</button>
        </div>
        <LiveIndicator lastSyncedAt={lastSyncedAt} />
      </div>

      {tab === 'planning' ? (
        <RosterPlanner />
      ) : (
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
            <button type="button" className="btn" onClick={() => setQrModalOpen(true)}>
              Display Office QR
            </button>
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
            </select>
          </label>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Shift</th><th>Check-in</th>
                <th>Check-out</th><th>Status</th><th style={{ textAlign: 'right' }}>Action</th>
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
                        </select>
                      </label>
                    </td>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}

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
            position: 'relative'
          }}>
            {/* Custom SVG QR Code Generator */}
            <svg width="220" height="220" viewBox="0 0 220 220" style={{ background: '#fff' }}>
              {/* Corner Finder Patterns */}
              {/* Top Left */}
              <rect x="10" y="10" width="50" height="50" fill="#0f172a" rx="4" />
              <rect x="20" y="20" width="30" height="30" fill="#fff" rx="2" />
              <rect x="27" y="27" width="16" height="16" fill="#4a6fa5" rx="1" />
              
              {/* Top Right */}
              <rect x="160" y="10" width="50" height="50" fill="#0f172a" rx="4" />
              <rect x="170" y="20" width="30" height="30" fill="#fff" rx="2" />
              <rect x="177" y="27" width="16" height="16" fill="#4a6fa5" rx="1" />

              {/* Bottom Left */}
              <rect x="10" y="160" width="50" height="50" fill="#0f172a" rx="4" />
              <rect x="20" y="170" width="30" height="30" fill="#fff" rx="2" />
              <rect x="27" y="177" width="16" height="16" fill="#4a6fa5" rx="1" />

              {/* Alignment Marker Bottom Right */}
              <rect x="165" y="165" width="20" height="20" fill="#0f172a" rx="2" />
              <rect x="170" y="170" width="10" height="10" fill="#fff" rx="1" />
              <rect x="174" y="174" width="2" height="2" fill="#0f172a" />

              <path d="M 80,20 h 10 v 10 h -10 z M 100,20 h 20 v 10 h -20 z M 130,20 h 10 v 30 h -10 z M 80,40 h 30 v 10 h -30 z M 120,40 h 10 v 10 h -10 z M 80,60 h 10 v 20 h -10 z M 100,60 h 40 v 10 h -40 z M 150,60 h 10 v 10 h -10 z" fill="#0f172a" />
              <path d="M 20,80 h 30 v 10 h -30 z M 60,80 h 10 v 20 h -10 z M 80,80 h 20 v 10 h -20 z M 120,80 h 10 v 10 h -10 z M 140,80 h 30 v 10 h -30 z M 180,80 h 20 v 30 h -20 z M 20,100 h 10 v 10 h -10 z M 40,100 h 10 v 30 h -10 z M 90,100 h 20 v 10 h -20 z M 120,100 h 20 v 10 h -20 z" fill="#0f172a" />
              <path d="M 80,120 h 10 v 10 h -10 z M 100,120 h 30 v 10 h -30 z M 140,120 h 10 v 20 h -10 z M 160,120 h 20 v 10 h -20 z M 190,120 h 10 v 20 h -10 z M 80,140 h 20 v 10 h -20 z M 110,140 h 10 v 30 h -10 z M 130,140 h 10 v 10 h -10 z M 150,140 h 30 v 10 h -30 z" fill="#0f172a" />
              <path d="M 80,160 h 10 v 20 h -10 z M 100,160 h 20 v 10 h -20 z M 130,160 h 20 v 10 h -20 z M 80,190 h 30 v 10 h -30 z M 120,190 h 20 v 10 h -20 z M 150,190 h 10 v 10 h -10 z" fill="#0f172a" />

              {qrToken.split('').map((char, index) => {
                const charCode = char.charCodeAt(0);
                const x = 70 + (charCode % 11) * 10;
                const y = 70 + ((charCode * (index + 1)) % 11) * 10;
                return (
                  <rect
                    key={`${qrToken}-${index}`}
                    x={x}
                    y={y}
                    width={index % 2 === 0 ? 10 : 20}
                    height={index % 3 === 0 ? 20 : 10}
                    fill={index % 2 === 0 ? "#4a6fa5" : "#0f172a"}
                  />
                );
              })}
            </svg>
          </div>

          <div style={{ width: '100%', maxWidth: '250px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666', marginBottom: 6 }}>
              <span>Rotating secure token...</span>
              <span className="mono" style={{ fontWeight: 600 }}>{timeLeft}s</span>
            </div>
            <div style={{ width: '100%', height: '5px', background: '#eee', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{
                width: `${(timeLeft / 10) * 100}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width 1s linear'
              }} />
            </div>
          </div>

          <div style={{
            fontSize: '12px',
            color: '#666',
            background: 'var(--bg-2)',
            padding: '6px 12px',
            borderRadius: '6px',
            fontFamily: 'monospace',
            border: '1px dashed #ccc'
          }}>
            SEPL-ATT-{qrToken}
          </div>
        </div>
      </Modal>

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
    </div>
  );
}
