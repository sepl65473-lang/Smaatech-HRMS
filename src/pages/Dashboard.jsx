import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import { IconCheck } from '../components/Icons';
import { formatDate, leaveTagClass, leaveTagLabel, daysBetween } from '../lib/helpers';

const SPARKS = {
  workforce: { color: '#5C7A52', pts: '0,28 15,24 30,26 45,18 60,20 75,12 90,10' },
  present:   { color: '#B8541F', pts: '0,18 15,20 30,14 45,22 60,16 75,18 90,12' },
  leave:     { color: '#C49B2A', pts: '0,20 15,16 30,22 45,18 60,14 75,16 90,18' },
  open:      { color: '#A33A2C', pts: '0,30 15,28 30,22 45,24 60,18 75,14 90,8' },
};

function Stat({ label, value, sub, spark }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-meta">{sub}</div>
      <svg className="spark" viewBox="0 0 90 38" preserveAspectRatio="none">
        <polyline fill="none" stroke={spark.color} strokeWidth="1.5" points={spark.pts} />
      </svg>
    </div>
  );
}

export default function Dashboard() {
  const {
    employees, attendance, pendingLeaves, recruitment, celebrations,
    approveLeave, declineLeave, sendWish,
  } = useHRMS();
  const navigate = useNavigate();
  const [chartRange, setChartRange] = useState('Month');

  const present = attendance.filter((a) => a.status === 'present' || a.status === 'late').length;
  const onLeave = employees.filter((e) => e.status === 'on-leave').length
    || attendance.filter((a) => a.status === 'leave').length;
  const openRoles = useMemo(
    () => new Set(recruitment.filter((r) => r.stage !== 'Hired').map((r) => r.title)).size,
    [recruitment],
  );
  const rate = employees.length ? ((present / employees.length) * 100).toFixed(1) : '0';

  const topPending = pendingLeaves.slice(0, 3);
  const topCelebs = celebrations.slice(0, 4);

  return (
    <div className="page-wrap active">
      {/* STATS */}
      <div className="stats">
        <Stat label="Total Workforce" value={employees.length}
          sub={<><span className="delta-up">↑ 12</span> from last month</>} spark={SPARKS.workforce} />
        <Stat label="Present Today"
          value={<>{present} <span style={{ fontSize: 16, color: 'var(--muted)' }}>/{employees.length}</span></>}
          sub={`${rate}% attendance rate`} spark={SPARKS.present} />
        <Stat label="On Leave" value={onLeave}
          sub={`${pendingLeaves.length} requests pending`} spark={SPARKS.leave} />
        <Stat label="Open Positions" value={openRoles}
          sub={`${recruitment.length} candidates in pipeline`} spark={SPARKS.open} />
      </div>

      {/* CHART + LEAVE */}
      <div className="grid">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Attendance overview</div>
              <div className="card-sub">{chartRange} breakdown across departments</div>
            </div>
            <div className="tab-row">
              {['Week', 'Month', 'Quarter'].map((range) => (
                <button
                  key={range}
                  className={`tab ${chartRange === range ? 'active' : ''}`}
                  onClick={() => setChartRange(range)}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>
          <AttendanceChart attendance={attendance} range={chartRange} />
          <div className="legend">
            <div><span className="legend-dot" style={{ background: '#5C7A52' }} />Present</div>
            <div><span className="legend-dot" style={{ background: '#C49B2A' }} />Late arrival</div>
            <div><span className="legend-dot" style={{ background: '#A33A2C' }} />Absent / leave</div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Leave requests</div>
              <div className="card-sub">{pendingLeaves.length} awaiting approval</div>
            </div>
            <button className="btn btn-ghost" onClick={() => navigate('/leave')}>View all</button>
          </div>
          <div className="leave-list">
            {topPending.length === 0 && <div className="empty">No pending requests 🎉</div>}
            {topPending.map((l) => (
              <div className="leave-item" key={l.id}>
                <Avatar name={l.name} size={42} className="leave-avatar" />
                <div className="leave-body">
                  <div className="leave-name">{l.name}</div>
                  <div className="leave-meta">
                    {daysBetween(l.start, l.end)} days · {formatDate(l.start)} – {formatDate(l.end)} · {l.dept}
                  </div>
                  <span className={`leave-tag ${leaveTagClass(l.type)}`}>{leaveTagLabel(l.type)}</span>
                  <div className="leave-actions">
                    <button className="mini-btn approve" onClick={() => approveLeave(l.id)}>Approve</button>
                    <button className="mini-btn" onClick={() => declineLeave(l.id)}>Decline</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* BIRTHDAYS */}
      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Upcoming celebrations</div>
              <div className="card-sub">Birthdays & work anniversaries</div>
            </div>
            <button className="btn btn-ghost" onClick={() => navigate('/celebrations')}>See all</button>
          </div>
          <div>
            {topCelebs.map((c) => (
              <div className="birthday-item" key={c.id}>
                <div className="cake-icon">{c.type === 'birthday' ? '🎂' : '✦'}</div>
                <div className="b-body">
                  <div className="b-name">{c.name}</div>
                  <div className="b-date">{c.detail}</div>
                </div>
                <button
                  className={`wish-btn ${c.wished ? 'wished' : ''}`}
                  onClick={() => !c.wished && sendWish(c.id)}
                >
                  {c.wished ? <><IconCheck width="11" height="11" /> Wished</> : 'Wish →'}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Quick actions</div>
              <div className="card-sub">Jump straight in</div>
            </div>
          </div>
          <div className="quick-actions">
            <button className="quick-action" onClick={() => navigate('/employees')}>
              <span>👥</span> Manage people
            </button>
            <button className="quick-action" onClick={() => navigate('/leave')}>
              <span>🌴</span> Review leave
            </button>
            <button className="quick-action" onClick={() => navigate('/payroll')}>
              <span>💸</span> Run payroll
            </button>
            <button className="quick-action" onClick={() => navigate('/attendance')}>
              <span>🕘</span> Attendance
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const RANGE_FACTOR = { Week: 5, Month: 22, Quarter: 66 };
const RANGE_DRIFT = { Week: 0, Month: 1, Quarter: 2 };

function AttendanceChart({ attendance, range }) {
  const rows = Object.values(attendance.reduce((acc, item) => {
    if (!acc[item.dept]) acc[item.dept] = { dept: item.dept, present: 0, late: 0, absent: 0 };
    if (item.status === 'present') acc[item.dept].present += 1;
    else if (item.status === 'late') acc[item.dept].late += 1;
    else acc[item.dept].absent += 1;
    return acc;
  }, {})).map((row, index) => {
    const factor = RANGE_FACTOR[range] || 1;
    const drift = RANGE_DRIFT[range] || 0;
    return {
      ...row,
      present: row.present * factor + Math.max(0, index - 1) * drift,
      late: row.late * factor + (index % 2) * drift,
      absent: row.absent * factor + (index % 3 === 0 ? drift : 0),
    };
  });
  const maxTotal = Math.max(1, ...rows.map((r) => r.present + r.late + r.absent));
  const base = 190;
  const scale = 135 / maxTotal;
  const bars = rows.map((row) => {
    const absentH = row.absent * scale;
    const lateH = row.late * scale;
    const presentH = row.present * scale;
    const absentY = base - absentH;
    const lateY = absentY - lateH;
    const presentY = lateY - presentH;
    return { ...row, presentY, presentH, lateY, lateH, absentY, absentH };
  });
  const x0 = 58, step = rows.length > 1 ? Math.min(84, 500 / rows.length) : 84, w = Math.min(42, Math.max(24, step - 18));
  return (
    <div className="chart">
      <svg viewBox="0 0 600 240" preserveAspectRatio="none">
        <g stroke="#D8CFB8" strokeDasharray="2 4" strokeWidth="0.5">
          {[40, 90, 140, 190].map((y) => <line key={y} x1="40" y1={y} x2="600" y2={y} />)}
        </g>
        <g fontFamily="JetBrains Mono" fontSize="9" fill="#6B6457">
          {[[44, maxTotal], [94, Math.ceil(maxTotal * 0.66)], [144, Math.ceil(maxTotal * 0.33)], [194, 0]].map(([y, v]) => (
            <text key={y} x="30" y={y} textAnchor="end">{v}</text>
          ))}
        </g>
        <g>
          {bars.map((bar, i) => {
            const x = x0 + i * step;
            return (
              <g key={bar.dept}>
                <rect x={x} y={bar.presentY} width={w} height={bar.presentH} fill="#5C7A52" rx="2" />
                <rect x={x} y={bar.lateY} width={w} height={bar.lateH} fill="#C49B2A" />
                <rect x={x} y={bar.absentY} width={w} height={bar.absentH} fill="#A33A2C" />
              </g>
            );
          })}
        </g>
        <g fontFamily="JetBrains Mono" fontSize="9" fill="#6B6457" textAnchor="middle">
          {bars.map((bar, i) => (
            <text key={bar.dept} x={x0 + i * step + w / 2} y="215">
              {bar.dept.split(' ')[0].slice(0, 6)}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
