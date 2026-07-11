import { useState } from 'react';
import Modal from './Modal';
import { parseCSV, rowsToObjects } from '../lib/csv';
import { DEPARTMENTS, LOCATIONS } from '../lib/helpers';

const TEMPLATE_HEADER = 'name,role,dept,loc,email,phone,status,joinDate,salary,bankAccount,ifsc,managerName';
const TEMPLATE_SAMPLE = 'Asha Verma,Frontend Engineer,Engineering,Bengaluru,asha.verma@smaatech.co,+91 9000000001,active,2024-01-15,150000,123456789012,HDFC0001234,Ananya Nair';

function validateRow(row, depts) {
  const errors = [];
  if (!row.name) errors.push('Name is required');
  if (!row.role) errors.push('Role is required');
  if (row.dept && !depts.includes(row.dept)) errors.push(`Unknown department "${row.dept}"`);
  if (row.email && !/^\S+@\S+\.\S+$/.test(row.email)) errors.push('Invalid email');
  if (row.salary && Number.isNaN(Number(row.salary))) errors.push('Salary must be a number');
  return errors;
}

function downloadTemplate() {
  const blob = new Blob([`${TEMPLATE_HEADER}\n${TEMPLATE_SAMPLE}\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'employee-import-template.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function CsvImportModal({ open, onClose, onImport, departments = DEPARTMENTS, employees = [] }) {
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);

  const reset = () => { setRows([]); setFileName(''); setImporting(false); };
  const close = () => { reset(); onClose(); };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = rowsToObjects(parseCSV(String(reader.result || '')));
      setRows(parsed.map((r) => ({ ...r, _errors: validateRow(r, departments) })));
    };
    reader.readAsText(file);
  };

  const validRows = rows.filter((r) => r._errors.length === 0);
  const invalidRows = rows.filter((r) => r._errors.length > 0);

  const confirmImport = async () => {
    setImporting(true);
    await onImport(validRows.map(({ _errors, ...r }) => ({
      name: r.name,
      role: r.role,
      dept: departments.includes(r.dept) ? r.dept : departments[0],
      loc: LOCATIONS.includes(r.loc) ? r.loc : LOCATIONS[0],
      email: r.email || '',
      phone: r.phone || '',
      status: r.status || 'active',
      joinDate: r.joinDate || '',
      salary: Number(r.salary) || 0,
      bankAccount: r.bankaccount || r.bankAccount || '',
      ifsc: r.ifsc || '',
      managerId: employees.find((e) => e.name === (r.managername || r.managerName))?.id || null,
    })));
    close();
  };

  return (
    <Modal
      open={open}
      title="Import employees from CSV"
      subtitle="Bulk add employees from a spreadsheet export"
      onClose={close}
      width={640}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <button className="btn" disabled={!validRows.length || importing} onClick={confirmImport}>
            {importing ? 'Importing…' : `Import ${validRows.length || ''} employee${validRows.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <div className="form-grid">
        <label className="field field-full">
          <span className="field-label">CSV file</span>
          <input className="input" type="file" accept=".csv,text/csv" onChange={handleFile} />
          <small className="muted-text">
            Columns: name, role, dept, loc, email, phone, status, joinDate, salary, bankAccount, ifsc, managerName (optional) ·{' '}
            <button
              type="button"
              onClick={downloadTemplate}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent, #B8541F)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
            >
              Download template
            </button>
          </small>
        </label>
      </div>

      {rows.length > 0 && (
        <>
          <div className="filter-chips" style={{ marginTop: 12 }}>
            <span className="chip active">{fileName}</span>
            <span className="chip">{validRows.length} valid</span>
            {invalidRows.length > 0 && <span className="chip">{invalidRows.length} with errors</span>}
          </div>

          <div className="table-scroll" style={{ marginTop: 12, maxHeight: 280 }}>
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Role</th><th>Dept</th><th>Salary</th><th>Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name || '—'}</td>
                    <td>{r.role || '—'}</td>
                    <td>{r.dept || '—'}</td>
                    <td>{r.salary || '—'}</td>
                    <td>
                      {r._errors.length === 0
                        ? <span className="state-badge approved">Ready</span>
                        : <span className="state-badge declined" title={r._errors.join('; ')}>{r._errors[0]}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
