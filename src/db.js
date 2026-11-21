// Almacenamiento local en IndexedDB: sesiones, fotos individuales y panorámicas.
const NAME = 'pano360', VERSION = 1;
let dbp = null;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      const frames = db.createObjectStore('frames', { keyPath: 'key', autoIncrement: true });
      frames.createIndex('session', 'sessionId');
      db.createObjectStore('panos', { keyPath: 'sessionId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { reject(e); try { t.abort(); } catch { /* ya cerrada */ } });
  });
}

export const putSession = (s) => tx(['sessions'], 'readwrite', (t) => wrap(t.objectStore('sessions').put(s)));
export const getSession = (id) => tx(['sessions'], 'readonly', (t) => wrap(t.objectStore('sessions').get(id)));
export const listSessions = async () =>
  (await tx(['sessions'], 'readonly', (t) => wrap(t.objectStore('sessions').getAll()))).sort((a, b) => b.created - a.created);

export const addFrame = (frame) => tx(['frames'], 'readwrite', (t) => wrap(t.objectStore('frames').add(frame)));
export const getFrames = async (sessionId) =>
  (await tx(['frames'], 'readonly', (t) => wrap(t.objectStore('frames').index('session').getAll(sessionId))))
    .sort((a, b) => a.meta.idx - b.meta.idx);
export const deleteFrameByKey = (key) => tx(['frames'], 'readwrite', (t) => wrap(t.objectStore('frames').delete(key)));

export const putPano = (p) => tx(['panos'], 'readwrite', (t) => wrap(t.objectStore('panos').put(p)));
export const getPano = (sessionId) => tx(['panos'], 'readonly', (t) => wrap(t.objectStore('panos').get(sessionId)));

export function deleteFrames(sessionId) {
  return tx(['frames'], 'readwrite', (t) => new Promise((res, rej) => {
    const req = t.objectStore('frames').index('session').openKeyCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res();
      t.objectStore('frames').delete(c.primaryKey);
      c.continue();
    };
    req.onerror = () => rej(req.error);
  }));
}

export async function deleteSession(id) {
  await deleteFrames(id);
  await tx(['sessions', 'panos'], 'readwrite', (t) => {
    t.objectStore('sessions').delete(id);
    t.objectStore('panos').delete(id);
  });
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage, quota: e.quota };
  } catch { return null; }
}

export function requestPersistence() {
  try { return navigator.storage?.persist?.(); } catch { return null; }
}
