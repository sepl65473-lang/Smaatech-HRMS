import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { lifecycleApi } from '../data/store';
import { useHRMS } from '../context/HRMSContext';

/**
 * Who is due for a confirmation decision.
 *
 * This is the point of tracking probation at all: without a queue, confirmation
 * happens when somebody remembers, and people sit past their date on probation
 * terms — shorter notice, and in many companies no access to the full benefit
 * set — without anyone intending it.
 *
 * Renders nothing when the queue is empty, so it never becomes furniture the
 * page has learned to ignore.
 */
export default function ProbationDueCard() {
  const { canDo } = useHRMS();
  const navigate = useNavigate();
  const [state, setState] = useState({ due: [], loading: true, error: '' });

  useEffect(() => {
    if (!canDo('manageEmployees')) {
      setState({ due: [], loading: false, error: '' });
      return undefined;
    }
    let cancelled = false;
    lifecycleApi.probationDue(30)
      .then((data) => { if (!cancelled) setState({ due: data.due || [], loading: false, error: '' }); })
      .catch((err) => {
        if (!cancelled) setState({ due: [], loading: false, error: err.message || 'Could not load the confirmation queue.' });
      });
    return () => { cancelled = true; };
  }, [canDo]);

  if (state.loading || state.error) return null;
  if (!state.due.length) return null;

  const overdue = state.due.filter((d) => d.overdue).length;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Confirmation due</div>
          <div className="card-sub">
            {state.due.length} employee{state.due.length === 1 ? '' : 's'} reach the end of probation within 30 days
            {overdue > 0 && ` · ${overdue} already past the date`}
          </div>
        </div>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Employee</th><th>Department</th><th>Joined</th><th>Probation ends</th><th style={{ textAlign: 'right' }} /></tr>
          </thead>
          <tbody>
            {state.due.map((person) => (
              <tr key={person.id}>
                <td><strong>{person.name}</strong><div className="muted-text" style={{ fontSize: 11 }}>{person.role}</div></td>
                <td>{person.dept}</td>
                <td className="mono">{person.joinDate || '—'}</td>
                <td className="mono">
                  {person.probationEndDate}
                  {person.overdue && <span className="state-badge declined" style={{ marginLeft: 6 }}>overdue</span>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="mini-btn approve" onClick={() => navigate(`/employees/${person.id}`)}>
                    Review
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
