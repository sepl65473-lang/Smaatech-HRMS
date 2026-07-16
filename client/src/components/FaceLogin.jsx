import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { loadFaceModels, detectFaceDescriptor, matchFace } from '../lib/faceAuth';

const SCAN_INTERVAL_MS = 700;

export default function FaceLogin({ open, profiles, onClose, onMatch }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | scanning | matched | error
  const [error, setError] = useState('');
  const [hasStream, setHasStream] = useState(false);

  const enrolledProfiles = profiles.filter((p) => p.faceDescriptor?.length);
  const enrolledRef = useRef(enrolledProfiles);
  enrolledRef.current = enrolledProfiles;
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;

  // Cleanup function for stream and timers
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

    let cancelled = false;
    setStatus('loading');
    setError('');

    (async () => {
      if (enrolledRef.current.length === 0) {
        setStatus('error');
        setError('No face profiles enrolled yet. Ask an admin to enroll a face in Settings → Users, or sign in with your email and password instead.');
        return;
      }

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

        const scan = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const descriptor = await detectFaceDescriptor(videoRef.current);
            if (descriptor && !cancelled) {
              const match = await matchFace(descriptor, enrolledRef.current);
              if (match && !cancelled) {
                setStatus('matched');
                onMatchRef.current(match);
                return;
              }
            }
          } catch (e) {
            console.error('Scan error:', e);
          }
          timerRef.current = setTimeout(scan, SCAN_INTERVAL_MS);
        };
        scan();
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Could not access camera or load face models.');
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      stopResources();
    };
  }, [open]);

  return (
    <Modal
      open={open}
      title="Sign in with face"
      subtitle="Look at the camera"
      onClose={onClose}
      width={420}
      footer={
        <div style={{ display: 'flex', width: '100%', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        {/* Style block for scanning animation */}
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes scanLineAnim {
            0% { top: 0%; }
            50% { top: 100%; }
            100% { top: 0%; }
          }
          .scan-container {
            position: relative;
            width: 280px;
            height: 210px;
            border-radius: 12px;
            overflow: hidden;
            background: #0f172a;
            border: 2px solid #3b7ddd;
            box-shadow: 0 8px 30px rgba(59,125,221,0.2);
          }
          .scan-laser {
            position: absolute;
            left: 0;
            width: 100%;
            height: 4px;
            background: linear-gradient(to bottom, rgba(59,125,221,0), #3b7ddd, rgba(59,125,221,0));
            box-shadow: 0 0 12px #3b7ddd, 0 0 4px #3b7ddd;
            z-index: 10;
            animation: scanLineAnim 3s infinite linear;
          }
          .scan-grid-overlay {
            position: absolute;
            inset: 0;
            background-image:
              linear-gradient(rgba(59,125,221,0.08) 1px, transparent 1px),
              linear-gradient(90deg, rgba(59,125,221,0.08) 1px, transparent 1px);
            background-size: 20px 20px;
            z-index: 5;
            pointer-events: none;
          }
          .scan-fallback-avatar {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(59, 125, 221, 0.4);
            z-index: 2;
          }
        `}} />

        <div className="scan-container">
          {/* Laser line animation overlay */}
          {status === 'scanning' && <div className="scan-laser" />}

          {/* Grid background overlay */}
          <div className="scan-grid-overlay" />

          {/* Fallback Face outline when camera is off */}
          {!hasStream && (
            <div className="scan-fallback-avatar">
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            </div>
          )}

          {/* Actual Video */}
          <video
            ref={videoRef}
            muted
            playsInline
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: 'scaleX(-1)',
              display: hasStream ? 'block' : 'none'
            }}
          />
        </div>

        {/* Text information */}
        <div style={{ textAlign: 'center', width: '100%' }}>
          {status === 'loading' && <div className="muted-text">Loading camera & face model…</div>}
          {status === 'scanning' && <div style={{ color: '#3b7ddd', fontWeight: 500 }}>Scanning for matches…</div>}
          {status === 'matched' && <div style={{ color: '#10b981', fontWeight: 600 }}>Face verified successfully ✓</div>}

          {error && (
            <div style={{
              marginTop: 8,
              padding: '8px 12px',
              background: 'rgba(220,53,69,0.08)',
              borderRadius: '8px',
              fontSize: '12.5px',
              color: '#dc3545',
              lineHeight: 1.5
            }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
