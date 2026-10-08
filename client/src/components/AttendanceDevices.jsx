import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import { apiFetch } from '../lib/apiClient';

/**
 * HR/Admin register of attendance machines (fixed face + fingerprint
 * terminals) and the link between each machine's own user numbers and HRMS
 * employees.
 *
 * Everything here is real and server-backed: a device authenticates to
 * POST /api/v1/device-punch with its own id and key, its punches are written
 * to the normal attendance record, and the site entered here is the location
 * shown for them. The key is displayed once, when it is generated; only a
 * hash is kept on the server. No biometric data is handled by the HRMS.
 */
const EMPTY_DEVICE = { deviceId: '', name: '', siteAddress: '', siteLat: '', siteLng: '' };

export default function AttendanceDevices() {
  const { employees, toast } = useHRMS();
  const [devices, setDevices] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [form, setForm] = useState(EMPTY_DEVICE);
  const [link, setLink] = useState({ deviceId: '', deviceUserId: '', empId: '' });
  const [issued, setIssued] = useState(null); // { deviceId, key } — shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [deviceList, mappingList] = await Promise.all([apiFetch('/devices'), apiFetch('/device-mappings')]);
      setDevices(deviceList);
      setMappings(mappingList);
      setError('');
    } catch (err) {
      setError(err?.message || 'Could not load attendance devices.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const sortedEmployees = useMemo(
    () => [...(employees || [])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    [employees],
  );
  const employeeName = (id) => sortedEmployees.find((e) => String(e.id) === String(id))?.name || 'Unknown employee';

  const run = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err?.message || 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const register = () => run(async () => {
    const created = await apiFetch('/devices', {
      method: 'POST',
      body: {
        deviceId: form.deviceId.trim(), name: form.name.trim(), siteAddress: form.siteAddress.trim(),
        ...(form.siteLat !== '' || form.siteLng !== '' ? { siteLat: form.siteLat, siteLng: form.siteLng } : {}),
      },
    });
    setIssued({ deviceId: created.deviceId, key: created.deviceKey });
    setForm(EMPTY_DEVICE);
    toast('success', `Device <strong>${created.name}</strong> registered. Copy its key now — it is shown only once.`);
  });

  const setActive = (device, active) => run(async () => {
    await apiFetch(`/devices/${device.id}`, { method: 'PATCH', body: { active } });
    toast('info', `${device.name} ${active ? 'enabled' : 'disabled'}.`);
  });

  const newKey = (device) => {
    if (!window.confirm(`Generate a new key for ${device.name}? The current key stops working immediately.`)) return;
    run(async () => {
      const updated = await apiFetch(`/devices/${device.id}/key`, { method: 'POST' });
      setIssued({ deviceId: updated.deviceId, key: updated.deviceKey });
    });
  };

  const addLink = () => run(async () => {
    await apiFetch('/device-mappings', { method: 'POST', body: { deviceId: link.deviceId, deviceUserId: link.deviceUserId.trim(), empId: link.empId } });
    setLink((current) => ({ ...current, deviceUserId: '', empId: '' }));
    toast('success', 'Device user linked to the employee.');
  });

  const removeLink = (mapping) => run(async () => {
    await apiFetch(`/device-mappings/${mapping.id}`, { method: 'DELETE' });
  });

  const canRegister = form.deviceId.trim() && form.name.trim() && form.siteAddress.trim().length >= 3;
  const canLink = link.deviceId && link.deviceUserId.trim() && link.empId;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Attendance devices (face + fingerprint)</div>
          <div className="card-sub">
            Fixed machines that send live check-ins and check-outs to POST /api/v1/device-punch. Their punches appear in Attendance like any other.
          </div>
        </div>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}

      {issued && (
        <div className="leave-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, marginBottom: 12 }}>
          <div><strong>Key for {issued.deviceId}</strong> — copy it now. It is not stored in readable form and will not be shown again.</div>
          <div className="mono" style={{ fontSize: 12.5, background: 'var(--bg-2)', padding: '8px 12px', borderRadius: 6, border: '1px dashed #ccc', wordBreak: 'break-all' }}>
            {issued.key}
          </div>
          <div><button type="button" className="mini-btn" onClick={() => setIssued(null)}>I have copied it</button></div>
        </div>
      )}

      {devices.length === 0 ? (
        <div className="empty" style={{ textAlign: 'left' }}>No device registered yet.</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Device ID</th><th>Name</th><th>Registered site</th><th>Status</th><th>Last punch</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.deviceId}</td>
                  <td>{d.name}</td>
                  <td>{d.siteAddress}{d.siteLat != null && d.siteLng != null ? <div className="muted-text mono" style={{ fontSize: 11.5 }}>{d.siteLat}, {d.siteLng}</div> : null}</td>
                  <td><span className={`state-badge ${d.active ? 'approved' : 'declined'}`}>{d.active ? 'Active' : 'Disabled'}</span></td>
                  <td className="mono">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button type="button" className="mini-btn" disabled={busy} onClick={() => newKey(d)}>New key</button>{' '}
                    <button type="button" className={`mini-btn ${d.active ? 'danger' : 'approve'}`} disabled={busy} onClick={() => setActive(d, !d.active)}>
                      {d.active ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card-sub" style={{ margin: '16px 0 6px' }}>Register a device</div>
      <div className="form-grid" style={{ gap: 10 }}>
        <div className="field">
          <label className="field-label" htmlFor="device-id">Device ID</label>
          <input id="device-id" className="input" value={form.deviceId} placeholder="e.g. IOT-BBSR-01" onChange={(e) => setForm({ ...form, deviceId: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="device-name">Name</label>
          <input id="device-name" className="input" value={form.name} placeholder="e.g. Main Gate Terminal" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label className="field-label" htmlFor="device-site">Site address (shown as the location of its punches)</label>
          <input id="device-site" className="input" value={form.siteAddress} placeholder="Building, road, locality, city, PIN" onChange={(e) => setForm({ ...form, siteAddress: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="device-lat">Latitude (optional)</label>
          <input id="device-lat" className="input" value={form.siteLat} inputMode="decimal" onChange={(e) => setForm({ ...form, siteLat: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="device-lng">Longitude (optional)</label>
          <input id="device-lng" className="input" value={form.siteLng} inputMode="decimal" onChange={(e) => setForm({ ...form, siteLng: e.target.value })} />
        </div>
      </div>
      <button type="button" className="btn" style={{ marginTop: 10 }} disabled={busy || !canRegister} onClick={register}>Register device</button>

      <div className="card-sub" style={{ margin: '20px 0 6px' }}>Link device users to employees</div>
      <div className="muted-text" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Each person is enrolled on the machine under a user number. Link that number to the HRMS employee once; the machine then only sends the number.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="inline-select">
          <span>Device</span>
          <select className="input" aria-label="Device to link" value={link.deviceId} onChange={(e) => setLink({ ...link, deviceId: e.target.value })}>
            <option value="">Choose…</option>
            {devices.map((d) => <option key={d.id} value={d.deviceId}>{d.name} ({d.deviceId})</option>)}
          </select>
        </label>
        <label className="inline-select">
          <span>Device user no.</span>
          <input className="input" aria-label="Device user number" value={link.deviceUserId} onChange={(e) => setLink({ ...link, deviceUserId: e.target.value })} style={{ width: 120 }} />
        </label>
        <label className="inline-select">
          <span>Employee</span>
          <select className="input" aria-label="Employee to link" value={link.empId} onChange={(e) => setLink({ ...link, empId: e.target.value })}>
            <option value="">Choose…</option>
            {sortedEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-ghost" disabled={busy || !canLink} onClick={addLink}>Link</button>
      </div>

      {mappings.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 10 }}>
          <table className="table">
            <thead><tr><th>Device ID</th><th>Device user no.</th><th>Employee</th><th style={{ textAlign: 'right' }}>Action</th></tr></thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.deviceId}</td>
                  <td className="mono">{m.deviceUserId}</td>
                  <td>{employeeName(m.empId)}</td>
                  <td style={{ textAlign: 'right' }}><button type="button" className="mini-btn danger" disabled={busy} onClick={() => removeLink(m)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
