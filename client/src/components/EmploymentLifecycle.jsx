import { useEffect, useMemo, useState } from 'react';
import { lifecycleApi } from '../data/store';
import { useHRMS } from '../context/HRMSContext';
import { formatINR } from '../lib/helpers';

/**
 * EMPLOYMENT LIFECYCLE for one employee: probation, confirmation, transfer,
 * promotion and salary revision — plus the history they produce.
 *
 * These changes used to be made by editing the profile form, which overwrote
 * the previous department or salary with no effective date and no record. Each
 * action here records what changed, from what, to what, when it takes effect
 * and why.
 */

const ACTIONS = [
  { id: 'confirm', label: 'Confirm employment', stageRequired: ['Probation'] },
  { id: 'extend', label: 'Extend probation', stageRequired: ['Probation'] },
  { id: 'promote', label: 'Promote' },
  { id: 'transfer', label: 'Transfer' },
  { id: 'salary', label: 'Revise salary', financeVisible: true },
];

const EVENT_LABEL = {
  'probation-started': 'Probation started',
  'probation-extended': 'Probation extended',
  confirmed: 'Confirmed',
  transferred: 'Transferred',
  promoted: 'Promoted',
  'salary-revised': 'Salary revised',
  'status-changed': 'Status changed',
  'notice-started': 'Notice period started',
  exited: 'Exited',
};

const MONEY_FIELDS = new Set(['salary', 'basic', 'da', 'hra']);

function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (MONEY_FIELDS.has(field)) return formatINR(Number(value));
  return String(value);
}

