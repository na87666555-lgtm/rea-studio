// Uploaded files live in this browser's IndexedDB (not localStorage, which is
// too small). Chat messages keep only metadata and a small preview.

const DB_NAME = 'rea-files';
const STORE = 'files';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PY_UPLOAD_DIR = '/home/pyodide/uploads';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const putFile = (id, blob) => tx('readwrite', s => s.put(blob, id));
export const getFile = id => tx('readonly', s => s.get(id));
export const deleteFiles = ids => tx('readwrite', s => { ids.forEach(id => s.delete(id)); });
export const clearFiles = () => tx('readwrite', s => s.clear());

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|ts|tsx|jsx|py|ipynb|html?|css|xml|ya?ml|toml|ini|cfg|srt|vtt|log|java|kt|c|cc|cpp|h|hpp|cs|go|rs|rb|php|sh|bat|ps1|sql|r|swift|dart|lua)$/i;

export function kindOf(file) {
  const t = (file.type || '').toLowerCase();
  const n = (file.name || '').toLowerCase();
  if (/^image\/(png|jpe?g|webp|gif|bmp)$/.test(t)) return 'image';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/.test(n)) return 'audio';
  if (t.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|3gp)$/.test(n)) return 'video';
  if (t.startsWith('text/') || t === 'application/json' || TEXT_EXT.test(n)) return 'text';
  return 'other';
}

export const KIND_ICON = { image: '🖼', pdf: '📕', audio: '🎵', video: '🎬', text: '📄', other: '📎' };

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A file name that is safe as a path inside Python's file system.
export function safeName(name) {
  const cleaned = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return cleaned.slice(-120) || 'file';
}

function canvasBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function drawScaled(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs become white, not black, as JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

// Photos are shrunk to at most 1568px on the long side (what vision models
// use anyway) and saved as JPEG, plus a small preview for the chat bubble.
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const big = await drawScaled(bitmap, 1568);
    const blob = await canvasBlob(big, 'image/jpeg', 0.85);
    const small = await drawScaled(bitmap, 240);
    const thumb = small.toDataURL('image/jpeg', 0.7);
    return { blob, thumb, type: 'image/jpeg' };
  } finally {
    bitmap.close?.();
  }
}

// Saves a picked file and returns its attachment metadata.
export async function addAttachment(file, id) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`"${file.name}" बहुत बड़ी है (${formatSize(file.size)})। ज़्यादा से ज़्यादा ${formatSize(MAX_FILE_BYTES)}।`);
  let kind = kindOf(file);
  let blob = file;
  let type = file.type || 'application/octet-stream';
  let thumb = null;
  if (kind === 'image') {
    try {
      ({ blob, thumb, type } = await prepareImage(file));
    } catch {
      kind = 'other'; // e.g. a format this browser can't decode
    }
  }
  await putFile(id, blob);
  return { id, name: safeName(file.name), type, size: blob.size, kind, thumb };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
