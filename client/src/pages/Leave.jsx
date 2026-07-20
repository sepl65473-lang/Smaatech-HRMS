import { useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import LeaveForm from '../components/LeaveForm';
import ConfirmDialog from '../components/ConfirmDialog';
import { IconPlus, IconTrash } from '../components/Icons';
import { formatDate, daysBetween, leaveTagClass, leaveTagLabel } from '../lib/helpers';

const FILTERS = ['Pending', 'Approved', 'Declined', 'All'];
const DEFAULT_STAGES = ['HR Manager', 'HR Director']; // mirrors server/src/routes/leave.js's fallback

export default function Leave() {
  const {
    leaves, employees, settings, currentUser, addLeave, approveLeave, declineLeave, deleteLeave,
    bulkApproveLeave, bulkDeclineLeave,
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

  const canActOn = (l) => {
    const stages = l.approvalStages?.length ? l.approvalStages : DEFAULT_STAGES;
    const requiredRole = stages[l.currentStage || 0] || stages[stages.length - 1];
    return currentUser.role === 'HR Director' || currentUser.role === requiredRole;
  };
  const selectableIds = useMemo(
    () => list.filter((l) => l.status === 'pending' && canActOn(l)).map((l) => l.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, currentUser.role],
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
    All: leaves.length,
  }), [leaves]);

  const balances = useMemo(() => employees.map((employee) => {
    const approved = leaves.filter((l) => l.empId === employee.id && l.status === 'approved');
    const pending = leaves.filter((l) => l.empId === employee.id && l.status === 'pending');
    const used = approved.reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    const pendingDays = pending.reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    const total = Number(settings.totalLeaveDays || 24);
    return {
      id: employee.id,
      name: employee.name,
      dept: employee.dept,
      used,
      pendingDays,
      remaining: Math.max(0, total - used),
      pct: Math.min(100, Math.round((used / total) * 100)),
    };
  }).sort((a, b) => b.used - a.used).slice(0, 3), [employees, leaves, settings.totalLeaveDays]);

  return (
    <div className="page-wrap active">
      <div className="balance-grid">
        {balances.map((b) => (
          <div
            className="balance-card"
            key={b.id}
            style={{ '--bar-width': `${Math.max(6, b.pct)}%`, '--bar-color': b.remaining < 6 ? 'var(--red)' : 'var(--sage)' }}
          >
            <div className="balance-label">{b.name}</div>
            <div className="balance-value">{b.remaining}<small> / 24 days</small></div>
            <div className="balance-meta">{b.used} used - {b.pendingDays} pending - {b.dept}</div>
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
          {list.map((l) => (
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
                </div>
                <div className="leave-meta">
                  {daysBetween(l.start, l.end)} days · {formatDate(l.start)} – {formatDate(l.end)} · {l.dept}
                </div>
                {l.reason && <div className="leave-reason">“{l.reason}”</div>}
                <span className={`leave-tag ${leaveTagClass(l.type)}`}>{leaveTagLabel(l.type)}</span>
                {l.status === 'pending' && (() => {
                  const stages = l.approvalStages?.length ? l.approvalStages : DEFAULT_STAGES;
                  const stage = l.currentStage || 0;
                  const requiredRole = stages[stage] || stages[stages.length - 1];
                  const canAct = currentUser.role === 'HR Director' || currentUser.role === requiredRole;
                  return (
                    <>
                      <div className="leave-meta" style={{ marginTop: 2 }}>
                        Stage {stage + 1} of {stages.length} — awaiting <strong>{requiredRole}</strong>
                      </div>
                      <div className="leave-actions">
                        {canAct ? (
                          <>
                            <button className="mini-btn approve" onClick={() => approveLeave(l.id)}>Approve</button>
                            <button className="mini-btn" onClick={() => declineLeave(l.id)}>Decline</button>
                          </>
                        ) : (
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
          ))}
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
