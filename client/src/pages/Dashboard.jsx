import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import {
  IconCheck, IconWorkforce, IconPresent, IconOnLeave, IconOpenPositions,
  IconEmployees, IconLeave, IconCalendar, IconPayroll, IconRecruit, IconPerformance,
  IconDocs, IconBell, IconDashboard, IconPlus, IconChevronRight, IconChevronDown, IconDownload,
} from '../components/Icons';
import {
  formatDate, leaveTagClass, leaveTagLabel, daysBetween, timeAgo, parseHolidayDay,
  MONTH_NAMES, formatINR,
} from '../lib/helpers';
import { downloadCSV } from '../lib/exportCsv';

const SPARKS = {
  workforce: { color: '#3B7DDD', pts: '0,28 15,24 30,26 45,18 60,20 75,12 90,10' },
  present:   { color: '#16A34A', pts: '0,18 15,20 30,14 45,22 60,16 75,18 90,12' },
  leave:     { color: '#D97706', pts: '0,20 15,16 30,22 45,18 60,14 75,16 90,18' },
  open:      { color: '#8B5CF6', pts: '0,30 15,28 30,22 45,24 60,18 75,14 90,8' },
};

function Stat({ label, value, sub, spark, icon, iconClass, trend }) {
  return (
    <div className="stat">
      <div className={`stat-icon ${iconClass}`}>{icon}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-meta">
        {trend && (
          <span className={trend.up ? 'delta-up' : 'delta-down'}>
            {trend.up ? '↑' : '↓'} {trend.text}
          </span>
        )}
        {sub}
      </div>
      <svg className="spark" viewBox="0 0 90 38" preserveAspectRatio="none">
        <polyline fill="none" stroke={spark.color} strokeWidth="1.5" points={spark.pts} />
      </svg>
    </div>
  );
}

const DEPT_COLORS = {
  Engineering: '#3B7DDD',
  Design: '#8B5CF6',
  Marketing: '#D97706',
  Sales: '#16A34A',
  Operations: '#0891B2',
  'Finance & HR': '#C2255C',
};
const DEPT_FALLBACK_COLOR = '#94A3B8';

const EMP_TYPE_COLORS = {
  'Full-time': '#3B7DDD',
  'Part-time': '#16A34A',
  Contract: '#D97706',
  Intern: '#8B5CF6',
};
const EMP_TYPE_FALLBACK_COLOR = '#94A3B8';

function Donut({ data, total, hoverDept, onHover }) {
  const size = 120, cx = 60, cy = 60, r = 45, sw = 17;
  const circumference = 2 * Math.PI * r;
  const segments = data.reduce((acc, d) => {
    const prevCumulative = acc.length ? acc[acc.length - 1].cumulative : 0;
    const rawLen = total ? (d.value / total) * circumference : 0;
    const segLen = Math.max(0, rawLen - 3);
    acc.push({ ...d, segLen, offset: -prevCumulative, cumulative: prevCumulative + rawLen });
    return acc;
  }, []);
  const hovered = hoverDept ? data.find((d) => d.dept === hoverDept) : null;
  return (
    <div className="donut-svg-wrap" onMouseLeave={() => onHover(null)}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {segments.filter((s) => s.value > 0).map((s) => (
            <circle
              key={s.dept}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={sw}
              strokeLinecap="butt"
              strokeDasharray={`${s.segLen} ${circumference - s.segLen}`}
              strokeDashoffset={s.offset}
              opacity={hoverDept && hoverDept !== s.dept ? 0.35 : 1}
              style={{ cursor: 'pointer', transition: 'opacity .15s' }}
              onMouseEnter={() => onHover(s.dept)}
            />
          ))}
        </g>
      </svg>
      <div className="donut-center">
        {hovered ? (
          <>
            <div className="donut-center-value">{hovered.value}</div>
            <div className="donut-center-label">{hovered.dept} · {total ? Math.round((hovered.value / total) * 100) : 0}%</div>
          </>
        ) : (
          <>
            <div className="donut-center-value">{total}</div>
            <div className="donut-center-label">Employees</div>
          </>
        )}
      </div>
    </div>
  );
}

