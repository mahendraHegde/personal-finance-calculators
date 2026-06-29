// Persists the non-extractable vault key (and its salt) in a tiny dedicated
// IndexedDB store. The CryptoKey survives refreshes so we prompt for the
// passphrase only once per unlock — yet the key bytes can never be read out.
// Browser-only (the key derivation/round-trip is what we unit-test in Node).

import type { KdfParams } from "./vault";

const DB_NAME = "pf-vault";
const STORE = "keys";
const KEY_ID = "vault";

interface StoredKey {
  id: string;
  key: CryptoKey; // structured-clonable even when non-extractable
  kdf: KdfParams;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveVaultKey(key: CryptoKey, kdf: KdfParams): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id: KEY_ID, key, kdf } satisfies StoredKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadVaultKey(): Promise<{ key: CryptoKey; kdf: KdfParams } | null> {
  const db = await open();
  const result = await new Promise<StoredKey | undefined>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID);
    req.onsuccess = () => resolve(req.result as StoredKey | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result ? { key: result.key, kdf: result.kdf } : null;
}

export async function clearVaultKey(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
