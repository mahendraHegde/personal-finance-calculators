// Generic, app-agnostic storage abstraction.
//
// The domain layer depends ONLY on these interfaces — never on IndexedDB
// directly — so the backing store is pluggable (IndexedDB today; SQLite-WASM,
// a remote API, or anything else later) with zero domain changes.
//
// Design goals baked into the interface:
//   - on-disk, paginated reads (keyset cursors) so we never load everything
//   - range/filter queries via named secondary indexes
//   - bulk export/import for backup & sync snapshots

/** Anything stored has a stable string id. */
export interface Entity {
  id: string;
}

/** Keys we support for primary id and secondary indexes (IndexedDB-compatible subset). */
export type IndexKey = string | number | Array<string | number>;

export type Direction = "next" | "prev";

/** A bound on a single index (or the primary key when `index` is omitted). */
export interface QueryRange {
  /** Named secondary index; omit to range over the primary key (`id`). */
  index?: string;
  /** Exact match — mutually exclusive with lower/upper. */
  equals?: IndexKey;
  lower?: IndexKey;
  upper?: IndexKey;
  lowerOpen?: boolean;
  upperOpen?: boolean;
}

/** Keyset cursor: the index key PLUS the primary key, so pagination is correct
 *  even when an index is non-unique (many rows share a date). */
export interface PageCursor {
  key: IndexKey;
  id: string;
}

/** A paginated read over an index/range. Use `after` (from the previous page's
 *  `nextCursor`) for O(1) keyset pagination — not OFFSET scanning. */
export interface PageQuery extends QueryRange {
  direction?: Direction;
  limit: number;
  /** Continue strictly after this (indexKey, id) cursor. */
  after?: PageCursor;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `after` to fetch the next page; undefined when exhausted. */
  nextCursor?: PageCursor;
  done: boolean;
}

/** One typed collection (≈ table / object store). */
export interface Collection<T extends Entity> {
  get(id: string): Promise<T | undefined>;
  put(record: T): Promise<void>;
  putMany(records: T[]): Promise<void>;
  delete(id: string): Promise<void>;
  count(range?: QueryRange): Promise<number>;
  /** Load the full matching slice — for aggregates that inherently need all rows
   *  in scope (e.g. XIRR over one holding's events). */
  getAll(range?: QueryRange): Promise<T[]>;
  /** Paginated read for list UIs — never materialises the whole collection. */
  page(query: PageQuery): Promise<Page<T>>;
  clear(): Promise<void>;
}

export interface IndexSpec {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

export interface CollectionSpec {
  name: string;
  indexes?: IndexSpec[];
}

export interface StorageSchema {
  version: number;
  collections: CollectionSpec[];
}

export type ImportMode = "replace" | "merge";

/** A single write in a multi-store atomic batch. */
export type BatchOp =
  | { collection: string; op: "put"; value: Entity }
  | { collection: string; op: "delete"; id: string };

export interface ImportOptions {
  /** Collections to leave untouched in "replace" mode (e.g. device-local data
   *  the snapshot deliberately omits). All OTHER schema collections are cleared. */
  preserve?: string[];
  /** Extra writes applied INSIDE the same import transaction (atomic with the
   *  replace), AFTER the clear + data puts. Use for bookkeeping (e.g. a version /
   *  settings row) that must not land in a separate transaction. */
  alsoPut?: BatchOp[];
}

/** The pluggable backing store. */
export interface StorageAdapter {
  collection<T extends Entity>(name: string): Collection<T>;
  /** Apply writes across one or more collections in a SINGLE atomic transaction
   *  (all-or-nothing). Used to commit a record change and its bookkeeping
   *  together, so a crash can't persist one without the other. */
  batch(ops: BatchOp[]): Promise<void>;
  /** Snapshot every collection — the basis for backup files & sync snapshots.
   *  Always includes every schema collection (empty ones as []). */
  exportAll(): Promise<Record<string, Entity[]>>;
  /** Load a snapshot. In `replace` mode EVERY schema collection except those in
   *  `opts.preserve` is cleared first, then `data` is loaded — so a collection
   *  absent from `data` ends up empty (no stale/orphaned rows). `merge` upserts
   *  by id without clearing. Atomic (all-or-nothing on error). */
  importAll(
    data: Record<string, Entity[]>,
    mode: ImportMode,
    opts?: ImportOptions,
  ): Promise<void>;
  close(): Promise<void>;
}
