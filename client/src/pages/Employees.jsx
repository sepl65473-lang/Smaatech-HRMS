import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import EmployeeForm from '../components/EmployeeForm';
import ConfirmDialog from '../components/ConfirmDialog';
import CsvImportModal from '../components/CsvImportModal';
import { downloadCSV } from '../lib/csv';
import {
  IconEdit, IconTrash, IconPlus, IconWorkforce, IconPresent, IconLeave, IconAnalytics,
} from '../components/Icons';
import { formatINR } from '../lib/helpers';

const STATUS_LABEL = { active: 'Active', remote: 'Remote', 'on-leave': 'On leave' };
const PAGE_SIZE = 6;

export default function Employees() {
  const {
    employees, search, addEmployee, updateEmployee, deleteEmployee, importEmployees,
    addUserAccount, toast, getMasterValues,
  } = useHRMS();
  const navigate = useNavigate();
  const departments = getMasterValues('departments');
  const locations = getMasterValues('locations');
  const [dept, setDept] = useState('All');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [importOpen, setImportOpen] = useState(false);

  const handleExportCsv = () => {
    const dataToExport = employees.map((e) => {
      const manager = employees.find((m) => m.id === e.managerId);
      return {
        ...e,
        managerName: manager ? manager.name : '',
      };
    });
    const keys = [
      'name', 'role', 'dept', 'loc', 'email', 'phone', 'status', 'joinDate',
      'salary', 'bankAccount', 'ifsc', 'managerName', 'employmentType'
    ];
    const labels = [
      'Name', 'Role', 'Department', 'Location', 'Email', 'Phone', 'Status', 'Join Date',
      'Salary', 'Bank Account', 'IFSC', 'Manager Name', 'Employment Type'
    ];
    downloadCSV(dataToExport, keys, 'employees.csv', labels);
    toast('success', 'Employees list exported successfully');
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      const matchDept = dept === 'All' || e.dept === dept;
      const matchQ = !q
        || e.name.toLowerCase().includes(q)
        || e.role.toLowerCase().includes(q)
        || e.dept.toLowerCase().includes(q)
        || e.loc.toLowerCase().includes(q);
      return matchDept && matchQ;
    });
  }, [employees, dept, search]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    const sorters = {
      name: (a, b) => a.name.localeCompare(b.name),
      dept: (a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name),
      salary: (a, b) => Number(b.salary || 0) - Number(a.salary || 0),
      rating: (a, b) => Number(b.rating || 0) - Number(a.rating || 0),
      newest: (a, b) => String(b.joinDate || '').localeCompare(String(a.joinDate || '')),
    };
    return list.sort(sorters[sort] || sorters.name);
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageItems = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [dept, search, sort]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (e) => { setEditing(e); setFormOpen(true); };

  const handleSave = async (data, loginPayload) => {
    if (editing) {
      await updateEmployee(editing.id, data);
    } else {
      const created = await addEmployee(data);
      if (loginPayload) {
        try {
          await addUserAccount({ ...loginPayload, employeeId: created.id });
        } catch (err) {
          toast('error', `Employee added, but creating the login failed: ${err.message}. Retry from Settings > Users & role access.`);
        }
      }
    }
    setFormOpen(false);
  };

  const activeCount = employees.filter((e) => e.status === 'active').length;
  const onLeaveCount = employees.filter((e) => e.status === 'on-leave').length;

  return (
    <div className="page-wrap active">
      <div className="stats">
        <div className="stat">
          <div className="stat-icon tone-accent"><IconWorkforce width="16" height="16" /></div>
          <div className="stat-label">Total employees</div><div className="stat-value">{employees.length}</div><div className="stat-meta">across {departments.length} departments</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-sage"><IconPresent width="16" height="16" /></div>
          <div className="stat-label">Active</div><div className="stat-value">{activeCount}</div><div className="stat-meta">working today</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-teal"><IconLeave width="16" height="16" /></div>
          <div className="stat-label">On leave</div><div className="stat-value">{onLeaveCount}</div><div className="stat-meta">currently away</div>
        </div>
        <div className="stat">
          <div className="stat-icon tone-purple"><IconAnalytics width="16" height="16" /></div>
          <div className="stat-label">Departments</div><div className="stat-value">{departments.length}</div><div className="stat-meta">org-wide</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">People directory</div>
            <div className="card-sub">{filtered.length} of {employees.length} shown</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={handleExportCsv}>Export CSV</button>
            <button className="btn btn-ghost" onClick={() => setImportOpen(true)}>Import CSV</button>
            <button className="btn" onClick={openAdd}><IconPlus width="14" height="14" /> Add employee</button>
          </div>
        </div>

        <div className="list-toolbar">
          <div className="filter-chips">
            {['All', ...departments].map((d) => (
              <button key={d} className={`chip ${dept === d ? 'active' : ''}`} onClick={() => setDept(d)}>{d}</button>
            ))}
          </div>
          <label className="inline-select">
            <span>Sort</span>
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="name">Name A-Z</option>
              <option value="dept">Department</option>
              <option value="salary">Highest salary</option>
              <option value="rating">Highest rating</option>
              <option value="newest">Newest joiners</option>
            </select>
          </label>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">No employees match your filters.</div>
        ) : (
          <div className="emp-grid" style={{ marginTop: 16 }}>
            {pageItems.map((e) => (
              <div className="emp-card" key={e.id}>
                <div className="emp-card-head">
                  <Avatar name={e.name} photo={e.photo} size={44} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="emp-card-name"
                      style={{ cursor: 'pointer' }}
                      title="Open profile"
                      onClick={() => navigate(`/employees/${e.id}`)}
                    >
                      {e.name}
                    </div>
                    <div className="emp-card-role">{e.role}</div>
                  </div>
                  <span className={`status-pill status-${e.status}`}>{STATUS_LABEL[e.status]}</span>
                </div>
                <div className="emp-card-meta">
                  <span>📍 {e.loc}</span>
                  <span>· {e.dept}</span>
                </div>
                <div className="emp-card-meta" style={{ marginTop: 4 }}>
                  <span className="mono">{e.email}</span>
                </div>
                <div className="emp-card-foot">
                  <span className="mono" title="Monthly gross">{formatINR(e.salary)}</span>
                  <div className="emp-card-actions">
                    <button className="icon-btn sm" title="Edit" onClick={() => openEdit(e)}>
                      <IconEdit width="14" height="14" />
                    </button>
                    <button className="icon-btn sm danger" title="Delete" onClick={() => setConfirm(e)}>
                      <IconTrash width="14" height="14" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {sorted.length > PAGE_SIZE && (
          <div className="pager">
            <button className="mini-btn" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span className="pager-meta">Page {page} of {totalPages}</span>
            <button className="mini-btn approve" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </div>

      <EmployeeForm open={formOpen} employee={editing} onClose={() => setFormOpen(false)} onSave={handleSave} />

      <CsvImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={importEmployees}
        departments={departments}
        locations={locations}
        employees={employees}
      />

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Remove employee"
        message={confirm ? `Remove ${confirm.name} from the directory? This can’t be undone.` : ''}
        confirmLabel="Remove"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { await deleteEmployee(confirm.id); setConfirm(null); }}
      />
    </div>
  );
}
