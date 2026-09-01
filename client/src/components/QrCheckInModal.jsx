import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import Modal from './Modal';

const SCAN_INTERVAL_MS = 400;
const QR_PREFIX = 'SEPL-ATT:';

const ERROR_MESSAGES = {
  NotAllowedError: 'Camera access was denied. Allow camera permission for this site and try again.',
  PermissionDeniedError: 'Camera access was denied. Allow camera permission for this site and try again.',
  NotFoundError: 'No camera was found on this device.',
  DevicesNotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is in use by another app or browser tab. Close it and try again.',
};

// Decodes real QR frames from the camera feed via jsQR — the old version of
// this component always "succeeded" after a 3-second timer regardless of
// what (if anything) the camera saw. The decoded value is just an opaque
// token; onScanSuccess hands it to the caller, which posts it to
// POST /attendance/qr-checkin — the server is what actually validates it
// (expiry, single-use, company match) and records the punch, the same way
// this app's face check-in treats client-side detection as UX-only.
export default function QrCheckInModal({ open, onClose, onScanSuccess }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | scanning | success | error
  const [error, setError] = useState('');
  const [hasStream, setHasStream] = useState(false);

  const stopCamera = () => {
    clearTimeout(timerRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setHasStream(false);
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(() => {
    if (!open) {
      stopCamera();
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');
    setError('');
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (cancelled) return;
        setHasStream(true);
        setStatus('scanning');

        const scan = () => {
          if (cancelled) return;
          if (!videoRef.current || videoRef.current.readyState < 2) {
            timerRef.current = setTimeout(scan, SCAN_INTERVAL_MS);
            return;
          }
          const canvas = canvasRef.current;
          canvas.width = videoRef.current.videoWidth;
          canvas.height = videoRef.current.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(imageData.data, imageData.width, imageData.height);

          if (result?.data?.startsWith(QR_PREFIX)) {
            const token = result.data.slice(QR_PREFIX.length);
            setStatus('success');
            stopCamera();
            setTimeout(() => onScanSuccess({ token }), 500);
            return;
          }
          timerRef.current = setTimeout(scan, SCAN_INTERVAL_MS);
        };
        scan();
      } catch (err) {
        if (!cancelled) {
          setError(ERROR_MESSAGES[err.name] || err.message || 'Could not access the camera.');
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open, onScanSuccess]);

  return (
    <Modal
      open={open}
      title="Scan Office QR Code"
      subtitle="Point your camera at the QR displayed on the office screen"
      onClose={onClose}
      width={400}
      footer={(
        <div style={{ display: 'flex', width: '100%', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <style dangerouslySetInnerHTML={{ __html: `
          @keyframes laserAnim {
            0% { top: 0%; }
            50% { top: 100%; }
            100% { top: 0%; }
          }
          .qr-box {
            position: relative;
            width: 260px;
            height: 260px;
            border-radius: 16px;
            overflow: hidden;
            background: #111;
            border: 3px solid var(--accent);
            box-shadow: 0 8px 30px rgba(0,0,0,0.3);
          }
          .qr-laser {
            position: absolute;
            left: 0;
            width: 100%;
            height: 4px;
            background: #dc3545;
            box-shadow: 0 0 10px #dc3545;
            z-index: 10;
            animation: laserAnim 2.5s infinite linear;
          }
          .qr-target-brackets {
            position: absolute;
            inset: 40px;
            border: 2px dashed rgba(255, 255, 255, 0.4);
            border-radius: 8px;
            z-index: 6;
          }
        ` }}
        />

        <div className="qr-box">
          {status === 'scanning' && <div className="qr-laser" />}
          <div className="qr-target-brackets" />
          {hasStream && (
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </div>

        {status === 'loading' && <div className="muted-text">Opening camera…</div>}
        {status === 'scanning' && <div style={{ color: 'var(--accent)', fontWeight: 500, fontSize: 13.5 }}>Scanning for the office QR code…</div>}
        {status === 'success' && <div style={{ color: '#10b981', fontWeight: 600, fontSize: 14 }}>QR code found ✓</div>}

        {error && (
          <div style={{
            marginTop: 4, padding: '8px 12px', background: 'rgba(220,53,69,0.08)',
            borderRadius: 8, fontSize: 12.5, color: '#dc3545', lineHeight: 1.5, textAlign: 'center',
          }}
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
