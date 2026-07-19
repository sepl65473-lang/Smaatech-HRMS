import { useState } from 'react';
import Modal from './Modal';
import { parseCSV, rowsToObjects } from '../lib/csv';
import { DEPARTMENTS, LOCATIONS } from '../lib/helpers';

const DEFAULT_EMPLOYEE_HEADER = 'name,role,dept,loc,email,phone,status,joinDate,salary,bankAccount,ifsc,managerName,employmentType';
const DEFAULT_EMPLOYEE_SAMPLE = 'Asha Verma,Frontend Engineer,Engineering,Bengaluru,asha.verma@smaatech.co,+91 9000000001,active,2024-01-15,150000,123456789012,HDFC0001234,Ananya Nair,Full-time';
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern'];

function defaultValidateRow(row, depts) {
  const errors = [];
  if (!row.name) errors.push('Name is required');
  if (!row.role) errors.push('Role is required');
  if (row.dept && !depts.includes(row.dept)) errors.push(`Unknown department "${row.dept}"`);
  if (row.email && !/^\S+@\S+\.\S+$/.test(row.email)) errors.push('Invalid email');
  if (row.salary && Number.isNaN(Number(row.salary))) errors.push('Salary must be a number');
  return errors;
}

export default function CsvImportModal({
  open,
  onClose,
  onImport,
  title = "Import employees from CSV",
  subtitle = "Bulk add employees from a spreadsheet export",
  templateHeader = DEFAULT_EMPLOYEE_HEADER,
  templateSample = DEFAULT_EMPLOYEE_SAMPLE,
  templateFileName = 'employee-import-template.csv',
  validateRow,
  mapRow,
  columns = [
    { key: 'name', label: 'Name' },
    { key: 'role', label: 'Role' },
    { key: 'dept', label: 'Dept' },
    { key: 'salary', label: 'Salary' },
  ],
  departments = DEPARTMENTS,
  employees = [],
}) {
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);

  const reset = () => { setRows([]); setFileName(''); setImporting(false); };
  const close = () => { reset(); onClose(); };

  const downloadTemplate = () => {
    const blob = new Blob([`${templateHeader}\n${templateSample}\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = templateFileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = rowsToObjects(parseCSV(String(reader.result || '')));
      const validated = parsed.map((r) => {
        const errors = validateRow 
          ? validateRow(r)
          : defaultValidateRow(r, departments);
        return { ...r, _errors: errors };
      });
      setRows(validated);
    };
    reader.readAsText(file);
  };

  const validRows = rows.filter((r) => r._errors.length === 0);
  const invalidRows = rows.filter((r) => r._errors.length > 0);

  const confirmImport = async () => {
    setImporting(true);
    const finalData = validRows.map(({ _errors, ...r }) => {
      if (mapRow) return mapRow(r);
      
      // Default employee mapper for backward compatibility
      return {
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
        employmentType: EMPLOYMENT_TYPES.includes(r.employmenttype) ? r.employmenttype : 'Full-time',
      };
    });
    await onImport(finalData);
    close();
  };

  return (
    <Modal
      open={open}
      title={title}
      subtitle={subtitle}
      onClose={close}
      width={640}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <button className="btn approve" disabled={!validRows.length || importing} onClick={confirmImport}>
            {importing ? 'Importing…' : `Import ${validRows.length || ''} item${validRows.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <div className="form-grid">
        <label className="field field-full">
          <span className="field-label">CSV file</span>
          <input className="input" type="file" accept=".csv,text/csv" onChange={handleFile} />
          <small className="muted-text">
            Columns: {templateHeader.replace(/,/g, ', ')} ·{' '}
            <button
              type="button"
              onClick={downloadTemplate}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
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
            {invalidRows.length > 0 && <span className="chip danger">{invalidRows.length} with errors</span>}
          </div>

          <div className="table-scroll" style={{ marginTop: 12, maxHeight: 280 }}>
            <table className="table">
              <thead>
                <tr>
                  {columns.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => <td key={c.key}>{r[c.key.toLowerCase()] || r[c.key] || '—'}</td>)}
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
