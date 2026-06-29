// IndexedDB implementation of StorageAdapter. Browser-only (uses the DOM
// `indexedDB` global); the in-memory adapter mirrors its semantics for tests.
//
// Reads are cursor-based with keyset pagination (`after`) so list views never
// materialise the whole store; aggregates use getAll over a bounded index range.

import type {
  BatchOp,
  Collection,
  Entity,
  ImportMode,
  ImportOptions,
  IndexKey,
  Page,
  PageCursor,
  PageQuery,
  QueryRange,
  StorageAdapter,
  StorageSchema,
} from "./types";
import { compareKeys } from "./keys";

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Build an IDBKeyRange from a QueryRange's bounds. Keyset continuation is
 *  handled separately (via cursor.continuePrimaryKey) so duplicate index keys
 *  aren't skipped. */
function toKeyRange(q: QueryRange): IDBKeyRange | null {
  if (q.equals !== undefined) return IDBKeyRange.only(q.equals as IDBValidKey);
  const lower = q.lower;
  const upper = q.upper;
  const lowerOpen = q.lowerOpen ?? false;
  const upperOpen = q.upperOpen ?? false;
  if (lower !== undefined && upper !== undefined) {
    return IDBKeyRange.bound(lower as IDBValidKey, upper as IDBValidKey, lowerOpen, upperOpen);
  }
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower as IDBValidKey, lowerOpen);
  if (upper !== undefined) return IDBKeyRange.upperBound(upper as IDBValidKey, upperOpen);
  return null;
}

class IdbCollection<T extends Entity> implements Collection<T> {
  private readonly db: IDBDatabase;
  private readonly name: string;

  constructor(db: IDBDatabase, name: string) {
    this.db = db;
    this.name = name;
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }

  private source(store: IDBObjectStore, range?: QueryRange): IDBObjectStore | IDBIndex {
    return range?.index ? store.index(range.index) : store;
  }

  async get(id: string): Promise<T | undefined> {
    return promisify<T | undefined>(this.store("readonly").get(id) as IDBRequest<T | undefined>);
  }

  async put(record: T): Promise<void> {
    const store = this.store("readwrite");
    store.put(record);
    await txDone(store.transaction);
  }

  async putMany(records: T[]): Promise<void> {
    const store = this.store("readwrite");
    for (const r of records) store.put(r);
    await txDone(store.transaction);
  }

  async delete(id: string): Promise<void> {
    const store = this.store("readwrite");
    store.delete(id);
    await txDone(store.transaction);
  }

  async clear(): Promise<void> {
    const store = this.store("readwrite");
    store.clear();
    await txDone(store.transaction);
  }

  async count(range?: QueryRange): Promise<number> {
    const src = this.source(this.store("readonly"), range);
    const kr = range ? toKeyRange(range) : null;
    return promisify<number>(src.count(kr ?? undefined));
  }

  async getAll(range?: QueryRange): Promise<T[]> {
    const src = this.source(this.store("readonly"), range);
    const kr = range ? toKeyRange(range) : null;
    return promisify<T[]>(src.getAll(kr ?? undefined) as IDBRequest<T[]>);
  }

  async page(query: PageQuery): Promise<Page<T>> {
    const dir: IDBCursorDirection = query.direction === "prev" ? "prev" : "next";
    const usingIndex = !!query.index;
    const src = this.source(this.store("readonly"), query);
    const kr = toKeyRange(query);
    const after = query.after;
    const items: T[] = [];
    let last: PageCursor | undefined;

    await new Promise<void>((resolve, reject) => {
      const req = src.openCursor(kr ?? undefined, dir);
      let positioned = !after; // when paginating, jump to the cursor first
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || items.length >= query.limit) {
          resolve();
          return;
        }
        if (!positioned && after) {
          positioned = true;
          // Resume exactly at the (indexKey, id) cursor — never skips rows that
          // merely share an index key.
          if (usingIndex) cursor.continuePrimaryKey(after.key as IDBValidKey, after.id);
          else cursor.continue(after.id);
          return;
        }
        const atBoundary =
          after !== undefined &&
          (cursor.primaryKey as string) === after.id &&
          (usingIndex ? compareKeys(cursor.key as IndexKey, after.key) === 0 : true);
        if (atBoundary) {
          cursor.continue();
          return;
        }
        items.push(cursor.value as T);
        last = { key: cursor.key as IndexKey, id: cursor.primaryKey as string };
        cursor.continue();
      };
    });

    const done = items.length < query.limit;
    return { items, nextCursor: done ? undefined : last, done };
  }
}

class IdbStorage implements StorageAdapter {
  private readonly db: IDBDatabase;
  private readonly schema: StorageSchema;

  constructor(db: IDBDatabase, schema: StorageSchema) {
    this.db = db;
    this.schema = schema;
  }

  collection<T extends Entity>(name: string): Collection<T> {
    return new IdbCollection<T>(this.db, name);
  }

  async batch(ops: BatchOp[]): Promise<void> {
    if (ops.length === 0) return;
    const stores = [...new Set(ops.map((o) => o.collection))];
    const tx = this.db.transaction(stores, "readwrite");
    for (const op of ops) {
      const store = tx.objectStore(op.collection);
      if (op.op === "put") store.put(op.value);
      else store.delete(op.id);
    }
    await txDone(tx);
  }

  async exportAll(): Promise<Record<string, Entity[]>> {
    const out: Record<string, Entity[]> = {};
    for (const spec of this.schema.collections) {
      out[spec.name] = await this.collection<Entity>(spec.name).getAll();
    }
    return out;
  }

  async importAll(
    data: Record<string, Entity[]>,
    mode: ImportMode,
    opts: ImportOptions = {},
  ): Promise<void> {
    const names = this.schema.collections.map((c) => c.name);
    const preserve = new Set(opts.preserve ?? []);
    const tx = this.db.transaction(names, "readwrite");
    // Replace clears EVERY non-preserved collection first (so a collection
    // absent from `data` is emptied, not left stale). One transaction = atomic.
    if (mode === "replace") {
      for (const name of names) {
        if (!preserve.has(name)) tx.objectStore(name).clear();
      }
    }
    for (const [name, rows] of Object.entries(data)) {
      if (!names.includes(name) || preserve.has(name)) continue;
      const store = tx.objectStore(name);
      for (const r of rows) store.put(r);
    }
    // Extra writes in the SAME transaction (e.g. version bookkeeping), after the
    // clear + data puts, so they're atomic with the replace.
    for (const op of opts.alsoPut ?? []) {
      if (!names.includes(op.collection)) continue;
      const store = tx.objectStore(op.collection);
      if (op.op === "put") store.put(op.value);
      else store.delete(op.id);
    }
    await txDone(tx);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function openIndexedDB(dbName: string, schema: StorageSchema): Promise<StorageAdapter> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, schema.version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const spec of schema.collections) {
        const store = db.objectStoreNames.contains(spec.name)
          ? req.transaction!.objectStore(spec.name)
          : db.createObjectStore(spec.name, { keyPath: "id" });
        const wanted = new Set((spec.indexes ?? []).map((i) => i.name));
        // Drop indexes removed from the schema, so a version bump that removes one
        // actually cleans it from existing DBs (not just fresh ones).
        for (const existing of Array.from(store.indexNames)) {
          if (!wanted.has(existing)) store.deleteIndex(existing);
        }
        for (const idx of spec.indexes ?? []) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
          }
        }
      }
    };
    req.onsuccess = () => resolve(new IdbStorage(req.result, schema));
    req.onerror = () => reject(req.error);
  });
}
