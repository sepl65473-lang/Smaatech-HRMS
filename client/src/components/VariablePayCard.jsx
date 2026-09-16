import { useEffect, useMemo, useState } from 'react';
import { payComponentsApi } from '../data/store';
import { useHRMS } from '../context/HRMSContext';
import { formatINR } from '../lib/helpers';

/**
 * VARIABLE PAY for a payroll cycle: overtime, bonus, incentive, arrears,
 * reimbursements and ad-hoc deductions.
 *
 * Payroll could only pay a fixed monthly gross minus statutory deductions and
 * loss of pay, so anything variable was paid outside the system or not at all.
 *
 * Two things this screen must make obvious, because money depends on them:
 *   - overtime is claimed in HOURS and valued by the server from the
 *     employee's salary and the company's configured multiplier;
 *   - only APPROVED components are paid, so anything still pending is shown
 *     as at risk of missing the run.
 */
const EARNING_KINDS = [
  { value: 'overtime', label: 'Overtime' },
  { value: 'bonus', label: 'Bonus' },
  { value: 'incentive', label: 'Incentive' },
  { value: 'arrear', label: 'Arrears' },
  { value: 'reimbursement', label: 'Reimbursement' },
  { value: 'other-earning', label: 'Other earning' },
];
const DEDUCTION_KINDS = [
  { value: 'advance-recovery', label: 'Advance recovery' },
  { value: 'other-deduction', label: 'Other deduction' },
];
const ALL_KINDS = [...EARNING_KINDS, ...DEDUCTION_KINDS];
const KIND_LABEL = Object.fromEntries(ALL_KINDS.map((k) => [k.value, k.label]));

const STATUS_CLASS = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'declined',
  paid: 'approved',
};

