import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import { formatDate, formatINR, todayISO } from '../lib/helpers';

export default function Resignations() {
  const {
    employees, currentUser, resignations, addResignation, signOffClearance,
    processFnF, payFnF, updateResignationStatus, toast
  } = useHRMS();

  const isHR = ['HR Director', 'HR Manager'].includes(currentUser.role);
  const isFinance = currentUser.role === 'Finance Lead';
  const isManager = isHR || isFinance;

  // ESS checks
  const myResignation = useMemo(() => {
    return resignations.find(r => r.employeeId === currentUser.empId);
  }, [resignations, currentUser.empId]);

  const [activeTab, setActiveTab] = useState(isManager ? 'directory' : 'my-exit');
  const [selectedExit, setSelectedExit] = useState(null);

  // Form states
  const [reason, setReason] = useState('');
  const [lwd, setLwd] = useState('');
  const [clearanceNotes, setClearanceNotes] = useState('');
  const [showFnFModal, setShowFnFModal] = useState(false);
  const [fnfForm, setFnfForm] = useState({
    monthlySalary: 0,
    leaveEncashment: 0,
    gratuity: 0,
    otherAllowances: 0,
    loansDeduction: 0,
    assetDeduction: 0,
    otherDeductions: 0,
    notes: ''
  });

  const [filterStatus, setFilterStatus] = useState('all'); // all | pending | approved

  const handleResign = async () => {
    if (!reason || !lwd) {
      toast('error', 'Please fill in LWD and reason.');
      return;
    }
    const emp = employees.find(e => e.id === currentUser.empId);
    if (!emp) return;

    await addResignation({
      employeeId: emp.id,
      employeeName: emp.name,
      resignationDate: new Date().toISOString().slice(0, 10),
      requestedLastWorkingDay: lwd,
      reason
    });
    setReason('');
    setLwd('');
  };

  const signOff = async (resId, dept, status) => {
    await signOffClearance(resId, { dept, status, notes: clearanceNotes });
    setClearanceNotes('');
  };

  const handleProcessFnF = async (exitId) => {
    await processFnF(exitId, fnfForm);
    setShowFnFModal(false);
  };

  const handlePayFnF = async (exitId) => {
    await payFnF(exitId);
  };

  const handleLWDUpdate = async (exitId, newLwd) => {
    await updateResignationStatus(exitId, { approvedLastWorkingDay: newLwd });
  };

  const filteredExits = useMemo(() => {
    return resignations.filter(r => {
      if (filterStatus === 'all') return true;
      if (filterStatus === 'pending') return r.status === 'Submitted';
      return r.status === 'Approved';
    });
  }, [resignations, filterStatus]);

  const activeResignation = selectedExit ? resignations.find(r => r.id === selectedExit.id) : null;

  return (
    <div className="page-wrap active">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Exit & Clearance Cockpit</div>
            <div className="card-sub">Process employee resignations, clearances, and Full & Final settlements</div>
          </div>
        </div>
      </div>

      {isManager && (
        <div style={{ display: 'flex', gap: 12, borderBottom: '1px solid var(--line)', padding: '4px 0', margin: '16px 0 20px 0' }}>
          <button onClick={() => setActiveTab('directory')} className={`btn ${activeTab === 'directory' ? '' : 'btn-ghost'}`}>
            Resignations Directory
          </button>
          {!isFinance && (
            <button onClick={() => setActiveTab('my-exit')} className={`btn ${activeTab === 'my-exit' ? '' : 'btn-ghost'}`}>
              My Exit
            </button>
          )}
        </div>
      )}

      {activeTab === 'directory' && isManager && (
        <div className="grid" style={{ gridTemplateColumns: activeResignation ? '1fr 380px' : '1fr', alignItems: 'start' }}>
          {/* List Table */}
          <div className="card">
            <div className="card-head">
              <div className="card-title">Active Exits</div>
              <div className="filter-chips">
                <button className={`chip ${filterStatus === 'all' ? 'active' : ''}`} onClick={() => setFilterStatus('all')}>All</button>
                <button className={`chip ${filterStatus === 'pending' ? 'active' : ''}`} onClick={() => setFilterStatus('pending')}>Pending</button>
                <button className={`chip ${filterStatus === 'approved' ? 'active' : ''}`} onClick={() => setFilterStatus('approved')}>Approved</button>
              </div>
            </div>

            {filteredExits.length === 0 ? (
              <div className="empty">No resignations on file.</div>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Employee</th><th>Resign Date</th><th>Requested LWD</th><th>Status</th><th>Clearances</th><th>FnF Settlement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExits.map(r => {
                      const approvedClearances = r.clearances.filter(c => c.status === 'Approved').length;
                      return (
                        <tr key={r.id} onClick={() => setSelectedExit(r)} style={{ cursor: 'pointer', background: activeResignation?.id === r.id ? 'var(--highlight)' : '' }}>
                          <td>
                            <div className="emp-cell">
                              <Avatar name={r.employeeName} size={28} />
                              <span>{r.employeeName}</span>
                            </div>
                          </td>
                          <td className="mono">{formatDate(r.resignationDate)}</td>
                          <td className="mono">{formatDate(r.requestedLastWorkingDay)}</td>
                          <td>
                            <span className={`state-badge ${r.status === 'Approved' ? 'approved' : r.status === 'Rejected' ? 'declined' : 'pending'}`}>
                              {r.status}
                            </span>
                          </td>
                          <td>
                            <span className={`state-badge ${approvedClearances === 4 ? 'approved' : 'pending'}`}>
                              {approvedClearances}/4 Signed
                            </span>
                          </td>
                          <td>
                            <span className={`state-badge ${r.fnfSettlement?.status === 'Paid' ? 'approved' : r.fnfSettlement?.status === 'Processed' ? 'pending' : 'declined'}`}>
                              {r.fnfSettlement?.status || 'Draft'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Details Sidebar panel */}
          {activeResignation && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">Exit Processing</div>
                <button className="btn btn-ghost btn-compact" onClick={() => setSelectedExit(null)}>Close</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{activeResignation.employeeName}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                    Resigned: {formatDate(activeResignation.resignationDate)}
                  </div>
                  <div style={{ fontSize: 13, background: '#f8f9fa', padding: 8, borderRadius: 6, marginTop: 8, fontStyle: 'italic' }}>
                    "{activeResignation.reason}"
                  </div>
                </div>

                {/* Approved LWD inputs */}
                {isHR && activeResignation.status === 'Submitted' && (
                  <label className="field">
                    <span className="field-label">Set Approved Last Working Day</span>
                    <input 
                      type="date" 
                      className="input compact" 
                      value={activeResignation.approvedLastWorkingDay || activeResignation.requestedLastWorkingDay}
                      onChange={(e) => handleLWDUpdate(activeResignation.id, e.target.value)}
                    />
                  </label>
                )}

                {/* Clearance Checklist */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4, marginBottom: 8 }}>
                    Department Sign-offs
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeResignation.clearances.map((c, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8f9fa', padding: '6px 10px', borderRadius: '6px' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 12 }}>{c.dept} Clearance</div>
                          {c.approvedBy && <div style={{ fontSize: 10, color: 'var(--muted)' }}>By: {c.approvedBy} ({formatDate(c.approvedAt)})</div>}
                          {c.notes && <div style={{ fontSize: 11, fontStyle: 'italic', marginTop: 2 }}>"{c.notes}"</div>}
                        </div>
                        <span className={`state-badge ${c.status === 'Approved' ? 'approved' : 'pending'}`}>
                          {c.status}
                        </span>
                      </div>
                    ))}
                  </div>

                  {activeResignation.status === 'Submitted' && (
                    <div style={{ marginTop: 12 }}>
                      <input 
                        type="text" 
                        placeholder="Clearance notes / comments" 
                        className="input compact" 
                        value={clearanceNotes}
                        onChange={(e) => setClearanceNotes(e.target.value)} 
                        style={{ marginBottom: 6 }}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        {activeResignation.clearances.map((c, i) => {
                          const isIT = c.dept === 'IT' && (req => req.role === 'IT Support' || isHR)(currentUser);
                          const isFin = c.dept === 'Finance' && (isFinance || isHR);
                          const isHrDept = (c.dept === 'HR' || c.dept === 'Admin') && isHR;
                          if (c.status !== 'Approved' && (isIT || isFin || isHrDept)) {
                            return (
                              <button key={i} className="btn btn-compact approve" onClick={() => signOff(activeResignation.id, c.dept, 'Approved')}>
                                Sign {c.dept}
                              </button>
                            );
                          }
                          return null;
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* FnF Settlement Sheet */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4, marginBottom: 8 }}>
                    Full & Final (FnF) Settlement
                  </div>
                  {activeResignation.fnfSettlement?.status !== 'Draft' ? (
                    <div style={{ background: '#f8f9fa', padding: 12, borderRadius: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                        <span>Salary & Allowances:</span>
                        <strong className="mono">
                          {formatINR((activeResignation.fnfSettlement.monthlySalary || 0) + (activeResignation.fnfSettlement.leaveEncashment || 0) + (activeResignation.fnfSettlement.gratuity || 0) + (activeResignation.fnfSettlement.otherAllowances || 0))}
                        </strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, color: 'var(--declined)' }}>
                        <span>Deductions:</span>
                        <strong className="mono">
                          -{formatINR((activeResignation.fnfSettlement.loansDeduction || 0) + (activeResignation.fnfSettlement.assetDeduction || 0) + (activeResignation.fnfSettlement.otherDeductions || 0))}
                        </strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderTop: '1px dashed var(--line)', paddingTop: 6, fontWeight: 700 }}>
                        <span>Net Settlement Payout:</span>
                        <span className="mono">{formatINR(activeResignation.fnfSettlement.netPayout)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                        <span className={`state-badge ${activeResignation.fnfSettlement.status === 'Paid' ? 'approved' : 'pending'}`}>
                          {activeResignation.fnfSettlement.status}
                        </span>
                        {activeResignation.fnfSettlement.status === 'Processed' && (isFinance || currentUser.role === 'HR Director') && (
                          <button className="btn btn-compact approve" onClick={() => handlePayFnF(activeResignation.id)}>
                            Disburse & Terminate
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 8 }}>No FnF settled yet.</span>
                      {(isFinance || currentUser.role === 'HR Director') && (
                        <button className="btn btn-compact" onClick={() => {
                          setFnfForm({
                            monthlySalary: activeResignation.fnfSettlement.monthlySalary || 0,
                            leaveEncashment: 0,
                            gratuity: 0,
                            otherAllowances: 0,
                            loansDeduction: 0,
                            assetDeduction: 0,
                            otherDeductions: 0,
                            notes: ''
                          });
                          setShowFnFModal(true);
                        }}>
                          Calculate FnF
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ESS User View */}
      {activeTab === 'my-exit' && (
        <div style={{ maxWidth: '600px', margin: '0 auto' }}>
          {myResignation ? (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">My Exit Clearance Tracker</div>
                  <div className="card-sub">Filed Date: {formatDate(myResignation.resignationDate)}</div>
                </div>
                <span className={`state-badge ${myResignation.status === 'Approved' ? 'approved' : 'pending'}`}>
                  {myResignation.status}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {/* LWD details */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, background: '#f8f9fa', padding: 12, borderRadius: 6 }}>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Requested LWD</span>
                    <strong className="mono">{formatDate(myResignation.requestedLastWorkingDay)}</strong>
                  </div>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Approved LWD</span>
                    <strong className="mono">{myResignation.approvedLastWorkingDay ? formatDate(myResignation.approvedLastWorkingDay) : 'Awaiting Approval'}</strong>
                  </div>
                </div>

                {/* Clearance Grid checklist */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>My Clearance Status</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {myResignation.clearances.map((c, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8f9fa', padding: '10px 14px', borderRadius: '6px' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{c.dept} Department Clearance</div>
                          {c.approvedBy && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>Approved by {c.approvedBy} on {formatDate(c.approvedAt)}</div>}
                          {c.notes && <div style={{ fontSize: 11, fontStyle: 'italic', marginTop: 4 }}>Notes: "{c.notes}"</div>}
                        </div>
                        <span className={`state-badge ${c.status === 'Approved' ? 'approved' : 'pending'}`}>
                          {c.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Final settlement sheet display */}
                {myResignation.fnfSettlement?.status !== 'Draft' && (
                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>My Full & Final (FnF) Settlement Statement</div>
                    <div style={{ background: '#f8f9fa', padding: 16, borderRadius: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                        <span>Base Salary (Remaining days):</span>
                        <span className="mono">{formatINR(myResignation.fnfSettlement.monthlySalary)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                        <span>Leave Encashment Payout:</span>
                        <span className="mono">{formatINR(myResignation.fnfSettlement.leaveEncashment)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                        <span>Gratuity:</span>
                        <span className="mono">{formatINR(myResignation.fnfSettlement.gratuity)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 10 }}>
                        <span>Other Allowances:</span>
                        <span className="mono">{formatINR(myResignation.fnfSettlement.otherAllowances)}</span>
                      </div>
                      <div style={{ borderBottom: '1px dashed var(--line)', marginBottom: 10 }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, color: 'var(--declined)' }}>
                        <span>Loans / Advances deduction:</span>
                        <span className="mono">-{formatINR(myResignation.fnfSettlement.loansDeduction)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, color: 'var(--declined)' }}>
                        <span>Asset damage penalty:</span>
                        <span className="mono">-{formatINR(myResignation.fnfSettlement.assetDeduction)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 10, color: 'var(--declined)' }}>
                        <span>Other deductions:</span>
                        <span className="mono">-{formatINR(myResignation.fnfSettlement.otherDeductions)}</span>
                      </div>
                      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700 }}>
                        <span>Total Net Settlement Payout:</span>
                        <span className="mono" style={{ color: 'var(--approved)' }}>{formatINR(myResignation.fnfSettlement.netPayout)}</span>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <span className={`state-badge ${myResignation.fnfSettlement.status === 'Paid' ? 'approved' : 'pending'}`}>
                          Payment Status: {myResignation.fnfSettlement.status}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">File Resignation</div>
                  <div className="card-sub">Request clearance and Full & Final settlement parameters</div>
                </div>
              </div>

              <div className="form-grid">
                <label className="field field-full">
                  <span className="field-label">Requested Last Working Day (LWD)</span>
                  <input type="date" className="input" min={todayISO()} value={lwd} onChange={(e) => setLwd(e.target.value)} />
                </label>
                <label className="field field-full">
                  <span className="field-label">Reason for leaving</span>
                  <textarea 
                    placeholder="Provide details about your resignation" 
                    className="input" 
                    value={reason} 
                    onChange={(e) => setReason(e.target.value)} 
                    style={{ height: '100px', padding: 8 }}
                  />
                </label>
              </div>

              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn approve" onClick={handleResign}>Submit Resignation</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Calculate FnF modal */}
      {activeResignation && (
        <Modal
          open={showFnFModal}
          title="Full & Final (FnF) Calculation Sheet"
          subtitle={`Calculate payout details for ${activeResignation.employeeName}`}
          onClose={() => setShowFnFModal(false)}
          width={450}
          footer={(
            <>
              <button className="btn btn-ghost" onClick={() => setShowFnFModal(false)}>Cancel</button>
              <button className="btn" onClick={() => handleProcessFnF(activeResignation.id)}>Save calculations</button>
            </>
          )}
        >
          <div className="form-grid">
            <div style={{ gridColumn: 'span 2', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4 }}>
              Earnings & Additions (₹)
            </div>
            <label className="field">
              <span className="field-label">Monthly Salary</span>
              <input type="number" className="input compact" value={fnfForm.monthlySalary} onChange={(e) => setFnfForm(prev => ({ ...prev, monthlySalary: Number(e.target.value) }))} />
            </label>
            <label className="field">
              <span className="field-label">Leave Encashment</span>
              <input type="number" className="input compact" value={fnfForm.leaveEncashment} onChange={(e) => setFnfForm(prev => ({ ...prev, leaveEncashment: Number(e.target.value) }))} />
            </label>
            <label className="field">
              <span className="field-label">Gratuity Payout</span>
              <input type="number" className="input compact" value={fnfForm.gratuity} onChange={(e) => setFnfForm(prev => ({ ...prev, gratuity: Number(e.target.value) }))} />
            </label>
            <label className="field">
              <span className="field-label">Other Allowances</span>
              <input type="number" className="input compact" value={fnfForm.otherAllowances} onChange={(e) => setFnfForm(prev => ({ ...prev, otherAllowances: Number(e.target.value) }))} />
            </label>

            <div style={{ gridColumn: 'span 2', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4, marginTop: 12 }}>
              Deductions (₹)
            </div>
            <label className="field">
              <span className="field-label">Loans / Advances Balance</span>
              <input type="number" className="input compact" value={fnfForm.loansDeduction} onChange={(e) => setFnfForm(prev => ({ ...prev, loansDeduction: Number(e.target.value) }))} />
            </label>
            <label className="field">
              <span className="field-label">Asset Damages / Fees</span>
              <input type="number" className="input compact" value={fnfForm.assetDeduction} onChange={(e) => setFnfForm(prev => ({ ...prev, assetDeduction: Number(e.target.value) }))} />
            </label>
            <label className="field field-full">
              <span className="field-label">Other Deductions</span>
              <input type="number" className="input compact" value={fnfForm.otherDeductions} onChange={(e) => setFnfForm(prev => ({ ...prev, otherDeductions: Number(e.target.value) }))} />
            </label>

            <div style={{ gridColumn: 'span 2', borderBottom: '1px solid var(--line)', marginTop: 12 }} />
            <label className="field field-full">
              <span className="field-label">Settlement Comments / Notes</span>
              <input type="text" className="input compact" placeholder="e.g. Cleared IT damages. Payslip settled." value={fnfForm.notes} onChange={(e) => setFnfForm(prev => ({ ...prev, notes: e.target.value }))} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
