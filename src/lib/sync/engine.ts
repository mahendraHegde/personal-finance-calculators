// Generic sync orchestration — app-agnostic (works for the portfolio app or the
// FIRE calculator). Composes a SyncProvider (transport) + Codec (serialize/
// encrypt) + version logic. Implements the agreed model:
//   - "latest" chosen by monotonic version (not clocks)
//   - one immutable file per session; created on first push, updated thereafter
//   - load-latest returns the decoded doc + meta so the caller can diff before
//     overwriting local state.

import type { Codec, SnapshotMeta, SyncProvider } from "./types";
import { latestSnapshot } from "./types";

export interface SyncEngineOptions<TDoc> {
  provider: SyncProvider;
  codec: Codec<TDoc>;
  /** Pull the monotonic version out of a document. */
  versionOf: (doc: TDoc) => number;
  author: string;
  deviceId: string;
  schemaVersion: number;
}

export interface LoadedSnapshot<TDoc> {
  doc: TDoc;
  meta: SnapshotMeta;
}

/** Build the neutral, time-sortable session filename. */
export function snapshotName(sessionStartIso: string): string {
  return `pf-${sessionStartIso.replace(/[:.]/g, "-")}.pfdb`;
}

export class SyncEngine<TDoc> {
  private readonly opts: SyncEngineOptions<TDoc>;
  private sessionFileId: string | null = null;

  constructor(opts: SyncEngineOptions<TDoc>) {
    this.opts = opts;
  }

  /** Fetch and decode the highest-version snapshot, or null if the folder is empty. */
  async loadLatest(): Promise<LoadedSnapshot<TDoc> | null> {
    const metas = await this.opts.provider.list();
    const latest = latestSnapshot(metas);
    if (!latest) return null;
    const bytes = await this.opts.provider.download(latest.id);
    const doc = await this.opts.codec.decode(bytes);
    return { doc, meta: latest };
  }

  /** List snapshot metadata without downloading bodies (cheap "is there newer?"). */
  list(): Promise<SnapshotMeta[]> {
    return this.opts.provider.list();
  }

  /**
   * Persist the document. The first call in a session CREATES the session file;
   * subsequent calls UPDATE that same file (the only mutation we ever do). Past
   * sessions' files are never touched.
   */
  async push(doc: TDoc, sessionStartIso: string, savedAtIso: string): Promise<SnapshotMeta> {
    const bytes = await this.opts.codec.encode(doc);
    const version = this.opts.versionOf(doc);
    const base = {
      version,
      author: this.opts.author,
      deviceId: this.opts.deviceId,
      savedAt: savedAtIso,
      schemaVersion: this.opts.schemaVersion,
    };

    if (this.sessionFileId === null) {
      const meta = await this.opts.provider.create(
        { ...base, name: snapshotName(sessionStartIso) },
        bytes,
      );
      this.sessionFileId = meta.id;
      return meta;
    }

    await this.opts.provider.update(this.sessionFileId, base, bytes);
    return { ...base, id: this.sessionFileId, name: snapshotName(sessionStartIso) };
  }

  /** Forget the current session file (so the next push starts a new one). */
  resetSession(): void {
    this.sessionFileId = null;
  }

  /**
   * Keep the `keep` highest-version snapshots and delete the rest, so a shared
   * folder doesn't grow unbounded across sessions. Best effort — a failed delete
   * is skipped, never breaking the sync that called it. Returns the count removed.
   *
   * SAFETY: `protectId` (the current session file) is never deleted. And when
   * `onlyDeviceId` is given, ONLY that device's own files are pruned — a foreign
   * device's snapshot is NEVER deleted, even if it's older than the kept set,
   * because "older version" ≠ "its edits are contained in a kept file" (there's
   * no auto-merge), so deleting an unmerged foreign file would lose data. Each
   * device prunes only its OWN session-file churn.
   */
  async prune(
    keep: number,
    protectId: string | null = this.sessionFileId,
    onlyDeviceId?: string,
  ): Promise<number> {
    const metas = await this.opts.provider.list();
    if (metas.length <= keep) return 0;
    // Newest first, deterministic tiebreak so every device prunes the same set.
    const sorted = [...metas].sort(
      (a, b) =>
        b.version - a.version ||
        (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    const stale = sorted
      .slice(keep)
      .filter((m) => m.id !== protectId && (onlyDeviceId === undefined || m.deviceId === onlyDeviceId));
    let removed = 0;
    for (const m of stale) {
      try {
        await this.opts.provider.remove(m.id);
        removed++;
      } catch {
        // transient delete failure — leave it; a later prune retries
      }
    }
    return removed;
  }

  /** The current session's file id (so it can be carried across engine rebuilds
   *  — re-picking a folder shouldn't start a second file for the same session). */
  getSessionFileId(): string | null {
    return this.sessionFileId;
  }
  setSessionFileId(id: string | null): void {
    this.sessionFileId = id;
  }
}