export default function EmploymentLifecycle({ employee }) {
  const { canDo, currentUser, employees, toast, refreshEmployees } = useHRMS();
  const canManage = canDo('manageEmployees');
  const canReviseSalary = currentUser.role === 'HR Director' || currentUser.role === 'HR Manager';

  const [events, setEvents] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openAction, setOpenAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({});

  const managerOptions = useMemo(
    () => employees.filter((e) => e.id !== employee.id),
    [employees, employee.id],
  );

  const load = () => {
    setLoading(true);
    Promise.all([
      lifecycleApi.events({ empId: employee.id }),
      lifecycleApi.policy().catch(() => null),
    ])
      .then(([rows, pol]) => { setEvents(rows); setPolicy(pol); setError(''); })
      .catch((err) => setError(err.message || 'Could not load the employment history.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [employee.id]);

  const open = (id) => {
    setOpenAction(id);
    setForm({
      effectiveDate: new Date().toISOString().slice(0, 10),
      role: employee.role || '',
      dept: employee.dept || '',
      loc: employee.loc || '',
      managerId: employee.managerId || '',
      salary: employee.salary ?? '',
      basic: employee.basic ?? '',
      months: policy?.probationExtensionMonths ?? 3,
      reason: '',
    });
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    try {
      const common = { effectiveDate: form.effectiveDate, reason: form.reason };
      if (openAction === 'confirm') {
        await lifecycleApi.confirm(employee.id, common);
        toast('success', `${employee.name} confirmed with effect from ${form.effectiveDate}.`);
      } else if (openAction === 'extend') {
        await lifecycleApi.extendProbation(employee.id, { ...common, months: Number(form.months) });
        toast('success', 'Probation extended.');
      } else if (openAction === 'promote') {
        await lifecycleApi.promote(employee.id, {
          ...common,
          role: form.role,
          ...(form.salary !== '' && Number(form.salary) !== employee.salary
            ? { salary: Number(form.salary), ...(form.basic !== '' ? { basic: Number(form.basic) } : {}) }
            : {}),
        });
        toast('success', `${employee.name} promoted to ${form.role}.`);
      } else if (openAction === 'transfer') {
        await lifecycleApi.transfer(employee.id, {
          ...common, dept: form.dept, loc: form.loc, managerId: form.managerId || null,
        });
        toast('success', 'Transfer recorded.');
      } else if (openAction === 'salary') {
        await lifecycleApi.reviseSalary(employee.id, {
          ...common,
          salary: Number(form.salary),
          ...(form.basic !== '' ? { basic: Number(form.basic) } : {}),
        });
        toast('success', 'Salary revision recorded.');
      }
      setOpenAction(null);
      load();
      // The employee document changed underneath the page.
      if (refreshEmployees) await refreshEmployees();
    } catch (err) {
      toast('error', err.message || 'That change could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const stage = employee.employmentStage || 'Probation';
  const availableActions = ACTIONS.filter((a) => {
    if (a.id === 'salary') return canReviseSalary;
    if (!canManage) return false;
    if (a.stageRequired && !a.stageRequired.includes(stage)) return false;
    return stage !== 'Exited';
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Employment status</div>
            <div className="card-sub">
              {stage}
              {employee.probationEndDate && stage === 'Probation' && ` · probation ends ${employee.probationEndDate}`}
              {employee.confirmationDate && stage === 'Confirmed' && ` · confirmed ${employee.confirmationDate}`}
            </div>
          </div>
        </div>

        {policy && !policy.confirmedByHR && canManage && (
          <div className="empty" style={{ marginBottom: 12 }}>
            The probation and notice-period figures in use are starting defaults — nobody has
            confirmed them for this company yet. Set them in Settings before relying on them.
          </div>
        )}

        {availableActions.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {availableActions.map((action) => (
              <button
                key={action.id}
                className={`btn ${openAction === action.id ? '' : 'btn-ghost'}`}
                onClick={() => (openAction === action.id ? setOpenAction(null) : open(action.id))}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {openAction && (
          <div className="form-grid" style={{ marginTop: 16 }}>
            {openAction === 'promote' && (
              <label className="field">
                <span className="field-label">New designation</span>
                <input className="input" value={form.role} onChange={set('role')} />
              </label>
            )}
            {openAction === 'transfer' && (
              <>
                <label className="field">
                  <span className="field-label">Department</span>
                  <input className="input" value={form.dept} onChange={set('dept')} />
                </label>
                <label className="field">
                  <span className="field-label">Location</span>
                  <input className="input" value={form.loc} onChange={set('loc')} />
                </label>
                <label className="field field-full">
                  <span className="field-label">Reports to</span>
                  <select className="input" value={form.managerId || ''} onChange={set('managerId')}>
                    <option value="">— none —</option>
                    {managerOptions.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} · {m.role}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {openAction === 'extend' && (
              <label className="field">
                <span className="field-label">Extend by (months)</span>
                <input type="number" min="1" max="24" className="input" value={form.months} onChange={set('months')} />
              </label>
            )}
            {(openAction === 'salary' || openAction === 'promote') && (
              <>
                <label className="field">
                  <span className="field-label">
                    {openAction === 'promote' ? 'New monthly gross (optional)' : 'New monthly gross'}
                  </span>
                  <input type="number" min="0" className="input" value={form.salary} onChange={set('salary')} />
                </label>
                <label className="field">
                  <span className="field-label">Basic (optional)</span>
                  <input type="number" min="0" className="input" value={form.basic} onChange={set('basic')} />
                </label>
              </>
            )}

            <label className="field">
              <span className="field-label">Effective from</span>
              <input type="date" className="input" value={form.effectiveDate} onChange={set('effectiveDate')} />
            </label>
            <label className="field">
              <span className="field-label">
                Reason{openAction === 'extend' ? '' : ' (optional)'}
              </span>
              <input className="input" value={form.reason} onChange={set('reason')} placeholder="Recorded in the history" />
            </label>

            <div className="modal-actions field-full">
              <button className="btn btn-ghost" onClick={() => setOpenAction(null)} disabled={busy}>Cancel</button>
              <button className="btn" onClick={submit} disabled={busy}>
                {busy ? 'Recording…' : 'Record change'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Employment history</div>
            <div className="card-sub">
              {loading ? 'Loading…' : `${events.length} recorded change${events.length === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>

        {error && <div className="empty">{error}</div>}
        {!error && !loading && events.length === 0 && (
          <div className="empty">Nothing recorded yet.</div>
        )}

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Change</th><th>Effective</th><th>What changed</th><th>Reason</th><th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td><strong>{EVENT_LABEL[event.type] || event.type}</strong></td>
                  <td className="mono">{event.effectiveDate}</td>
                  <td>
                    {Object.entries(event.changes || {}).map(([field, change]) => (
                      <div key={field} style={{ fontSize: 12.5 }}>
                        {field}: <span className="mono">{formatValue(field, change.from)}</span>
                        {' → '}
                        <span className="mono">{formatValue(field, change.to)}</span>
                      </div>
                    ))}
                    {event.note && <div className="muted-text" style={{ fontSize: 11.5 }}>{event.note}</div>}
                  </td>
                  <td>{event.reason || '—'}</td>
                  <td>
                    {event.actor?.name || '—'}
                    {event.actor?.role && (
                      <div className="muted-text" style={{ fontSize: 11 }}>{event.actor.role}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
