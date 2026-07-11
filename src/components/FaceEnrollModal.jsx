import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { loadFaceModels, detectFaceDescriptor } from '../lib/faceAuth';

export default function FaceEnrollModal({ open, user, onClose, onSave }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | capturing | captured | error
  const [error, setError] = useState('');
  const [descriptor, setDescriptor] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setStatus('loading');
    setDescriptor(null);
    setError('');

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
        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Could not access camera or load face models.');
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  const capture = async () => {
    if (!videoRef.current) return;
    setStatus('capturing');
    const result = await detectFaceDescriptor(videoRef.current);
    if (!result) {
      setError('No face detected — make sure your face is well-lit and centered, then try again.');
      setStatus('ready');
      return;
    }
    setError('');
    setDescriptor(result);
    setStatus('captured');
  };

  const save = () => {
    onSave(descriptor);
  };

  return (
    <Modal
      open={open}
      title="Enroll face"
      subtitle={user ? `${user.name} · used for face sign-in` : ''}
      onClose={onClose}
      width={420}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {status === 'captured'
            ? <button className="btn" onClick={save}>Save face</button>
            : <button className="btn" disabled={status !== 'ready'} onClick={capture}>Capture face</button>}
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: 280, height: 210, borderRadius: 10, background: '#111', transform: 'scaleX(-1)' }}
        />
        {status === 'loading' && <div className="muted-text">Loading camera & face model…</div>}
        {status === 'captured' && <div className="muted-text">Face captured ✓ — click Save to enroll.</div>}
        {error && <span className="field-error">{error}</span>}
      </div>
    </Modal>
  );
}
