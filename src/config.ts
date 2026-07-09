// Central place for tunable app constants — keep "magic numbers" here rather
// than scattered across the code so they're easy to find and adjust.

/** Drive sync */
export const SYNC = {
  /** Max snapshot files to retain per shared folder. After a successful push we
   *  prune older ones (by version) beyond this, so the folder doesn't grow
   *  unbounded over many sessions. The current session file is always kept. */
  SNAPSHOT_KEEP: 1000,
  /** Max keyring files (envelope encryption) to retain per folder. Keyrings are
   *  tiny (~300 B) and only a password change writes a new one. We keep MANY so a
   *  device that's been offline across several password changes and holds no DEK
   *  can still find a keyring it can unwrap (an older keyring wraps the same
   *  invariant DEK) — i.e. it bounds the "straggler lockout" window to this many
   *  password changes. The latest keyring is never pruned. */
  KEYRING_KEEP: 20,
  /** Debounce between an edit and the autosave push. */
  AUTOSAVE_DEBOUNCE_MS: 4000,
  /** Backoff before retrying a push that failed transiently. */
  AUTOSAVE_RETRY_MS: 30_000,
} as const;

/** FX rates */
export const FX = {
  /** Refresh live FX at most this often (lazy, on load + hourly while open). */
  REFRESH_INTERVAL_MS: 60 * 60 * 1000,
} as const;

/** UI */
export const UI = {
  /** Max rows rendered per section in the snapshot diff (keeps the DOM bounded
   *  on very large diffs; the rest show as "+N more"). */
  DIFF_ROW_CAP: 50,
} as const;
