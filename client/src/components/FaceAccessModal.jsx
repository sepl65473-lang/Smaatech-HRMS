import { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import { useHRMS } from '../context/HRMSContext';

/**
 * HR/Admin control for ONE employee's temporary face re-verification access.
 *
 * Granting access does not verify anybody and does not touch face matching:
 * it only re-opens the normal enrolment flow for that one account, for a
 * limited time, with a reason recorded. The employee still has to pass the
 * same face capture and the server still computes the descriptor itself.
 */
const HOUR_CHOICES = [2, 8, 24, 72, 168];

export default function FaceAccessModal({ open, employee, onClose }) {
  const { listFaceAccess, grantFaceAccess, revokeFaceAccess, toast } = useHRMS();
  const [grants, setGrants] = useState([]);
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const email = employee ? String(employee.email || '') : '';

  const load = useCallback(async () => {
    if (!email) return;
    try {
      const all = await listFaceAccess();
      // The employee's login is matched by the address Employee Management
      // already holds, so no extra lookup endpoint is needed.
      setGrants(all.filter((g) => String(g.subjectEmail || '').toLowerCase() === email.toLowerCase()));
      setError('');
    } catch (err) {
      setError(err?.message || 'Could not load access history.');
    }
  }, [email, listFaceAccess]);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setHours(24);
    setError('');
    load();
  }, [open, load]);

  const active = grants.find((g) => g.status === 'active');

  const grant = async () => {
    if (!reason.trim()) {
      setError('A reason is required — it is recorded with the grant.');
      return;
    }
    setBusy(true);
    try {
      await grantFaceAccess({ email, reason: reason.trim(), hours });
      toast('success', `Face re-verification access granted to <strong>${employee.name}</strong>`);
      setReason('');
      await load();
    } catch (err) {
      setError(err?.message || 'Could not grant access.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    setBusy(true);
    try {
      await revokeFaceAccess(id);
      toast('info', 'Access revoked.');
      await load();
    } catch (err) {
      setError(err?.message || 'Could not revoke access.');
    } finally {
      setBusy(false);
    }
  };

  const when = (value) => (value ? new Date(value).toLocaleString() : '—');

  return (
    <Modal
      open={open}
      title="Face re-verification access"
      subtitle={employee ? `${employee.name} · ${employee.email}` : undefined}
      onClose={onClose}
      width={560}
      footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}
    >
      <p className="muted-text" style={{ marginTop: 0 }}>
        Grants this one employee a temporary window to redo their face enrolment
        in their own portal. It is not a verification bypass: they still complete
        the normal face capture, and it is spent as soon as they do.
      </p>

      {active ? (
        <div className="leave-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div><span className="state-badge approved">Access active</span></div>
          <div className="muted-text">Expires {when(active.expiresAt)} · granted by {active.grantedBy?.name || 'HR'}</div>
          <div className="muted-text">Reason: {active.reason}</div>
          <div>
            <button className="mini-btn danger" disabled={busy} onClick={() => revoke(active.id)}>
              Revoke access
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label className="field-label">Reason</label>
            <input
              className="input"
              value={reason}
              onChange={(e) => { setReason(e.target.value); setError(''); }}
              placeholder="e.g. face check-in keeps failing after an injury"
            />
          </div>
          <div className="field">
            <label className="field-label">Access expires after</label>
            <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {HOUR_CHOICES.map((h) => (
                <option key={h} value={h}>{h >= 24 ? `${h / 24} day(s)` : `${h} hours`}</option>
              ))}
            </select>
          </div>
          <button className="btn" disabled={busy} onClick={grant}>
            {busy ? 'Granting…' : 'Grant access'}
          </button>
        </>
      )}

      {error && <div className="login-error" style={{ marginTop: 10 }}>{error}</div>}

      {grants.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="card-sub" style={{ marginBottom: 6 }}>History</div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Granted</th><th>By</th><th>Reason</th><th>Expires</th><th>Status</th></tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.id}>
                    <td className="mono">{when(g.createdAt)}</td>
                    <td>{g.grantedBy?.name || '—'}</td>
                    <td>{g.reason}</td>
                    <td className="mono">{when(g.expiresAt)}</td>
                    <td style={{ textTransform: 'capitalize' }}>{g.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
