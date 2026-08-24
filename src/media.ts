import { api } from './api';
import { getCachedMediaBlob, cacheMediaBlobById } from './offlineDb';

// Cached object URLs for server media (fetched with auth header).
const cache = new Map<number, string>();
const MAX_CACHED_MEDIA = 100;

export async function getMediaUrl(mediaId: number): Promise<string> {
  const hit = cache.get(mediaId);
  if (hit) return hit;
  // Try IndexedDB cache first
  try {
    const cachedBlob = await getCachedMediaBlob(mediaId);
    if (cachedBlob) {
      const url = URL.createObjectURL(cachedBlob);
      cache.set(mediaId, url);
      return url;
    }
  } catch { /* ignore */ }
  const blob = await api.fetchMediaBlob(mediaId);
  const url = URL.createObjectURL(blob);
  cache.set(mediaId, url);
  // Cache blob in IndexedDB for offline use
  cacheMediaBlobById(mediaId, blob).catch(() => {});
  while (cache.size > MAX_CACHED_MEDIA) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    URL.revokeObjectURL(cache.get(oldest)!);
    cache.delete(oldest);
  }
  return url;
}

export function clearMediaCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export async function downloadMedia(media: { id: number; name: string }): Promise<void> {
  const blob = await api.fetchMediaBlob(media.id, true);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = media.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Compute a compact waveform (peak bars) from decoded audio data.
export function computeWaveform(channel: Float32Array, bars = 48): number[] {
  const out: number[] = [];
  const block = Math.max(1, Math.floor(channel.length / bars));
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    const start = i * block;
    const end = Math.min(channel.length, start + block);
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > sum) sum = v;
    }
    out.push(Math.min(1, sum * 1.4));
  }
  return out;
}
