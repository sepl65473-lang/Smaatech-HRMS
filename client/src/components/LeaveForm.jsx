import { useEffect, useState } from 'react';
import Modal from './Modal';
import { useHRMS } from '../context/HRMSContext';
import { LEAVE_TYPES, daysBetween } from '../lib/helpers';
import { leavesApi } from '../data/store';

export default function LeaveForm({ open, employees, onClose, onSave }) {
  const { getMasterValues, currentUser } = useHRMS();

  // Only HR may file on someone else's behalf (server/src/routes/leave.js
  // rejects anything else with 403 FORBIDDEN). This form used to default the
  // Employee field to employees[0] for EVERYONE, so an ordinary employee
  // raising their own leave submitted a colleague's id and was refused every
  // single time — the most common action in the module could not be completed.
  const canFileForOthers = ['HR Director', 'HR Manager'].includes(currentUser?.role);
  const ownEmpId = currentUser?.empId ? String(currentUser.empId) : '';
  const selectableEmployees = canFileForOthers
    ? employees
    : employees.filter((e) => String(e.id) === ownEmpId);
  const defaultEmpId = canFileForOthers ? (employees[0]?.id || '') : (selectableEmployees[0]?.id || ownEmpId);
  const [form, setForm] = useState({ empId: '', type: 'casual', start: '', end: '', reason: '', isHalfDay: false, halfDayTiming: 'first-half', attachment: '' });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [saving, setSaving] = useState(false);

  // The AUTHORITATIVE list is the company's configured leave policy
  // (GET /leaves/types) — the same records the server validates and reserves
  // against. The master-data list is only a fallback for an older tenant whose
  // policy call fails, because offering a type the server does not know about
  // means the request is refused with UNKNOWN_LEAVE_TYPE after the person has
  // filled the whole form in.
  const [policyTypes, setPolicyTypes] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    leavesApi.types()
      .then((types) => { if (!cancelled) setPolicyTypes(types); })
      .catch(() => { if (!cancelled) setPolicyTypes(null); });
    return () => { cancelled = true; };
  }, [open]);

  const fallbackTypes = getMasterValues('leave_types').map((val) => {
    const matching = LEAVE_TYPES.find((lt) => lt.value === val);
    if (matching) return matching;
    return {
      value: val,
      label: val.charAt(0).toUpperCase() + val.slice(1) + ' leave',
      tag: `tag-${val.toLowerCase()}`,
    };
  });
  const leaveTypes = policyTypes?.length
    ? policyTypes.map((t) => ({ value: t.code, label: t.name, allowHalfDay: t.allowHalfDay }))
    : fallbackTypes;
  const selectedType = leaveTypes.find((t) => t.value === form?.type);

  useEffect(() => {
    if (open) {
      setForm({ empId: defaultEmpId, type: leaveTypes[0]?.value || 'casual', start: '', end: '', reason: '', isHalfDay: false, halfDayTiming: 'first-half', attachment: '' });
      setErrors({});
      setSubmitError('');
      setSaving(false);
    }
  }, [open, employees, defaultEmpId]);

  // The policy arrives after the form has already reset, so a type that is not
  // in this company's policy (the 'casual' initial value, say) would sit
  // selected and be rejected on submit. Snap to a configured one instead.
  useEffect(() => {
    if (!open || !leaveTypes.length) return;
    if (!leaveTypes.some((t) => t.value === form.type)) {
      setForm((f) => ({ ...f, type: leaveTypes[0].value }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, policyTypes, form.type]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setBool = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }));

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      setForm((f) => ({ ...f, attachment: evt.target.result }));
    };
    reader.readAsDataURL(file);
  };

  const days = form.isHalfDay ? 0.5 : daysBetween(form.start, form.end);

  const submit = async () => {
    const er = {};
    if (!form.empId) er.empId = 'Select an employee';
    if (!form.start) er.start = 'Pick a start date';
    if (!form.end) er.end = 'Pick an end date';
    if (form.start && form.end && daysBetween(form.start, form.end) <= 0) er.end = 'End must be on/after start';
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
      subtitle={days > 0 ? `${days} day${days !== 1 ? 's' : ''}` : (canFileForOthers ? 'Raise on behalf of an employee' : 'Raise your own leave request')}
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
          <select className="input" value={form.empId} onChange={set('empId')} disabled={!canFileForOthers}>
            {selectableEmployees.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.dept}</option>)}
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
          <input type="date" className="input" value={form.start} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, start: val, ...(f.isHalfDay ? { end: val } : {}) }));
          }} />
          {errors.start && <span className="field-error">{errors.start}</span>}
        </label>
        <label className="field">
          <span className="field-label">To</span>
          <input type="date" className="input" value={form.end} disabled={form.isHalfDay} onChange={set('end')} />
          {errors.end && <span className="field-error">{errors.end}</span>}
        </label>

        <div className="field field-full" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '13px', fontWeight: 500 }}>
            <input type="checkbox" checked={form.isHalfDay} disabled={selectedType?.allowHalfDay === false} onChange={(e) => {
              const checked = e.target.checked;
              setForm((f) => ({ ...f, isHalfDay: checked, ...(checked && f.start ? { end: f.start } : {}) }));
            }} />
            <span>Half-Day Leave</span>
          </label>
          {form.isHalfDay && (
            <select className="input" style={{ width: 'auto', flex: 1 }} value={form.halfDayTiming} onChange={set('halfDayTiming')}>
              <option value="first-half">First Half (Morning)</option>
              <option value="second-half">Second Half (Afternoon)</option>
            </select>
          )}
        </div>

        <label className="field field-full">
          <span className="field-label">Reason (optional)</span>
          <textarea className="input" rows={2} value={form.reason} onChange={set('reason')} placeholder="Short note…" />
        </label>
        <label className="field field-full">
          <span className="field-label">Attachment / Document (optional)</span>
          <input type="file" accept="image/*,.pdf" className="input" onChange={handleFileUpload} />
          {form.attachment && <span className="muted-text" style={{ fontSize: '11px', marginTop: 4 }}>File attached ✓</span>}
        </label>
      </div>
    </Modal>
  );
}
