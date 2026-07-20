import { useEffect, useState } from 'react';
import Modal from './Modal';
import { IconPlus, IconTrash } from './Icons';
import { formatINR } from '../lib/helpers';

const DEDUCTION_CATEGORIES = ['PF', 'ESI', 'PT', 'TDS', 'Other'];

function ComponentList({ label, items, onChange, categories }) {
  const update = (i, key, value) => {
    const next = items.map((c, idx) => (idx === i ? { ...c, [key]: value } : c));
    onChange(next);
  };
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, categories ? { name: '', amount: 0, category: 'Other' } : { name: '', amount: 0 }]);
  const total = items.reduce((sum, c) => sum + Number(c.amount || 0), 0);

  return (
    <div className="field field-full">
      <span className="field-label">{label} <span className="muted-text">· {formatINR(total)}</span></span>
      {items.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          {categories && (
            <select className="input" style={{ maxWidth: 100 }} value={c.category || 'Other'} onChange={(e) => update(i, 'category', e.target.value)}>
              {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          )}
          <input className="input" value={c.name} onChange={(e) => update(i, 'name', e.target.value)} placeholder="Component name" />
          <input type="number" className="input" style={{ maxWidth: 130 }} value={c.amount} onChange={(e) => update(i, 'amount', e.target.value)} placeholder="0" />
          <button className="icon-btn sm danger" title="Remove" onClick={() => remove(i)}>
            <IconTrash width="13" height="13" />
          </button>
        </div>
      ))}
      <button className="mini-btn" onClick={add}><IconPlus width="12" height="12" /> Add component</button>
    </div>
  );
}

export default function SalaryStructureModal({ open, slip, onClose, onSave }) {
  const [earnings, setEarnings] = useState([]);
  const [deductions, setDeductions] = useState([]);
  const [lopDays, setLopDays] = useState(0);

  useEffect(() => {
    if (open && slip) {
      setEarnings(slip.components?.earnings || [{ name: 'Basic + allowances', amount: slip.gross }]);
      setDeductions(slip.components?.deductions || [{ name: 'Statutory deductions', amount: slip.deductions, category: 'Other' }]);
      setLopDays(slip.lopDays || 0);
    }
  }, [open, slip]);

  if (!slip) return null;

  const gross = earnings.reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const ded = deductions.reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const lopAmount = Math.round((gross / 30) * Number(lopDays || 0));
  const net = gross - ded - lopAmount;

  return (
    <Modal
      open={open}
      title="Salary structure"
      subtitle={`${slip.name} · ${slip.cycle}`}
      onClose={onClose}
      width={560}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => onSave(slip.id, { earnings, deductions, lopDays })}>Save structure</button>
        </>
      )}
    >
      <div className="form-grid">
        <ComponentList label="Earnings" items={earnings} onChange={setEarnings} />
        <ComponentList label="Deductions" items={deductions} onChange={setDeductions} categories={DEDUCTION_CATEGORIES} />
        <label className="field field-full">
          <span className="field-label">LOP (loss of pay) days this cycle</span>
          <input type="number" min="0" max="31" className="input" value={lopDays} onChange={(e) => setLopDays(e.target.value)} />
          <small className="muted-text">Per-day rate uses a fixed 30-day basis: {formatINR(Math.round(gross / 30))}/day</small>
        </label>
        <div className="payslip-preview" style={{ width: '100%' }}>
          <div className="payslip-row"><span>Gross</span><strong>{formatINR(gross)}</strong></div>
          <div className="payslip-row"><span>Deductions</span><strong>– {formatINR(ded)}</strong></div>
          <div className="payslip-row"><span>LOP ({lopDays} days)</span><strong>– {formatINR(lopAmount)}</strong></div>
          <div className="payslip-total"><span>Net payout</span><strong>{formatINR(net)}</strong></div>
        </div>
      </div>
    </Modal>
  );
}
