import { generateKeyPair, exportPublicKey, fingerprintOf } from './e2e';
import { api } from '../api';
import { cache } from '../db/indexeddb';

function storeId(userId: number): string {
  return `e2e-keys:${userId}`;
}

let keysDbPromise: Promise<IDBDatabase> | null = null;
function openKeysDb(): Promise<IDBDatabase> {
  if (keysDbPromise) return keysDbPromise;
  keysDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('messenger-keys', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('keys')) req.result.createObjectStore('keys', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { keysDbPromise = null; reject(req.error); };
  });
  return keysDbPromise;
}

async function idbGet(userId: number): Promise<{
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
  signedPrekey?: { id: number; privateKey: CryptoKey; publicJwk: JsonWebKey };
  prekeyCounter?: number;
  prekeyCreatedAt?: number;
} | null> {
  const db = await openKeysDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readonly');
    const get = tx.objectStore('keys').get(storeId(userId));
    get.onsuccess = () => resolve(get.result ?? null);
    get.onerror = () => reject(get.error);
  });
}

async function idbPut(userId: number, value: unknown): Promise<void> {
  const db = await openKeysDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put({ id: storeId(userId), ...(value as object) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const cached = new Map<number, {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
  signedPrekey?: { id: number; privateKey: CryptoKey; publicJwk: JsonWebKey };
  prekeyCounter?: number;
  prekeyCreatedAt?: number;
}>();

export async function ensureE2EKeys(userId: number): Promise<{
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
  signedPrekey?: { id: number; privateKey: CryptoKey; publicJwk: JsonWebKey };
  prekeyCounter?: number;
  prekeyCreatedAt?: number;
}> {
  const inMemory = cached.get(userId);
  if (inMemory) return inMemory;

  let stored = await idbGet(userId);
  if (!stored?.privateKey || !stored.publicJwk) {
    const pair = await generateKeyPair();
    const publicJwk = await exportPublicKey(pair.publicKey);
    const fingerprint = await fingerprintOf(publicJwk);
    stored = { privateKey: pair.privateKey, publicJwk, fingerprint, prekeyCounter: 0 };
  }

  await api.uploadE2EKey(stored.publicJwk, stored.fingerprint);

  // Register device for multi-device E2E
  try {
    const deviceId = localStorage.getItem('e2e_device_id');
    const existingDevices = await api.listE2EDevices();
    const thisDeviceExists = existingDevices.some((d: any) => String(d.id) === String(deviceId));
    if (!thisDeviceExists) {
      const label = navigator.userAgent.slice(0, 100);
      const res = await api.registerE2EDevice(label, JSON.stringify(stored.publicJwk));
      if (res.id) localStorage.setItem('e2e_device_id', String(res.id));
    }
  } catch { /* ignore device registration errors */ }

  // Generate signed prekey if missing, or rotate if older than 7 days
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  if (!stored.signedPrekey || (stored.prekeyCreatedAt && now - stored.prekeyCreatedAt > WEEK_MS)) {
    const spkId = stored.signedPrekey ? (stored.signedPrekey.id + 1) : 1;
    const spkPair = await generateKeyPair();
    const spkJwk = await exportPublicKey(spkPair.publicKey);
    // Generate a separate ECDSA key for signing (ECDH keys cannot sign)
    const signingPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const dataToSign = new TextEncoder().encode(JSON.stringify({ prekey_id: spkId, jwk: spkJwk }));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingPair.privateKey, dataToSign);
    const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
    await api.uploadSignedPrekey(spkId, spkJwk, sigBase64);
    stored.signedPrekey = { id: spkId, privateKey: spkPair.privateKey, publicJwk: spkJwk };
    stored.prekeyCreatedAt = Date.now();
  }

  // Upload one-time prekeys in batches
  const counter = stored.prekeyCounter ?? 0;
  if (counter < 20) {
    const batch: Array<{ prekey_id: number; public_jwk: JsonWebKey }> = [];
    for (let i = counter; i < counter + 10; i++) {
      const otp = await generateKeyPair();
      const otpJwk = await exportPublicKey(otp.publicKey);
      batch.push({ prekey_id: i, public_jwk: otpJwk });
    }
    await api.uploadOneTimePrekeys(batch);
    stored.prekeyCounter = counter + 10;
  }

  await idbPut(userId, stored);
  cached.set(userId, stored);
  return stored;
}

export async function getE2EKeys(userId: number) {
  return ensureE2EKeys(userId);
}

export function clearE2EKeyCache(userId?: number): void {
  if (userId === undefined) cached.clear();
  else cached.delete(userId);
}

export { cache };
