import { useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import LeaveForm from '../components/LeaveForm';
import ConfirmDialog from '../components/ConfirmDialog';
import { IconPlus, IconTrash } from '../components/Icons';
import { formatDate, daysBetween, leaveTagClass, leaveTagLabel } from '../lib/helpers';
import { canDecideLeave, requiredStageFor, stagesFor } from '../lib/leaveApproval';
import { leavesApi } from '../data/store';

const FILTERS = ['Pending', 'Approved', 'Declined', 'Withdrawn', 'All'];

export default function Leave() {
  const {
    leaves, employees, currentUser, addLeave, approveLeave, declineLeave, deleteLeave,
    withdrawLeave, bulkApproveLeave, bulkDeclineLeave,
  } = useHRMS();
  const [filter, setFilter] = useState('Pending');
  const [formOpen, setFormOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const list = useMemo(() => {
    if (filter === 'All') return leaves;
    return leaves.filter((l) => l.status === filter.toLowerCase());
  }, [leaves, filter]);

  // Mirrors the server's own rule (src/lib/leaveApproval.js) rather than
  // guessing, so the page never offers a decision the API will refuse.
  const canActOn = (l) => canDecideLeave({ leave: l, currentUser, employees });
  const selectableIds = useMemo(
    () => list.filter((l) => l.status === 'pending' && canActOn(l)).map((l) => l.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, currentUser.role, currentUser.empId, employees],
  );

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((prev) => (
      prev.size === selectableIds.length ? new Set() : new Set(selectableIds)
    ));
  };
  const clearSelection = () => setSelectedIds(new Set());

  useEffect(() => { clearSelection(); }, [filter]);

  const runBulk = async (action) => {
    setBulkBusy(true);
    try {
      const fn = action === 'approved' ? bulkApproveLeave : bulkDeclineLeave;
      await fn([...selectedIds]);
      clearSelection();
    } finally {
      setBulkBusy(false);
    }
  };

  const counts = useMemo(() => ({
    Pending: leaves.filter((l) => l.status === 'pending').length,
    Approved: leaves.filter((l) => l.status === 'approved').length,
    Declined: leaves.filter((l) => l.status === 'declined').length,
    Withdrawn: leaves.filter((l) => l.status === 'withdrawn').length,
    All: leaves.length,
  }), [leaves]);

  // The authoritative balance comes from the server ledger — the same figures
  // the reservation on POST /leaves checks against. Deriving it in the browser
  // (as this page used to) produced a number nothing enforced, so an employee
  // could be told they had days left and then be refused.
  const [balances, setBalances] = useState([]);
  const [balanceError, setBalanceError] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!currentUser.empId) { setBalances([]); return undefined; }
    leavesApi.balance()
      .then((res) => { if (!cancelled) { setBalances(res.balances || []); setBalanceError(''); } })
      .catch((err) => { if (!cancelled) { setBalances([]); setBalanceError(err.message || 'Could not load your leave balance.'); } });
    return () => { cancelled = true; };
    // Re-read after any decision, since approving commits a reservation.
  }, [currentUser.empId, leaves]);

  return (
    <div className="page-wrap active">
      <div className="balance-grid">
        {balanceError && <div className="empty">{balanceError}</div>}
        {balances.filter((b) => b.balanceTracked).map((b) => (
          <div
            className="balance-card"
            key={b.type}
            style={{
              '--bar-width': `${Math.max(6, Math.min(100, Math.round(((b.used + b.pending) / Math.max(1, b.annualQuota)) * 100)))}%`,
              '--bar-color': b.available < 2 ? 'var(--red)' : 'var(--sage)',
            }}
          >
            <div className="balance-label">{b.name}</div>
            <div className="balance-value">{b.available}<small> / {b.annualQuota} days left</small></div>
            <div className="balance-meta">
              {b.used}d used · {b.pending}d pending{b.adjusted ? ` · ${b.adjusted}d adjusted` : ''}
            </div>
            <div className="balance-meta">
              {b.accrualMode === 'monthly' ? 'Accrues monthly' : 'Credited annually'}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Leave requests</div>
            <div className="card-sub">{counts.Pending} pending · {counts.Approved} approved</div>
          </div>
          <button className="btn" onClick={() => setFormOpen(true)}>
            <IconPlus width="14" height="14" /> New request
          </button>
        </div>

        <div className="filter-chips">
          {FILTERS.map((f) => (
            <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f} <span className="chip-count">{counts[f]}</span>
            </button>
          ))}
        </div>

        {selectableIds.length > 0 && (
          <div className="list-toolbar" style={{ marginTop: 12 }}>
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
                <button className="mini-btn" disabled={bulkBusy} onClick={() => runBulk('declined')}>
                  Decline selected
                </button>
              </div>
            )}
          </div>
        )}

        <div className="leave-list" style={{ marginTop: 16 }}>
          {list.length === 0 && <div className="empty">Nothing here.</div>}
          {list.map((l) => {
            const isOwner = currentUser.empId && String(l.empId) === String(currentUser.empId);
            return (
              <div className="leave-item" key={l.id}>
                {l.status === 'pending' && canActOn(l) && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(l.id)}
                    onChange={() => toggleSelect(l.id)}
                    style={{ marginTop: 4 }}
                  />
                )}
                <Avatar name={l.name} size={42} className="leave-avatar" />
                <div className="leave-body">
                  <div className="leave-name">
                    {l.name}
                    {l.status !== 'pending' && (
                      <span className={`state-badge ${l.status}`}>{l.status}</span>
                    )}
                    {l.isHalfDay && (
                      <span className="state-badge pending" style={{ marginLeft: 6 }}>Half-Day ({l.halfDayTiming === 'second-half' ? 'PM' : 'AM'})</span>
                    )}
                  </div>
                  <div className="leave-meta">
                    {l.workingDays || (l.isHalfDay ? 0.5 : daysBetween(l.start, l.end))} working day(s) · {formatDate(l.start)} – {formatDate(l.end)} · {l.dept}
                  </div>
                  {l.reason && <div className="leave-reason">“{l.reason}”</div>}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                    <span className={`leave-tag ${leaveTagClass(l.type)}`}>{leaveTagLabel(l.type)}</span>
                    {l.attachment && (
                      <a href={l.attachment} target="_blank" rel="noreferrer" className="muted-text" style={{ fontSize: '11.5px', textDecoration: 'underline' }}>
                        📎 Document Attachment
                      </a>
                    )}
                  </div>
                  {l.status === 'pending' && (() => {
                    const stages = stagesFor(l);
                    const stage = l.currentStage || 0;
                    const requiredRole = requiredStageFor(l);
                    const canAct = canActOn(l);
                    return (
                      <>
                        <div className="leave-meta" style={{ marginTop: 2 }}>
                          Stage {stage + 1} of {stages.length} — awaiting <strong>{requiredRole}</strong>
                        </div>
                        <div className="leave-actions">
                          {canAct && (
                            <>
                              <button className="mini-btn approve" onClick={() => approveLeave(l.id)}>Approve</button>
                              <button className="mini-btn" onClick={() => { const note = window.prompt('Reason for declining this leave request?'); if (note !== null) declineLeave(l.id, note); }}>Decline</button>
                            </>
                          )}
                          {(isOwner || currentUser.role === 'HR Director') && (
                            <button className="mini-btn danger" onClick={() => withdrawLeave(l.id)}>Withdraw</button>
                          )}
                          {!canAct && !isOwner && currentUser.role !== 'HR Director' && (
                            <span className="muted-text">Waiting on {requiredRole}</span>
                          )}
                        </div>
                      </>
                    );
                  })()}
                  {l.status !== 'pending' && (
                    <div className="leave-actions">
                      <button className="mini-btn danger" onClick={() => setConfirm(l)}>
                        <IconTrash width="12" height="12" /> Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <LeaveForm
        open={formOpen}
        employees={employees}
        onClose={() => setFormOpen(false)}
        onSave={async (data) => { await addLeave(data); setFormOpen(false); }}
      />

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Delete leave record"
        message={confirm ? `Delete ${confirm.name}’s ${leaveTagLabel(confirm.type).toLowerCase()} record?` : ''}
        confirmLabel="Delete"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { await deleteLeave(confirm.id); setConfirm(null); }}
      />
    </div>
  );
}
