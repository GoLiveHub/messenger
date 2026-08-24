// Client-side image compression before upload.
// Resizes images larger than maxWidth/maxHeight and compresses to JPEG quality.

export async function compressImage(
  file: File,
  maxWidth = 1920,
  maxHeight = 1920,
  quality = 0.82,
): Promise<Blob> {
  // Only compress images
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;
  // Skip small files (< 100KB)
  if (file.size < 100 * 1024) return file;

  const img = await loadImage(file);
  let { width, height } = img;

  // Scale down if needed
  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob ?? file),
      'image/jpeg',
      quality,
    );
  });
}

// Generate a thumbnail (square, small)
export async function generateThumbnail(
  file: File,
  size = 200,
): Promise<Blob | null> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return null;

  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Center-crop to square
  const minDim = Math.min(img.width, img.height);
  const sx = (img.width - minDim) / 2;
  const sy = (img.height - minDim) / 2;
  ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')); };
    img.src = URL.createObjectURL(file);
  });
}

// Resumable upload: split file into chunks and upload with resume support.
export async function resumableUpload(
  chatId: number,
  kind: string,
  file: File,
  name: string,
  mime: string,
  extra?: Record<string, string>,
  onProgress?: (pct: number) => void,
): Promise<{ media: { id: number } }> {
  const CHUNK_SIZE = 512 * 1024; // 512KB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // For small files, use regular upload
  if (file.size <= CHUNK_SIZE * 2) {
    const form = new FormData();
    form.append('chatId', String(chatId));
    form.append('kind', kind);
    form.append('file', file, name);
    if (extra) Object.entries(extra).forEach(([k, v]) => form.append(k, v));
    const res = await fetch('/api/media', { method: 'POST', body: form, credentials: 'include' });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  }

  // Initiate resumable upload
  const initRes = await fetch('/api/media/upload-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ chatId, kind, name, mime, totalChunks, size: file.size, ...(extra || {}) }),
  });
  if (!initRes.ok) throw new Error('Failed to initiate upload');
  const { uploadId } = await initRes.json();

  // Upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    const chunkForm = new FormData();
    chunkForm.append('uploadId', uploadId);
    chunkForm.append('chunkIndex', String(i));
    chunkForm.append('chunk', chunk);

    const res = await fetch('/api/media/upload-chunk', {
      method: 'POST',
      body: chunkForm,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Chunk ${i} upload failed`);

    onProgress?.(Math.round(((i + 1) / totalChunks) * 100));
  }

  // Finalize upload
  const finalRes = await fetch('/api/media/upload-finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ uploadId }),
  });
  if (!finalRes.ok) throw new Error('Failed to finalize upload');
  return finalRes.json();
}
