import { useEffect, useState } from 'react';
import { lifecycleApi } from '../data/store';
import { useHRMS } from '../context/HRMSContext';

/**
 * EMPLOYMENT POLICY — probation length, notice period and the overtime rate.
 *
 * These numbers decide real outcomes: when someone is due for confirmation,
 * how much notice they owe, and what an hour of overtime is worth. They are
 * company decisions, so the product must not invent them and then act as
 * though they were agreed. Until HR saves this form the API reports the values
 * in use as unconfirmed defaults, and that is said plainly here too.
 */
const FIELDS = [
  {
    group: 'Probation and confirmation',
    items: [
      { key: 'probationMonths', label: 'Probation length (months)', min: 0, max: 36,
        help: 'Applied from the joining date when a new employee is created.' },
      { key: 'probationExtensionMonths', label: 'Default extension (months)', min: 0, max: 24,
        help: 'Offered when HR extends someone’s probation.' },
    ],
  },
  {
    group: 'Notice period',
    items: [
      { key: 'noticePeriodDays', label: 'After confirmation (days)', min: 0, max: 365,
        help: 'Used to check the last working day on a resignation.' },
      { key: 'noticePeriodDaysOnProbation', label: 'During probation (days)', min: 0, max: 365 },
    ],
  },
  {
    group: 'Overtime',
    items: [
      { key: 'overtimeMultiplier', label: 'Rate multiplier', min: 1, max: 5, step: 0.25,
        help: 'An overtime hour is paid at this multiple of the ordinary hourly rate.' },
      { key: 'monthlyWorkingDays', label: 'Working days per month', min: 1, max: 31 },
      { key: 'dailyWorkHours', label: 'Work hours per day', min: 1, max: 24,
        help: 'Gross ÷ (working days × hours) gives the ordinary hourly rate.' },
    ],
  },
];

export default function EmploymentPolicyCard() {
  const { currentUser, toast } = useHRMS();
  const canEdit = currentUser.role === 'HR Director';

  const [policy, setPolicy] = useState(null);
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    lifecycleApi.policy()
      .then((data) => {
        if (cancelled) return;
        setPolicy(data);
        setDraft(data);
        setError('');
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the employment policy.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      const body = {};
      for (const group of FIELDS) {
        for (const item of group.items) body[item.key] = Number(draft[item.key]);
      }
      body.overtimeRequiresApproval = Boolean(draft.overtimeRequiresApproval);
      const saved = await lifecycleApi.savePolicy(body);
      setPolicy(saved);
      setDraft(saved);
      toast('success', 'Employment policy saved. It applies to changes recorded from now on.');
    } catch (err) {
      toast('error', err.message || 'Could not save the employment policy.');
    } finally {
      setSaving(false);
    }
  };

  const hourlyExample = (() => {
    const days = Number(draft.monthlyWorkingDays) || 0;
    const hours = Number(draft.dailyWorkHours) || 0;
    const multiplier = Number(draft.overtimeMultiplier) || 0;
    if (!days || !hours) return null;
    // A worked example, on a round number, so the effect of these three fields
    // is visible before anyone relies on them.
    const rate = 100000 / (days * hours);
    return `On a ₹1,00,000 gross, an overtime hour pays ₹${Math.round(rate * multiplier).toLocaleString('en-IN')}.`;
  })();

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Employment policy</div>
          <div className="card-sub">
            {loading ? 'Loading…' : (policy?.confirmedByHR
              ? 'Confirmed for this company'
              : 'Starting defaults — not yet confirmed for this company')}
          </div>
        </div>
      </div>

      {error && <div className="empty">{error}</div>}

      {!policy?.confirmedByHR && !loading && !error && (
        <div className="empty" style={{ marginBottom: 14 }}>
          Probation dates, notice periods and overtime are being calculated from the values below,
          but nobody has confirmed them for this company. Review and save them.
        </div>
      )}

      {policy && FIELDS.map((group) => (
        <div key={group.group} style={{ marginBottom: 14 }}>
          <div className="form-section-label">{group.group}</div>
          <div className="form-grid">
            {group.items.map((item) => (
              <label className="field" key={item.key}>
                <span className="field-label">{item.label}</span>
                <input
                  id={`policy-${item.key}`}
                  type="number"
                  min={item.min}
                  max={item.max}
                  step={item.step || 1}
                  className="input"
                  disabled={!canEdit}
                  value={draft[item.key] ?? ''}
                  onChange={set(item.key)}
                />
                {item.help && (
                  <span className="muted-text" style={{ fontSize: 11 }}>{item.help}</span>
                )}
              </label>
            ))}
          </div>
        </div>
      ))}

      {policy && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12 }}>
          <input
            id="policy-overtime-approval"
            type="checkbox"
            disabled={!canEdit}
            checked={Boolean(draft.overtimeRequiresApproval)}
            onChange={(e) => setDraft((d) => ({ ...d, overtimeRequiresApproval: e.target.checked }))}
          />
          <span>Overtime claims need approval before they are paid</span>
        </label>
      )}

      {hourlyExample && <div className="card-sub">{hourlyExample}</div>}

      {canEdit && policy && (
        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save employment policy'}
          </button>
        </div>
      )}
    </div>
  );
}
