// Generic, app-agnostic dataset diff. Used to show the user exactly what an
// incoming Drive snapshot will change *before* it replaces local data.
//
// A dataset is a map of collection-name → array of {id}-keyed records — the
// same shape StorageAdapter.exportAll() produces — so this works for the
// portfolio app, the FIRE calculator, or anything else.

export interface Keyed {
  id: string;
}

export interface Modified<T> {
  id: string;
  before: T;
  after: T;
  /** Top-level field names that differ. */
  changes: string[];
}

export interface CollectionDiff<T> {
  added: T[];
  removed: T[];
  modified: Array<Modified<T>>;
}

export interface DatasetDiff {
  collections: Record<string, CollectionDiff<Keyed>>;
  summary: { added: number; removed: number; modified: number; changed: boolean };
}

/** Stable stringify (sorted keys) so field order never causes false diffs. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

function changedFields(before: Keyed, after: Keyed): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) {
    const a = (before as unknown as Record<string, unknown>)[k];
    const b = (after as unknown as Record<string, unknown>)[k];
    if (stable(a) !== stable(b)) out.push(k);
  }
  return out.sort();
}

export function diffCollections<T extends Keyed>(local: T[], remote: T[]): CollectionDiff<T> {
  const localById = new Map(local.map((r) => [r.id, r]));
  const remoteById = new Map(remote.map((r) => [r.id, r]));

  const added: T[] = [];
  const removed: T[] = [];
  const modified: Array<Modified<T>> = [];

  for (const [id, after] of remoteById) {
    const before = localById.get(id);
    if (!before) {
      added.push(after);
    } else if (stable(before) !== stable(after)) {
      modified.push({ id, before, after, changes: changedFields(before, after) });
    }
  }
  for (const [id, before] of localById) {
    if (!remoteById.has(id)) removed.push(before);
  }
  return { added, removed, modified };
}

export function diffDatasets(
  local: Record<string, Keyed[]>,
  remote: Record<string, Keyed[]>,
): DatasetDiff {
  const names = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const collections: Record<string, CollectionDiff<Keyed>> = {};
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const name of names) {
    const d = diffCollections(local[name] ?? [], remote[name] ?? []);
    collections[name] = d;
    added += d.added.length;
    removed += d.removed.length;
    modified += d.modified.length;
  }

  return {
    collections,
    summary: { added, removed, modified, changed: added + removed + modified > 0 },
  };
}
