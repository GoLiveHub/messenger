// Minimal IndexedDB wrapper for local caching (mirrors Telegram Web's
// offline-first approach where IndexedDB is the local source of truth).

const DB_NAME = 'messenger-cache';
const DB_VERSION = 1;

let cachedDbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (cachedDbPromise) return cachedDbPromise;
  cachedDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('chat_id', 'chat_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { cachedDbPromise = null; reject(req.error); };
    req.onblocked = () => { /* keep the promise open; upgrade can retry */ };
  });
  return cachedDbPromise;
}

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const cache = {
  async putChats(chats: unknown[]) {
    for (const c of chats) await tx('chats', 'readwrite', (s) => s.put(c));
  },
  async getChats<T = unknown[]>(): Promise<T> {
    return tx('chats', 'readonly', (s) => s.getAll()) as Promise<T>;
  },
  async putMessages(chatId: number, messages: unknown[]) {
    for (const m of messages) await tx('messages', 'readwrite', (s) => s.put(m));
    // keep a simple key for the chat's message list freshness
    await tx('messages', 'readwrite', (s) => s.put({ id: `meta-${chatId}`, count: messages.length }));
  },
  async getMessages<T = unknown[]>(chatId: number): Promise<T> {
    return tx('messages', 'readonly', (s) => {
      const idx = s.index('chat_id');
      return idx.getAll(IDBKeyRange.only(chatId)) as unknown as IDBRequest<T>;
    });
  },
};
