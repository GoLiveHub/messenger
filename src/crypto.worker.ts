// Web Worker for heavy crypto operations.
// Offloads encrypt/decrypt/ratchet off the main thread.

import type { JsonWebKey } from 'crypto';

interface WorkerRequest {
  id: number;
  type: 'encrypt' | 'decrypt' | 'ratchet' | 'deriveKey';
  payload: unknown;
}

function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function deriveSharedKey(privateKeyJwk: JsonWebKey, peerPublicKey: JsonWebKey): Promise<CryptoKey> {
  const privateKey = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
  const peer = await importPublicKey(peerPublicKey);
  const rawSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', rawSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('messenger-e2e-v1') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function encryptMessage(key: CryptoKey, plaintext: string, associatedData?: Uint8Array): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (associatedData) params.additionalData = associatedData;
  const ct = await crypto.subtle.encrypt(params, key, encoded);
  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

async function decryptMessage(key: CryptoKey, ciphertextB64: string, ivB64: string, associatedData?: Uint8Array): Promise<string> {
  const ct = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (associatedData) params.additionalData = associatedData;
  const pt = await crypto.subtle.decrypt(params, key, ct);
  return new TextDecoder().decode(pt);
}

async function ratchetStep(keyJwk: JsonWebKey, direction: 'send' | 'recv'): Promise<{ newKeyJwk: JsonWebKey; chainKey: string }> {
  const key = await crypto.subtle.importKey('jwk', keyJwk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = new TextEncoder().encode(direction === 'send' ? 'msg-send' : 'msg-recv');
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const newKeyRaw = new Uint8Array(sig);
  const newKey = await crypto.subtle.importKey('raw', newKeyRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const newKeyJwk = await crypto.subtle.exportKey('jwk', newKey);
  return { newKeyJwk, chainKey: btoa(String.fromCharCode(...newKeyRaw)) };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = e.data;
  try {
    let result: unknown;
    switch (type) {
      case 'deriveKey': {
        const p = payload as { privateKeyJwk: JsonWebKey; peerPublicKey: JsonWebKey };
        const key = await deriveSharedKey(p.privateKeyJwk, p.peerPublicKey);
        result = await crypto.subtle.exportKey('jwk', key);
        break;
      }
      case 'encrypt': {
        const p = payload as { keyJwk: JsonWebKey; plaintext: string; associatedData?: string };
        const key = await crypto.subtle.importKey('jwk', p.keyJwk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const ad = p.associatedData ? new TextEncoder().encode(p.associatedData) : undefined;
        result = await encryptMessage(key, p.plaintext, ad);
        break;
      }
      case 'decrypt': {
        const p = payload as { keyJwk: JsonWebKey; ciphertext: string; iv: string; associatedData?: string };
        const key = await crypto.subtle.importKey('jwk', p.keyJwk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        const ad = p.associatedData ? new TextEncoder().encode(p.associatedData) : undefined;
        result = await decryptMessage(key, p.ciphertext, p.iv, ad);
        break;
      }
      case 'ratchet': {
        result = await ratchetStep(payload.keyJwk, payload.direction);
        break;
      }
    }
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
