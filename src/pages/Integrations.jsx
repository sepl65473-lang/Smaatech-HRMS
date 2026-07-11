import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import { uid, todayISO, formatINR } from '../lib/helpers';
import { downloadTallyXML } from '../lib/tally';

const DEVICES = [
  { id: 'dev_gate', name: 'Main Gate · ZKTeco K40', ip: '192.168.1.150', port: '4370', status: 'ready', lastSync: null },
  { id: 'dev_floor2', name: 'Floor 2 Reader · eSSL X990', ip: '192.168.1.151', port: '4370', status: 'ready', lastSync: null },
];

function randomTime() {
  const h = 8 + Math.floor(Math.random() * 2);
  const m = Math.floor(Math.random() * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default function Integrations() {
  const { employees, payroll, recordPunch, audit, toast } = useHRMS();
  const [devices, setDevices] = useState(DEVICES);
  const [staging, setStaging] = useState([]);
  const [cycle, setCycle] = useState('');

  const cycles = useMemo(() => [...new Set(payroll.map((p) => p.cycle || 'Current'))], [payroll]);
  const activeCycle = cycle || cycles[0] || '';
  const cyclePayroll = useMemo(
    () => payroll.filter((p) => (p.cycle || 'Current') === activeCycle),
    [payroll, activeCycle],
  );

  const testConnection = (deviceId) => {
    setDevices((list) => list.map((d) => (d.id === deviceId ? { ...d, status: 'pinging' } : d)));
    setTimeout(() => {
      setDevices((list) => list.map((d) => {
        if (d.id === deviceId) {
          const isValidIp = d.ip.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
          if (isValidIp) {
            toast('success', `Connection to <strong>${d.name}</strong> successful (Ping: 32ms)`);
            return { ...d, status: 'online' };
          } else {
            toast('error', `Failed to connect to <strong>${d.name}</strong> at ${d.ip || 'empty'}:${d.port}`);
            return { ...d, status: 'offline' };
          }
        }
        return d;
      }));
    }, 1200);
  };

  const syncDevice = (device) => {
    if (device.status === 'offline') {
      toast('error', `Cannot sync. <strong>${device.name}</strong> is currently offline.`);
      return;
    }
    const sample = [...employees].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 2));
    const unmappedCount = Math.random() > 0.4 ? 1 : 0;
    const punches = sample.map((e) => ({
      id: uid('punch'),
      deviceUserId: `DU-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      empId: e.id,
      guessName: e.name,
      time: randomTime(),
      type: Math.random() > 0.5 ? 'in' : 'out',
      deviceName: device.name,
    }));

    for (let i = 0; i < unmappedCount; i++) {
      punches.push({
        id: uid('punch'),
        deviceUserId: `DU-UNMAPPED-${String(Math.floor(Math.random() * 900) + 100)}`,
        empId: null,
        guessName: null,
        time: randomTime(),
        type: Math.random() > 0.5 ? 'in' : 'out',
        deviceName: device.name,
      });
    }

    setStaging((list) => [...punches, ...list]);
    setDevices((list) => list.map((d) => (d.id === device.id ? { ...d, lastSync: new Date().toLocaleTimeString('en-IN') } : d)));
    audit('Biometric device synced', device.name, `${punches.length} punches pulled`);
    toast('success', `Pulled <strong>${punches.length}</strong> punches from <strong>${device.name}</strong>`);
  };

  const reconcile = async (punch) => {
    const updated = await recordPunch(punch.empId, punch.time, punch.type);
    if (updated) {
      setStaging((list) => list.filter((p) => p.id !== punch.id));
      toast('success', `Reconciled ${punch.guessName}'s ${punch.type === 'in' ? 'check-in' : 'check-out'}`);
    } else {
      toast('info', `No attendance record for ${punch.guessName} today — skipped`);
    }
  };

  const discard = (id) => setStaging((list) => list.filter((p) => p.id !== id));

  const exportTally = () => {
    if (cyclePayroll.length === 0) return;
    downloadTallyXML(activeCycle, cyclePayroll);
    audit('Tally export generated', activeCycle, `${cyclePayroll.length} payroll rows`);
    toast('success', `Tally journal exported for <strong>${activeCycle}</strong>`);
  };

  return (
    <div className="page-wrap active">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Biometric devices</div>
            <div className="card-sub">Configure network settings, test connection, & sync logs</div>
          </div>
        </div>
        <div className="settings-rows">
          {devices.map((d) => (
            <div className="settings-row" key={d.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div className="settings-row-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {d.name}
                    <span className={`state-badge ${d.status === 'online' ? 'approved' : d.status === 'offline' ? 'declined' : d.status === 'pinging' ? 'pending' : 'approved'}`} style={{ textTransform: 'none' }}>
                      {d.status === 'online' ? 'Connected ✓' : d.status === 'offline' ? 'Offline ❌' : d.status === 'pinging' ? 'Testing...' : 'Ready'}
                    </span>
                  </div>
                  <div className="settings-row-sub">{d.lastSync ? `Last synced ${d.lastSync}` : 'Never synced'}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="mini-btn" disabled={d.status === 'pinging'} onClick={() => testConnection(d.id)}>
                    {d.status === 'pinging' ? 'Pinging...' : 'Ping Test'}
                  </button>
                  <button type="button" className="mini-btn approve" disabled={d.status === 'pinging'} onClick={() => syncDevice(d)}>Sync now</button>
                </div>
              </div>

              {/* IP / Port Settings form */}
              <div style={{ display: 'flex', gap: 12, background: 'var(--paper-dark, #fcfcfc)', padding: '8px 12px', borderRadius: '6px', border: '1px solid #eee' }}>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: '11px', color: '#666' }}>
                  Device IP Address
                  <input 
                    type="text" 
                    className="input compact mono" 
                    value={d.ip} 
                    onChange={(e) => {
                      const ip = e.target.value;
                      setDevices(list => list.map(item => item.id === d.id ? { ...item, ip } : item));
                    }} 
                  />
                </label>
                <label style={{ width: '80px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: '11px', color: '#666' }}>
                  SDK Port
                  <input 
                    type="text" 
                    className="input compact mono" 
                    value={d.port} 
                    onChange={(e) => {
                      const port = e.target.value;
                      setDevices(list => list.map(item => item.id === d.id ? { ...item, port } : item));
                    }} 
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Staging — unmatched punches</div>
            <div className="card-sub">{staging.length} pulled, awaiting reconciliation against today ({todayISO()})</div>
          </div>
        </div>
        {staging.length === 0 ? (
          <div className="empty">No pending punches. Sync a device above.</div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Device user</th><th>Mapped employee</th><th>Device</th><th>Time</th><th>Type</th><th style={{ textAlign: 'right' }}>Action</th></tr>
              </thead>
              <tbody>
                {staging.map((p) => (
                  <tr key={p.id}>
                    <td className="mono" style={{ color: p.empId ? 'inherit' : '#dc3545', fontWeight: p.empId ? 'normal' : 'bold' }}>
                      {p.deviceUserId}
                    </td>
                    <td>
                      {p.empId ? (
                        <div className="emp-cell"><Avatar name={p.guessName} size={26} /><span>{p.guessName}</span></div>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ color: '#dc3545', fontWeight: 600, fontSize: '11px' }}>⚠️ Unlinked:</span>
                          <select 
                            className="input compact" 
                            style={{ maxWidth: 150, padding: '2px 6px', fontSize: '12px', height: 'auto' }}
                            onChange={(e) => {
                              const empId = e.target.value;
                              const emp = employees.find(x => x.id === empId);
                              if (emp) {
                                setStaging(list => list.map(item => item.id === p.id ? { ...item, empId: emp.id, guessName: emp.name } : item));
                                toast('success', `Linked device user ${p.deviceUserId} to <strong>${emp.name}</strong>`);
                              }
                            }}
                          >
                            <option value="">-- Link Employee --</option>
                            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                        </div>
                      )}
                    </td>
                    <td>{p.deviceName}</td>
                    <td className="mono">{p.time}</td>
                    <td><span className="state-badge approved">{p.type === 'in' ? 'Check-in' : 'Check-out'}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                        <button className="mini-btn approve" disabled={!p.empId} onClick={() => reconcile(p)}>Reconcile</button>
                        <button className="mini-btn danger" onClick={() => discard(p.id)}>Discard</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Accounting export (Tally)</div>
            <div className="card-sub">Payroll journal → Tally-compatible XML import</div>
          </div>
          {cycles.length > 1 && (
            <select className="input" value={activeCycle} onChange={(e) => setCycle(e.target.value)}>
              {cycles.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <button className="btn" disabled={cyclePayroll.length === 0} onClick={exportTally}>Export to Tally</button>
        </div>
        {cyclePayroll.length > 0 && (
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-label">Salary expense</div>
              <span className="mono">{formatINR(cyclePayroll.reduce((s, p) => s + p.gross, 0))}</span>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">Statutory liabilities</div>
              <span className="mono">{formatINR(cyclePayroll.reduce((s, p) => s + p.deductions, 0))}</span>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">Net bank outflow</div>
              <span className="mono">{formatINR(cyclePayroll.reduce((s, p) => s + p.net, 0))}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
