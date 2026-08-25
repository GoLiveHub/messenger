// IndexedDB offline cache for messages and media.
// Provides offline-first read and a sync queue for pending actions.

const DB_NAME = 'messenger_offline';
const DB_VERSION = 1;

let sharedDb: IDBDatabase | null = null;
let sharedDbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (sharedDb && sharedDb.objectStoreNames.length > 0) return Promise.resolve(sharedDb);
  if (sharedDbPromise) return sharedDbPromise;
  sharedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'chat.id' });
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('chat_id', 'chat_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media_blobs')) db.createObjectStore('media_blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sync_queue')) {
        const q = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
        q.createIndex('type', 'type', { unique: false });
        q.createIndex('created_at', 'created_at', { unique: false });
      }
    };
    req.onsuccess = () => {
      sharedDb = req.result;
      req.result.onclose = () => { sharedDb = null; sharedDbPromise = null; };
      req.result.onerror = () => { sharedDb = null; sharedDbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { sharedDbPromise = null; reject(req.error); };
  });
  return sharedDbPromise;
}

async function dbPut<T>(storeName: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result as T | undefined); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result as T[]); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbGetByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const idx = tx.objectStore(storeName).index(indexName);
    const req = idx.getAll(key);
    req.onsuccess = () => { db.close(); resolve(req.result as T[]); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbClear(storeName: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// --- Chat cache ---
export async function cacheChat(chat: Record<string, unknown>): Promise<void> {
  await dbPut('chats', chat);
}

export async function getCachedChats(): Promise<Record<string, unknown>[]> {
  return dbGetAll('chats');
}

// --- Messages cache ---
export async function cacheMessage(msg: Record<string, unknown>): Promise<void> {
  await dbPut('messages', msg);
}

export async function cacheMessages(msgs: Array<Record<string, unknown>>): Promise<void> {
  for (const m of msgs) await dbPut('messages', m);
}

export async function getCachedMessages(chatId: number): Promise<Record<string, unknown>[]> {
  return dbGetByIndex('messages', 'chat_id', chatId);
}

// --- User cache ---
export async function cacheUser(user: Record<string, unknown>): Promise<void> {
  await dbPut('users', user);
}

export async function getCachedUsers(): Promise<Record<string, unknown>[]> {
  return dbGetAll('users');
}

// --- Media blob cache ---
export async function cacheMediaBlob(id: number, blob: Blob): Promise<void> {
  await dbPut('media_blobs', { id, blob, cached_at: Date.now() });
  // Evict oldest entries if cache exceeds 200 MB (check periodically)
  try {
    const db = await openDB();
    const tx = db.transaction('media_blobs', 'readwrite');
    const store = tx.objectStore('media_blobs');
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > 500) {
        // Delete oldest entries
        const cursorReq = store.openCursor();
        let deleted = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && deleted < 100) {
            cursor.delete();
            deleted++;
            cursor.continue();
          }
        };
      }
    };
  } catch { /* ignore eviction errors */ }
}

export async function getCachedMediaBlob(id: number): Promise<Blob | undefined> {
  const entry = await dbGet<{ id: number; blob: Blob }>('media_blobs', id);
  return entry?.blob;
}

export async function clearMediaBlobCache(): Promise<void> {
  await dbClear('media_blobs');
}

// --- Sync queue (offline actions replayed on reconnect) ---
export interface SyncAction {
  type: 'message:send' | 'message:edit' | 'message:delete' | 'message:react' | 'message:pin';
  payload: Record<string, unknown>;
  chatId: number;
  created_at: string;
}

export async function enqueueSync(action: SyncAction): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sync_queue', 'readwrite');
    const req = tx.objectStore('sync_queue').add({ ...action, created_at: action.created_at || new Date().toISOString() });
    req.onsuccess = () => { db.close(); resolve(req.result as number); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function getSyncQueue(): Promise<(SyncAction & { id: number })[]> {
  return dbGetAll('sync_queue');
}

export async function dequeueSync(id: number): Promise<void> {
  await dbDelete('sync_queue', id);
}

export async function clearSyncQueue(): Promise<void> {
  await dbClear('sync_queue');
}

// --- Open for media blob fetch integration ---
export async function cacheMediaBlobById(mediaId: number, blob: Blob): Promise<void> {
  await cacheMediaBlob(mediaId, blob);
}
