// Stockage local (IndexedDB « vintrend-studio ») : l'article en cours et les photos reçues par « Partager ».
// createStore(openDB) : openDB() -> {get,put,del,drain}(table, ...) ; idbOpen en est l'implémentation IndexedDB.
// Tables : item (clé « current »), shared (clé numérique croissante).
const TABLES = ['item', 'shared'];

export function idbOpen() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open('vintrend-studio', 1);
    rq.onupgradeneeded = () => TABLES.forEach((t) => rq.result.createObjectStore(t));
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const run = (t, mode, f) => new Promise((ok, ko) => {
        const tx = db.transaction(t, mode), r = f(tx.objectStore(t));
        tx.oncomplete = () => ok(r.result);
        tx.onerror = tx.onabort = () => ko(tx.error);
      });
      resolve({
        get: (t, k) => run(t, 'readonly', (s) => s.get(k)),
        put: (t, k, v) => run(t, 'readwrite', (s) => s.put(v, k)),
        del: (t, k) => run(t, 'readwrite', (s) => s.delete(k)),
        // Lit puis vide dans UNE transaction readwrite (atomique).
        drain: (t) => new Promise((ok, ko) => {
          const tx = db.transaction(t, 'readwrite'), s = tx.objectStore(t), r = s.getAll();
          r.onsuccess = () => s.clear();
          tx.oncomplete = () => ok(r.result);
          tx.onerror = tx.onabort = () => ko(tx.error);
        }),
      });
    };
  });
}

export function createStore(openDB = idbOpen) {
  let db; const open = () => (db ??= openDB());
  let seq = 0;
  const saveItem = async (item) => (await open()).put('item', 'current', item);
  const loadItem = async () => (await (await open()).get('item', 'current')) ?? null;
  const clearItem = async () => (await open()).del('item', 'current');
  // Efface l'article s'il n'a pas bougé depuis plus de `days` jours ; renvoie true si effacé.
  const purgeStale = async (nowMs, days = 7) => {
    const it = await loadItem();
    if (!it || nowMs - it.updatedAt <= days * 864e5) return false;
    await clearItem();
    return true;
  };
  const putShared = async (files) => { const d = await open(); for (const f of files) await d.put('shared', Date.now() + (seq++ % 1000) / 1000, f); };
  const takeShared = async () => { return (await open()).drain('shared'); };
  return { saveItem, loadItem, clearItem, purgeStale, putShared, takeShared };
}
