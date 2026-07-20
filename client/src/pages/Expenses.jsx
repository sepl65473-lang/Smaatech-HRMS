import { useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import { formatINR } from '../lib/helpers';

const DEFAULT_STAGES = ['Finance Lead', 'HR Director']; // mirrors server/src/routes/expenses.js's fallback

export default function Expenses() {
  const {
    expenses, currentUser, employees, addExpense, updateExpenseStatus,
    bulkApproveExpenses, bulkDeclineExpenses,
  } = useHRMS();

  // Local state
  const [formOpen, setFormOpen] = useState(false);
  const [claimForm, setClaimForm] = useState({ category: 'Travel & Lodging', amount: '', description: '', receiptUrl: '' });
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [actionClaim, setActionClaim] = useState(null); // { claim, status }
  const [actionReason, setActionReason] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const isEmployee = currentUser.role === 'Employee';

  // Filter list based on role
  const filteredExpenses = useMemo(() => {
    if (isEmployee) {
      // Find linked employee ID to show only own expenses
      const me = employees.find((e) => e.name === currentUser.name);
      return me ? expenses.filter((e) => e.empId === me.id) : [];
    }
    return expenses;
  }, [expenses, isEmployee, employees, currentUser.name]);

  // Calculations for Admin/Finance summary stats
  const stats = useMemo(() => {
    return expenses.reduce(
      (acc, e) => {
        if (e.status === 'approved') acc.approvedSum += e.amount;
        else if (e.status === 'pending') acc.pendingCount += 1;
        else if (e.status === 'declined') acc.declinedCount += 1;
        return acc;
      },
      { approvedSum: 0, pendingCount: 0, declinedCount: 0 }
    );
  }, [expenses]);

  const handleFileClaim = async () => {
    if (!claimForm.amount || Number(claimForm.amount) <= 0) return;
    const me = employees.find((e) => e.name === currentUser.name);
    
    // Set a default receipt placeholder if none provided
    let finalReceipt = claimForm.receiptUrl;
    if (!finalReceipt) {
      const categories = {
        'Travel & Lodging': 'https://images.unsplash.com/photo-1554415707-6e8cfc93fe23?w=400&q=80',
        'Software Subscription': 'https://images.unsplash.com/photo-1586281380349-632531db7ed4?w=400&q=80',
        'Office Supplies': 'https://images.unsplash.com/photo-1497032628192-86f99bcd76bc?w=400&q=80',
        'Meals & Entertainment': 'https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=400&q=80',
        'Others': 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=400&q=80'
      };
      finalReceipt = categories[claimForm.category] || '';
    }

    await addExpense({
      empId: me ? me.id : 'emp_unknown',
      name: currentUser.name,
      category: claimForm.category,
      amount: Number(claimForm.amount),
      date: new Date().toISOString().slice(0, 10),
      description: claimForm.description,
      receiptUrl: finalReceipt
    });

    setClaimForm({ category: 'Travel & Lodging', amount: '', description: '', receiptUrl: '' });
    setFormOpen(false);
  };

  const handleProcessClaim = async () => {
    if (!actionClaim) return;
    await updateExpenseStatus(actionClaim.claim.id, actionClaim.status, actionReason);
    setActionClaim(null);
    setActionReason('');
  };

  const canActOn = (exp) => {
    const stages = exp.approvalStages?.length ? exp.approvalStages : DEFAULT_STAGES;
    const requiredRole = stages[exp.currentStage || 0] || stages[stages.length - 1];
    return currentUser.role === 'HR Director' || currentUser.role === requiredRole;
  };
  const selectableIds = useMemo(
    () => (isEmployee ? [] : filteredExpenses.filter((exp) => exp.status === 'pending' && canActOn(exp)).map((exp) => exp.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredExpenses, isEmployee, currentUser.role],
  );
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((prev) => (prev.size === selectableIds.length ? new Set() : new Set(selectableIds)));
  };
  const clearSelection = () => setSelectedIds(new Set());
  useEffect(() => { clearSelection(); }, [filteredExpenses.length]);

  const runBulk = async (status) => {
    setBulkBusy(true);
    try {
      const fn = status === 'approved' ? bulkApproveExpenses : bulkDeclineExpenses;
      await fn([...selectedIds]);
      clearSelection();
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="page-wrap active">
      {/* Stats header (Visible only to Admin/Finance) */}
      {!isEmployee && (
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Total disbursed</div>
            <div className="stat-value mono" style={{ fontSize: 22 }}>{formatINR(stats.approvedSum)}</div>
            <div className="stat-meta">approved claims</div>
          </div>
          <div className="stat">
            <div className="stat-label">Pending claims</div>
            <div className="stat-value" style={{ color: 'orange' }}>{stats.pendingCount}</div>
            <div className="stat-meta">awaiting review</div>
          </div>
          <div className="stat">
            <div className="stat-label">Declined claims</div>
            <div className="stat-value">{stats.declinedCount}</div>
            <div className="stat-meta">records mismatch</div>
          </div>
        </div>
      )}

      {/* Main card */}
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="card-title">{isEmployee ? 'My Expense Claims' : 'Reimbursements Register'}</div>
            <div className="card-sub">{filteredExpenses.length} entries on record</div>
          </div>
          {isEmployee && (
            <button className="btn" onClick={() => setFormOpen(true)}>
              File New Claim
            </button>
          )}
        </div>

        {selectableIds.length > 0 && (
          <div className="list-toolbar" style={{ padding: '0 16px' }}>
            <label className="inline-select" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={selectedIds.size > 0 && selectedIds.size === selectableIds.length}
                onChange={toggleSelectAll}
              />
              <span>{selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}</span>
            </label>
            {selectedIds.size > 0 && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="mini-btn approve" disabled={bulkBusy} onClick={() => runBulk('approved')}>
                  Approve selected
                </button>
                <button className="mini-btn danger" disabled={bulkBusy} onClick={() => runBulk('declined')}>
                  Decline selected
                </button>
              </div>
            )}
          </div>
        )}

        {filteredExpenses.length === 0 ? (
          <div className="empty">No expense claims found.</div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {selectableIds.length > 0 && <th></th>}
                  {!isEmployee && <th>Employee</th>}
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Receipt</th>
                  <th>Status</th>
                  {!isEmployee && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {filteredExpenses.map((exp) => (
                  <tr key={exp.id}>
                    {selectableIds.length > 0 && (
                      <td>
                        {exp.status === 'pending' && canActOn(exp) && (
                          <input type="checkbox" checked={selectedIds.has(exp.id)} onChange={() => toggleSelect(exp.id)} />
                        )}
                      </td>
                    )}
                    {!isEmployee && (
                      <td>
                        <div className="emp-cell">
                          <Avatar name={exp.name} size={28} />
                          <span>{exp.name}</span>
                        </div>
                      </td>
                    )}
                    <td className="mono">{exp.date}</td>
                    <td><span className="state-badge approved" style={{ textTransform: 'none' }}>{exp.category}</span></td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={exp.description}>
                      {exp.description}
                      {exp.reason && <div style={{ fontSize: 11, fontStyle: 'italic', color: '#666' }}>Note: "{exp.reason}"</div>}
                    </td>
                    <td style={{ textAlign: 'right' }} className="mono"><strong>{formatINR(exp.amount)}</strong></td>
                    <td>
                      {exp.receiptUrl ? (
                        <button 
                          className="mini-btn" 
                          style={{ padding: '2px 6px', fontSize: 11 }}
                          onClick={() => setSelectedReceipt(exp)}
                        >
                          View Receipt
                        </button>
                      ) : (
                        <span className="muted-text">None</span>
                      )}
                    </td>
                    <td>
                      <span className={`state-badge ${exp.status}`}>
                        {exp.status}
                      </span>
                      {exp.status === 'pending' && (() => {
                        const stages = exp.approvalStages?.length ? exp.approvalStages : DEFAULT_STAGES;
                        const stage = exp.currentStage || 0;
                        const requiredRole = stages[stage] || stages[stages.length - 1];
                        return (
                          <div className="muted-text" style={{ fontSize: 11, marginTop: 2 }}>
                            Stage {stage + 1}/{stages.length} — {requiredRole}
                          </div>
                        );
                      })()}
                    </td>
                    {!isEmployee && (
                      <td style={{ textAlign: 'right' }}>
                        {exp.status === 'pending' ? (() => {
                          const stages = exp.approvalStages?.length ? exp.approvalStages : DEFAULT_STAGES;
                          const requiredRole = stages[exp.currentStage || 0] || stages[stages.length - 1];
                          const canAct = currentUser.role === 'HR Director' || currentUser.role === requiredRole;
                          return canAct ? (
                            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                              <button className="mini-btn approve" onClick={() => setActionClaim({ claim: exp, status: 'approved' })}>
                                Approve
                              </button>
                              <button className="mini-btn danger" onClick={() => setActionClaim({ claim: exp, status: 'declined' })}>
                                Decline
                              </button>
                            </div>
                          ) : (
                            <span className="muted-text">Waiting on {requiredRole}</span>
                          );
                        })() : (
                          <span className="muted-text">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal - File new Claim */}
      <Modal
        open={formOpen}
        title="File New Expense Claim"
        subtitle="Submit expenses with receipts for supervisor approval"
        onClose={() => setFormOpen(false)}
        width={450}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setFormOpen(false)}>Cancel</button>
            <button className="btn" disabled={!claimForm.amount} onClick={handleFileClaim}>File Claim</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Expense Category</span>
            <select 
              className="input" 
              value={claimForm.category}
              onChange={(e) => setClaimForm(prev => ({ ...prev, category: e.target.value }))}
            >
              <option value="Travel & Lodging">Travel & Lodging</option>
              <option value="Software Subscription">Software Subscription</option>
              <option value="Office Supplies">Office Supplies</option>
              <option value="Meals & Entertainment">Meals & Entertainment</option>
              <option value="Others">Others</option>
            </select>
          </label>
          <label className="field field-full">
            <span className="field-label">Amount (INR)</span>
            <input 
              type="number" 
              className="input mono" 
              placeholder="e.g. 5000"
              value={claimForm.amount}
              onChange={(e) => setClaimForm(prev => ({ ...prev, amount: e.target.value }))}
            />
          </label>
          <label className="field field-full">
            <span className="field-label">Mock Receipt Image URL (Optional)</span>
            <input 
              type="text" 
              className="input" 
              placeholder="Paste any image URL or leave blank to simulate"
              value={claimForm.receiptUrl}
              onChange={(e) => setClaimForm(prev => ({ ...prev, receiptUrl: e.target.value }))}
            />
          </label>
          <label className="field field-full">
            <span className="field-label">Claim Description</span>
            <textarea 
              className="input" 
              rows={3} 
              placeholder="Describe what this expense was for..."
              value={claimForm.description}
              onChange={(e) => setClaimForm(prev => ({ ...prev, description: e.target.value }))}
            />
          </label>
        </div>
      </Modal>

      {/* Lightbox Modal - View Receipt */}
      <Modal
        open={Boolean(selectedReceipt)}
        title="Expense Receipt Preview"
        subtitle={selectedReceipt ? `${selectedReceipt.name} · ${selectedReceipt.category} · ${formatINR(selectedReceipt.amount)}` : ''}
        onClose={() => setSelectedReceipt(null)}
        width={480}
        footer={<button className="btn" onClick={() => setSelectedReceipt(null)}>Close Preview</button>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          {selectedReceipt?.receiptUrl ? (
            <img 
              src={selectedReceipt.receiptUrl} 
              alt="Receipt Invoice" 
              style={{ maxWidth: '100%', maxHeight: '350px', borderRadius: '8px', border: '1px solid #ddd', objectFit: 'contain' }}
            />
          ) : (
            <div className="empty">No scanned receipt attached.</div>
          )}
        </div>
      </Modal>

      {/* Modal - Approve/Decline Claim Reason */}
      <Modal
        open={Boolean(actionClaim)}
        title={actionClaim?.status === 'approved' ? 'Approve Expense Claim' : 'Decline Expense Claim'}
        subtitle={actionClaim ? `${actionClaim.claim.name} · ${formatINR(actionClaim.claim.amount)}` : ''}
        onClose={() => setActionClaim(null)}
        width={400}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setActionClaim(null)}>Cancel</button>
            <button 
              className={`btn ${actionClaim?.status === 'approved' ? 'approve' : 'danger'}`} 
              onClick={handleProcessClaim}
            >
              Submit decision
            </button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Comments / Remarks (Optional)</span>
            <input 
              type="text" 
              className="input" 
              placeholder="Add audit comments..."
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
