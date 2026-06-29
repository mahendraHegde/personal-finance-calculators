// Reusable sync seam (interfaces only — concrete Google Drive provider and the
// orchestration engine land in a later phase). Kept app-agnostic so the FIRE
// calculator could back up its own config to the same shared-folder model.

/** Metadata stored alongside each snapshot (in Drive `appProperties`) so the
 *  latest can be chosen and a diff prompt described WITHOUT downloading files. */
export interface SnapshotMeta {
  /** Provider-native file id. */
  id: string;
  /** Neutral, time-sortable name, e.g. `pf-2026-06-27T14-30-00Z.pfdb`. */
  name: string;
  /** Monotonic counter — the single source of truth for "latest" (not clocks). */
  version: number;
  author: string;
  deviceId: string;
  /** ISO timestamp, for display only. */
  savedAt: string;
  schemaVersion: number;
}

/** Transport: where snapshots live (Google Drive, a local file, Dropbox, …). */
export interface SyncProvider {
  /** Cheap metadata listing — no file bodies downloaded. */
  list(): Promise<SnapshotMeta[]>;
  download(id: string): Promise<Uint8Array>;
  /** Create a new immutable snapshot (on first edit of a session). */
  create(meta: Omit<SnapshotMeta, "id">, data: Uint8Array): Promise<SnapshotMeta>;
  /** Update THIS session's own file (the only mutation we ever do). */
  update(id: string, meta: Partial<SnapshotMeta>, data: Uint8Array): Promise<void>;
  /** Permanently remove a snapshot (used to prune old files). */
  remove(id: string): Promise<void>;
}

/** Serialise/encrypt a document to bytes and back. Lets sync stay agnostic to
 *  both the document shape and the encryption scheme. */
export interface Codec<TDoc> {
  encode(doc: TDoc): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<TDoc>;
}

/** Pick the latest snapshot: highest version, with a deterministic tiebreak
 *  (later savedAt, then higher id) so a version collision between two devices
 *  resolves the same way everywhere instead of depending on list order. */
export function latestSnapshot(snapshots: SnapshotMeta[]): SnapshotMeta | undefined {
  let best: SnapshotMeta | undefined;
  for (const s of snapshots) {
    if (!best) {
      best = s;
      continue;
    }
    if (s.version > best.version) best = s;
    else if (s.version === best.version) {
      if (s.savedAt > best.savedAt || (s.savedAt === best.savedAt && s.id > best.id)) best = s;
    }
  }
  return best;
}
