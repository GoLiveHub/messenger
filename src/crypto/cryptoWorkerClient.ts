// Offloads heavy crypto to a Web Worker when available.
// Falls back to main-thread crypto.subtle if worker is unavailable.
//
// All functions accept/return JWK (serializable) — callers must
// export/import CryptoKey themselves before calling.

type WorkerResult = { result: unknown } | { error: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('../crypto.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number } & WorkerResult>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if ('error' in e.data) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = () => {
      // Worker crashed — next call will create a new one
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function postMsg<T>(type: string, payload: unknown): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('Worker unavailable'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, type, payload });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Worker timeout'));
      }
    }, 10_000);
  });
}

export async function workerDeriveSharedKey(
  privateKeyJwk: JsonWebKey,
  peerPublicKeyJwk: JsonWebKey,
): Promise<JsonWebKey> {
  return postMsg<JsonWebKey>('deriveKey', { privateKeyJwk, peerPublicKey: peerPublicKeyJwk });
}

export async function workerEncrypt(
  keyJwk: JsonWebKey,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  return postMsg<{ ciphertext: string; iv: string }>('encrypt', { keyJwk, plaintext });
}

export async function workerDecrypt(
  keyJwk: JsonWebKey,
  ciphertext: string,
  iv: string,
): Promise<string> {
  return postMsg<string>('decrypt', { keyJwk, ciphertext, iv });
}

export function isWorkerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}
