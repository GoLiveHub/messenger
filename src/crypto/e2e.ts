// Client-side E2E encryption for Secret Chats.
// Flow (mirrors Telegram's Secret Chats):
//   1. Each client generates an ECDH P-256 keypair.
//   2. Public key (JWK) + fingerprint is uploaded to the server.
//   3. When opening a secret chat, both clients derive a shared key:
//      HKDF(ECDH(myPrivate, peerPublic)) -> AES-256-GCM key.
//   4. Messages are encrypted client-side; the server only relays ciphertext.
// The server never sees the plaintext of secret chats.
//
// Heavy operations (deriveSharedKey, encryptSecret, decryptSecret) are
// offloaded to a Web Worker when available, falling back to main thread.

import {
  workerEncrypt,
  workerDecrypt,
  isWorkerAvailable,
} from './cryptoWorkerClient';

export interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey'],
  );
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', publicKey);
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

// Import an AES-GCM JWK (used for re-importing keys returned by the worker).
async function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function fingerprintOf(jwk: JsonWebKey): Promise<string> {
  const raw = JSON.stringify({ crv: jwk.crv, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function deriveSharedKey(
  privateKey: CryptoKey,
  peerPublicKey: JsonWebKey,
): Promise<CryptoKey> {
  // NOTE: no Web Worker path here. The worker used a different salt/info
  // ("messenger-e2e-v1" / empty salt) than this function, so depending on
  // whether a worker was available the two clients derived *different* root
  // keys and the session never matched. ECDH + one HKDF is microsecond-fast,
  // so we always derive on the main thread for consistency.
  const peer = await importPublicKey(peerPublicKey);
  const rawSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', rawSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('messenger-secret-chat-v1'),
      info: new TextEncoder().encode('messenger-shared-key'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so we can export the raw root seed below
    ['encrypt', 'decrypt'],
  );
}

// ---- X3DH Key Agreement ----
// Correct X3DH: initiator generates ephemeral keypair.
// DH1 = ECDH(IKa, SPKb), DH2 = ECDH(EKa, IKb), DH3 = ECDH(EKa, SPKb), DH4 = ECDH(EKa, OPKb)
// Session key = HKDF(DH1 || DH2 || DH3 || DH4)

export async function ecdhDeriveBits(
  privateKey: CryptoKey,
  peerPublicKey: JsonWebKey,
  bits = 256,
): Promise<ArrayBuffer> {
  const peer = await importPublicKey(peerPublicKey);
  return crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, bits);
}

export async function x3dh(
  identityPrivate: CryptoKey,
  signedPrekeyPublic: JsonWebKey,
  oneTimePrekeyPublic: JsonWebKey | null,
  identityKeyPublic: JsonWebKey,
): Promise<{ key: CryptoKey; ephemeralPublic: JsonWebKey }> {
  // Generate ephemeral keypair for DH2/DH3/DH4
  const ephemeral = await generateKeyPair();
  const ephemeralPublicJwk = await exportPublicKey(ephemeral.publicKey);

  // DH1 = ECDH(IKa_priv, SPKb_pub) — identity private with responder's signed prekey
  const dh1 = await ecdhDeriveBits(identityPrivate, signedPrekeyPublic);
  // DH2 = ECDH(EKa_priv, IKb_pub) — ephemeral with responder's identity key
  const dh2 = await ecdhDeriveBits(ephemeral.privateKey, identityKeyPublic);
  // DH3 = ECDH(EKa_priv, SPKb_pub) — ephemeral with responder's signed prekey
  const dh3 = await ecdhDeriveBits(ephemeral.privateKey, signedPrekeyPublic);

  const dhParts = [new Uint8Array(dh1), new Uint8Array(dh2), new Uint8Array(dh3)];
  if (oneTimePrekeyPublic) {
    // DH4 = ECDH(EKa_priv, OPKb_pub) — ephemeral with one-time prekey
    const dh4 = await ecdhDeriveBits(ephemeral.privateKey, oneTimePrekeyPublic);
    dhParts.push(new Uint8Array(dh4));
  }

  // Concat DH outputs
  const totalLen = dhParts.reduce((s, p) => s + p.length, 0);
  const concat = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of dhParts) { concat.set(p, offset); offset += p.length; }

  const hkdfKey = await crypto.subtle.importKey('raw', concat, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('messenger-x3dh-session-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, ephemeralPublic: ephemeralPublicJwk };
}

// ---- Secret Chat KDF Chains ----
//
// Secret chats use static ECDH for the root key (no X3DH ephemeral transport
// exists in this app, so the old X3DH path could never converge — both sides
// generated their *own* ephemeral and never exchanged it, producing different
// keys). Each client derives the shared root key symmetrically, then splits it
// into two independent KDF chains (send / recv). Roles are assigned
// deterministically by user id so both clients build the *same* mapping:
//   - the user with the LOWER id sends on chain "a"  and receives on chain "b"
//   - the user with the HIGHER id sends on chain "b" and receives on chain "a"
// This makes A's send chain equal to B's receive chain, and vice versa.
//
// Chain values are kept as raw 32-byte arrays (NOT opaque CryptoKeys) so the
// ratchet never needs exportKey() and cannot hit "key is not extractable".
// Each KDF step derives the next chain value and the per-message AES key.

export interface RatchetState {
  rootKey: CryptoKey;
  sendKey: Uint8Array; // raw 32-byte current send-chain value
  recvKey: Uint8Array; // raw 32-byte current receive-chain value
  messageNum: number; // total messages sent (used for display/tests)
  prevChainLen: number;
  skippedKeys: Map<string, CryptoKey>;
}

// Derive a 32-byte chain seed from the root raw key material + a domain label.
async function chainSeed(rootRaw: Uint8Array, domain: string): Promise<Uint8Array> {
  const hkdfKey = await crypto.subtle.importKey('raw', rootRaw as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  const info = new TextEncoder().encode(`messenger-chain-${domain}-v1`);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('messenger-secret-chat-v1'), info },
    hkdfKey,
    256,
  );
  return new Uint8Array(bits);
}

// Build a session from the symmetric root key. Both sides call this and get an
// identical, correctly-role-assigned session.
export async function setupSecretSession(
  rootKey: CryptoKey,
  myId: number,
  peerId: number,
): Promise<RatchetState> {
  const rootRaw = new Uint8Array(await crypto.subtle.exportKey('raw', rootKey));
  const seedA = await chainSeed(rootRaw, 'a');
  const seedB = await chainSeed(rootRaw, 'b');
  const iAmLower = myId < peerId;
  return {
    rootKey,
    sendKey: iAmLower ? seedA : seedB,
    recvKey: iAmLower ? seedB : seedA,
    messageNum: 0,
    prevChainLen: 0,
    skippedKeys: new Map(),
  };
}

export function createEmptyRatchet(): RatchetState {
  throw new Error('Use setupSecretSession() to initialize a secret session');
}

// Advance a chain: returns the next chain value and the AES key for the
// *current* chain value (the message is encrypted with the key being consumed).
export async function ratchetStep(
  currentChain: Uint8Array,
): Promise<{ chainKey: Uint8Array; messageKey: CryptoKey }> {
  const next = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...currentChain, 0x01])));
  const messageKey = await crypto.subtle.importKey(
    'raw',
    currentChain as Uint8Array<ArrayBuffer>,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { chainKey: next, messageKey };
}

