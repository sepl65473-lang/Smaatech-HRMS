import { useEffect, useState } from 'react';
import Modal from './Modal';

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = true, onConfirm, onCancel }) {
  const [confirming, setConfirming] = useState(false);

  // Reset whenever the dialog is (re)opened for a new target, so a stale
  // disabled/"…"-labelled button from a previous confirmation never leaks in.
  useEffect(() => {
    if (open) setConfirming(false);
  }, [open]);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
    } catch {
      // The action itself already surfaced a toast with the real reason —
      // just stop showing "…" so Cancel/retry are usable again. Callers
      // that don't set open=false on failure keep the dialog open, same as
      // before; this only fixes the button getting stuck mid-request.
      setConfirming(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={400}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={confirming}>Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={handleConfirm} disabled={confirming}>
            {confirming ? 'Working…' : confirmLabel}
          </button>
        </>
      )}
    >
      <p style={{ color: 'var(--ink-2)', lineHeight: 1.5 }}>{message}</p>
    </Modal>
  );
}
