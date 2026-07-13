const KEY = 'Smaatech_hrms_device_id';

// A persistent per-browser identifier, generated once and reused on every
// check-in/out. It's a deterrent/anomaly signal, not a hardware root of
// trust — clearing site data or using a different browser resets it. Real
// device attestation would need a native app (Play Integrity / App Attest).
export function getDeviceId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
