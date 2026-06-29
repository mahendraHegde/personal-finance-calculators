// In-memory StorageAdapter — same semantics as the IndexedDB adapter.
// Used for unit tests (Node has no IndexedDB) and as a safe fallback. Because
// it implements the same interface, anything that passes against it is exercising
// the exact contract the domain depends on.

import type {
  BatchOp,
  Collection,
  CollectionSpec,
  Entity,
  ImportMode,
  ImportOptions,
  IndexKey,
  IndexSpec,
  Page,
  PageQuery,
  QueryRange,
  StorageAdapter,
  StorageSchema,
} from "./types";
import { compareKeys, extractKey, inRange } from "./keys";

const tiebreak = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

class MemoryCollection<T extends Entity> implements Collection<T> {
  private readonly rows = new Map<string, T>();
  private readonly indexes: Map<string, IndexSpec>;

  constructor(spec: CollectionSpec) {
    this.indexes = new Map((spec.indexes ?? []).map((i) => [i.name, i]));
  }

  async get(id: string): Promise<T | undefined> {
    return this.rows.get(id);
  }

  async put(record: T): Promise<void> {
    this.rows.set(record.id, structuredClone(record));
  }

  async putMany(records: T[]): Promise<void> {
    for (const r of records) this.rows.set(r.id, structuredClone(r));
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }

  /** Resolve a record's key for the given range's index (or primary key). */
  private keyFor(record: T, range: QueryRange | undefined): IndexKey | undefined {
    if (!range || !range.index) return record.id;
    const spec = this.indexes.get(range.index);
    if (!spec) throw new Error(`unknown index "${range.index}"`);
    return extractKey(record as unknown as Record<string, unknown>, spec.keyPath);
  }

  private matching(range?: QueryRange): Array<{ key: IndexKey; row: T }> {
    const out: Array<{ key: IndexKey; row: T }> = [];
    for (const row of this.rows.values()) {
      const key = this.keyFor(row, range);
      if (key === undefined) continue; // not present in this index
      if (range && !inRange(key, range)) continue;
      out.push({ key, row: structuredClone(row) });
    }
    return out;
  }

  async count(range?: QueryRange): Promise<number> {
    return this.matching(range).length;
  }

  async getAll(range?: QueryRange): Promise<T[]> {
    const matched = this.matching(range);
    // Tiebreak equal index keys by id to match IndexedDB's (key, primaryKey) order.
    matched.sort((a, b) => compareKeys(a.key, b.key) || tiebreak(a.row.id, b.row.id));
    return matched.map((m) => m.row);
  }

  async page(query: PageQuery): Promise<Page<T>> {
    const dir = query.direction ?? "next";
    // Order by (indexKey, id) so a non-unique index still has a total order —
    // the id tiebreaker is what prevents rows on the same key being skipped.
    const cmp = (a: { key: IndexKey; row: T }, b: { key: IndexKey; row: T }): number => {
      const c = compareKeys(a.key, b.key);
      if (c !== 0) return c;
      return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
    };
    let matched = this.matching(query);
    matched.sort((a, b) => (dir === "next" ? cmp(a, b) : cmp(b, a)));

    const after = query.after;
    if (after) {
      matched = matched.filter((m) => {
        const c = compareKeys(m.key, after.key) || tiebreak(m.row.id, after.id);
        return dir === "next" ? c > 0 : c < 0;
      });
    }
    const slice = matched.slice(0, query.limit);
    const last = slice[slice.length - 1];
    const done = slice.length < query.limit;
    return {
      items: slice.map((m) => m.row),
      nextCursor: done || !last ? undefined : { key: last.key, id: last.row.id },
      done,
    };
  }

  /** Internal: raw dump for exportAll. */
  dump(): T[] {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
}

class MemoryStorage implements StorageAdapter {
  private readonly collections = new Map<string, MemoryCollection<Entity>>();

  constructor(schema: StorageSchema) {
    for (const spec of schema.collections) {
      this.collections.set(spec.name, new MemoryCollection(spec));
    }
  }

  collection<T extends Entity>(name: string): Collection<T> {
    const c = this.collections.get(name);
    if (!c) throw new Error(`unknown collection "${name}"`);
    return c as unknown as Collection<T>;
  }

  async batch(ops: BatchOp[]): Promise<void> {
    if (ops.length === 0) return;
    // Snapshot affected collections for all-or-nothing rollback.
    const touched = new Set(ops.map((o) => o.collection));
    const backup = new Map<string, Entity[]>();
    for (const name of touched) {
      const col = this.collections.get(name);
      if (!col) throw new Error(`unknown collection "${name}"`);
      backup.set(name, col.dump());
    }
    try {
      for (const op of ops) {
        const col = this.collections.get(op.collection)!;
        if (op.op === "put") await col.put(op.value);
        else await col.delete(op.id);
      }
    } catch (e) {
      for (const [name, rows] of backup) {
        const col = this.collections.get(name)!;
        await col.clear();
        await col.putMany(rows);
      }
      throw e;
    }
  }

  async exportAll(): Promise<Record<string, Entity[]>> {
    const out: Record<string, Entity[]> = {};
    for (const [name, col] of this.collections) out[name] = col.dump();
    return out;
  }

  async importAll(
    data: Record<string, Entity[]>,
    mode: ImportMode,
    opts: ImportOptions = {},
  ): Promise<void> {
    const preserve = new Set(opts.preserve ?? []);
    // Snapshot for all-or-nothing rollback (atomicity parity with IndexedDB).
    const backup = new Map<string, Entity[]>();
    for (const [name, col] of this.collections) backup.set(name, col.dump());
    try {
      if (mode === "replace") {
        for (const [name, col] of this.collections) {
          if (!preserve.has(name)) await col.clear();
        }
      }
      for (const [name, rows] of Object.entries(data)) {
        const col = this.collections.get(name);
        if (!col || preserve.has(name)) continue;
        await col.putMany(rows);
      }
      // Extra writes (e.g. version bookkeeping), atomic with the replace via the
      // snapshot/rollback below; applied after the clear + data puts.
      for (const op of opts.alsoPut ?? []) {
        const col = this.collections.get(op.collection);
        if (!col) continue;
        if (op.op === "put") await col.put(op.value);
        else await col.delete(op.id);
      }
    } catch (e) {
      for (const [name, col] of this.collections) {
        await col.clear();
        await col.putMany(backup.get(name) ?? []);
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

export function createMemoryStorage(schema: StorageSchema): StorageAdapter {
  return new MemoryStorage(schema);
}
