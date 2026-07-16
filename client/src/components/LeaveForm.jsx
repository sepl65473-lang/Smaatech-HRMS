import { useEffect, useState } from 'react';
import Modal from './Modal';
import { LEAVE_TYPES, daysBetween } from '../lib/helpers';

export default function LeaveForm({ open, employees, onClose, onSave }) {
  const [form, setForm] = useState({ empId: '', type: 'casual', start: '', end: '', reason: '' });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) {
      setForm({ empId: employees[0]?.id || '', type: 'casual', start: '', end: '', reason: '' });
      setErrors({});
    }
  }, [open, employees]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const days = daysBetween(form.start, form.end);

  const submit = () => {
    const er = {};
    if (!form.empId) er.empId = 'Select an employee';
    if (!form.start) er.start = 'Pick a start date';
    if (!form.end) er.end = 'Pick an end date';
    if (form.start && form.end && days <= 0) er.end = 'End must be on/after start';
    setErrors(er);
    if (Object.keys(er).length) return;
    onSave(form);
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
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit}>Raise request</button>
        </>
      )}
    >
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
            {LEAVE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
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
