// ─────────────────────────────────────────────────────────────
//  FILE STORE (IndexedDB)
//
//  Uploaded document files used to be saved as base64 inside
//  localStorage, which shares a ~5MB quota with the whole HRMS
//  DB — a few uploads could brick persistence. Files now live in
//  IndexedDB (hundreds of MB available); localStorage only keeps
//  lightweight metadata.
//
//  ➜ When the real backend lands, replace these with upload /
//    download calls (e.g. POST /api/files, GET /api/files/:id).
// ─────────────────────────────────────────────────────────────

const DB_NAME = 'Smaatech_hrms_files';
const STORE = 'files';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = run(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function putFile(id, blob) {
  const db = await openDB();
  await tx(db, 'readwrite', (s) => s.put(blob, id));
}

export async function getFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFile(id) {
  const db = await openDB();
  await tx(db, 'readwrite', (s) => s.delete(id));
}

// Converts legacy base64 data-URLs (old localStorage format) to Blobs
export function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const mime = /data:(.*?);/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
