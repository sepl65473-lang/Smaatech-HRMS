import { useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import { IconEdit, IconTrash } from '../components/Icons';
import { formatDate, formatINR, todayISO } from '../lib/helpers';

const FOLDERS = [
  { id: 'policies', name: 'Policies', type: 'Company' },
  { id: 'payslips', name: 'Payslips', type: 'Payroll' },
  { id: 'leave', name: 'Leave records', type: 'HR' },
  { id: 'people', name: 'Employee files', type: 'People' },
];

const emptyUpload = { title: '', owner: '', ownerId: '', folder: 'people', type: 'PDF', visibility: 'all', file: null, expiryDate: '' };

const VISIBILITY = {
  all: { label: 'Everyone', cls: 'approved' },
  hr: { label: 'HR only', cls: 'pending' },
  finance: { label: 'Finance only', cls: 'declined' },
};

const canSeeDoc = (doc, role) => {
  if (role === 'HR Director') return true;
  if (role === 'Finance Lead') return doc.visibility !== 'hr';
  if (role === 'HR Manager') return doc.visibility !== 'finance';
  return doc.visibility === 'all';
};

const downloadTextFile = (doc, html) => {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${doc.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'document'}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const generatedHtml = (doc) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${doc.title}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #252019; padding: 32px; }
      h1 { margin-bottom: 8px; }
      .meta { color: #6b7a90; margin-bottom: 24px; }
      .row { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd6c8; padding: 12px 0; }
      .label { color: #6b7a90; }
      strong { text-align: right; }
    </style>
  </head>
  <body>
    <h1>${doc.title}</h1>
    <div class="meta">Generated from Smaatech HRMS on ${new Date().toLocaleDateString('en-IN')}</div>
    <div class="row"><span class="label">Owner</span><strong>${doc.owner}</strong></div>
    <div class="row"><span class="label">Folder</span><strong>${doc.folder}</strong></div>
    <div class="row"><span class="label">Type</span><strong>${doc.type}</strong></div>
    <div class="row"><span class="label">Details</span><strong>${doc.meta}</strong></div>
  </body>
</html>`;

export default function Documents() {
  const {
    employees, payroll, leaves, settings, search, toast, currentUser, getMasterValues,
    documents: dbDocs, addDocument, updateDocument, deleteDocument, downloadDocument
  } = useHRMS();

  const documentTypes = getMasterValues('document_types');
  const [folder, setFolder] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all'); // all | active | warning | expired
  const [upload, setUpload] = useState(emptyUpload);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState('');

  const isHR = ['HR Director', 'HR Manager'].includes(currentUser.role);

  // Computes document statuses (Active, Expiring Soon, Expired)
  const getDocStatus = (doc) => {
    if (!doc.expiryDate) return { label: 'Active', cls: 'approved', key: 'active' };
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const expiry = new Date(doc.expiryDate);
    if (isNaN(expiry.getTime())) return { label: 'Active', cls: 'approved', key: 'active' };

    const expiryDateOnly = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate());
    if (expiryDateOnly < today) {
      return { label: 'Expired', cls: 'declined', key: 'expired' };
    }

    const diffTime = expiryDateOnly - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays <= 30) {
      return { label: `Expiring in ${diffDays}d`, cls: 'pending', key: 'warning' };
    }

    return { label: 'Active', cls: 'approved', key: 'active' };
  };

  const documents = useMemo(() => {
    const orgOwner = settings.orgName || 'Organisation';
    
    // Legacy simulated documents
    const policyDocs = [
      { id: 'pol_leave', folder: 'policies', title: 'Leave policy', owner: orgOwner, type: 'PDF', visibility: 'all', meta: `${leaves.length} requests tracked`, expiryDate: '' },
      { id: 'pol_payroll', folder: 'policies', title: 'Payroll handbook', owner: orgOwner, type: 'PDF', visibility: 'all', meta: `${payroll.length} salary slips linked`, expiryDate: '' },
      { id: 'pol_security', folder: 'policies', title: 'Security checklist', owner: orgOwner, type: 'DOC', visibility: 'all', meta: settings.twoFactor ? '2FA enabled' : '2FA optional', expiryDate: '' },
    ];

    const payslips = payroll.map((p) => ({
      id: `pay_${p.id}`,
      folder: 'payslips',
      title: `${p.name} payslip`,
      owner: p.name,
      type: 'PDF',
      visibility: 'finance',
      meta: `${p.cycle} - ${formatINR(p.net)} - ${p.status}`,
      expiryDate: ''
    }));

    const leaveDocs = leaves.map((l) => ({
      id: `leave_${l.id}`,
      folder: 'leave',
      title: `${l.name} leave request`,
      owner: l.name,
      type: 'REQ',
      visibility: 'hr',
      meta: `${formatDate(l.start)} to ${formatDate(l.end)} - ${l.status}`,
      expiryDate: ''
    }));

    const peopleDocs = employees.map((e) => ({
      id: `emp_${e.id}`,
      folder: 'people',
      title: `${e.name} employee profile`,
      owner: e.name,
      type: 'FILE',
      visibility: 'hr',
      meta: `${e.dept} - ${e.role}`,
      expiryDate: ''
    }));

    const normalizedDbDocs = dbDocs.map(d => ({
      ...d,
      meta: d.expiryDate ? `Expires: ${formatDate(d.expiryDate)}` : 'No expiry set',
      hasFile: true
    }));

    return [...normalizedDbDocs, ...policyDocs, ...payslips, ...leaveDocs, ...peopleDocs];
  }, [employees, leaves, payroll, settings, dbDocs]);

  const validateFile = (file, type) => {
    if (!file) return '';
    const MAX_FILE_SIZE = 2 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) return 'File must be 2 MB or smaller.';
    return '';
  };

  const resetForm = () => {
    setUpload(emptyUpload);
    setEditing(null);
    setError('');
  };

  const saveUpload = async () => {
    if (!upload.title.trim()) {
      setError('Document title is required.');
      return;
    }
    if (!upload.ownerId) {
      setError('Document owner is required.');
      return;
    }
    const fileError = validateFile(upload.file, upload.type);
    if (fileError) {
      setError(fileError);
      return;
    }

    const formData = new FormData();
    formData.append('title', upload.title.trim());
    formData.append('owner', upload.owner);
    formData.append('ownerId', upload.ownerId);
    formData.append('folder', upload.folder);
    formData.append('type', upload.type);
    formData.append('visibility', upload.visibility);
    formData.append('expiryDate', upload.expiryDate);
    if (upload.file) {
      formData.append('file', upload.file);
    }

    try {
      if (editing) {
        await updateDocument(editing.id, formData);
      } else {
        if (!upload.file) {
          setError('A file attachment is required for new uploads.');
          return;
        }
        await addDocument(formData);
      }
      resetForm();
    } catch (err) {
      setError(err.message || 'Failed to save document. Please try again.');
    }
  };

  const openFile = async (doc) => {
    try {
      toast('info', 'Downloading file from server...');
      const blob = await downloadDocument(doc.id);
      if (!blob) {
        toast('error', 'File not found on server.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.title || 'download';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      toast('error', 'Could not open this file.');
    }
  };

  const startEdit = (doc) => {
    setEditing(doc);
    setUpload({
      title: doc.title,
      owner: doc.owner,
      ownerId: doc.ownerId || '',
      folder: doc.folder,
      type: doc.type,
      visibility: doc.visibility || 'all',
      expiryDate: doc.expiryDate || '',
      file: null,
    });
    setError('');
  };

  const deleteUpload = async () => {
    if (!confirm) return;
    try {
      await deleteDocument(confirm.id);
      setConfirm(null);
      if (editing?.id === confirm.id) resetForm();
    } catch (err) {
      toast('error', 'Failed to delete document.');
    }
  };

  const downloadGenerated = (doc) => {
    downloadTextFile(doc, generatedHtml(doc));
    toast('info', 'Generating simulated document...');
  };

  const visible = useMemo(
    () => documents.filter((doc) => canSeeDoc(doc, currentUser.role)),
    [documents, currentUser.role],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visible.filter((doc) => {
      const matchFolder = folder === 'all' || doc.folder === folder;
      
      const docStatus = getDocStatus(doc);
      const matchStatus = statusFilter === 'all' || docStatus.key === statusFilter;

      const matchQ = !q
        || doc.title.toLowerCase().includes(q)
        || doc.owner.toLowerCase().includes(q)
        || doc.meta.toLowerCase().includes(q);
      
      return matchFolder && matchStatus && matchQ;
    });
  }, [visible, folder, statusFilter, search]);

  const counts = useMemo(() => {
    const base = {
      all: visible.length,
      active: visible.filter(d => getDocStatus(d).key === 'active').length,
      warning: visible.filter(d => getDocStatus(d).key === 'warning').length,
      expired: visible.filter(d => getDocStatus(d).key === 'expired').length,
    };
    FOLDERS.forEach((f) => {
      base[f.id] = visible.filter((d) => d.folder === f.id).length;
    });
    return base;
  }, [visible]);

  const isRealUpload = (doc) => {
    return !doc.id.startsWith('pol_') && !doc.id.startsWith('pay_') && !doc.id.startsWith('leave_') && !doc.id.startsWith('emp_');
  };

  return (
    <div className="page-wrap active">
      <div className="stats">
        <div className="stat"><div className="stat-label">Total files</div><div className="stat-value">{counts.all}</div><div className="stat-meta">active documents</div></div>
        <div className="stat"><div className="stat-label">Active / Valid</div><div className="stat-value">{counts.active}</div><div className="stat-meta">clean documents</div></div>
        <div className="stat"><div className="stat-label">Expiring Soon</div><div className="stat-value" style={{ color: 'var(--pending)' }}>{counts.warning}</div><div className="stat-meta">expires in 30 days</div></div>
        <div className="stat"><div className="stat-label">Expired</div><div className="stat-value" style={{ color: 'var(--declined)' }}>{counts.expired}</div><div className="stat-meta">action required</div></div>
      </div>

      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Document library</div>
              <div className="card-sub">{filtered.length} files shown from live database</div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
            <div className="filter-chips" style={{ margin: 0 }}>
              <button className={`chip ${folder === 'all' ? 'active' : ''}`} onClick={() => setFolder('all')}>
                All Folders <span className="chip-count">{counts.all}</span>
              </button>
              {FOLDERS.map((f) => (
                <button key={f.id} className={`chip ${folder === f.id ? 'active' : ''}`} onClick={() => setFolder(f.id)}>
                  {f.name} <span className="chip-count">{counts[f.id]}</span>
                </button>
              ))}
            </div>

            <div className="filter-chips" style={{ margin: 0 }}>
              <button className={`chip ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>
                All Status
              </button>
              <button className={`chip ${statusFilter === 'active' ? 'active' : ''}`} onClick={() => setStatusFilter('active')}>
                Active ({counts.active})
              </button>
              <button className={`chip ${statusFilter === 'warning' ? 'active' : ''}`} onClick={() => setStatusFilter('warning')}>
                Expiring ({counts.warning})
              </button>
              <button className={`chip ${statusFilter === 'expired' ? 'active' : ''}`} onClick={() => setStatusFilter('expired')}>
                Expired ({counts.expired})
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty">No documents match this search.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Document</th><th>Owner</th><th>Type</th><th>Visible to</th><th>Status</th><th>Expiry Date</th><th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((doc) => {
                    const status = getDocStatus(doc);
                    return (
                      <tr key={doc.id}>
                        <td><strong>{doc.title}</strong></td>
                        <td>
                          <div className="emp-cell">
                            <Avatar name={doc.owner} size={28} />
                            <span>{doc.owner}</span>
                          </div>
                        </td>
                        <td><span className="state-badge approved">{doc.type}</span></td>
                        <td><span className={`state-badge ${VISIBILITY[doc.visibility]?.cls || 'approved'}`}>{VISIBILITY[doc.visibility]?.label || 'Everyone'}</span></td>
                        <td><span className={`state-badge ${status.cls}`}>{status.label}</span></td>
                        <td className="mono">{doc.expiryDate ? formatDate(doc.expiryDate) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                            {isRealUpload(doc) ? (
                              <button className="mini-btn" onClick={() => openFile(doc)}>Open</button>
                            ) : (
                              <button className="mini-btn" onClick={() => downloadGenerated(doc)}>Download</button>
                            )}
                            {isRealUpload(doc) && isHR && (
                              <>
                                <button className="icon-btn sm" title="Edit" onClick={() => startEdit(doc)}>
                                  <IconEdit width="13" height="13" />
                                </button>
                                <button className="icon-btn sm danger" title="Delete" onClick={() => setConfirm(doc)}>
                                  <IconTrash width="13" height="13" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {isHR && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">{editing ? 'Edit document' : 'Upload document'}</div>
                  <div className="card-sub">{editing ? 'Update document credentials' : 'Adds a new secure document to database'}</div>
                </div>
              </div>
              <div className="form-grid">
                <label className="field field-full">
                  <span className="field-label">Document title</span>
                  <input className="input" value={upload.title} onChange={(e) => setUpload((u) => ({ ...u, title: e.target.value }))} placeholder="e.g. Appointment letter" />
                  {error && <span className="field-error" style={{ color: 'var(--declined)' }}>{error}</span>}
                </label>
                <label className="field field-full">
                  <span className="field-label">Document Owner (Employee)</span>
                  <select
                    className="input"
                    value={upload.ownerId}
                    onChange={(e) => {
                      const emp = employees.find(x => x.id === e.target.value);
                      setUpload(u => ({
                        ...u,
                        ownerId: e.target.value,
                        owner: emp ? emp.name : ''
                      }));
                    }}
                  >
                    <option value="">-- Choose Employee --</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.name} · {e.role}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Folder</span>
                  <select className="input" value={upload.folder} onChange={(e) => setUpload((u) => ({ ...u, folder: e.target.value }))}>
                    {FOLDERS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Type</span>
                  <select className="input" value={upload.type} onChange={(e) => setUpload((u) => ({ ...u, type: e.target.value }))}>
                    {documentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="field field-full">
                  <span className="field-label">Expiry Date (Leave empty if no expiry)</span>
                  <input type="date" className="input" value={upload.expiryDate} onChange={(e) => setUpload((u) => ({ ...u, expiryDate: e.target.value }))} />
                </label>
                <label className="field field-full">
                  <span className="field-label">Visible to</span>
                  <select className="input" value={upload.visibility} onChange={(e) => setUpload((u) => ({ ...u, visibility: e.target.value }))}>
                    <option value="all">Everyone with Documents access</option>
                    <option value="hr">HR only</option>
                    <option value="finance">Finance only</option>
                  </select>
                </label>
                <label className="field field-full">
                  <span className="field-label">File</span>
                  <input
                    type="file"
                    className="input"
                    accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.xls,.xlsx"
                    onChange={(e) => setUpload((u) => ({ ...u, file: e.target.files?.[0] || null }))}
                  />
                </label>
              </div>
              <div className="modal-actions" style={{ marginTop: 16 }}>
                {editing && <button className="btn btn-ghost" onClick={resetForm}>Cancel</button>}
                <button className="btn" onClick={saveUpload}>{editing ? 'Save document' : 'Add document'}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Delete document"
        message={confirm ? `Delete ${confirm.title}? This will permanently remove the file from the database server.` : ''}
        confirmLabel="Delete"
        onCancel={() => setConfirm(null)}
        onConfirm={deleteUpload}
      />
    </div>
  );
}
