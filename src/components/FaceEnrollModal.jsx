import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { loadFaceModels, detectFaceDescriptor } from '../lib/faceAuth';

export default function FaceEnrollModal({ open, user, onClose, onSave }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | capturing | captured | saving | error
  const [error, setError] = useState('');
  const [photoBlob, setPhotoBlob] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setStatus('loading');
    setPhotoBlob(null);
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

  // Client-side detection here is only a quick "is a face even visible"
  // sanity check for UX — the server independently re-detects and computes
  // the real enrollment descriptor from the uploaded photo itself.
  const capture = async () => {
    if (!videoRef.current) return;
    setStatus('capturing');
    const result = await detectFaceDescriptor(videoRef.current);
    if (!result) {
      setError('No face detected — make sure your face is well-lit and centered, then try again.');
      setStatus('ready');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    canvas.getContext('2d').drawImage(videoRef.current, 0, 0);
    canvas.toBlob((blob) => {
      setError('');
      setPhotoBlob(blob);
      setStatus('captured');
    }, 'image/jpeg', 0.92);
  };

  const save = async () => {
    setStatus('saving');
    try {
      await onSave(photoBlob);
    } catch (err) {
      setError(err.message || 'Could not save face — try capturing again.');
      setStatus('captured');
    }
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
          {status === 'captured' || status === 'saving'
            ? <button className="btn" disabled={status === 'saving'} onClick={save}>{status === 'saving' ? 'Saving…' : 'Save face'}</button>
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
