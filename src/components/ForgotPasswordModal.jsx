import { useEffect, useState } from 'react';
import Modal from './Modal';

export default function ForgotPasswordModal({ open, profiles, onClose, onReset }) {
  const [step, setStep] = useState('email'); // email | reset | done
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [matched, setMatched] = useState(null);

  useEffect(() => {
    if (open) {
      setStep('email'); setEmail(''); setPassword(''); setConfirm(''); setError(''); setMatched(null);
    }
  }, [open]);

  const findAccount = () => {
    const found = profiles.find((p) => p.email?.toLowerCase() === email.trim().toLowerCase());
    if (!found) {
      setError('No account found with this email.');
      return;
    }
    // Client-side reset is demo-only; never allow it for the admin account.
    if (found.role === 'HR Director') {
      setError('Admin password can only be changed from Settings after signing in.');
      return;
    }
    setError('');
    setMatched(found);
    setStep('reset');
  };

  const resetPassword = () => {
    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    onReset(matched.email, password);
    setStep('done');
  };

  return (
    <Modal
      open={open}
      title="Reset password"
      subtitle={step === 'email' ? 'Find your account' : step === 'reset' ? matched?.name : 'All set'}
      onClose={onClose}
      width={420}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose}>{step === 'done' ? 'Close' : 'Cancel'}</button>
          {step === 'email' && <button className="btn" onClick={findAccount}>Continue</button>}
          {step === 'reset' && <button className="btn" onClick={resetPassword}>Reset password</button>}
        </>
      )}
    >
      {step === 'email' && (
        <div className="form-grid">
          <p className="muted-text">
            This is a local demo — no email is sent. Enter your account email and you'll be able to set a new password directly.
          </p>
          <label className="field field-full">
            <span className="field-label">Email</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') findAccount(); }}
              placeholder="you@smaatech.co"
              autoFocus
            />
            {error && <span className="field-error">{error}</span>}
          </label>
        </div>
      )}

      {step === 'reset' && (
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">New password</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              placeholder="At least 6 characters"
              autoFocus
            />
          </label>
          <label className="field field-full">
            <span className="field-label">Confirm new password</span>
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') resetPassword(); }}
              placeholder="Re-enter password"
            />
            {error && <span className="field-error">{error}</span>}
          </label>
        </div>
      )}

      {step === 'done' && (
        <p className="muted-text">Password updated for <strong>{matched?.email}</strong>. You can sign in now.</p>
      )}
    </Modal>
  );
}
