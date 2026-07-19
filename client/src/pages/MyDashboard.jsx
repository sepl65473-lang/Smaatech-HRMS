import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import LeaveForm from '../components/LeaveForm';
import FaceAttendanceModal from '../components/FaceAttendanceModal';
import FaceEnrollModal from '../components/FaceEnrollModal';
import {
  IconPlus, IconCheck, IconX, IconFaceScan, IconDashboard, IconChevronRight,
} from '../components/Icons';
import { formatDate, daysBetween, formatINR, leaveTagClass, leaveTagLabel } from '../lib/helpers';
import { downloadPayslip } from '../lib/payslip';

export default function MyDashboard() {
  const {
    currentUser, employees, leaves, attendance, payroll, settings, reviews,
    addLeave, checkIn, checkOut, audit, submitSelfReview, toast,
    enrollFace, faceEnrolled,
  } = useHRMS();
  const [formOpen, setFormOpen] = useState(false);
  const [selfRating, setSelfRating] = useState(3);
  const [selfComments, setSelfComments] = useState('');

  // GPS Geofencing State
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsStatus, setGpsStatus] = useState(null);

  // Face + GPS attendance verification state
  const [faceModalOpen, setFaceModalOpen] = useState(false);
  const [faceAction, setFaceAction] = useState('in'); // in | out
  const [pendingRowId, setPendingRowId] = useState(null);
  const [pendingLoc, setPendingLoc] = useState(null);
  const [faceEnrollOpen, setFaceEnrollOpen] = useState(false);

  // Haversine distance calculation in meters
  const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3; // Earth radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  };

  const resolveLocation = () => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by your browser.'));
        return;
      }
      const targetLat = settings.geofenceLat ?? 19.0760;
      const targetLng = settings.geofenceLng ?? 72.8777;
      const radius = settings.geofenceRadius ?? 25;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const dist = getDistanceMeters(lat, lng, targetLat, targetLng);
          resolve({
            lat, lng, distance: dist, isInside: dist <= radius,
            accuracy: pos.coords.accuracy, timestamp: pos.timestamp,
          });
        },
        (err) => {
          reject(new Error(`GPS Error: ${err.message}`));
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  };

  const me = useMemo(
    () => employees.find((e) => e.id === currentUser.empId),
    [employees, currentUser.empId],
  );

  const startAttendance = async (rowId, action) => {
    if (!faceEnrolled) {
      toast('error', `Enroll your face below before you can check ${action === 'in' ? 'in' : 'out'}.`);
      return;
    }
    setGpsLoading(true);
    setGpsStatus(null);
    try {
      let loc = null;
      if (settings.gpsCheckInEnabled) {
        loc = await resolveLocation();
        setGpsStatus(loc);
        if (!loc.isInside) {
          toast('error', `Location check failed: You're ${loc.distance.toFixed(0)}m from the office — outside the allowed ${settings.geofenceRadius ?? 25}m radius.`);
          return;
        }
      }
      setPendingLoc(loc);
      setPendingRowId(rowId);
      setFaceAction(action);
      setFaceModalOpen(true);
    } catch (err) {
      setGpsStatus({ error: err.message });
      toast('error', err.message);
    } finally {
      setGpsLoading(false);
    }
  };

  const handleCheckIn = (rowId) => startAttendance(rowId, 'in');
  const handleCheckOut = (rowId) => startAttendance(rowId, 'out');

  // `photo` is the captured selfie Blob — the server independently re-detects
  // and matches it against the enrolled descriptor; this call doesn't know
  // yet whether it'll actually pass.
  const handleFaceVerified = async (photo) => {
    setFaceModalOpen(false);
    const locationData = { ...(pendingLoc || {}), photo };
    try {
      if (faceAction === 'in') {
        await checkIn(pendingRowId, locationData);
        toast('success', pendingLoc
          ? `Checked in — face + location verified (${pendingLoc.distance.toFixed(1)}m from office).`
          : 'Checked in — face verified.');
      } else {
        await checkOut(pendingRowId, locationData);
        toast('info', pendingLoc
          ? 'Checked out — face + location verified.'
          : 'Checked out — face verified.');
      }
    } catch {
      // The server already surfaced the rejection reason (e.g. outside the
      // geofence, or the face didn't match) via a toast — nothing more to do here.
    } finally {
      setPendingRowId(null);
      setPendingLoc(null);
    }
  };

  const handleFaceModalClose = () => {
    setFaceModalOpen(false);
    setPendingRowId(null);
    setPendingLoc(null);
  };

  const handleSaveMyFace = async (photoBlob) => {
    if (!me) {
      toast('error', "Your login isn't linked to your employee record — ask HR to fix this in Settings → Users.");
      setFaceEnrollOpen(false);
      return;
    }
    await enrollFace(photoBlob);
    setFaceEnrollOpen(false);
  };

  const myLeaves = useMemo(
    () => leaves.filter((l) => l.empId === currentUser.empId),
    [leaves, currentUser.empId],
  );

  const balance = useMemo(() => {
    const approved = myLeaves.filter((l) => l.status === 'approved');
    const pending = myLeaves.filter((l) => l.status === 'pending');
    const used = approved.reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    const pendingDays = pending.reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    const total = Number(settings.totalLeaveDays || 24);
    return { used, pendingDays, remaining: Math.max(0, total - used), total };
  }, [myLeaves, settings.totalLeaveDays]);

  const myAttendance = useMemo(
    () => attendance.filter((a) => a.empId === currentUser.empId),
    [attendance, currentUser.empId],
  );
  const todayRow = myAttendance[0];

  const myPayroll = useMemo(
    () => payroll.filter((p) => p.empId === currentUser.empId),
    [payroll, currentUser.empId],
  );

  const myReviews = useMemo(
    () => reviews.filter((r) => r.empId === currentUser.empId),
    [reviews, currentUser.empId],
  );
  const openReview = myReviews.find((r) => r.status === 'pending');

  if (!me) {
    return (
      <div className="page-wrap active">
        <div className="card">
          <div className="empty">
            {currentUser.empId
              ? 'Your session looks out of date — please sign out and sign in again.'
              : 'No linked employee record found for this profile.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-wrap active">
      <div className="page-header-row">
        <div>
          <div className="breadcrumb">
            <IconDashboard width="13" height="13" />
            <span>Dashboard</span>
            <IconChevronRight width="12" height="12" />
            <span className="breadcrumb-current">My Dashboard</span>
          </div>
          <h1 className="page-header-title">My Dashboard</h1>
        </div>
        <div className="page-header-actions">
          <button className="btn" onClick={() => setFormOpen(true)}>
            <IconPlus width="14" height="14" /> New leave request
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <div className="emp-cell">
            <Avatar name={me.name} photo={me.photo} size={48} />
            <div>
              <div className="card-title">{me.name}</div>
              <div className="card-sub">{me.role} · {me.dept} · {me.loc}</div>
            </div>
          </div>
          <Link className="btn btn-ghost" to={`/employees/${me.id}`}>View full profile</Link>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Leave balance</div>
          <div className="stat-value">{balance.remaining}<small style={{ fontSize: 14 }}> / {balance.total} days</small></div>
          <div className="stat-meta">{balance.used} used · {balance.pendingDays} pending</div>
        </div>
        <div className="stat">
          <div className="stat-label">Today</div>
          <div className="stat-value">{todayRow ? (todayRow.checkOut ? 'Done' : todayRow.checkIn ? 'Checked in' : 'Not in yet') : '—'}</div>
          <div className="stat-meta">{todayRow?.checkIn ? `In ${todayRow.checkIn}` : 'No check-in'}{todayRow?.checkOut ? ` · Out ${todayRow.checkOut}` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Latest payslip</div>
          <div className="stat-value mono" style={{ fontSize: 20 }}>{myPayroll[0] ? formatINR(myPayroll[0].net) : '—'}</div>
          <div className="stat-meta">{myPayroll[0]?.cycle || 'No cycle yet'}</div>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">My attendance</div>
              <div className="card-sub">Today's status & check-in/out</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {faceEnrolled
              ? <span className="state-badge approved">Face ID enrolled</span>
              : <span className="muted-text">Face ID not enrolled</span>}
            {me ? (
              <button type="button" className="mini-btn" onClick={() => setFaceEnrollOpen(true)}>
                {faceEnrolled ? 'Re-enroll my face' : 'Enroll my face'}
              </button>
            ) : (
              <span className="muted-text">Login not linked — ask HR to link your profile in Settings → Users.</span>
            )}
          </div>
          {todayRow ? (
            <div className="leave-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
              <div className="leave-body">
                <div className="leave-meta">
                  Check-in: <strong className="mono">{todayRow.checkIn || '—'}</strong> 
                  {todayRow.checkInLoc && <span className="muted-text"> ({todayRow.checkInDetails || 'GPS'}: {todayRow.checkInLoc})</span>}
                  <br />
                  Check-out: <strong className="mono">{todayRow.checkOut || '—'}</strong>
                  {todayRow.checkOutLoc && <span className="muted-text"> ({todayRow.checkOutDetails || 'GPS'}: {todayRow.checkOutLoc})</span>}
                </div>
              </div>

              {/* Geofencing Verification details */}
              {settings.gpsCheckInEnabled && !todayRow.checkOut && (
                <div style={{
                  background: 'var(--bg-2)',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  border: '1px solid var(--line)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <IconFaceScan width="14" height="14" /> GPS Geofencing
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--muted)' }}>(Enabled by Admin)</span>
                  </div>

                  {/* Status Indicator */}
                  {gpsLoading ? (
                    <div className="muted-text" style={{ fontSize: '12px' }}>Checking GPS coordinates...</div>
                  ) : gpsStatus ? (
                    gpsStatus.error ? (
                      <div style={{ color: 'var(--red)', fontSize: '12px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <IconX width="12" height="12" /> {gpsStatus.error}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div style={{ color: gpsStatus.isInside ? 'var(--sage)' : 'var(--red)', fontWeight: 600, fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: 4 }}>
                          {gpsStatus.isInside ? <IconCheck width="12" height="12" /> : <IconX width="12" height="12" />}
                          {gpsStatus.isInside ? 'Inside Geofence Area' : 'Outside Allowed Boundary'}
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--muted)' }}>
                          Distance: <strong>{gpsStatus.distance > 1000 ? `${(gpsStatus.distance/1000).toFixed(2)}km` : `${gpsStatus.distance.toFixed(1)}m`}</strong> from office.
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="muted-text" style={{ fontSize: '12px' }}>GPS verification pending check action.</div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="leave-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
                {todayRow.status === 'leave' && !todayRow.checkIn && (
                  <span className="muted-text">Marked on leave today — checking in below will override that.</span>
                )}

                {/* Check In Action Button */}
                {!todayRow.checkIn && (
                  faceEnrolled ? (
                    <button type="button" className="mini-btn approve" disabled={gpsLoading} onClick={() => handleCheckIn(todayRow.id)}>
                      {gpsLoading ? 'Checking location…' : 'Check In (Face + GPS)'}
                    </button>
                  ) : (
                    <span className="muted-text">Enroll your face above for Face + GPS check-in</span>
                  )
                )}

                {/* Check Out Action Button */}
                {todayRow.checkIn && !todayRow.checkOut && (
                  faceEnrolled ? (
                    <button type="button" className="mini-btn approve" disabled={gpsLoading} onClick={() => handleCheckOut(todayRow.id)}>
                      {gpsLoading ? 'Checking location…' : 'Check Out (Face + GPS)'}
                    </button>
                  ) : (
                    <span className="muted-text">Enroll your face above for Face + GPS check-out</span>
                  )
                )}

                {todayRow.checkIn && todayRow.checkOut && (
                  <span className="muted-text" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--sage)', fontWeight: 600 }}>
                    <IconCheck width="14" height="14" /> Checked in & checked out today
                  </span>
                )}
              </div>
            </div>
          ) : <div className="empty">No attendance record yet.</div>}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">My leave requests</div>
              <div className="card-sub">{myLeaves.length} total</div>
            </div>
            <button className="btn" onClick={() => setFormOpen(true)}>
              <IconPlus width="14" height="14" /> New request
            </button>
          </div>
          <div className="leave-list">
            {myLeaves.length === 0 && <div className="empty">No leave requests yet.</div>}
            {myLeaves.map((l) => (
              <div className="leave-item" key={l.id}>
                <div className="leave-body">
                  <div className="leave-name">
                    {daysBetween(l.start, l.end)} days
                    {l.status !== 'pending' && <span className={`state-badge ${l.status}`}>{l.status}</span>}
                  </div>
                  <div className="leave-meta">{formatDate(l.start)} – {formatDate(l.end)}</div>
                  {l.reason && <div className="leave-reason">"{l.reason}"</div>}
                  <span className={`leave-tag ${leaveTagClass(l.type)}`}>{leaveTagLabel(l.type)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(openReview || myReviews.length > 0) && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Performance review</div>
              <div className="card-sub">{openReview ? `${openReview.cycleName} — self-review pending` : `${myReviews.length} cycle(s) on record`}</div>
            </div>
          </div>
          {openReview ? (
            <div className="form-grid">
              <label className="field field-full">
                <span className="field-label">Self rating (0–5)</span>
                <input type="number" min="0" max="5" step="0.1" className="input" value={selfRating} onChange={(e) => setSelfRating(e.target.value)} />
              </label>
              <label className="field field-full">
                <span className="field-label">Self comments</span>
                <textarea className="input" rows={3} value={selfComments} onChange={(e) => setSelfComments(e.target.value)} placeholder="Highlights, challenges, what you're proud of…" />
              </label>
              <div className="modal-actions" style={{ marginTop: 4 }}>
                <button
                  className="btn"
                  onClick={() => submitSelfReview(openReview.id, { selfRating: Number(selfRating), selfComments })}
                >
                  Submit self review
                </button>
              </div>
            </div>
          ) : (
            <div className="leave-list">
              {myReviews.map((r) => (
                <div className="leave-item" key={r.id}>
                  <div className="leave-body">
                    <div className="leave-name">
                      {r.cycleName}
                      <span className={`state-badge ${r.status === 'completed' ? 'approved' : 'pending'}`}>{r.status}</span>
                    </div>
                    <div className="leave-meta">
                      Self: {r.selfRating ?? '—'} / 5 · Manager: {r.managerRating ?? '—'} / 5
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">My payslips</div>
            <div className="card-sub">{myPayroll.length} cycles</div>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Cycle</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th style={{ textAlign: 'right' }}>Deductions</th>
                <th style={{ textAlign: 'right' }}>Net</th>
                <th>Status</th><th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {myPayroll.length === 0 && (
                <tr><td colSpan={6}><div className="empty">No payslips yet.</div></td></tr>
              )}
              {myPayroll.map((p) => (
                <tr key={p.id}>
                  <td>{p.cycle}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{formatINR(p.gross)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">– {formatINR(p.deductions)}</td>
                  <td style={{ textAlign: 'right' }} className="mono"><strong>{formatINR(p.net)}</strong></td>
                  <td>{p.status === 'paid' ? <><IconCheck width="11" height="11" /> Paid</> : p.status}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="mini-btn"
                      onClick={() => { downloadPayslip(p); audit('Payslip downloaded', p.name, p.cycle); }}
                    >
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <LeaveForm
        open={formOpen}
        employees={me ? [me] : []}
        onClose={() => setFormOpen(false)}
        onSave={async (data) => { await addLeave({ ...data, empId: currentUser.empId }); setFormOpen(false); }}
      />
      <FaceAttendanceModal
        open={faceModalOpen}
        action={faceAction}
        onClose={handleFaceModalClose}
        onVerified={handleFaceVerified}
      />
      <FaceEnrollModal
        open={faceEnrollOpen}
        user={me}
        onClose={() => setFaceEnrollOpen(false)}
        onSave={handleSaveMyFace}
      />
    </div>
  );
}
