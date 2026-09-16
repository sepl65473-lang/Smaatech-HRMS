import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import Document from '../models/Document.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import {
  savePhoto, readPhoto, deleteFileRef, wrapUpload,
  safeExtension, randomFilename, contentTypeForRef, isDurableStorage,
} from '../lib/photoStorage.js';
import Employee from '../models/Employee.js';
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
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 25 },
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

  const { page, limit, folder, type } = req.query;
  const combinedFilter = { ...filter, ...visibilityFilter };
  if (folder) combinedFilter.folder = folder;
  if (type) combinedFilter.type = type;

  if (!page && !limit) {
    const DEFAULT_CAP = 100;
    const docs = await Document.find(combinedFilter).sort({ createdAt: -1 }).limit(DEFAULT_CAP);
    return res.json(docs);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [docs, total] = await Promise.all([
    Document.find(combinedFilter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    Document.countDocuments(combinedFilter),
  ]);
  res.json({ rows: docs, total, page: pageNum, limit: limitNum });
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
    // Never build a stored filename out of the client-supplied originalname,
    // and never trust its extension: safeExtension() collapses anything off
    // the allow-list, randomFilename() adds 12 bytes of real entropy so a
    // stored ref can't be guessed from a timestamp.
    fileRef = await savePhoto('documents', randomFilename(safeExtension(req.file.originalname, '.pdf')), req.file.buffer);
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
    updateData.fileRef = await savePhoto('documents', randomFilename(safeExtension(req.file.originalname, '.pdf')), req.file.buffer);
    if (before.fileRef) await deleteFileRef(before.fileRef);
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
  if (before.fileRef) await deleteFileRef(before.fileRef);

  await logAudit(req, { action: 'Document removed', subject: before.title, before });
  res.json({ id: req.params.id });
});

// Download document file.
//
// Objects live in a PRIVATE bucket (or a non-served local directory) — there
// is no public URL for any of them. When object storage is configured, the
// caller gets a short-lived pre-signed URL AFTER passing the same
// authorization check that guards the streaming path below; otherwise the
// bytes are streamed back through this authenticated request.
router.get('/:id/download', async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });

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
    // 'private' is owner + HR Director only; anything unrecognised is treated
    // as private rather than defaulting open.
    if (!['all', 'hr', 'finance'].includes(doc.visibility)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied.' } });
    }
  }

  if (!doc.fileRef) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No file reference exists for this document.' } });
  }

  const safeTitle = doc.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'download';
  const downloadName = `${safeTitle}${path.extname(doc.fileRef) || '.pdf'}`;

  await logAudit(req, { action: 'Document downloaded', subject: doc.title, details: `visibility: ${doc.visibility}` });

  // Signed-URL mode is OPT-IN (?mode=url), not the default.
  //
  // client/src/data/store.js downloads via apiFetchBlob() with
  // responseType:'blob' and hands the result to URL.createObjectURL. Returning
  // a JSON envelope by default meant that the moment real object storage was
  // configured — the exact P0 fix operators are told to deploy — every
  // download saved a file containing {"url":"https://..."} instead of the
  // document. Streaming stays the default so the shipped client keeps working.
  // Streaming is the only mode. GridFS has no pre-signed URL, and the client
  // (client/src/data/store.js) downloads via apiFetchBlob with
  // responseType:'blob' — a JSON envelope here would save a file containing
  // {"url":...} instead of the document.

  const buffer = await readPhoto(doc.fileRef);
  if (!buffer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document file missing on server.' } });

  // Derive the type from the stored ref's real extension, not from the
  // client-settable `type` metadata field.
  res.setHeader('Content-Type', contentTypeForRef(doc.fileRef));
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

export default router;
