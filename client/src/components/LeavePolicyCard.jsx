import { useEffect, useState } from 'react';
import { leavesApi } from '../data/store';
import { useHRMS } from '../context/HRMSContext';

/**
 * Leave policy configuration for HR.
 *
 * The quotas, accrual modes and carry-forward rules were seeded defaults with
 * no way to change them — so every balance the server enforced was a number HR
 * had never agreed to. This is where a company sets its own.
 *
 * Two things are deliberately not offered here, because the server refuses
 * them for good reasons:
 *   - a type's CODE cannot be changed (leave requests, balances and the ledger
 *     all join on it);
 *   - a type people have already used is retired, not deleted.
 */
const ACCRUAL_LABEL = {
  annual: 'Whole quota at the start of the leave year',
  monthly: 'Accrues month by month',
};

export default function LeavePolicyCard() {
  const { canDo, toast } = useHRMS();
  const canEdit = canDo('manageLeave') || canDo('manageEmployees');

  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingCode, setSavingCode] = useState(null);
  const [draft, setDraft] = useState({});
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState({ code: '', name: '', annualQuota: 0, accrualMode: 'annual', paid: true });

  const load = () => {
    setLoading(true);
    leavesApi.types({ includeInactive: true })
      .then((rows) => { setTypes(rows); setError(''); })
      .catch((err) => setError(err.message || 'Could not load the leave policy.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const edit = (code, patch) => setDraft((d) => ({ ...d, [code]: { ...d[code], ...patch } }));

  const save = async (type) => {
    const patch = draft[type.code];
    if (!patch) return;
    setSavingCode(type.code);
    try {
      const updated = await leavesApi.updateType(type.code, {
        ...patch,
        annualQuota: patch.annualQuota !== undefined ? Number(patch.annualQuota) : undefined,
      });
      setTypes((list) => list.map((t) => (t.code === type.code ? { ...t, ...updated } : t)));
      setDraft((d) => ({ ...d, [type.code]: undefined }));
      // The server does not retroactively rewrite balances, and saying so here
      // is the difference between HR expecting a change they will not see and
      // knowing to make an adjustment.
      toast('success', `${updated.name} updated. Existing balances are unchanged — the new policy applies from the next accrual.`);
    } catch (err) {
      toast('error', err.message || 'Could not save this leave type.');
    } finally {
      setSavingCode(null);
    }
  };

  const create = async () => {
    setSavingCode('__new__');
    try {
      const created = await leavesApi.createType({
        ...newType,
        code: newType.code.trim().toLowerCase(),
        annualQuota: Number(newType.annualQuota) || 0,
      });
      setTypes((list) => [...list, created]);
      setAdding(false);
      setNewType({ code: '', name: '', annualQuota: 0, accrualMode: 'annual', paid: true });
      toast('success', `${created.name} added.`);
    } catch (err) {
      toast('error', err.message || 'Could not add this leave type.');
    } finally {
      setSavingCode(null);
    }
  };

  const remove = async (type) => {
    const confirmed = window.confirm(
      `Remove "${type.name}"?\n\nIf anyone has already taken this leave it will be retired instead of deleted, so their history stays readable.`,
    );
    if (!confirmed) return;
    setSavingCode(type.code);
    try {
      const result = await leavesApi.deleteType(type.code);
      if (result.retired) {
        setTypes((list) => list.map((t) => (t.code === type.code ? { ...t, active: false } : t)));
        toast('info', result.message);
      } else {
        setTypes((list) => list.filter((t) => t.code !== type.code));
        toast('success', `${type.name} removed.`);
      }
    } catch (err) {
      toast('error', err.message || 'Could not remove this leave type.');
    } finally {
      setSavingCode(null);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Leave policy</div>
          <div className="card-sub">
            Quotas and accrual rules the server enforces when leave is applied for
          </div>
        </div>
        {canEdit && !adding && (
          <button className="btn btn-ghost" onClick={() => setAdding(true)}>Add leave type</button>
        )}
      </div>

      {error && <div className="empty">{error}</div>}
      {loading && !types.length && <div className="empty">Loading…</div>}

      {adding && (
        <div className="form-grid" style={{ marginBottom: 16 }}>
          <label className="field">
            <span className="field-label">Code</span>
            <input
              className="input" placeholder="e.g. bereavement" value={newType.code}
              onChange={(e) => setNewType((t) => ({ ...t, code: e.target.value }))}
            />
            <span className="muted-text" style={{ fontSize: 11 }}>Permanent — it is how every request refers to this type.</span>
          </label>
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input" placeholder="Bereavement Leave" value={newType.name}
              onChange={(e) => setNewType((t) => ({ ...t, name: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">Days per year</span>
            <input
              type="number" min="0" max="366" className="input" value={newType.annualQuota}
              onChange={(e) => setNewType((t) => ({ ...t, annualQuota: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">Accrual</span>
            <select
              className="input" value={newType.accrualMode}
              onChange={(e) => setNewType((t) => ({ ...t, accrualMode: e.target.value }))}
            >
              <option value="annual">Annual</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <div className="modal-actions field-full">
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" disabled={savingCode === '__new__'} onClick={create}>
              {savingCode === '__new__' ? 'Adding…' : 'Add leave type'}
            </button>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Leave type</th><th>Days / year</th><th>Accrual</th><th>Paid</th><th>Carry forward</th>
              {canEdit && <th style={{ textAlign: 'right' }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {types.map((type) => {
              const pending = draft[type.code] || {};
              const value = (key) => (pending[key] !== undefined ? pending[key] : type[key]);
              const dirty = Object.keys(pending).length > 0;
              return (
                <tr key={type.code} style={type.active === false ? { opacity: 0.55 } : undefined}>
                  <td>
                    <strong>{type.name}</strong>
                    <div className="muted-text" style={{ fontSize: 11 }}>
                      <span className="mono">{type.code}</span>
                      {type.active === false && ' · retired'}
                    </div>
                  </td>
                  <td>
                    {canEdit ? (
                      <input
                        type="number" min="0" max="366" className="input" style={{ width: 90 }}
                        value={value('annualQuota')}
                        onChange={(e) => edit(type.code, { annualQuota: e.target.value })}
                      />
                    ) : value('annualQuota')}
                  </td>
                  <td>
                    {canEdit ? (
                      <select
                        className="input" style={{ width: 130 }} value={value('accrualMode')}
                        onChange={(e) => edit(type.code, { accrualMode: e.target.value })}
                      >
                        <option value="annual">Annual</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    ) : value('accrualMode')}
                    <div className="muted-text" style={{ fontSize: 11 }}>{ACCRUAL_LABEL[value('accrualMode')]}</div>
                  </td>
                  <td>{type.paid ? 'Paid' : 'Unpaid'}</td>
                  <td>{type.carryForward ? `Up to ${type.carryForwardCap || '∞'} days` : 'No'}</td>
                  {canEdit && (
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="mini-btn approve" disabled={!dirty || savingCode === type.code}
                        onClick={() => save(type)}
                      >
                        {savingCode === type.code ? 'Saving…' : 'Save'}
                      </button>
                      {' '}
                      <button className="mini-btn danger" disabled={savingCode === type.code} onClick={() => remove(type)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {!loading && types.length === 0 && (
              <tr><td colSpan={canEdit ? 6 : 5}>No leave types configured.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card-sub" style={{ marginTop: 12 }}>
        Changing a quota does not rewrite balances that already exist — the ledger records what actually
        happened. A new quota applies from the next accrual or leave-year rollover; use a manual balance
        adjustment to correct someone now.
      </div>
    </div>
  );
}
