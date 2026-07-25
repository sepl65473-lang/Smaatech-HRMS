import { useEffect, useState } from 'react';
import Modal from './Modal';
import { useHRMS } from '../context/HRMSContext';
import { LEAVE_TYPES, daysBetween } from '../lib/helpers';

export default function LeaveForm({ open, employees, onClose, onSave }) {
  const { getMasterValues } = useHRMS();
  const leaveTypesFromDB = getMasterValues('leave_types');
  const leaveTypes = leaveTypesFromDB.map((val) => {
    const matching = LEAVE_TYPES.find((lt) => lt.value === val);
    if (matching) return matching;
    return {
      value: val,
      label: val.charAt(0).toUpperCase() + val.slice(1) + ' leave',
      tag: `tag-${val.toLowerCase()}`,
    };
  });

  const [form, setForm] = useState({ empId: '', type: 'casual', start: '', end: '', reason: '' });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ empId: employees[0]?.id || '', type: leaveTypes[0]?.value || 'casual', start: '', end: '', reason: '' });
      setErrors({});
      setSubmitError('');
      setSaving(false);
    }
    // leaveTypes intentionally excluded: it's rebuilt from getMasterValues()
    // on every render (a fresh array each call), so including it here would
    // rerun this effect — and its setState calls — on every render, an
    // infinite loop (see the identical bug fixed in EmployeeForm.jsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employees]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const days = daysBetween(form.start, form.end);

  const submit = async () => {
    const er = {};
    if (!form.empId) er.empId = 'Select an employee';
    if (!form.start) er.start = 'Pick a start date';
    if (!form.end) er.end = 'Pick an end date';
    if (form.start && form.end && days <= 0) er.end = 'End must be on/after start';
    setErrors(er);
    if (Object.keys(er).length) return;
    setSubmitError('');
    setSaving(true);
    try {
      await onSave(form);
    } catch (err) {
      setSubmitError(err.message || 'Could not raise this leave request. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New leave request"
      subtitle={days > 0 ? `${days} day${days > 1 ? 's' : ''}` : 'Raise on behalf of an employee'}
      onClose={onClose}
      width={480}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" onClick={submit} disabled={saving}>{saving ? 'Raising…' : 'Raise request'}</button>
        </>
      )}
    >
      {submitError && <span className="login-error" style={{ marginBottom: 16 }}>{submitError}</span>}
      <div className="form-grid">
        <label className="field field-full">
          <span className="field-label">Employee</span>
          <select className="input" value={form.empId} onChange={set('empId')}>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.dept}</option>)}
          </select>
          {errors.empId && <span className="field-error">{errors.empId}</span>}
        </label>
        <label className="field field-full">
          <span className="field-label">Leave type</span>
          <select className="input" value={form.type} onChange={set('type')}>
            {leaveTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">From</span>
          <input type="date" className="input" value={form.start} onChange={set('start')} />
          {errors.start && <span className="field-error">{errors.start}</span>}
        </label>
        <label className="field">
          <span className="field-label">To</span>
          <input type="date" className="input" value={form.end} onChange={set('end')} />
          {errors.end && <span className="field-error">{errors.end}</span>}
        </label>
        <label className="field field-full">
          <span className="field-label">Reason (optional)</span>
          <textarea className="input" rows={3} value={form.reason} onChange={set('reason')} placeholder="Short note…" />
        </label>
      </div>
    </Modal>
  );
}
