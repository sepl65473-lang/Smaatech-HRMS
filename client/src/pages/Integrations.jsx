import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import AttendanceDevices from '../components/AttendanceDevices';
import { formatINR } from '../lib/helpers';
import { downloadTallyXML } from '../lib/tally';

export default function Integrations() {
  const { payroll, audit, toast, currentUser } = useHRMS();
  const [cycle, setCycle] = useState('');

  const cycles = useMemo(() => [...new Set(payroll.map((p) => p.cycle || 'Current'))], [payroll]);
  const activeCycle = cycle || cycles[0] || '';
  const cyclePayroll = useMemo(
    () => payroll.filter((p) => (p.cycle || 'Current') === activeCycle),
    [payroll, activeCycle],
  );
  const STATUTORY_LABELS = { PF: 'Provident Fund', ESI: 'ESI', PT: 'Professional Tax', TDS: 'TDS', Other: 'Other deductions' };
  const deductionsByCategory = useMemo(() => {
    const byCategory = { PF: 0, ESI: 0, PT: 0, TDS: 0, Other: 0 };
    cyclePayroll.forEach((p) => {
      const items = p.components?.deductions;
      if (items?.length) {
        items.forEach((d) => { byCategory[d.category || 'Other'] += Number(d.amount || 0); });
      } else {
        byCategory.Other += Number(p.deductions || 0);
      }
    });
    return Object.entries(byCategory).filter(([, amount]) => amount > 0);
  }, [cyclePayroll]);

  const exportTally = () => {
    if (cyclePayroll.length === 0) return;
    downloadTallyXML(activeCycle, cyclePayroll);
    audit('Tally export generated', activeCycle, `${cyclePayroll.length} payroll rows`);
    toast('success', `Tally journal exported for <strong>${activeCycle}</strong>`);
  };

  return (
    <div className="page-wrap active">
      {/* Real, server-backed: per-device credentials, the registered site and
          the device-user links. This replaces the single company-wide key
          card: a device now authenticates with its own id and key. */}
      {['HR Director', 'HR Manager'].includes(currentUser?.role) && <AttendanceDevices />}

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
            {deductionsByCategory.map(([cat, amount]) => (
              <div className="settings-row" key={cat} style={{ paddingLeft: 24 }}>
                <div className="settings-row-sub">{STATUTORY_LABELS[cat]}</div>
                <span className="mono muted-text">{formatINR(amount)}</span>
              </div>
            ))}
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
