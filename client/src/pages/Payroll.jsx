import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import SalaryStructureModal from '../components/SalaryStructureModal';
import { IconPayroll, IconCheck } from '../components/Icons';
import { formatINR } from '../lib/helpers';
import { downloadPayslip } from '../lib/payslip';
import { downloadCSV } from '../lib/exportCsv';

const STATUS = {
  ready:      { label: 'Ready',   cls: 'status-active' },
  processing: { label: 'Processing', cls: 'status-late' },
  paid:       { label: 'Paid',    cls: 'status-paid' },
};

export default function Payroll() {
  const { payroll, employees, processPayroll, markPaid, updatePayrollStructure, audit, toast } = useHRMS();
  const [confirm, setConfirm] = useState(false);
  const [slip, setSlip] = useState(null);
  const [structureSlip, setStructureSlip] = useState(null);
  const cycles = useMemo(() => [...new Set(payroll.map((p) => p.cycle || 'Current'))], [payroll]);
  const [cycle, setCycle] = useState('');
  const activeCycle = cycle || cycles[0] || 'Current';
  const cyclePayroll = useMemo(
    () => payroll.filter((p) => (p.cycle || 'Current') === activeCycle),
    [payroll, activeCycle],
  );

  const totals = useMemo(() => cyclePayroll.reduce(
    (acc, p) => {
      acc.gross += p.gross; acc.ded += p.deductions; acc.net += p.net;
      if (p.status === 'ready') acc.ready += 1;
      return acc;
    },
    { gross: 0, ded: 0, net: 0, ready: 0 },
  ), [cyclePayroll]);

  const exportBankFile = () => {
    const rows = cyclePayroll.map((p) => {
      const emp = employees.find((e) => e.id === p.empId);
      return {
        name: p.name,
        account: emp?.bankAccount || 'MISSING',
        ifsc: emp?.ifsc || 'MISSING',
        amount: p.net,
      };
    });
    const missing = rows.filter((r) => r.account === 'MISSING' || r.ifsc === 'MISSING').length;
    const reconciled = rows.reduce((sum, r) => sum + r.amount, 0) === totals.net;
    downloadCSV(`bank-advice-${activeCycle}`, rows, [
      { key: 'name', label: 'Beneficiary name' },
      { key: 'account', label: 'Account number' },
      { key: 'ifsc', label: 'IFSC code' },
      { key: 'amount', label: 'Amount' },
    ]);
    audit('Bank file generated', activeCycle, `${rows.length} rows · ${reconciled ? 'reconciled' : 'mismatch'}`);
    if (missing > 0) {
      toast('info', `Bank file exported — ${missing} employee${missing === 1 ? '' : 's'} missing bank details`);
    } else {
      toast('success', `Bank file exported · totals reconcile to ${formatINR(totals.net)}`);
    }
  };

  return (
    <div className="page-wrap active">
      <div className="stats">
        <div className="stat">
          <div className="stat-icon tone-accent"><IconPayroll width="16" height="16" /></div>
          <div className="stat-label">Gross payout</div><div className="stat-value mono" style={{ fontSize: 22 }}>{formatINR(totals.gross)}</div><div className="stat-meta">{cyclePayroll.length} employees</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-gold"><IconPayroll width="16" height="16" /></div>
          <div className="stat-label">Deductions</div><div className="stat-value mono" style={{ fontSize: 22 }}>{formatINR(totals.ded)}</div><div className="stat-meta">tax + PF + others</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-sage"><IconPayroll width="16" height="16" /></div>
          <div className="stat-label">Net payout</div><div className="stat-value mono" style={{ fontSize: 22 }}>{formatINR(totals.net)}</div><div className="stat-meta">to be disbursed</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-teal"><IconCheck width="16" height="16" /></div>
          <div className="stat-label">Pending slips</div><div className="stat-value">{totals.ready}</div><div className="stat-meta">ready to process</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Payroll register - {activeCycle}</div>
            <div className="card-sub">{totals.ready} of {cyclePayroll.length} ready to pay</div>
          </div>
          {cycles.length > 1 && (
            <select className="input" value={activeCycle} onChange={(e) => setCycle(e.target.value)}>
              {cycles.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <button className="btn btn-ghost" disabled={cyclePayroll.length === 0} onClick={exportBankFile}>
            Export bank file
          </button>
          <button className="btn" disabled={totals.ready === 0} onClick={() => setConfirm(true)}>
            Process payroll →
          </button>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th><th>Department</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th style={{ textAlign: 'right' }}>Deductions</th>
                <th style={{ textAlign: 'right' }}>Net</th>
                <th>Status</th><th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {cyclePayroll.map((r) => {
                const s = STATUS[r.status] || STATUS.ready;
                return (
                  <tr key={r.id}>
                    <td><div className="emp-cell"><Avatar name={r.name} size={30} /><div className="emp-name">{r.name}</div></div></td>
                    <td>{r.dept}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{formatINR(r.gross)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">– {formatINR(r.deductions)}</td>
                    <td style={{ textAlign: 'right' }} className="mono"><strong>{formatINR(r.net)}</strong></td>
                    <td><span className={`status-dot ${s.cls}`} /> {s.label}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row-actions">
                        <button className="mini-btn" onClick={() => setSlip(r)}>Preview</button>
                        <button className="mini-btn" onClick={() => setStructureSlip(r)}>Structure</button>
                      {r.status !== 'paid'
                        ? <button className="mini-btn approve" onClick={() => markPaid(r.id)}>Mark paid</button>
                        : <span className="muted-text">✓ Paid</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        danger={false}
        title="Process payroll"
        message={`Disburse net salaries for ${totals.ready} employees (${formatINR(totals.net)})? This marks all ready slips as paid.`}
        confirmLabel="Process now"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => { await processPayroll(); setConfirm(false); }}
      />

      <Modal
        open={Boolean(slip)}
        title="Payslip preview"
        subtitle={slip ? `${slip.name} - ${slip.cycle}` : ''}
        onClose={() => setSlip(null)}
        width={520}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setSlip(null)}>Close</button>
            <button className="btn btn-ghost" onClick={() => { downloadPayslip(slip); audit('Payslip downloaded', slip.name, slip.cycle); }}>Download</button>
            <button className="btn" onClick={() => window.print()}>Print</button>
          </>
        )}
      >
        {slip && (
          <div className="payslip-preview print-area">
            <div className="payslip-row"><span>Employee</span><strong>{slip.name}</strong></div>
            <div className="payslip-row"><span>Department</span><strong>{slip.dept}</strong></div>
            <div className="payslip-row"><span>Cycle</span><strong>{slip.cycle}</strong></div>
            <div className="payslip-row"><span>Gross salary</span><strong>{formatINR(slip.gross)}</strong></div>
            {slip.components?.deductions?.length ? (
              slip.components.deductions.map((d, i) => (
                <div className="payslip-row" key={i}>
                  <span>{d.name || d.category}{d.category && d.category !== 'Other' ? ` (${d.category})` : ''}</span>
                  <strong>- {formatINR(d.amount)}</strong>
                </div>
              ))
            ) : (
              <div className="payslip-row"><span>Deductions</span><strong>- {formatINR(slip.deductions)}</strong></div>
            )}
            {slip.lopDays > 0 && (
              <div className="payslip-row"><span>LOP ({slip.lopDays} days)</span><strong>- {formatINR(slip.lopAmount || 0)}</strong></div>
            )}
            <div className="payslip-total"><span>Net payout</span><strong>{formatINR(slip.net)}</strong></div>
            <div className="payslip-row"><span>Status</span><strong>{STATUS[slip.status]?.label || slip.status}</strong></div>
          </div>
        )}
      </Modal>

      <SalaryStructureModal
        open={Boolean(structureSlip)}
        slip={structureSlip}
        onClose={() => setStructureSlip(null)}
        onSave={async (id, data) => { await updatePayrollStructure(id, data); setStructureSlip(null); }}
      />
    </div>
  );
}
