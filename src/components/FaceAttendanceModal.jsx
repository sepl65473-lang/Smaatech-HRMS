import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { loadFaceModels, detectFaceDescriptor, matchFace } from '../lib/faceAuth';

const SCAN_INTERVAL_MS = 700;
const MAX_SCAN_MS = 15000;

const ERROR_MESSAGES = {
  NotAllowedError: 'Camera access was denied. Allow camera permission for this site and try again.',
  PermissionDeniedError: 'Camera access was denied. Allow camera permission for this site and try again.',
  NotFoundError: 'No camera was found on this device. A working camera is required to verify attendance.',
  DevicesNotFoundError: 'No camera was found on this device. A working camera is required to verify attendance.',
  NotReadableError: 'The camera is in use by another app or browser tab. Close it and try again.',
};

export default function FaceAttendanceModal({ open, action, profile, onClose, onVerified }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const scanStartRef = useRef(0);
  const noFaceCountRef = useRef(0);
  const mismatchCountRef = useRef(0);
  const [status, setStatus] = useState('loading'); // loading | scanning | matched | mismatch | no-face-timeout | error | not-enrolled
  const [error, setError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [hasStream, setHasStream] = useState(false);

  const stopResources = () => {
    clearTimeout(timerRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setHasStream(false);
  };

  useEffect(() => {
    if (!open) {
      stopResources();
      return undefined;
    }

    if (!profile?.faceDescriptor?.length) {
      setStatus('not-enrolled');
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');
    setError('');
    noFaceCountRef.current = 0;
    mismatchCountRef.current = 0;

    const scan = async () => {
      if (cancelled || !videoRef.current) return;
      if (Date.now() - scanStartRef.current > MAX_SCAN_MS) {
        setStatus(mismatchCountRef.current > noFaceCountRef.current ? 'mismatch' : 'no-face-timeout');
        stopResources();
        return;
      }
      try {
        const descriptor = await detectFaceDescriptor(videoRef.current);
        if (cancelled) return;
        if (descriptor) {
          const match = await matchFace(descriptor, [profile]);
          if (cancelled) return;
          if (match) {
            setStatus('matched');
            stopResources();
            setTimeout(() => { if (!cancelled) onVerified(); }, 400);
            return;
          }
          mismatchCountRef.current += 1;
        } else {
          noFaceCountRef.current += 1;
        }
      } catch {
        // transient detection error — keep looping
      }
      timerRef.current = setTimeout(scan, SCAN_INTERVAL_MS);
    };

    (async () => {
      try {
        await loadFaceModels();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (cancelled) return;
        setHasStream(true);
        setStatus('scanning');
        scanStartRef.current = Date.now();
        scan();
      } catch (err) {
        if (cancelled) return;
        setError(ERROR_MESSAGES[err.name] || err.message || 'Could not load face verification models or access the camera.');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      stopResources();
    };
  }, [open, retryToken]);

  const tryAgain = () => setRetryToken((t) => t + 1);

  const title = action === 'out' ? 'Verify your face to check out' : 'Verify your face to check in';

  return (
    <Modal
      open={open}
      title={title}
      subtitle={status === 'scanning' ? 'Look directly at the camera' : undefined}
      onClose={onClose}
      width={420}
      footer={
        <div style={{ display: 'flex', width: '100%', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {(status === 'mismatch' || status === 'no-face-timeout' || status === 'error') && (
            <button className="btn" onClick={tryAgain}>Try Again</button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{
          position: 'relative', width: 280, height: 210, borderRadius: 12, overflow: 'hidden',
          background: '#0f172a', border: '2px solid #3b7ddd',
        }}>
          <video
            ref={videoRef}
            muted
            playsInline
            style={{
              width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)',
              display: hasStream ? 'block' : 'none',
            }}
          />
        </div>

        <div style={{ textAlign: 'center', width: '100%' }}>
          {status === 'not-enrolled' && (
            <div className="muted-text">You haven't enrolled your face yet. Close this and use <strong>Enroll my face</strong> on your dashboard first.</div>
          )}
          {status === 'loading' && <div className="muted-text">Loading camera &amp; face verification model…</div>}
          {status === 'scanning' && <div style={{ color: '#3b7ddd', fontWeight: 500 }}>Verifying your identity…</div>}
          {status === 'matched' && <div style={{ color: '#10b981', fontWeight: 600 }}>Face verified ✓ Recording attendance…</div>}
          {status === 'mismatch' && (
            <div className="muted-text">Face detected but it didn't match your enrolled profile. Make sure it's really you, or re-enroll your face from the dashboard if your appearance has changed.</div>
          )}
          {status === 'no-face-timeout' && (
            <div className="muted-text">We couldn't clearly detect a face. Make sure you're well-lit, centered, and looking at the camera.</div>
          )}
          {status === 'error' && error && (
            <div style={{
              padding: '8px 12px', background: 'rgba(220,53,69,0.08)', borderRadius: 8,
              fontSize: '12.5px', color: '#dc3545', lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
