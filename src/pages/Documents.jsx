import { useEffect, useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import { IconEdit, IconTrash } from '../components/Icons';
import { formatDate, formatINR } from '../lib/helpers';
import { putFile, getFile, deleteFile, dataUrlToBlob } from '../lib/fileStore';

const FOLDERS = [
  { id: 'policies', name: 'Policies', type: 'Company' },
  { id: 'payslips', name: 'Payslips', type: 'Payroll' },
  { id: 'leave', name: 'Leave records', type: 'HR' },
  { id: 'people', name: 'Employee files', type: 'People' },
];

const UPLOAD_KEY = 'Smaatech_hrms_uploads';
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ACCEPTED_TYPES = {
  PDF: ['application/pdf'],
  DOC: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  IMG: ['image/png', 'image/jpeg', 'image/webp'],
  XLS: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

const emptyUpload = { title: '', owner: '', folder: 'people', type: 'PDF', visibility: 'all', file: null };

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
      .meta { color: #6b6457; margin-bottom: 24px; }
      .row { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd6c8; padding: 12px 0; }
      .label { color: #6b6457; }
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
  const { employees, payroll, leaves, settings, search, audit, toast, currentUser } = useHRMS();
  const [folder, setFolder] = useState('all');
  const [uploads, setUploads] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(UPLOAD_KEY) || '[]');
    } catch {
      return [];
    }
  });
  const [upload, setUpload] = useState(emptyUpload);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    localStorage.setItem(UPLOAD_KEY, JSON.stringify(uploads));
  }, [uploads]);

  // One-time migration: move legacy base64 fileData out of localStorage into IndexedDB.
  useEffect(() => {
    const legacy = uploads.filter((u) => u.fileData);
    if (legacy.length === 0) return;
    (async () => {
      for (const doc of legacy) {
        try {
          await putFile(doc.id, dataUrlToBlob(doc.fileData));
        } catch (err) {
          console.warn('File migration failed for', doc.id, err);
          return; // keep legacy data so nothing is lost
        }
      }
      setUploads((list) => list.map((u) => (
        u.fileData ? { ...u, fileData: undefined, hasFile: true } : u
      )));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const documents = useMemo(() => {
    const owner = settings.orgName || 'Organisation';
    const policyDocs = [
      { id: 'pol_leave', folder: 'policies', title: 'Leave policy', owner, type: 'PDF', visibility: 'all', meta: `${leaves.length} requests tracked` },
      { id: 'pol_payroll', folder: 'policies', title: 'Payroll handbook', owner, type: 'PDF', visibility: 'all', meta: `${payroll.length} salary slips linked` },
      { id: 'pol_security', folder: 'policies', title: 'Security checklist', owner, type: 'DOC', visibility: 'all', meta: settings.twoFactor ? '2FA enabled' : '2FA optional' },
    ];

    const payslips = payroll.map((p) => ({
      id: `pay_${p.id}`,
      folder: 'payslips',
      title: `${p.name} payslip`,
      owner: p.name,
      type: 'PDF',
      visibility: 'finance',
      meta: `${p.cycle} - ${formatINR(p.net)} - ${p.status}`,
    }));

    const leaveDocs = leaves.map((l) => ({
      id: `leave_${l.id}`,
      folder: 'leave',
      title: `${l.name} leave request`,
      owner: l.name,
      type: 'REQ',
      visibility: 'hr',
      meta: `${formatDate(l.start)} to ${formatDate(l.end)} - ${l.status}`,
    }));

    const peopleDocs = employees.map((e) => ({
      id: `emp_${e.id}`,
      folder: 'people',
      title: `${e.name} employee profile`,
      owner: e.name,
      type: 'FILE',
      visibility: 'hr',
      meta: `${e.dept} - ${e.role}`,
    }));

    return [...uploads, ...policyDocs, ...payslips, ...leaveDocs, ...peopleDocs];
  }, [employees, leaves, payroll, settings, uploads]);

  const validateFile = (file, type) => {
    if (!file) return '';
    if (file.size > MAX_FILE_SIZE) return 'File must be 2 MB or smaller.';
    const allowed = ACCEPTED_TYPES[type] || [];
    if (allowed.length && !allowed.includes(file.type)) return `${type} upload expects a matching file type.`;
    return '';
  };

  const resetForm = () => {
    setUpload(emptyUpload);
    setEditing(null);
    setError('');
  };

  const saveUpload = () => {
    if (!upload.title.trim()) {
      setError('Document title is required.');
      return;
    }
    const fileError = validateFile(upload.file, upload.type);
    if (fileError) {
      setError(fileError);
      return;
    }
    const owner = upload.owner.trim() || settings.orgName || 'Organisation';
    const file = upload.file;
    const id = editing?.id || `upload_${Date.now()}`;

    const record = {
      id,
      folder: upload.folder,
      title: upload.title.trim(),
      owner,
      type: upload.type,
      visibility: upload.visibility || 'all',
      meta: file ? `${file.name} - ${Math.ceil(file.size / 1024)} KB` : editing?.meta || 'Uploaded just now',
      fileName: file?.name || editing?.fileName || '',
      hasFile: Boolean(file) || Boolean(editing?.hasFile),
    };

    const commit = () => {
      setUploads((list) => (
        editing
          ? list.map((item) => (item.id === editing.id ? record : item))
          : [record, ...list]
      ));
      audit(editing ? 'Document updated' : 'Document uploaded', record.title, record.folder);
      resetForm();
    };

    if (!file) {
      commit();
      return;
    }

    // Store the actual file in IndexedDB — only metadata goes to localStorage.
    putFile(id, file)
      .then(commit)
      .catch(() => setError('Could not store the file in this browser. Try again.'));
  };

  const openFile = async (doc) => {
    try {
      const blob = doc.fileData ? dataUrlToBlob(doc.fileData) : await getFile(doc.id);
      if (!blob) {
        toast('error', 'File not found in this browser’s storage.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.fileName || doc.title;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      audit('Document downloaded', doc.title, doc.folder);
    } catch {
      toast('error', 'Could not open this file.');
    }
  };

  const startEdit = (doc) => {
    setEditing(doc);
    setUpload({
      title: doc.title,
      owner: doc.owner,
      folder: doc.folder,
      type: doc.type,
      visibility: doc.visibility || 'all',
      file: null,
    });
    setError('');
  };

  const deleteUpload = async () => {
    if (!confirm) return;
    setUploads((list) => list.filter((doc) => doc.id !== confirm.id));
    deleteFile(confirm.id).catch(() => {});
    audit('Document deleted', confirm.title, confirm.folder);
    toast('info', 'Document deleted');
    setConfirm(null);
    if (editing?.id === confirm.id) resetForm();
  };

  const downloadGenerated = (doc) => {
    downloadTextFile(doc, generatedHtml(doc));
    audit('Generated document downloaded', doc.title, doc.folder);
  };

  const visible = useMemo(
    () => documents.filter((doc) => canSeeDoc(doc, currentUser.role)),
    [documents, currentUser.role],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visible.filter((doc) => {
      const matchFolder = folder === 'all' || doc.folder === folder;
      const matchQ = !q
        || doc.title.toLowerCase().includes(q)
        || doc.owner.toLowerCase().includes(q)
        || doc.meta.toLowerCase().includes(q);
      return matchFolder && matchQ;
    });
  }, [visible, folder, search]);

  const counts = useMemo(() => {
    const base = { all: visible.length };
    FOLDERS.forEach((f) => { base[f.id] = visible.filter((d) => d.folder === f.id).length; });
    return base;
  }, [visible]);

  return (
    <div className="page-wrap active">
      <div className="stats">
        <div className="stat"><div className="stat-label">Total files</div><div className="stat-value">{documents.length}</div><div className="stat-meta">generated from HR data</div></div>
        <div className="stat"><div className="stat-label">Payslips</div><div className="stat-value">{counts.payslips}</div><div className="stat-meta">current payroll cycle</div></div>
        <div className="stat"><div className="stat-label">Leave records</div><div className="stat-value">{counts.leave}</div><div className="stat-meta">requests and approvals</div></div>
        <div className="stat"><div className="stat-label">Employee files</div><div className="stat-value">{counts.people}</div><div className="stat-meta">live people directory</div></div>
      </div>

      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Document library</div>
              <div className="card-sub">{filtered.length} files shown from live workspace data</div>
            </div>
          </div>

          <div className="filter-chips" style={{ marginBottom: 16 }}>
            <button className={`chip ${folder === 'all' ? 'active' : ''}`} onClick={() => setFolder('all')}>
              All <span className="chip-count">{counts.all}</span>
            </button>
            {FOLDERS.map((f) => (
              <button key={f.id} className={`chip ${folder === f.id ? 'active' : ''}`} onClick={() => setFolder(f.id)}>
                {f.name} <span className="chip-count">{counts[f.id]}</span>
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="empty">No documents match this search.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Document</th><th>Owner</th><th>Type</th><th>Visible to</th><th>Details</th><th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((doc) => (
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
                      <td>{doc.meta}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                          {(doc.hasFile || doc.fileData) ? (
                            <button className="mini-btn" onClick={() => openFile(doc)}>Open</button>
                          ) : (
                            <button className="mini-btn" onClick={() => downloadGenerated(doc)}>Download</button>
                          )}
                          {doc.id.startsWith('upload_') && (
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
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Folders</div>
                <div className="card-sub">Counts update as data changes</div>
              </div>
            </div>
            <div className="folder-grid">
              {FOLDERS.map((f) => (
                <button key={f.id} className="folder" onClick={() => setFolder(f.id)}>
                  <span className="folder-icon" />
                  <span className="folder-name">{f.name}</span>
                  <span className="folder-count">{counts[f.id]} {f.type} files</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">{editing ? 'Edit document' : 'Upload document'}</div>
                <div className="card-sub">{editing ? 'Update uploaded file details' : 'Adds a new file to this frontend workspace'}</div>
              </div>
            </div>
          <div className="form-grid">
            <label className="field field-full">
              <span className="field-label">Document title</span>
              <input className="input" value={upload.title} onChange={(e) => setUpload((u) => ({ ...u, title: e.target.value }))} placeholder="e.g. Appointment letter" />
              {error && <span className="field-error">{error}</span>}
            </label>
            <label className="field field-full">
              <span className="field-label">Owner</span>
              <input className="input" value={upload.owner} onChange={(e) => setUpload((u) => ({ ...u, owner: e.target.value }))} placeholder="Employee or organisation" />
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
                <option>PDF</option>
                <option>DOC</option>
                <option>IMG</option>
                <option>XLS</option>
              </select>
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
      </div>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Delete document"
        message={confirm ? `Delete ${confirm.title}? This only removes the uploaded local copy.` : ''}
        confirmLabel="Delete"
        onCancel={() => setConfirm(null)}
        onConfirm={deleteUpload}
      />
    </div>
  );
}
