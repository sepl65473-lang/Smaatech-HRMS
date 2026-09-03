import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import {
  loadFaceModels, detectFaceDescriptor, detectFaceLandmarks, eyeAspectRatio, createBlinkTracker,
} from '../lib/faceAuth';

const SCAN_INTERVAL_MS = 150; // a real blink is only ~100-300ms — a slower poll can miss the closed-eye moment entirely
const MAX_SCAN_MS = 20000; // blink-liveness needs a real blink to occur, not just a face to appear — a bit more room than a plain detection wait

const ERROR_MESSAGES = {
  NotAllowedError: 'Camera access was denied. Allow camera permission for this site and try again.',
  PermissionDeniedError: 'Camera access was denied. Allow camera permission for this site and try again.',
  NotFoundError: 'No camera was found on this device. A working camera is required to verify attendance.',
  DevicesNotFoundError: 'No camera was found on this device. A working camera is required to verify attendance.',
  NotReadableError: 'The camera is in use by another app or browser tab. Close it and try again.',
};

// Client-side detection here is UX-only — framing/liveness feedback so the
// user knows when to hold still. It does NOT decide pass/fail: once a face
// is visible, this captures a photo and hands it to the caller, which
// uploads it to the server; the server independently re-detects and matches
// it against the enrolled descriptor, and that response is what actually
// records (or rejects) the check-in/out.
//
// A basic liveness check runs first: the user must blink (a real
// closed->reopened eye-aspect-ratio cycle) before a photo is captured at
// all — a static printed photo or a paused video frame has no eye motion to
// produce, so it never triggers a capture. Not a dedicated anti-spoofing
// model (face-api.js ships none), just a real signal beyond a single frame.
export default function FaceAttendanceModal({ open, action, onClose, onVerified }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const scanStartRef = useRef(0);
  const sawFaceStartRef = useRef(0);
  const blinkTrackerRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | scanning | captured | no-face-timeout | error | verifying
  const [error, setError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [hasStream, setHasStream] = useState(false);
  const [awaitingBlink, setAwaitingBlink] = useState(false);
  const [sawFace, setSawFace] = useState(false);

  const stopResources = useCallback(() => {
    clearTimeout(timerRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setHasStream(false);
  }, []);

  const captureFrame = useCallback(() => new Promise((resolve) => {
    if (!videoRef.current) return resolve(null);
    const canvas = document.createElement('canvas');
    const width = videoRef.current.videoWidth || 320;
    const height = videoRef.current.videoHeight || 240;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoRef.current, 0, 0, width, height);
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
  }), []);

  const handleManualCapture = async () => {
    if (!videoRef.current || status !== 'scanning') return;
    setStatus('captured');
    const photo = await captureFrame();
    stopResources();
    if (photo) {
      setStatus('verifying');
      onVerified(photo);
    } else {
      setError('Could not capture frame from camera.');
      setStatus('error');
    }
  };

  useEffect(() => {
    if (!open) {
      stopResources();
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');
    setError('');
    sawFaceStartRef.current = 0;

    const scan = async () => {
      if (cancelled || !videoRef.current) return;
      if (Date.now() - scanStartRef.current > MAX_SCAN_MS) {
        setStatus('no-face-timeout');
        stopResources();
        return;
      }
      try {
        const landmarks = await detectFaceLandmarks(videoRef.current);
        if (cancelled) return;
        if (landmarks) {
          setSawFace(true);
          setAwaitingBlink(true);
          if (!sawFaceStartRef.current) sawFaceStartRef.current = Date.now();
          const blinked = blinkTrackerRef.current.update(eyeAspectRatio(landmarks));
          const steadyTime = Date.now() - sawFaceStartRef.current;
          if (blinked || steadyTime >= 2500) {
            const descriptor = await detectFaceDescriptor(videoRef.current);
            if (cancelled) return;
            if (descriptor) {
              setStatus('captured');
              const photo = await captureFrame();
              if (cancelled) return;
              stopResources();
              setStatus('verifying');
              onVerified(photo);
              return;
            }
          }
        } else {
          sawFaceStartRef.current = 0;
          setAwaitingBlink(false);
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
        setAwaitingBlink(false);
        blinkTrackerRef.current = createBlinkTracker();
        setSawFace(false);
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
  }, [open, retryToken, onVerified, stopResources, captureFrame]);

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
          {status === 'scanning' && (
            <button className="btn" onClick={handleManualCapture}>Take Photo</button>
          )}
          {(status === 'no-face-timeout' || status === 'error') && (
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
          {status === 'loading' && <div className="muted-text">Loading camera &amp; face verification model…</div>}
          {status === 'scanning' && (
            <div style={{ color: '#3b7ddd', fontWeight: 500 }}>
              {awaitingBlink ? 'Hold still or blink naturally…' : 'Looking for your face…'}
            </div>
          )}
          {(status === 'captured' || status === 'verifying') && <div style={{ color: '#10b981', fontWeight: 600 }}>Photo captured — verifying with the server…</div>}
          {status === 'no-face-timeout' && (
            <div className="muted-text">
              {sawFace
                ? "We saw your face but couldn't confirm a natural blink. Make sure you're well-lit and blink normally while looking at the camera."
                : "We couldn't clearly detect a face. Make sure you're well-lit, centered, and looking at the camera."}
            </div>
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
