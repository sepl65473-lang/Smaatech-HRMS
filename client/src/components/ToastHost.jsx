import { useHRMS } from '../context/HRMSContext';
import { IconCheck } from './Icons';

const plainToast = (msg = '') => String(msg).replace(/<\/?strong>/g, '');

export default function ToastHost() {
  const { toasts, dismissToast } = useHRMS();
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => dismissToast(t.id)}>
          <div className="toast-icon">
            {t.type === 'success'
              ? <IconCheck width="12" height="12" />
              : <span style={{ fontWeight: 700 }}>i</span>}
          </div>
          <div className="toast-msg">{plainToast(t.msg)}</div>
        </div>
      ))}
    </div>
  );
}
