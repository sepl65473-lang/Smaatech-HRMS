import { useState } from 'react';
import Modal from './Modal';
import { useHRMS } from '../context/HRMSContext';

export default function ChangePasswordModal({ open, onClose }) {
  const { changePassword, toast } = useHRMS();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  };

  const close = () => { reset(); onClose(); };

  const submit = async () => {
    setError('');
    if (!currentPassword) {
      setError('Enter your current password.');
      return;
    }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError('New password must be at least 8 characters and include a letter and a number.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast('success', 'Password updated. Other signed-in sessions have been signed out.');
      close();
    } catch (err) {
      setError(err.message || 'Could not update password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Change your password"
      subtitle="Update the password for your own account"
      onClose={close}
      width={420}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <button className="btn" disabled={busy} onClick={submit}>{busy ? 'Updating…' : 'Update password'}</button>
        </>
      )}
    >
      <div className="form-grid">
        <label className="field field-full">
          <span className="field-label">Current password</span>
          <input
            type="password"
            className="input"
            value={currentPassword}
            onChange={(e) => { setCurrentPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Your current password"
            autoFocus
          />
        </label>
        <label className="field field-full">
          <span className="field-label">New password</span>
          <input
            type="password"
            className="input"
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="At least 8 characters, with a letter and a number"
          />
        </label>
        <label className="field field-full">
          <span className="field-label">Confirm new password</span>
          <input
            type="password"
            className="input"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Re-enter the new password"
          />
        </label>
        {error && <span className="field-error">{error}</span>}
      </div>
    </Modal>
  );
}
