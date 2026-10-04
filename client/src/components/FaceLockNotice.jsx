import { useEffect, useRef, useState } from 'react';

export function formatWait(total) {
  const seconds = Math.max(0, Math.round(total));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The temporary face-verification lock, counted down.
 *
 * `seconds` is the wait the SERVER reported; this only counts it down, on a
 * monotonic clock so changing the device time does not move it. Reaching zero
 * unlocks nothing by itself: `onExpire` asks the server again, and the server
 * decides. Give it a new `key` to restart it from a new server value.
 */
export default function FaceLockNotice({ seconds, onExpire, onRecheck, audience = 'employee' }) {
  const [left, setLeft] = useState(seconds);
  const expire = useRef(onExpire);
  useEffect(() => { expire.current = onExpire; });

  useEffect(() => {
    const deadline = performance.now() + seconds * 1000;
    const timer = setInterval(() => {
      const remaining = Math.ceil((deadline - performance.now()) / 1000);
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(timer);
        expire.current?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [seconds]);

  const minutes = Math.floor(left / 60);
  const rest = left % 60;
  return (
    <div className="login-error" role="status" aria-live="off" style={{ marginBottom: 10 }}>
      <strong>
        {audience === 'hr' ? 'Face verification is locked for this employee.' : 'Too many failed face verification attempts.'}
      </strong>
      <div style={{ marginTop: 4 }}>
        {audience === 'hr' ? 'It unlocks automatically in ' : 'You can try again in '}
        <strong className="mono">{formatWait(left)}</strong>
        {` (${minutes} minute${minutes === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}).`}
      </div>
      {audience !== 'hr' && (
        <div style={{ marginTop: 4 }}>
          Need immediate access? Ask HR/Admin to unlock your face verification.
          {onRecheck && (
            <>
              {' '}
              <button type="button" className="mini-btn" onClick={onRecheck}>I have been unlocked — check again</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
