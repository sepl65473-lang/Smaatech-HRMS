import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';

function Node({ employee, childrenMap }) {
  const [collapsed, setCollapsed] = useState(false);
  const reports = childrenMap[employee.id] || [];

  return (
    <div className="org-node">
      <div className="org-row">
        <Avatar name={employee.name} photo={employee.photo} size={36} />
        <div className="leave-body">
          <div className="leave-name">
            {employee.name}
            {reports.length > 0 && (
              <button className="mini-btn" style={{ marginLeft: 8 }} onClick={() => setCollapsed((c) => !c)}>
                {collapsed ? `+ ${reports.length} reports` : 'Collapse'}
              </button>
            )}
          </div>
          <div className="leave-meta">{employee.role} · {employee.dept}</div>
        </div>
      </div>
      {!collapsed && reports.length > 0 && (
        <div className="org-children">
          {reports.map((child) => (
            <Node key={child.id} employee={child} childrenMap={childrenMap} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function OrgChart() {
  const { employees } = useHRMS();

  const childrenMap = useMemo(() => {
    const map = {};
    employees.forEach((e) => {
      if (e.managerId && employees.some((m) => m.id === e.managerId)) {
        (map[e.managerId] = map[e.managerId] || []).push(e);
      }
    });
    return map;
  }, [employees]);

  const roots = useMemo(
    () => employees.filter((e) => !e.managerId || !employees.some((m) => m.id === e.managerId)),
    [employees],
  );

  const unassignedCount = roots.length;

  return (
    <div className="page-wrap active">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Organisation chart</div>
            <div className="card-sub">{employees.length} employees · {unassignedCount} at the top of the hierarchy</div>
          </div>
        </div>
        {roots.length === 0 ? (
          <div className="empty">No employees yet.</div>
        ) : (
          <div className="org-tree">
            {roots.map((root) => (
              <Node key={root.id} employee={root} childrenMap={childrenMap} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
