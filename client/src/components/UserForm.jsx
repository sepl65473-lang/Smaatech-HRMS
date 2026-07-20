import { useEffect, useState } from 'react';
import Modal from './Modal';
import { ROLES } from '../lib/permissions';
import { initials } from '../lib/helpers';

const EMPTY = { name: '', role: ROLES[0], email: '', password: '', employeeId: '' };

export default function UserForm({ open, user, employees, onClose, onSave }) {
  const isEdit = Boolean(user);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) {
      setForm(user ? { ...EMPTY, ...user, password: '', employeeId: user.employeeId || '' } : EMPTY);
      setErrors({});
    }
  }, [open, user]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    const er = {};
    if (!form.name.trim()) er.name = 'Name is required';
    if (!/^\S+@\S+\.\S+$/.test(form.email)) er.email = 'Enter a valid email';
    // Password is required to create a login; on edit, a blank field means
    // "leave the current password unchanged" rather than forcing a reset.
    const weakPasswordMsg = 'Password must be at least 8 characters and include a letter and a number';
    const isWeak = (pw) => pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw);
    if (!isEdit && (!form.password || isWeak(form.password))) er.password = weakPasswordMsg;
    else if (form.password && isWeak(form.password)) er.password = weakPasswordMsg;
    setErrors(er);
    if (Object.keys(er).length) return;
    onSave({
      name: form.name.trim(),
      role: form.role,
      initials: initials(form.name),
      email: form.email.trim(),
      ...(form.password ? { password: form.password } : {}),
      ...(form.role === 'Employee' ? { employeeId: form.employeeId || null } : {}),
    });
  };

  return (
    <Modal
      open={open}
      title={isEdit ? 'Edit user' : 'Add user'}
      subtitle="Workspace login profile & role"
      onClose={onClose}
      width={460}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit}>{isEdit ? 'Save changes' : 'Add user'}</button>
        </>
      )}
    >
      <div className="form-grid">
        <label className="field field-full">
          <span className="field-label">Full name</span>
          <input className="input" value={form.name} onChange={set('name')} placeholder="e.g. Rahul Mehta" />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </label>
        <label className="field field-full">
          <span className="field-label">Role</span>
          <select className="input" value={form.role} onChange={set('role')}>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        {form.role === 'Employee' && (
          <label className="field field-full">
            <span className="field-label">Linked employee record (optional)</span>
            <select className="input" value={form.employeeId} onChange={set('employeeId')}>
              <option value="">— none —</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.dept}</option>)}
            </select>
          </label>
        )}
        <label className="field field-full">
          <span className="field-label">Email</span>
          <input className="input" type="email" value={form.email} onChange={set('email')} placeholder="name@smaatech.co" />
          {errors.email && <span className="field-error">{errors.email}</span>}
        </label>
        <label className="field field-full">
          <span className="field-label">{isEdit ? 'New password (optional)' : 'Password'}</span>
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={set('password')}
            placeholder={isEdit ? 'Leave blank to keep current password' : 'At least 8 characters, with a letter and a number'}
          />
          {errors.password && <span className="field-error">{errors.password}</span>}
        </label>
      </div>
    </Modal>
  );
}
