import Modal from './Modal';

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = true, onConfirm, onCancel }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={400}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={onConfirm}>{confirmLabel}</button>
        </>
      )}
    >
      <p style={{ color: 'var(--ink-2)', lineHeight: 1.5 }}>{message}</p>
    </Modal>
  );
}
