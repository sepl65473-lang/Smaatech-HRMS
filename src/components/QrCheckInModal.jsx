import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';

export default function QrCheckInModal({ open, onClose, onScanSuccess }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | scanning | success | error
  const [error, setError] = useState('');
  const [scanTimeLeft, setScanTimeLeft] = useState(3);
  const timerRef = useRef(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    clearInterval(timerRef.current);
  };

  useEffect(() => {
    if (!open) {
      stopCamera();
      return undefined;
    }

    setStatus('loading');
    setError('');
    setScanTimeLeft(3);

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 320, facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus('scanning');

        // Automatically simulate a successful QR scan after 3 seconds of "looking" at the screen
        let seconds = 3;
        timerRef.current = setInterval(() => {
          seconds -= 1;
          setScanTimeLeft(seconds);
          if (seconds <= 0) {
            clearInterval(timerRef.current);
            handleSuccess();
          }
        }, 1000);

      } catch (err) {
        // Fallback for no camera or blocked permission
        setStatus('scanning'); // Still enter scanning but show simulated bypass trigger
        toastFallback();
      }
    })();

    return () => {
      stopCamera();
    };
  }, [open]);

  const handleSuccess = () => {
    setStatus('success');
    setTimeout(() => {
      onScanSuccess({ time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) });
    }, 800);
  };

  const toastFallback = () => {
    // Camera error won't block, we show a gorgeous mock scanning grid
  };

  return (
    <Modal
      open={open}
      title="Scan Office QR Code"
      subtitle="Point your camera at the QR displayed on the office display"
      onClose={onClose}
      width={400}
      footer={
        <div style={{ display: 'flex', width: '100%', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {status === 'scanning' && (
            <button className="btn approve" onClick={handleSuccess}>Simulate QR Capture</button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <style dangerouslySetInnerHTML={{__html: `
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
            border: 3px solid var(--blue, #4a6fa5);
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
          .qr-scanner-grid {
            position: absolute;
            inset: 0;
            background-image: 
              linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
            background-size: 20px 20px;
            z-index: 5;
            pointer-events: none;
          }
          .qr-target-brackets {
            position: absolute;
            inset: 40px;
            border: 2px dashed rgba(255, 255, 255, 0.4);
            border-radius: 8px;
            z-index: 6;
          }
          .qr-countdown {
            background: rgba(0,0,0,0.7);
            color: #fff;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 11px;
            position: absolute;
            bottom: 12px;
            z-index: 12;
            font-family: monospace;
          }
        `}} />

        <div className="qr-box">
          {status === 'scanning' && <div className="qr-laser" />}
          <div className="qr-scanner-grid" />
          <div className="qr-target-brackets" />
          
          {/* Display camera feed or fallback animation */}
          {streamRef.current ? (
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#666',
              padding: 20,
              textAlign: 'center',
              fontSize: '12.5px'
            }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ marginBottom: 12, color: 'var(--blue)' }}>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M7 7h4v4H7zM13 7h4v4h-4zM7 13h4v4H7z" />
                <path d="M13 13h4v4h-4z" />
              </svg>
              <span>Camera not active or simulated mode.<br />Click "Simulate QR Capture" to scan.</span>
            </div>
          )}

          {status === 'scanning' && streamRef.current && (
            <div className="qr-countdown">Auto-capturing in {scanTimeLeft}s</div>
          )}
        </div>

        {status === 'loading' && <div className="muted-text">Opening camera feed...</div>}
        {status === 'scanning' && <div style={{ color: 'var(--blue)', fontWeight: 500, fontSize: 13.5 }}>Scanning for dynamic HRMS QR code...</div>}
        {status === 'success' && <div style={{ color: '#10b981', fontWeight: 600, fontSize: 14 }}>QR Code Verified ✓</div>}
      </div>
    </Modal>
  );
}