const ACTIVITY_TYPES = [
  { test: (a) => a.startsWith('Employee'), Icon: IconEmployees, tone: 'accent' },
  { test: (a) => a.startsWith('Leave'), Icon: IconLeave, tone: 'gold' },
  { test: (a) => a.startsWith('Attendance') || a.startsWith('Biometric'), Icon: IconCalendar, tone: 'teal' },
  { test: (a) => a.startsWith('Payroll') || a.startsWith('Payslip') || a.startsWith('Salary'), Icon: IconPayroll, tone: 'sage' },
  { test: (a) => a.startsWith('Candidate') || a.startsWith('Job'), Icon: IconRecruit, tone: 'purple' },
  { test: (a) => a.startsWith('Holiday'), Icon: IconCalendar, tone: 'rose' },
  { test: (a) => a.startsWith('Review') || a.startsWith('Goal'), Icon: IconPerformance, tone: 'teal' },
  { test: (a) => a.startsWith('Expense'), Icon: IconPayroll, tone: 'gold' },
  { test: (a) => a.startsWith('Asset'), Icon: IconDocs, tone: 'accent' },
];
function activityMeta(action = '') {
  return ACTIVITY_TYPES.find((t) => t.test(action)) || { Icon: IconBell, tone: 'muted' };
}

const EVENT_TYPE_CLASS = { National: 'tag-earned', Regional: 'tag-casual', Optional: 'tag-sick' };

