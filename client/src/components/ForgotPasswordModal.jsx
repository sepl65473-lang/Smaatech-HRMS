import { useEffect, useState } from 'react';
import Modal from './Modal';

export default function ForgotPasswordModal({ open, onClose, onRequestOtp, onReset }) {
  const [step, setStep] = useState('email'); // email | otp | done
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open) {
      setStep('email'); setEmail(''); setOtp(''); setPassword(''); setConfirm(''); setError(''); setSending(false);
    }
  }, [open]);

  const requestOtp = async () => {
    if (!email.trim()) { setError('Enter your account email.'); return; }
    setError('');
    setSending(true);
    try {
      await onRequestOtp(email.trim());
      setStep('otp');
    } catch (err) {
      setError(err.message || 'Could not send the verification code.');
    } finally {
      setSending(false);
    }
  };

  const submitReset = async () => {
    if (otp.trim().length !== 6) { setError('Enter the 6-digit code from your email.'); return; }
    if (!password || password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setError('');
    setSending(true);
    try {
      await onReset(email.trim(), otp.trim(), password);
      setStep('done');
    } catch (err) {
      setError(err.message || 'Incorrect or expired code.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Reset password"
      subtitle={step === 'email' ? 'Find your account' : step === 'otp' ? 'Check your email' : 'All set'}
      onClose={onClose}
      width={420}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose}>{step === 'done' ? 'Close' : 'Cancel'}</button>
          {step === 'email' && <button className="btn" disabled={sending} onClick={requestOtp}>{sending ? 'Sending…' : 'Send code'}</button>}
          {step === 'otp' && <button className="btn" disabled={sending} onClick={submitReset}>{sending ? 'Resetting…' : 'Reset password'}</button>}
        </>
      )}
    >
      {step === 'email' && (
        <div className="form-grid">
          <p className="muted-text">
            We'll email a 6-digit verification code to your account address.
          </p>
          <label className="field field-full">
            <span className="field-label">Email</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') requestOtp(); }}
              placeholder="you@smaatech.co"
              autoFocus
            />
            {error && <span className="field-error">{error}</span>}
          </label>
        </div>
      )}

      {step === 'otp' && (
        <div className="form-grid">
          <p className="muted-text">
            Enter the 6-digit code sent to <strong>{email}</strong>, and your new password.
          </p>
          <label className="field field-full">
            <span className="field-label">Verification code</span>
            <input
              className="input mono"
              type="text"
              maxLength="6"
              value={otp}
              onChange={(e) => { setOtp(e.target.value.replace(/[^0-9]/g, '')); setError(''); }}
              placeholder="000000"
              style={{ textAlign: 'center', letterSpacing: '4px', fontSize: '18px' }}
              autoFocus
            />
          </label>
          <label className="field field-full">
            <span className="field-label">New password</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              placeholder="At least 6 characters"
            />
          </label>
          <label className="field field-full">
            <span className="field-label">Confirm new password</span>
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitReset(); }}
              placeholder="Re-enter password"
            />
            {error && <span className="field-error">{error}</span>}
          </label>
          <button type="button" className="login-forgot-btn" style={{ alignSelf: 'flex-start' }} disabled={sending} onClick={requestOtp}>
            Resend code
          </button>
        </div>
      )}

      {step === 'done' && (
        <p className="muted-text">Password updated for <strong>{email}</strong>. You can sign in now.</p>
      )}
    </Modal>
  );
}
