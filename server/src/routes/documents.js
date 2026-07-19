import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import Document from '../models/Document.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import { savePhoto, readPhoto } from '../lib/photoStorage.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
router.post('/', upload.single('file'), async (req, res) => {
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
router.patch('/:id', upload.single('file'), async (req, res) => {
  const before = await Document.findById(req.params.id);
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });

  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR personnel can edit documents.' } });
  }

  const updateData = { ...(req.body || {}) };
  if (req.file) {
    // Save new file and remove old one
    const ext = path.extname(req.file.originalname) || '.pdf';
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    updateData.fileRef = savePhoto('documents', filename, req.file.buffer);

    if (before.fileRef) {
      try {
        const oldPath = path.resolve(import.meta.dirname, '../../uploads', before.fileRef);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (err) {
        console.warn('Failed to delete old file:', err);
      }
    }
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
  const before = await Document.findById(req.params.id);
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });

  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR personnel can delete documents.' } });
  }

  await Document.findByIdAndDelete(req.params.id);

  if (before.fileRef) {
    try {
      const filePath = path.resolve(import.meta.dirname, '../../uploads', before.fileRef);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('Failed to delete file from disk:', err);
    }
  }

  await logAudit(req, { action: 'Document removed', subject: before.title, before });
  res.json({ id: req.params.id });
});

// Download/Stream document file
router.get('/:id/download', async (req, res) => {
  const doc = await Document.findById(req.params.id);
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