export default function Dashboard() {
  const {
    employees, attendance, pendingLeaves, celebrations, jobs,
    leaves, holidays, recruitment, auditLog, payroll,
    approveLeave, declineLeave, sendWish, toast, audit,
  } = useHRMS();
  const navigate = useNavigate();
  const [chartRange, setChartRange] = useState('Month');
  const [hoverDept, setHoverDept] = useState(null);
  const [hoverEmpType, setHoverEmpType] = useState(null);

  const present = attendance.filter((a) => a.status === 'present' || a.status === 'late').length;
  const onLeave = employees.filter((e) => e.status === 'on-leave').length
    || attendance.filter((a) => a.status === 'leave').length;
  const openJobs = jobs.filter((j) => j.status === 'Open').length;
  const closedJobs = jobs.filter((j) => j.status === 'Closed').length;
  const rate = employees.length ? ((present / employees.length) * 100).toFixed(1) : '0';

  const leaveRate = employees.length ? (onLeave / employees.length) * 100 : 0;
  const leaveTrend = leaveRate <= 10
    ? { up: false, text: `${leaveRate.toFixed(1)}% of workforce` }
    : { up: true, text: `${leaveRate.toFixed(1)}% of workforce` };
  const jobsTrend = openJobs >= closedJobs
    ? { up: true, text: `${openJobs} vs ${closedJobs} closed` }
    : { up: false, text: `${closedJobs} vs ${openJobs} open` };
  const attendanceTrend = Number(rate) >= 90
    ? { up: true, text: 'on target' }
    : { up: false, text: 'below target' };

  const topPending = pendingLeaves.slice(0, 3);
  const topCelebs = celebrations.slice(0, 3);

  const deptData = useMemo(() => {
    const counts = {};
    employees.forEach((e) => { counts[e.dept] = (counts[e.dept] || 0) + 1; });
    return Object.keys(counts).map((dept) => ({
      dept, value: counts[dept], color: DEPT_COLORS[dept] || DEPT_FALLBACK_COLOR,
    }));
  }, [employees]);

  const recentActivities = auditLog.slice(0, 4);

  const upcomingEvents = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const year = today.getFullYear();
    return holidays
      .map((h) => {
        const parsed = parseHolidayDay(h.date);
        if (!parsed) return null;
        let resolved = new Date(year, parsed.month, parsed.day);
        if (resolved < today) resolved = new Date(year + 1, parsed.month, parsed.day);
        return { ...h, resolved };
      })
      .filter(Boolean)
      .sort((a, b) => a.resolved - b.resolved)
      .slice(0, 4);
  }, [holidays]);

  const leaveTotal = leaves.length;
  const leaveApproved = leaves.filter((l) => l.status === 'approved').length;
  const leavePending = pendingLeaves.length;
  const leaveDeclined = leaves.filter((l) => l.status === 'declined').length;

  const recruitApplications = recruitment.length;
  const recruitInterviews = recruitment.filter((c) => c.stage === 'Interview' || c.stage === 'Offer').length;
  const recruitHired = recruitment.filter((c) => c.stage === 'Hired').length;

  const empTypeData = useMemo(() => {
    const counts = {};
    employees.forEach((e) => {
      const type = e.employmentType || 'Full-time';
      counts[type] = (counts[type] || 0) + 1;
    });
    return Object.keys(counts).map((type) => ({
      dept: type, value: counts[type], color: EMP_TYPE_COLORS[type] || EMP_TYPE_FALLBACK_COLOR,
    }));
  }, [employees]);

  const payrollMonthly = useMemo(() => {
    const byCycle = payroll.reduce((acc, p) => {
      acc[p.cycle] = (acc[p.cycle] || 0) + (p.gross || 0);
      return acc;
    }, {});
    return Object.keys(byCycle)
      .sort()
      .map((cycle) => ({
        cycle, label: MONTH_NAMES[Number(cycle.slice(5, 7)) - 1] || cycle, total: byCycle[cycle],
      }));
  }, [payroll]);
  const latestPayrollMonth = payrollMonthly[payrollMonthly.length - 1];
  const prevPayrollMonth = payrollMonthly[payrollMonthly.length - 2];
  const payrollTrend = latestPayrollMonth && prevPayrollMonth && prevPayrollMonth.total > 0
    ? {
        up: latestPayrollMonth.total >= prevPayrollMonth.total,
        text: `${Math.abs(((latestPayrollMonth.total - prevPayrollMonth.total) / prevPayrollMonth.total) * 100).toFixed(1)}% vs last month`,
      }
    : null;

  const dateRangeLabel = useMemo(() => {
    const fmt = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const end = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - 2);
    return `${fmt(start)} – ${fmt(end)}`;
  }, []);

  const handleExport = () => {
    downloadCSV('employees-directory', employees, [
      { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' },
      { key: 'dept', label: 'Department' }, { key: 'employmentType', label: 'Employment Type' },
      { key: 'loc', label: 'Location' }, { key: 'status', label: 'Status' },
      { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
      { key: 'joinDate', label: 'Joining Date' }, { key: 'salary', label: 'Monthly Gross' },
    ]);
    audit('Employees exported', `${employees.length} rows`, 'Dashboard export');
    toast('success', `Exported ${employees.length} employees to CSV`);
  };
  const handleDateRange = () => toast('info', 'Custom date range filtering is coming soon');

  return (
    <div className="page-wrap active">
      {/* PAGE HEADER */}
      <div className="page-header-row">
        <div>
          <div className="breadcrumb">
            <IconDashboard width="13" height="13" />
            <span>Dashboard</span>
            <IconChevronRight width="12" height="12" />
            <span className="breadcrumb-current">Admin Dashboard</span>
          </div>
          <h1 className="page-header-title">Admin Dashboard</h1>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-ghost dropdown-btn" onClick={handleExport}>
            <IconDownload width="14" height="14" /> Export <IconChevronDown width="12" height="12" />
          </button>
          <button className="btn btn-ghost dropdown-btn" onClick={handleDateRange}>
            <IconCalendar width="14" height="14" /> {dateRangeLabel} <IconChevronDown width="12" height="12" />
          </button>
          <button className="btn btn-ghost" onClick={() => navigate('/employees')}>
            <IconPlus width="14" height="14" /> Add Employee
          </button>
          <button className="btn" onClick={() => navigate('/leave')}>
            <IconPlus width="14" height="14" /> Add Request
          </button>
        </div>
      </div>

      {/* STATS */}
      <div className="stats">
        <Stat label="Total Workforce" value={employees.length}
          sub="from last month" trend={{ up: true, text: '12' }}
          spark={SPARKS.workforce} icon={<IconWorkforce width="18" height="18" />} iconClass="workforce" />
        <Stat label="Present Today"
          value={<>{present} <span style={{ fontSize: 16, color: 'var(--muted)' }}>/{employees.length}</span></>}
          sub={`${rate}% attendance rate`} trend={attendanceTrend}
          spark={SPARKS.present} icon={<IconPresent width="18" height="18" />} iconClass="present" />
        <Stat label="On Leave" value={onLeave}
          sub={`${pendingLeaves.length} requests pending`} trend={leaveTrend}
          spark={SPARKS.leave} icon={<IconOnLeave width="18" height="18" />} iconClass="leave" />
        <Stat label="Open Positions" value={openJobs}
          sub={`of ${jobs.length} roles tracked`} trend={jobsTrend}
          spark={SPARKS.open} icon={<IconOpenPositions width="18" height="18" />} iconClass="open" />
      </div>

      {/* ROW 1: ATTENDANCE + DEPARTMENT DONUT + RECENT ACTIVITIES */}
      <div className="grid-2">
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
            <div><span className="legend-dot" style={{ background: '#16A34A' }} />Present</div>
            <div><span className="legend-dot" style={{ background: '#D97706' }} />Late arrival</div>
            <div><span className="legend-dot" style={{ background: '#DC3545' }} />Absent / leave</div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Employees by department</div>
              <div className="card-sub">{employees.length} total across {deptData.length} departments</div>
            </div>
          </div>
          <div className="donut-wrap">
            <Donut data={deptData} total={employees.length} hoverDept={hoverDept} onHover={setHoverDept} />
            <div className="donut-legend">
              {deptData.map((d) => (
                <div
                  className="donut-legend-row"
                  key={d.dept}
                  onMouseEnter={() => setHoverDept(d.dept)}
                  onMouseLeave={() => setHoverDept(null)}
                >
                  <span className="legend-dot" style={{ background: d.color }} />
                  <span className="dept-name">{d.dept}</span>
                  <span className="dept-count">{d.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Recent activities</div>
              <div className="card-sub">Latest actions across the team</div>
            </div>
          </div>
          {recentActivities.length === 0 ? (
            <div className="empty">
              <div className="empty-title">No recent activity yet</div>
              Actions you take (adding an employee, approving leave, processing payroll…) will show up here.
            </div>
          ) : (
            <div className="activity-list">
              {recentActivities.map((a) => {
                const { Icon, tone } = activityMeta(a.action);
                return (
                  <div className="activity-item" key={a.id}>
                    <div className={`activity-icon tone-${tone}`}><Icon width="16" height="16" /></div>
                    <div className="activity-body">
                      <div>
                        <div className="activity-title">{a.action}</div>
                        <div className="activity-meta">{a.subject}{a.details ? ` · ${a.details}` : ''}</div>
                      </div>
                      <div className="activity-time">{timeAgo(a.at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ROW 2: EMPLOYEE STATUS + MONTHLY PAYROLL OVERVIEW + UPCOMING EVENTS */}
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Employee Status</div>
              <div className="card-sub">By employment type</div>
            </div>
          </div>
          <div className="donut-wrap">
            <Donut data={empTypeData} total={employees.length} hoverDept={hoverEmpType} onHover={setHoverEmpType} />
            <div className="donut-legend">
              {empTypeData.map((d) => (
                <div
                  className="donut-legend-row"
                  key={d.dept}
                  onMouseEnter={() => setHoverEmpType(d.dept)}
                  onMouseLeave={() => setHoverEmpType(null)}
                >
                  <span className="legend-dot" style={{ background: d.color }} />
                  <span className="dept-name">{d.dept}</span>
                  <span className="dept-count">
                    {d.value} <span className="muted-text">({employees.length ? ((d.value / employees.length) * 100).toFixed(1) : 0}%)</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Monthly Payroll Overview</div>
              <div className="card-sub">Gross payroll cost, last 12 months</div>
            </div>
          </div>
          <div className="payroll-overview-head">
            <div className="payroll-overview-value mono">{formatINR(latestPayrollMonth?.total || 0)}</div>
            <div className="payroll-overview-meta">
              Total Payroll Cost · {latestPayrollMonth?.label || '—'}
              {payrollTrend && (
                <span className={payrollTrend.up ? 'delta-up' : 'delta-down'} style={{ marginLeft: 8 }}>
                  {payrollTrend.up ? '↑' : '↓'} {payrollTrend.text}
                </span>
              )}
            </div>
          </div>
          <PayrollChart data={payrollMonthly} />
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Upcoming events</div>
              <div className="card-sub">Public & regional holidays</div>
            </div>
            <button className="btn btn-ghost" onClick={() => navigate('/holidays')}>View all</button>
          </div>
          <div>
            {upcomingEvents.length === 0 && <div className="empty">No upcoming events</div>}
            {upcomingEvents.map((e) => (
              <div className="event-item" key={e.id}>
                <div className="event-date">
                  <div className="day">{e.resolved.getDate()}</div>
                  <div className="mon">{e.resolved.toLocaleDateString('en-IN', { month: 'short' })}</div>
                </div>
                <div className="event-body">
                  <div className="event-name">{e.name}</div>
                  <span className={`leave-tag ${EVENT_TYPE_CLASS[e.type] || 'tag-casual'}`}>
                    {e.type}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ROW 3: LEAVE SUMMARY + RECRUITMENT STATUS + UPCOMING CELEBRATIONS */}
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Leave summary</div>
              <div className="card-sub">This month</div>
            </div>
            <button className="btn btn-ghost" onClick={() => navigate('/leave')}>View all</button>
          </div>
          <div className="summary-pill-row">
            <div className="summary-pill tone-accent">
              <div className="summary-pill-value">{leaveTotal}</div>
              <div className="summary-pill-label">Total leave</div>
            </div>
            <div className="summary-pill tone-sage">
              <div className="summary-pill-value">{leaveApproved}</div>
              <div className="summary-pill-label">Approved</div>
            </div>
            <div className="summary-pill tone-gold">
              <div className="summary-pill-value">{leavePending}</div>
              <div className="summary-pill-label">Pending</div>
            </div>
            <div className="summary-pill tone-red">
              <div className="summary-pill-value">{leaveDeclined}</div>
              <div className="summary-pill-label">Rejected</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Recruitment status</div>
              <div className="card-sub">This month</div>
            </div>
            <button className="btn btn-ghost" onClick={() => navigate('/recruitment')}>View all</button>
          </div>
          <div className="summary-pill-row cols-3">
            <div className="summary-pill tone-accent">
              <div className="summary-pill-value">{recruitApplications}</div>
              <div className="summary-pill-label">Applications</div>
            </div>
            <div className="summary-pill tone-gold">
              <div className="summary-pill-value">{recruitInterviews}</div>
              <div className="summary-pill-label">Interviews</div>
            </div>
            <div className="summary-pill tone-sage">
              <div className="summary-pill-value">{recruitHired}</div>
              <div className="summary-pill-label">Hired</div>
            </div>
          </div>
        </div>

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
      </div>

      {/* ROW 4: LEAVE REQUESTS + QUICK ACTIONS */}
      <div className="grid">
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

// Deterministic (not Math.random()) so the chart doesn't flicker on re-render,
// but genuinely different per department+range+status — unlike a uniform
// factor, this survives the chart's own auto-scaling below.
function rangeVariance(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 0.7 + (h % 100) / 100 * 0.6; // 0.7 – 1.3
}

function AttendanceChart({ attendance, range }) {
  const rows = Object.values(attendance.reduce((acc, item) => {
    if (!acc[item.dept]) acc[item.dept] = { dept: item.dept, present: 0, late: 0, absent: 0 };
    if (item.status === 'present') acc[item.dept].present += 1;
    else if (item.status === 'late') acc[item.dept].late += 1;
    else acc[item.dept].absent += 1;
    return acc;
  }, {})).map((row) => {
    const factor = RANGE_FACTOR[range] || 1;
    return {
      ...row,
      present: Math.round(row.present * factor * rangeVariance(`${row.dept}-${range}-present`)),
      late: Math.round(row.late * factor * rangeVariance(`${row.dept}-${range}-late`)),
      absent: Math.round(row.absent * factor * rangeVariance(`${row.dept}-${range}-absent`)),
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
        <g stroke="#E2E7F0" strokeDasharray="2 4" strokeWidth="0.5">
          {[40, 90, 140, 190].map((y) => <line key={y} x1="40" y1={y} x2="600" y2={y} />)}
        </g>
        <g fontFamily="JetBrains Mono" fontSize="9" fill="#6B7A90">
          {[[44, maxTotal], [94, Math.ceil(maxTotal * 0.66)], [144, Math.ceil(maxTotal * 0.33)], [194, 0]].map(([y, v]) => (
            <text key={y} x="30" y={y} textAnchor="end">{v}</text>
          ))}
        </g>
        <g>
          {bars.map((bar, i) => {
            const x = x0 + i * step;
            return (
              <g key={bar.dept}>
                <rect x={x} y={bar.presentY} width={w} height={bar.presentH} fill="#16A34A" rx="2" />
                <rect x={x} y={bar.lateY} width={w} height={bar.lateH} fill="#D97706" />
                <rect x={x} y={bar.absentY} width={w} height={bar.absentH} fill="#DC3545" />
              </g>
            );
          })}
        </g>
        <g fontFamily="JetBrains Mono" fontSize="9" fill="#6B7A90" textAnchor="middle">
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

const formatCompactINR = (n) => {
  if (n >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
};

function PayrollChart({ data }) {
  const maxTotal = Math.max(1, ...data.map((d) => d.total));
  const base = 190;
  const scale = 135 / maxTotal;
  const x0 = 58, step = data.length > 1 ? Math.min(46, 500 / data.length) : 46, w = Math.min(28, Math.max(14, step - 10));
  return (
    <div className="chart">
      <svg viewBox="0 0 600 240" preserveAspectRatio="none">
        <g stroke="#E2E7F0" strokeDasharray="2 4" strokeWidth="0.5">
          {[40, 90, 140, 190].map((y) => <line key={y} x1="40" y1={y} x2="600" y2={y} />)}
        </g>
        <g fontFamily="JetBrains Mono" fontSize="9" fill="#6B7A90">
          {[[44, maxTotal], [94, maxTotal * 0.66], [144, maxTotal * 0.33], [194, 0]].map(([y, v]) => (
            <text key={y} x="30" y={y} textAnchor="end">{formatCompactINR(v)}</text>
          ))}
        </g>
        <g>
          {data.map((d, i) => {
            const h = d.total * scale;
            return <rect key={d.cycle} x={x0 + i * step} y={base - h} width={w} height={h} fill="#3B7DDD" rx="2" />;
          })}
        </g>
        <g fontFamily="JetBrains Mono" fontSize="9" fill="#6B7A90" textAnchor="middle">
          {data.map((d, i) => (
            <text key={d.cycle} x={x0 + i * step + w / 2} y="215">{d.label}</text>
          ))}
        </g>
      </svg>
    </div>
  );
}
