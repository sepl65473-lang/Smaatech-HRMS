import { useEffect, useState } from 'react';
import Modal from './Modal';
import { ROLES, ROLE_SCOPE } from '../lib/permissions';
import { initials, uid } from '../lib/helpers';

const EMPTY = { name: '', role: ROLES[0], email: '', password: '', empName: '' };

export default function UserForm({ open, user, employees, onClose, onSave }) {
  const isEdit = Boolean(user);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) {
      setForm(user ? { ...EMPTY, ...user } : EMPTY);
      setErrors({});
    }
  }, [open, user]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    const er = {};
    if (!form.name.trim()) er.name = 'Name is required';
    if (!/^\S+@\S+\.\S+$/.test(form.email)) er.email = 'Enter a valid email';
    if (!form.password || form.password.length < 6) er.password = 'Password must be at least 6 characters';
    setErrors(er);
    if (Object.keys(er).length) return;
    onSave({
      id: user?.id || uid('profile'),
      name: form.name.trim(),
      role: form.role,
      initials: initials(form.name),
      scope: ROLE_SCOPE[form.role] || '',
      email: form.email.trim(),
      password: form.password,
      ...(form.role === 'Employee' && form.empName ? { empName: form.empName } : {}),
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
            <select className="input" value={form.empName} onChange={set('empName')}>
              <option value="">— none —</option>
              {employees.map((e) => <option key={e.id} value={e.name}>{e.name} · {e.dept}</option>)}
            </select>
          </label>
        )}
        <label className="field field-full">
          <span className="field-label">Email</span>
          <input className="input" type="email" value={form.email} onChange={set('email')} placeholder="name@smaatech.co" />
          {errors.email && <span className="field-error">{errors.email}</span>}
        </label>
        <label className="field field-full">
          <span className="field-label">Password</span>
          <input className="input" type="password" value={form.password} onChange={set('password')} placeholder="At least 6 characters" />
          {errors.password && <span className="field-error">{errors.password}</span>}
        </label>
      </div>
    </Modal>
  );
}
