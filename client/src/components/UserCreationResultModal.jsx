import { useState } from 'react';
import Modal from './Modal';

export default function UserCreationResultModal({ open, result, onClose, onRetry }) {
  const [retrying, setRetrying] = useState(false);

  if (!result) return null;

  const isEmailSent = result.emailStatus === 'SENT';

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry(result.id);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Modal
      open={open}
      title="User account creation result"
      subtitle="Workspace login profile & email delivery status"
      onClose={onClose}
      width={460}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Done</button>
        </>
      )}
    >
      <div className="form-grid">
        <div style={{ background: 'var(--bg-2)', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--line)' }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>{result.name}</div>
          <div className="mono" style={{ fontSize: '12px', color: 'var(--muted)' }}>{result.email} · {result.role}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--card-bg)', border: '1px solid var(--line)', borderRadius: '6px' }}>
            <span style={{ fontSize: '13px', fontWeight: 500 }}>Account Status</span>
            <span className="state-badge approved">Active</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--card-bg)', border: '1px solid var(--line)', borderRadius: '6px' }}>
            <span style={{ fontSize: '13px', fontWeight: 500 }}>Welcome Email</span>
            {isEmailSent ? (
              <span className="state-badge approved">Sent</span>
            ) : (
              <span className="state-badge rejected">Failed</span>
            )}
          </div>

          {!isEmailSent && (
            <div style={{ background: '#fff5f5', border: '1px solid #feb2b2', padding: '12px', borderRadius: '6px', fontSize: '12px', color: '#c53030' }}>
              <div><strong>Email Delivery Failed:</strong> {result.emailError || 'Email server not reachable.'}</div>
              <div style={{ marginTop: 8 }}>
                The account is active and safe. You can retry sending the welcome email now.
              </div>
              <button
                className="btn sm"
                style={{ marginTop: 10, background: '#e53e3e', color: '#fff' }}
                disabled={retrying}
                onClick={handleRetry}
              >
                {retrying ? 'Retrying Email…' : 'Retry Welcome Email'}
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
