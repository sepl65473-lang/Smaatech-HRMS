import { useState } from 'react';
import { useHRMS } from '../context/HRMSContext';

export default function Workflows() {
  const { settings, updateSettings } = useHRMS();

  // Load workflows from settings or fallback to default
  const workflows = settings.approvalWorkflows || {
    leave: ['HR Manager', 'HR Director'],
    expense: ['Finance Lead', 'HR Director']
  };

  const [leaveStages, setLeaveStages] = useState(workflows.leave);
  const [expenseStages, setExpenseStages] = useState(workflows.expense);

  const roles = ['HR Manager', 'HR Director', 'Finance Lead', 'Employee'];

  const addStage = (type, role) => {
    if (type === 'leave') {
      setLeaveStages(prev => [...prev, role]);
    } else {
      setExpenseStages(prev => [...prev, role]);
    }
  };

  const removeStage = (type, index) => {
    if (type === 'leave') {
      setLeaveStages(prev => prev.filter((_, i) => i !== index));
    } else {
      setExpenseStages(prev => prev.filter((_, i) => i !== index));
    }
  };

  const saveWorkflows = () => {
    updateSettings({
      approvalWorkflows: {
        leave: leaveStages,
        expense: expenseStages
      }
    });
  };

  return (
    <div className="page-wrap active">
      <div className="card">
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="card-title">Approval Workflows Engine</div>
            <div className="card-sub">Establish multi-level validation sequences for internal requests</div>
          </div>
          <button className="btn" onClick={saveWorkflows}>
            Save Workflows
          </button>
        </div>

        {/* Workflow Section: Leaves */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #eee' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', color: '#333' }}>1. Leave Application Approval Workflow</h3>
          <p className="muted-text" style={{ fontSize: '13px', margin: '0 0 16px 0' }}>
            Configure sequence of authorizations required before a leave request is marked "Approved" in system database.
          </p>

          {/* Flowchart Diagram */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', background: '#f8f9fa', padding: '16px 20px', borderRadius: '8px', border: '1px solid #e9ecef', marginBottom: 16 }}>
            <div style={{ padding: '8px 14px', background: '#fff', border: '1px solid #ccc', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>
              📥 Employee Requests
            </div>
            {leaveStages.length > 0 && <span style={{ fontSize: 18, color: '#999' }}>➔</span>}
            
            {leaveStages.map((stage, idx) => (
              <div key={`leave-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ 
                  padding: '8px 14px', 
                  background: 'var(--paper-white, #fff)', 
                  border: '2px solid #3b7ddd', 
                  borderRadius: '6px', 
                  fontSize: '13px', 
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  boxShadow: '0 4px 6px rgba(59,125,221,0.05)'
                }}>
                  <span>Level {idx + 1}: {stage}</span>
                  <button 
                    type="button"
                    style={{ border: 'none', background: 'none', color: '#dc3545', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
                    onClick={() => removeStage('leave', idx)}
                  >
                    ×
                  </button>
                </div>
                {idx < leaveStages.length - 1 && <span style={{ fontSize: 18, color: '#999' }}>➔</span>}
              </div>
            ))}
            
            <span style={{ fontSize: 18, color: '#999' }}>➔</span>
            <div style={{ padding: '8px 14px', background: '#198754', color: '#fff', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>
              ✓ Approved & Persisted
            </div>
          </div>

          {/* Builder controls */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: '#495057' }}>Append approval stage:</span>
            <select 
              className="input compact" 
              style={{ maxWidth: 160, padding: '4px 8px', height: 'auto' }}
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  addStage('leave', e.target.value);
                  e.target.value = '';
                }
              }}
            >
              <option value="">-- Choose Role --</option>
              {roles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        {/* Workflow Section: Expenses */}
        <div style={{ padding: '20px 24px' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', color: '#333' }}>2. Reimbursement Claims Workflow</h3>
          <p className="muted-text" style={{ fontSize: '13px', margin: '0 0 16px 0' }}>
            Configure authorizations required before expense claims are approved for payroll disbursement.
          </p>

          {/* Flowchart Diagram */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', background: '#f8f9fa', padding: '16px 20px', borderRadius: '8px', border: '1px solid #e9ecef', marginBottom: 16 }}>
            <div style={{ padding: '8px 14px', background: '#fff', border: '1px solid #ccc', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>
              📥 Employee Requests
            </div>
            {expenseStages.length > 0 && <span style={{ fontSize: 18, color: '#999' }}>➔</span>}
            
            {expenseStages.map((stage, idx) => (
              <div key={`expense-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ 
                  padding: '8px 14px', 
                  background: 'var(--paper-white, #fff)', 
                  border: '2px solid #3b7ddd', 
                  borderRadius: '6px', 
                  fontSize: '13px', 
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  boxShadow: '0 4px 6px rgba(59,125,221,0.05)'
                }}>
                  <span>Level {idx + 1}: {stage}</span>
                  <button 
                    type="button"
                    style={{ border: 'none', background: 'none', color: '#dc3545', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}
                    onClick={() => removeStage('expense', idx)}
                  >
                    ×
                  </button>
                </div>
                {idx < expenseStages.length - 1 && <span style={{ fontSize: 18, color: '#999' }}>➔</span>}
              </div>
            ))}
            
            <span style={{ fontSize: 18, color: '#999' }}>➔</span>
            <div style={{ padding: '8px 14px', background: '#198754', color: '#fff', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>
              ✓ Approved & Paid
            </div>
          </div>

          {/* Builder controls */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: '#495057' }}>Append approval stage:</span>
            <select 
              className="input compact" 
              style={{ maxWidth: 160, padding: '4px 8px', height: 'auto' }}
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  addStage('expense', e.target.value);
                  e.target.value = '';
                }
              }}
            >
              <option value="">-- Choose Role --</option>
              {roles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