// Import a raw chain value into an AES key (for the receive direction, where we
// don't step the chain until the message key has been used).
export async function chainKeyToAes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw as Uint8Array<ArrayBuffer>,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Save a skipped message key so out-of-order messages can still be decrypted.
export function saveSkippedKey(state: RatchetState, chain: string, msgNum: number, key: CryptoKey): RatchetState {
  const map = new Map(state.skippedKeys);
  map.set(`raw:${chain}:${msgNum}`, key);
  if (map.size > 1000) {
    const keys = Array.from(map.keys());
    for (let i = 0; i < 200; i++) map.delete(keys[i]);
  }
  return { ...state, skippedKeys: map };
}

export function getSkippedKey(state: RatchetState, chain: string, msgNum: number): CryptoKey | undefined {
  return state.skippedKeys.get(`raw:${chain}:${msgNum}`);
}

export function removeSkippedKey(state: RatchetState, chain: string, msgNum: number): RatchetState {
  const map = new Map(state.skippedKeys);
  map.delete(`raw:${chain}:${msgNum}`);
  return { ...state, skippedKeys: map };
}

export function ratchetStateToBytes(state: RatchetState): string {
  return JSON.stringify({ messageNum: state.messageNum, prevChainLen: state.prevChainLen });
}

// ---- Encryption / Decryption with per-message keys ----

