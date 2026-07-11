import { useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icons';

const STATUS_LABEL = {
  pending: 'Awaiting self-review',
  'self-submitted': 'Self-review done',
  completed: 'Completed',
};

function ReviewModal({ open, review, onClose, onSubmitManager, onAddGoal, onToggleGoal }) {
  const [rating, setRating] = useState(3);
  const [comments, setComments] = useState('');
  const [goalText, setGoalText] = useState('');

  useEffect(() => {
    if (review) {
      setRating(review.managerRating ?? review.selfRating ?? 3);
      setComments(review.managerComments || '');
      setGoalText('');
    }
  }, [review?.id]);

  if (!review) return null;

  const submit = () => {
    onSubmitManager(review.id, { managerRating: Number(rating), managerComments: comments });
  };

  return (
    <Modal
      open={open}
      title="Manager review"
      subtitle={`${review.name} · ${review.cycleName}`}
      onClose={onClose}
      width={480}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn" onClick={submit}>Submit manager review</button>
        </>
      )}
    >
      <div className="form-grid">
        <div className="field field-full">
          <span className="field-label">Self rating</span>
          <div>{review.selfRating != null ? `${review.selfRating} / 5` : 'Not submitted yet'}</div>
        </div>
        {review.selfComments && (
          <div className="field field-full">
            <span className="field-label">Self comments</span>
            <div className="leave-reason">"{review.selfComments}"</div>
          </div>
        )}
        <label className="field field-full">
          <span className="field-label">Manager rating</span>
          <input type="number" min="0" max="5" step="0.1" className="input" value={rating} onChange={(e) => setRating(e.target.value)} />
        </label>
        <label className="field field-full">
          <span className="field-label">Manager comments</span>
          <textarea className="input" rows={3} value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Feedback for this cycle…" />
        </label>
        <div className="field field-full">
          <span className="field-label">Goals / KPIs</span>
          <div className="settings-rows">
            {(review.goals || []).length === 0 && <div className="empty">No goals added yet.</div>}
            {(review.goals || []).map((g) => (
              <button
                key={g.id}
                className="settings-row"
                style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer' }}
                onClick={() => onToggleGoal(review.id, g.id)}
              >
                <div className="settings-row-label" style={{ textDecoration: g.done ? 'line-through' : 'none', opacity: g.done ? 0.6 : 1 }}>{g.text}</div>
                <span className={`toggle ${g.done ? 'on' : ''}`} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input className="input" value={goalText} onChange={(e) => setGoalText(e.target.value)} placeholder="Add a goal…" />
            <button
              className="btn btn-ghost"
              onClick={() => { if (goalText.trim()) { onAddGoal(review.id, goalText.trim()); setGoalText(''); } }}
            >
              <IconPlus width="14" height="14" /> Add
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function Performance() {
  const {
    employees, updateEmployee, reviews,
    startReviewCycle, submitManagerReview, addGoal, toggleGoal,
  } = useHRMS();
  const [cycleName, setCycleName] = useState('');
  const [activeCycle, setActiveCycle] = useState('');
  const [reviewingId, setReviewingId] = useState(null);

  const cycles = useMemo(() => [...new Set(reviews.map((r) => r.cycleName))], [reviews]);
  const currentCycle = activeCycle || cycles[cycles.length - 1] || '';
  const cycleReviews = useMemo(
    () => reviews.filter((r) => r.cycleName === currentCycle),
    [reviews, currentCycle],
  );
  const reviewing = reviews.find((r) => r.id === reviewingId);

  const launchCycle = async () => {
    const name = cycleName.trim() || `Cycle ${new Date().toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`;
    await startReviewCycle(name);
    setActiveCycle(name);
    setCycleName('');
  };

  const ranked = useMemo(
    () => [...employees].sort((a, b) => b.rating - a.rating),
    [employees],
  );

  const avg = employees.length
    ? (employees.reduce((s, e) => s + e.rating, 0) / employees.length).toFixed(2)
    : '0';

  const adjust = (e, delta) => {
    const r = Math.min(5, Math.max(0, Math.round((e.rating + delta) * 10) / 10));
    updateEmployee(e.id, { rating: r });
  };

  return (
    <div className="page-wrap active">
      <div className="stats">
        <div className="stat"><div className="stat-label">Avg. rating</div><div className="stat-value">{avg}</div><div className="stat-meta">across {employees.length} people</div></div>
        <div className="stat"><div className="stat-label">Top rated</div><div className="stat-value">{ranked[0]?.rating ?? '—'}</div><div className="stat-meta">{ranked[0]?.name ?? ''}</div></div>
        <div className="stat"><div className="stat-label">4.5+ performers</div><div className="stat-value">{employees.filter((e) => e.rating >= 4.5).length}</div><div className="stat-meta">high achievers</div></div>
        <div className="stat"><div className="stat-label">Reviews due</div><div className="stat-value">{employees.filter((e) => e.rating < 4).length}</div><div className="stat-meta">below 4.0</div></div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Review cycles</div>
            <div className="card-sub">{cycleReviews.length ? `${cycleReviews.filter((r) => r.status === 'completed').length}/${cycleReviews.length} completed` : 'No cycle started yet'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {cycles.length > 0 && (
              <select className="input" value={currentCycle} onChange={(e) => setActiveCycle(e.target.value)}>
                {cycles.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            <input className="input" value={cycleName} onChange={(e) => setCycleName(e.target.value)} placeholder="e.g. H1 2026" style={{ width: 140 }} />
            <button className="btn" onClick={launchCycle}><IconPlus width="14" height="14" /> Start cycle</button>
          </div>
        </div>

        {cycleReviews.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Employee</th><th>Self-review</th><th>Manager rating</th><th>Status</th><th style={{ textAlign: 'right' }}>Action</th></tr>
              </thead>
              <tbody>
                {cycleReviews.map((r) => (
                  <tr key={r.id}>
                    <td><div className="emp-cell"><Avatar name={r.name} size={28} /><span>{r.name}</span></div></td>
                    <td>{r.selfRating != null ? `${r.selfRating} / 5` : '—'}</td>
                    <td>{r.managerRating != null ? `${r.managerRating} / 5` : '—'}</td>
                    <td><span className={`state-badge ${r.status === 'completed' ? 'approved' : 'pending'}`}>{STATUS_LABEL[r.status]}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="mini-btn" onClick={() => setReviewingId(r.id)}>Review</button>
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
          <div><div className="card-title">Performance leaderboard</div><div className="card-sub">Adjust ratings inline · saved instantly</div></div>
        </div>
        <div>
          {ranked.map((e, i) => (
            <div className="birthday-item" key={e.id}>
              <div className="cake-icon" style={{
                background: i === 0 ? 'var(--gold)' : 'var(--bg-2)',
                border: 'none', color: i === 0 ? 'white' : 'var(--ink)', fontWeight: 600,
              }}>{i + 1}</div>
              <Avatar name={e.name} size={34} />
              <div className="b-body" style={{ flex: 1 }}>
                <div className="b-name">{e.name}</div>
                <div className="b-date">{e.dept} · {e.role}</div>
                <div className="rating-bar" style={{ marginTop: 5 }}>
                  <div className="rating-fill" style={{ width: `${(e.rating / 5) * 100}%` }} />
                </div>
              </div>
              <div className="rating-control">
                <button className="mini-btn" onClick={() => adjust(e, -0.1)}>–</button>
                <span className="mono" style={{ fontWeight: 600, minWidth: 28, textAlign: 'center' }}>{e.rating.toFixed(1)}</span>
                <button className="mini-btn approve" onClick={() => adjust(e, +0.1)}>+</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <ReviewModal
        open={Boolean(reviewing)}
        review={reviewing}
        onClose={() => setReviewingId(null)}
        onSubmitManager={async (id, data) => { await submitManagerReview(id, data); setReviewingId(null); }}
        onAddGoal={addGoal}
        onToggleGoal={toggleGoal}
      />
    </div>
  );
}
