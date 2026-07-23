import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import Document from '../models/Document.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import { savePhoto, readPhoto, deleteFileRef, wrapUpload } from '../lib/photoStorage.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

const ALLOWED_DOCUMENT_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const upload = wrapUpload(multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_DOCUMENT_MIMES.has(file.mimetype)) {
      return cb(new Error('Unsupported file type. Allowed: PDF, JPEG/PNG, Word, Excel.'));
    }
    cb(null, true);
  },
}).single('file'));

// Client-settable document metadata — fileRef/company/reminderSent are
// always server-computed and must never come straight from the request body.
const ALLOWED_DOCUMENT_FIELDS = ['title', 'owner', 'ownerId', 'folder', 'type', 'visibility', 'expiryDate'];

// List all documents based on company scoped rules and role visibilities
router.get('/', async (req, res) => {
  const filter = companyFilter(req);
  
  const isHRDir = req.auth.role === 'HR Director';
  const isHRMgr = req.auth.role === 'HR Manager';
  const isFinance = req.auth.role === 'Finance Lead';
  const empId = req.auth.employeeId;

  let visibilityFilter = {};
  if (!isHRDir) {
    const allowedVisibilities = ['all'];
    if (isHRMgr) allowedVisibilities.push('hr');
    if (isFinance) allowedVisibilities.push('finance');

    visibilityFilter = {
      $or: [
        { visibility: { $in: allowedVisibilities } },
        ...(empId ? [{ ownerId: empId }] : [])
      ]
    };
  }

  const combinedFilter = { ...filter, ...visibilityFilter };
  const docs = await Document.find(combinedFilter).sort({ createdAt: -1 });
  res.json(docs);
});

// Create document metadata and upload file to disk
router.post('/', upload, async (req, res) => {
  // Only HR can upload/create documents
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR personnel can upload documents.' } });
  }

  let fileRef = '';
  if (req.file) {
    const ext = path.extname(req.file.originalname) || '.pdf';
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    fileRef = savePhoto('documents', filename, req.file.buffer);
  }

  const docData = {
    title: req.body.title || 'Untitled Document',
    owner: req.body.owner || 'System',
    ownerId: req.body.ownerId || null,
    folder: req.body.folder || 'people',
    type: req.body.type || 'PDF',
    visibility: req.body.visibility || 'all',
    expiryDate: req.body.expiryDate || '',
    fileRef,
    company: req.auth.company,
  };

  const created = await Document.create(docData);
  await logAudit(req, { action: 'Document uploaded', subject: created.title, after: created });
  res.status(201).json(created);
});

// Update document details
router.patch('/:id', upload, async (req, res) => {
  const before = await Document.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });

  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR personnel can edit documents.' } });
  }

  const updateData = {};
  for (const field of ALLOWED_DOCUMENT_FIELDS) {
    if (req.body?.[field] !== undefined) updateData[field] = req.body[field];
  }

  if (req.file) {
    // Save new file and remove old one
    const ext = path.extname(req.file.originalname) || '.pdf';
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    updateData.fileRef = savePhoto('documents', filename, req.file.buffer);
    if (before.fileRef) deleteFileRef(before.fileRef);
  }

  // Reset reminder flag if expiryDate gets modified
  if (updateData.expiryDate !== undefined && updateData.expiryDate !== before.expiryDate) {
    updateData.reminderSent = false;
  }

  const updated = await Document.findByIdAndUpdate(req.params.id, updateData, { new: true });
  await logAudit(req, { action: 'Document updated', subject: updated.title, before, after: updated });
  res.json(updated);
});

// Delete document record
router.delete('/:id', async (req, res) => {
  const before = await Document.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });

  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR personnel can delete documents.' } });
  }

  await Document.findByIdAndDelete(req.params.id);
  if (before.fileRef) deleteFileRef(before.fileRef);

  await logAudit(req, { action: 'Document removed', subject: before.title, before });
  res.json({ id: req.params.id });
});

// Download/Stream document file
router.get('/:id/download', async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });

  // Access checks
  const isHRDir = req.auth.role === 'HR Director';
  const isHRMgr = req.auth.role === 'HR Manager';
  const isFinance = req.auth.role === 'Finance Lead';
  const isOwner = req.auth.employeeId && String(doc.ownerId) === String(req.auth.employeeId);

  if (!isHRDir && !isOwner) {
    if (doc.visibility === 'hr' && !isHRMgr) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied.' } });
    }
    if (doc.visibility === 'finance' && !isFinance) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied.' } });
    }
  }

  if (!doc.fileRef) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No file reference exists for this document.' } });
  }

  const buffer = readPhoto(doc.fileRef);
  if (!buffer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document file missing on server.' } });

  const filename = doc.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'download';
  let contentType = 'application/octet-stream';
  if (doc.type === 'PDF') contentType = 'application/pdf';
  else if (doc.type === 'IMG') contentType = 'image/jpeg';
  else if (doc.type === 'DOC') contentType = 'application/msword';
  else if (doc.type === 'XLS') contentType = 'application/vnd.ms-excel';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}${path.extname(doc.fileRef) || '.pdf'}"`);
  res.send(buffer);
});

export default router;
