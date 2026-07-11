import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import Avatar from './Avatar';
import { useHRMS } from '../context/HRMSContext';
import { DEPARTMENTS, LOCATIONS } from '../lib/helpers';

const emptyForm = (depts) => ({
  name: '', role: '', dept: depts[0], loc: LOCATIONS[0],
  email: '', phone: '', status: 'active', joinDate: '', salary: '',
  bankAccount: '', ifsc: '', managerId: '', photo: '',
});

const MAX_PHOTO_SIZE = 2 * 1024 * 1024; // 2 MB raw upload cap
const PHOTO_DIMENSION = 240; // stored square size in px

// Downscale + compress the chosen image client-side so it stays small
// enough to live safely inside the employee record (localStorage).
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a valid image.'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = PHOTO_DIMENSION;
        canvas.height = PHOTO_DIMENSION;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, PHOTO_DIMENSION, PHOTO_DIMENSION);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export default function EmployeeForm({ open, employee, onClose, onSave }) {
  const { settings, employees } = useHRMS();
  const departments = settings.departments?.length ? settings.departments : DEPARTMENTS;
  const designations = settings.designations || [];
  const managerOptions = employees.filter((e) => e.id !== employee?.id);
  const isEdit = Boolean(employee);
  const [form, setForm] = useState(() => emptyForm(departments));
  const [errors, setErrors] = useState({});
  const [photoError, setPhotoError] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setForm(employee ? { ...emptyForm(departments), ...employee, salary: String(employee.salary ?? '') } : emptyForm(departments));
      setErrors({});
    }
  }, [open, employee]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handlePhotoChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPhotoError('');
    if (!file.type.startsWith('image/')) {
      setPhotoError('Please choose an image file (PNG, JPG, WEBP).');
      return;
    }
    if (file.size > MAX_PHOTO_SIZE) {
      setPhotoError('Image must be 2 MB or smaller.');
      return;
    }
    try {
      const dataUrl = await resizePhoto(file);
      setForm((f) => ({ ...f, photo: dataUrl }));
    } catch (err) {
      setPhotoError(err.message || 'Could not process that image.');
    }
  };

  const removePhoto = () => setForm((f) => ({ ...f, photo: '' }));

  const validate = () => {
    const er = {};
    if (!form.name.trim()) er.name = 'Name is required';
    if (!form.role.trim()) er.role = 'Role is required';
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) er.email = 'Enter a valid email';
    if (form.salary && Number(form.salary) < 0) er.salary = 'Cannot be negative';
    setErrors(er);
    return Object.keys(er).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    const payload = {
      ...form,
      salary: Number(form.salary) || 0,
      rating: employee?.rating ?? 4.0,
      managerId: form.managerId || null,
      photo: form.photo || '',
    };
    onSave(payload);
  };

  return (
    <Modal
      open={open}
      title={isEdit ? 'Edit employee' : 'Add employee'}
      subtitle={isEdit ? form.name : 'Create a new team member'}
      onClose={onClose}
      width={520}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit}>{isEdit ? 'Save changes' : 'Add employee'}</button>
        </>
      )}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <Avatar name={form.name || '?'} photo={form.photo} size={64} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
              {form.photo ? 'Change photo' : 'Upload photo'}
            </button>
            {form.photo && (
              <button type="button" className="btn btn-ghost" onClick={removePhoto}>Remove</button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={handlePhotoChange}
          />
          {photoError ? (
            <span className="field-error">{photoError}</span>
          ) : (
            <span className="card-sub" style={{ margin: 0 }}>PNG, JPG or WEBP · up to 2 MB</span>
          )}
        </div>
      </div>

      <div className="form-grid">
        <Field label="Full name" error={errors.name} full>
          <input className="input" value={form.name} onChange={set('name')} placeholder="e.g. Aarav Patel" />
        </Field>
        <Field label="Role" error={errors.role}>
          <input className="input" list="designation-options" value={form.role} onChange={set('role')} placeholder="e.g. Senior SDE" />
          <datalist id="designation-options">
            {designations.map((d) => <option key={d} value={d} />)}
          </datalist>
        </Field>
        <Field label="Department">
          <select className="input" value={form.dept} onChange={set('dept')}>
            {departments.map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Reports to">
          <select className="input" value={form.managerId || ''} onChange={set('managerId')}>
            <option value="">— none (top of hierarchy) —</option>
            {managerOptions.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role}</option>)}
          </select>
        </Field>
        <Field label="Location">
          <select className="input" value={form.loc} onChange={set('loc')}>
            {LOCATIONS.map((l) => <option key={l}>{l}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="input" value={form.status} onChange={set('status')}>
            <option value="active">Active</option>
            <option value="remote">Remote</option>
            <option value="on-leave">On leave</option>
          </select>
        </Field>
        <Field label="Email" error={errors.email}>
          <input className="input" value={form.email} onChange={set('email')} placeholder="name@smaatech.co" />
        </Field>
        <Field label="Phone">
          <input className="input" value={form.phone} onChange={set('phone')} placeholder="+91 …" />
        </Field>
        <Field label="Joining date">
          <input type="date" className="input" value={form.joinDate} onChange={set('joinDate')} />
        </Field>
        <Field label="Monthly gross (₹)" error={errors.salary}>
          <input type="number" className="input" value={form.salary} onChange={set('salary')} placeholder="0" />
        </Field>
        <Field label="Bank account no.">
          <input className="input" value={form.bankAccount} onChange={set('bankAccount')} placeholder="For salary disbursement" />
        </Field>
        <Field label="IFSC code">
          <input className="input" value={form.ifsc} onChange={set('ifsc')} placeholder="e.g. HDFC0001234" />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, error, full, children }) {
  return (
    <label className={`field ${full ? 'field-full' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