export default function VariablePayCard({ cycle }) {
  const { employees, currentUser, canDo, toast } = useHRMS();

  const canApprove = ['Finance Lead', 'HR Director'].includes(currentUser.role);
  const canRaise = canApprove || currentUser.role === 'HR Manager';
  const canSeeSummary = canApprove || canDo('managePayroll') || currentUser.role === 'HR Manager';

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ empId: '', kind: 'overtime', hours: '', amount: '', description: '' });

  const load = () => {
    setLoading(true);
    Promise.all([
      payComponentsApi.list({ cycle }),
      canSeeSummary ? payComponentsApi.summary(cycle).catch(() => null) : Promise.resolve(null),
    ])
      .then(([list, sum]) => { setRows(list); setSummary(sum); setError(''); })
      .catch((err) => setError(err.message || 'Could not load variable pay for this cycle.'))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [cycle, canSeeSummary]);

  const payableEmployees = useMemo(
    () => employees.filter((e) => e.status !== 'exited'),
    [employees],
  );

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const isOvertime = form.kind === 'overtime';

  const raise = async () => {
    setBusyId('__new__');
    try {
      const created = await payComponentsApi.raise({
        empId: form.empId,
        cycle,
        kind: form.kind,
        description: form.description,
        ...(isOvertime ? { hours: Number(form.hours) } : { amount: Number(form.amount) }),
      });
      setRows((list) => [created, ...list]);
      setAdding(false);
      setForm({ empId: '', kind: 'overtime', hours: '', amount: '', description: '' });
      toast('success', isOvertime
        ? `Overtime recorded: ${created.hours}h at ${created.multiplier}x = ${formatINR(created.amount)}.`
        : `${KIND_LABEL[created.kind]} of ${formatINR(created.amount)} raised.`);
      load();
    } catch (err) {
      toast('error', err.message || 'That could not be raised.');
    } finally {
      setBusyId(null);
    }
  };

  const decide = async (row, decision) => {
    let note = '';
    if (decision === 'rejected') {
      note = window.prompt(`Why is this ${KIND_LABEL[row.kind]} being rejected?`) || '';
      if (!note.trim()) return;
    }
    setBusyId(row.id);
    try {
      const updated = await payComponentsApi.decide(row.id, decision, note);
      setRows((list) => list.map((r) => (r.id === row.id ? updated : r)));
      toast('success', `${KIND_LABEL[row.kind]} ${decision}.`);
      load();
    } catch (err) {
      toast('error', err.message || 'That decision could not be recorded.');
    } finally {
      setBusyId(null);
    }
  };

  const withdraw = async (row) => {
    if (!window.confirm(`Withdraw this ${KIND_LABEL[row.kind]}?`)) return;
    setBusyId(row.id);
    try {
      await payComponentsApi.withdraw(row.id);
      setRows((list) => list.filter((r) => r.id !== row.id));
      toast('success', 'Withdrawn.');
      load();
    } catch (err) {
      toast('error', err.message || 'That could not be withdrawn.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Variable pay — {cycle}</div>
          <div className="card-sub">
            {loading ? 'Loading…' : `${rows.length} item${rows.length === 1 ? '' : 's'} · only approved items are paid`}
          </div>
        </div>
        {canRaise && !adding && (
          <button className="btn btn-ghost" onClick={() => setAdding(true)}>Add variable pay</button>
        )}
      </div>

      {error && <div className="empty">{error}</div>}

      {summary && (
        <div className="stats" style={{ marginBottom: 14 }}>
          <div className="stat">
            <div className="stat-label">Approved earnings</div>
            <div className="stat-value mono" style={{ fontSize: 20 }}>{formatINR(summary.approvedEarnings)}</div>
            <div className="stat-meta">will be added to this run</div>
          </div>
          <div className="stat">
            <div className="stat-label">Approved deductions</div>
            <div className="stat-value mono" style={{ fontSize: 20 }}>{formatINR(summary.approvedDeductions)}</div>
            <div className="stat-meta">will be subtracted</div>
          </div>
          <div className="stat">
            <div className="stat-label">Awaiting approval</div>
            <div className="stat-value mono" style={{ fontSize: 20 }}>{formatINR(summary.pendingTotal)}</div>
            <div className="stat-meta">
              {summary.pendingCount
                ? `${summary.pendingCount} item(s) will NOT be paid until approved`
                : 'nothing outstanding'}
            </div>
          </div>
        </div>
      )}

      {adding && (
        <div className="form-grid" style={{ marginBottom: 16 }}>
          <label className="field">
            <span className="field-label">Employee</span>
            <select id="vp-employee" className="input" value={form.empId} onChange={set('empId')}>
              <option value="">— select —</option>
              {payableEmployees.map((e) => (
                <option key={e.id} value={e.id}>{e.name} · {e.dept}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Type</span>
            <select id="vp-kind" className="input" value={form.kind} onChange={set('kind')}>
              <optgroup label="Earnings">
                {EARNING_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </optgroup>
              <optgroup label="Deductions">
                {DEDUCTION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </optgroup>
            </select>
          </label>
          {isOvertime ? (
            <label className="field">
              <span className="field-label">Hours worked</span>
              <input id="vp-hours" type="number" min="0" step="0.5" className="input" value={form.hours} onChange={set('hours')} />
              <span className="muted-text" style={{ fontSize: 11 }}>
                The amount is calculated from the employee’s salary and the company overtime rate.
              </span>
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Amount (₹)</span>
              <input id="vp-amount" type="number" min="0" className="input" value={form.amount} onChange={set('amount')} />
            </label>
          )}
          <label className="field field-full">
            <span className="field-label">Description</span>
            <input id="vp-description" className="input" value={form.description} onChange={set('description')} placeholder="Shown on the payslip" />
          </label>
          <div className="modal-actions field-full">
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button
              className="btn"
              disabled={busyId === '__new__' || !form.empId || (isOvertime ? !form.hours : !form.amount)}
              onClick={raise}
            >
              {busyId === '__new__' ? 'Raising…' : 'Raise'}
            </button>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th><th>Type</th><th>Detail</th>
              <th style={{ textAlign: 'right' }}>Amount</th><th>Status</th><th>Raised by</th>
              <th style={{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7}>No variable pay raised for this cycle.</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.employeeName}</td>
                <td>{KIND_LABEL[row.kind] || row.kind}</td>
                <td>
                  {row.kind === 'overtime'
                    ? <span className="mono">{row.hours}h @ {row.multiplier}x of {formatINR(row.hourlyRate)}/h</span>
                    : (row.description || '—')}
                  {row.decisionNote && (
                    <div className="muted-text" style={{ fontSize: 11 }}>{row.decisionNote}</div>
                  )}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>{formatINR(row.amount)}</td>
                <td><span className={`state-badge ${STATUS_CLASS[row.status] || 'pending'}`}>{row.status}</span></td>
                <td>{row.raisedBy?.name || '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {row.status === 'pending' && canApprove && (
                    <>
                      <button className="mini-btn approve" disabled={busyId === row.id} onClick={() => decide(row, 'approved')}>
                        Approve
                      </button>
                      {' '}
                      <button className="mini-btn" disabled={busyId === row.id} onClick={() => decide(row, 'rejected')}>
                        Reject
                      </button>
                    </>
                  )}
                  {row.status === 'pending' && !canApprove && canRaise && (
                    <button className="mini-btn danger" disabled={busyId === row.id} onClick={() => withdraw(row)}>
                      Withdraw
                    </button>
                  )}
                  {row.status !== 'pending' && <span className="muted-text">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
