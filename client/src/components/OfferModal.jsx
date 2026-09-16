import { useEffect, useState } from 'react';
import Modal from './Modal';
import { recruitmentApi } from '../data/store';
import { useHRMS } from '../context/HRMSContext';
import { formatINR } from '../lib/helpers';

/**
 * OFFER AND HIRE for one candidate.
 *
 * Recruitment used to end at a "Hired" column — nothing turned the candidate
 * into an employee, so their details were re-typed into the employee form and
 * the link between the applicant and the person was lost, along with any
 * record of what they had been offered.
 *
 * The flow this drives is: issue offer → record the answer → create the
 * employee from the accepted offer.
 */
export default function OfferModal({ candidate, open, onClose, onChanged }) {
  const { toast, refreshEmployees } = useHRMS();

  const [form, setForm] = useState({ salary: '', basic: '', joiningDate: '', note: '', email: '', dept: '', loc: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !candidate) return;
    setError('');
    setForm({
      salary: candidate.offer?.salary ?? '',
      basic: candidate.offer?.basic ?? '',
      joiningDate: candidate.offer?.joiningDate || '',
      note: candidate.offer?.note || '',
      email: candidate.email || '',
      dept: candidate.dept || '',
      loc: candidate.loc || '',
    });
  }, [open, candidate]);

  if (!candidate) return null;

  const offer = candidate.offer || { status: 'draft' };
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const run = async (fn, successMessage) => {
    setBusy(true);
    setError('');
    try {
      const result = await fn();
      toast('success', successMessage);
      if (onChanged) onChanged(result);
      return result;
    } catch (err) {
      setError(err.message || 'That could not be completed.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveDetails = () => recruitmentApi.update(candidate.id, {
    email: form.email, dept: form.dept, loc: form.loc,
  });

  const issueOffer = () => run(async () => {
    // The contact details live on the candidate, and hiring needs them, so
    // they are saved alongside the offer rather than asked for twice.
    await saveDetails();
    return recruitmentApi.issueOffer(candidate.id, {
      salary: Number(form.salary),
      basic: form.basic === '' ? undefined : Number(form.basic),
      joiningDate: form.joiningDate,
      note: form.note,
    });
  }, 'Offer recorded.');

  const respond = (decision) => run(() => {
    let reason = '';
    if (decision === 'declined') {
      reason = window.prompt('Why did the candidate decline?') || '';
      if (!reason.trim()) throw new Error('A reason is required when an offer is declined.');
    }
    return recruitmentApi.offerResponse(candidate.id, decision, reason);
  }, decision === 'accepted' ? 'Offer accepted.' : 'Decline recorded.');

  const hire = () => run(async () => {
    const result = await recruitmentApi.hire(candidate.id);
    if (refreshEmployees) await refreshEmployees();
    return result;
  }, `${candidate.candidate} now has an employee record.`);

  const canIssue = ['draft', 'declined', 'withdrawn'].includes(offer.status) && !candidate.employeeId;
  const awaitingResponse = offer.status === 'sent';
  const accepted = offer.status === 'accepted';

  return (
    <Modal
      open={open}
      title="Offer and hiring"
      subtitle={`${candidate.candidate} · ${candidate.title}`}
      onClose={onClose}
      width={520}
      footer={<button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>}
    >
      {error && <span className="login-error" style={{ marginBottom: 16 }}>{error}</span>}

      {candidate.employeeId && (
        <div className="empty" style={{ marginBottom: 14 }}>
          Hired — an employee record already exists for {candidate.candidate}.
        </div>
      )}

      {offer.status !== 'draft' && (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <div className="card-sub" style={{ margin: 0 }}>Current offer</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <span>{formatINR(offer.salary)} · joining {offer.joiningDate}</span>
            <span className={`state-badge ${accepted ? 'approved' : offer.status === 'declined' ? 'declined' : 'pending'}`}>
              {offer.status}
            </span>
          </div>
          {offer.declineReason && (
            <div className="muted-text" style={{ fontSize: 12, marginTop: 6 }}>{offer.declineReason}</div>
          )}
        </div>
      )}

      {canIssue && (
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Work email</span>
            <input id="offer-email" className="input" value={form.email} onChange={set('email')} placeholder="name@smaatech.co" />
            <span className="muted-text" style={{ fontSize: 11 }}>Needed to create the employee record.</span>
          </label>
          <label className="field">
            <span className="field-label">Department</span>
            <input id="offer-dept" className="input" value={form.dept} onChange={set('dept')} />
          </label>
          <label className="field">
            <span className="field-label">Location</span>
            <input id="offer-loc" className="input" value={form.loc} onChange={set('loc')} />
          </label>
          <label className="field">
            <span className="field-label">Monthly gross (₹)</span>
            <input id="offer-salary" type="number" min="1" className="input" value={form.salary} onChange={set('salary')} />
          </label>
          <label className="field">
            <span className="field-label">Basic (optional)</span>
            <input id="offer-basic" type="number" min="0" className="input" value={form.basic} onChange={set('basic')} />
          </label>
          <label className="field field-full">
            <span className="field-label">Joining date</span>
            <input id="offer-joining" type="date" className="input" value={form.joiningDate} onChange={set('joiningDate')} />
          </label>
          <label className="field field-full">
            <span className="field-label">Note (optional)</span>
            <input id="offer-note" className="input" value={form.note} onChange={set('note')} />
          </label>
          <div className="modal-actions field-full">
            <button
              className="btn"
              disabled={busy || !form.salary || !form.joiningDate}
              onClick={issueOffer}
            >
              {busy ? 'Recording…' : 'Record offer'}
            </button>
          </div>
        </div>
      )}

      {awaitingResponse && (
        <div className="modal-actions" style={{ marginTop: 8 }}>
          <button className="btn btn-ghost" disabled={busy} onClick={() => respond('declined')}>Candidate declined</button>
          <button className="btn" disabled={busy} onClick={() => respond('accepted')}>Candidate accepted</button>
        </div>
      )}

      {accepted && !candidate.employeeId && (
        <div style={{ marginTop: 8 }}>
          <div className="card-sub">
            Creates the employee record from this offer — the same salary, joining date and
            department, with probation starting per company policy.
          </div>
          <div className="modal-actions" style={{ marginTop: 10 }}>
            <button className="btn" disabled={busy} onClick={hire}>
              {busy ? 'Creating…' : 'Create employee record'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