export async function encryptSecret(
  key: CryptoKey,
  text: string,
): Promise<{ cipher: string; iv: string }> {
  // Try Web Worker
  if (isWorkerAvailable()) {
    try {
      const keyJwk = await crypto.subtle.exportKey('jwk', key);
      const result = await workerEncrypt(keyJwk, text);
      return { cipher: result.ciphertext, iv: result.iv };
    } catch { /* fall through */ }
  }
  // Main-thread fallback
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { cipher: bytesToBase64(new Uint8Array(cipher)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(
  key: CryptoKey,
  cipher: string,
  iv: string,
): Promise<string> {
  // Try Web Worker
  if (isWorkerAvailable()) {
    try {
      const keyJwk = await crypto.subtle.exportKey('jwk', key);
      return await workerDecrypt(keyJwk, cipher, iv);
    } catch { /* fall through */ }
  }
  // Main-thread fallback
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(cipher),
  );
  return new TextDecoder().decode(plain);
}

// ---- Safety Numbers ----

export async function safetyNumber(
  myIdentityJwk: JsonWebKey,
  peerIdentityJwk: JsonWebKey,
): Promise<string> {
  const parts = [
    { crv: myIdentityJwk.crv, x: myIdentityJwk.x, y: myIdentityJwk.y },
    { crv: peerIdentityJwk.crv, x: peerIdentityJwk.x, y: peerIdentityJwk.y },
  ];
  // Sort deterministically by x coordinate
  parts.sort((a, b) => (a.x ?? '').localeCompare(b.x ?? ''));
  const raw = JSON.stringify(parts);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Utility ----

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- File Encryption / Decryption (AES-GCM) ----

export async function encryptFile(file: ArrayBuffer, key: CryptoKey): Promise<{ encrypted: ArrayBuffer; iv: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, file);
  return { encrypted, iv: iv.buffer };
}

export async function decryptFile(encrypted: ArrayBuffer, iv: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, encrypted);
}

export async function generateFileKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportFileKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(raw));
}

export async function importFileKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(b64), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---- Multi-Device E2E ----

export interface E2EDevice {
  id: number;
  user_id: number;
  device_label: string;
  identity_key: string; // JSON JWK
  created_at: string;
}

export async function encryptFileKeyForDevices(
  fileKeyB64: string,
  devices: E2EDevice[],
): Promise<Array<{ device_id: number; encrypted_key: string; iv: string }>> {
  const results: Array<{ device_id: number; encrypted_key: string; iv: string }> = [];
  for (const device of devices) {
    try {
      const identityJwk = JSON.parse(device.identity_key) as JsonWebKey;
      const peerPublic = await importPublicKey(identityJwk);
      // Derive a symmetric key from the raw public point for wrapping
      const rawPoint = await crypto.subtle.importKey('jwk', identityJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const ephemeral = await generateKeyPair();
      const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: rawPoint }, ephemeral.privateKey, 256);
      const wrapKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
      const aesKey = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('messenger-device-wrap-v1') },
        wrapKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const fileKeyBytes = base64ToBytes(fileKeyB64);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, fileKeyBytes);
      results.push({
        device_id: device.id,
        encrypted_key: bytesToBase64(new Uint8Array(enc)),
        iv: bytesToBase64(iv),
      });
    } catch {
      // Skip devices that can't be reached
    }
  }
  return results;
}
