// Browser-only orchestration of vault unlock + Google Drive sync on top of the
// (framework-agnostic) store. Kept separate from the store so the store stays
// testable and the Google/crypto code is isolated.
//
// Flow: setup/unlock vault → configure Drive (client id + api key) → pick the
// shared folder → push session snapshots (autosave) / pull-and-diff on demand.

import { latestSnapshot, type Codec, type SnapshotMeta } from "../../../lib/sync/types";
import { SyncEngine } from "../../../lib/sync/engine";
import { diffDatasets, type DatasetDiff } from "../../../lib/sync/diff";
import {
  applyChoices,
  baselineClaim,
  planMerge,
  snapshotKey,
  unincorporatedFiles,
  type ConflictChoice,
  type MergePlan,
} from "../../../lib/sync/merge";
import type { VersionFingerprint } from "./store";

/** A previewed merge: the plan the user reviews, plus the version bookkeeping the commit
 *  needs (see previewMerge). Passed back to commitMerge unchanged. */
export interface MergePreview {
  doc: SnapshotDoc;
  plan: MergePlan;
  /** PERSISTED version bookkeeping when the plan was computed — revalidated inside the write
   *  lock. Persisted (not in-memory) so a second tab's writes are visible to the check. */
  base: VersionFingerprint;
  /** Remote version this merge reconciles, or null when it can't be safely acknowledged.
   *  Only an OPTIMISATION now (it prunes the seen-log); publishability rests on `seenKey`. */
  seenRemoteVersion: number | null;
  /** `<fileId>@<version>` of the snapshot being merged — recorded even when the watermark
   *  can't move, so successive merges accumulate until nothing is outstanding. */
  seenKey: string | null;
  /** Other files still holding data this merge did NOT incorporate. When > 0 the merge stays
   *  local and the user must reconcile those too — surfaced so the UI can say which. */
  outstandingOthers: number;
  /** Why this merge can't be published yet, so the UI explains the RIGHT reason rather than
   *  blaming the folder listing for every case. `null` = it can be. */
  ackBlocked: "outstanding" | "unavailable" | null;
  /** The listing this preview was computed from, and when — so `commitMerge` can recount it after
   *  the write instead of republishing a pre-merge number under a fresh timestamp. */
  listing: Listing | null;
  /** What the merged snapshot already holds (its provenance, widened with its author's own files
   *  in the listing), so the commit records exactly what the preview counted. */
  inherit?: SnapshotProvenance;
}
import {
  createDekCodec,
  createEncryptedCodec,
  createPlainCodec,
  encodeBackup,
  encryptedFormat,
  isEncryptedFile,
  readEmbeddedKeyring,
} from "../../../lib/crypto/codec";
import { bytesToUtf8 } from "../../../lib/crypto/base64";
import type { KdfParams } from "../../../lib/crypto/vault";
import { decryptJson, deriveKey, generateDek, newSalt, unwrapDek, wrapDek } from "../../../lib/crypto/vault";
import {
  compareKeyringNewestFirst,
  encodeKeyring,
  KEYRING_FORMAT,
  newestKeyring,
  parseKeyring,
  type Keyring,
} from "../../../lib/crypto/keyring";
import { clearVaultKey, loadVaultKey, saveVaultKey } from "../../../lib/crypto/keystore";
import { GoogleAuth, pickFolder, SignInRequiredError } from "../../../lib/google/drive-auth";
import { DriveSyncProvider } from "../../../lib/google/drive-provider";
import { SheetsOracle } from "../../../lib/google/sheets-oracle";
import { newId } from "../../../lib/util/id";
import { SCHEMA } from "../model/schema";
import type { SnapshotDoc, SnapshotProvenance } from "../model/types";
import type { PortfolioStore } from "./store";
import { SYNC } from "../../../config";

/** Known plaintext encrypted under the vault key so a passphrase can be proven
 *  correct (a wrong passphrase must never become "ready" and poison the folder
 *  with snapshots written under the wrong key). */
const VAULT_SENTINEL = "pf-vault-check-v1";

// --- per-tab session resume (sessionStorage: survives refresh, clears on tab
// close) so a reload keeps writing the SAME snapshot file. ----------------------
// v2 suffix: the record shape changed (salt → dekId) with envelope encryption;
// a bumped key makes an old tab's pre-v2 record be ignored (fails safe to a fresh
// session file) instead of resuming with a missing dekId.
const SESSION_RESUME_KEY = "pf-sync-session-v2";
interface SessionResume {
  startIso: string;
  folderId: string | null;
  /** DEK identity (envelope encryption): the folder-DATA identity, unchanged
   *  across password changes. A password change must NOT reset the session file
   *  (same DEK → same snapshots), so we track the dekId, not the KDF salt. */
  dekId: string | null;
  fileId: string | null;
}
function readSessionResume(): SessionResume | null {
  try {
    const raw = sessionStorage.getItem(SESSION_RESUME_KEY);
    return raw ? (JSON.parse(raw) as SessionResume) : null;
  } catch {
    return null;
  }
}
function writeSessionResume(s: SessionResume): void {
  sessionStorage.setItem(SESSION_RESUME_KEY, JSON.stringify(s));
}

export type SyncPhase = "no-vault" | "locked" | "no-folder" | "ready" | "syncing" | "error";

/** The CLAUSE for each recurring failure, in one place. The surfaces compose it differently (a
 *  banner explains what happens next, a tooltip is a fragment), but a user who hits the same
 *  problem twice in a session must not be given two different names for it. */
export const SYNC_TEXT = {
  authExpired: "Google sign-in expired",
  unreachable: "Couldn't reach the shared folder",
} as const;

export interface SyncStatus {
  phase: SyncPhase;
  message?: string;
  /** True only when the error is specifically a sign-in/token failure — the UI
   *  shows "Reconnect Google" for this, NOT for a conflict / data-loss / vault
   *  error (those need "Pull latest", and Reconnect can't resolve them). */
  needsAuth?: boolean;
  /** The last time we LOOKED at the folder, as one indivisible fact: when, and either how many
   *  snapshots were unincorporated or that we couldn't see it.
   *
   *  Deliberately not three fields. As `behind` / `lastCheckedAt` / `unreachable` they were three
   *  projections of a single observation, written from five call sites — and two of them published
   *  one projection from an observation that didn't support the others (a fresh timestamp on a
   *  stale count; a count measured against state the write then destroyed). Every bug in this area
   *  had that shape. Written only by `observed()`, which recomputes the count itself. */
  lastCheck?: { at: string; behind: number } | { at: string; unreachable: true };
  /** Version of a snapshot applied WITHOUT the user asking (the startup gate's automatic lane),
   *  so the UI can acknowledge it. Live status rather than the gate's one-shot result, because the
   *  write can land after the gate has already given up waiting. */
  appliedVersion?: number;
  /** The raw error text, for the pill's tooltip and debugging — never the banner, which needs a
   *  sentence a person can act on. Cleared whenever a new `message` is set, so a stale error can't
   *  be mis-attributed to a later, unrelated one. */
  detail?: string;
  /** A problem the STARTUP CHECK found. Separate from `message` because the check deliberately
   *  leaves `phase` alone (a failed read must not gate autosave), and the notice's error branch is
   *  keyed on `phase === "error"` — so anything written to `message` here reached a tooltip and
   *  nowhere else. Cleared by the next successful check.
   *
   *  It CARRIES its own `detail` rather than borrowing the top-level one: clearing the sentence
   *  and leaving the diagnostic behind re-attached "decrypt failed: bad MAC" to whatever notice
   *  showed next. A diagnostic that can outlive its sentence will. */
  problem?: { text: string; detail?: string };
}

/** Outcome of the startup check, so the shell knows whether to let the user in.
 *
 *  The shell acts on the `kind` alone: `review` opens the diff, and `refundsCheckSlot` (in
 *  `sync-readings.ts`, where it is tested) decides which outcomes give back the one-check-per-start
 *  slot. The rest are informational — everything the UI SHOWS comes from
 *  live `SyncStatus`, never from this result, so the two can't drift.
 *
 *  Deliberately read-only apart from ONE narrow write (`applied`): a device that has just been
 *  opened is the most likely to be stale, and finding that out after an edit turns a free
 *  fast-forward into a merge the user has to reason about. */
export type StartupCheck =
  /** Looked, and nothing in the folder is newer. */
  | { kind: "up-to-date" }
  /** No folder configured, so there was nothing to look at. Distinct from `up-to-date` because
   *  the shell spends its one check per app start on the answer: a session that STARTS without a
   *  folder and picks one a minute later must still get a gate for it — that is the moment a
   *  folder is most likely to hold family data this device has never seen. */
  | { kind: "no-folder" }
  /** A pure addition was applied automatically (local was clean, nothing removed or modified). */
  | { kind: "applied" }
  /** Needs a human: something would be removed or rewritten, or this device has unsynced work. */
  | { kind: "review" }
  /** Behind, but the vault is locked so snapshots can't be decoded — only listed. */
  | { kind: "locked-behind" }
  /** Couldn't reach the folder (offline, sign-in expired, timeout). Work continues locally. */
  | { kind: "unavailable" };

/** The persisted bookkeeping the hazard rule reads. */
type SyncFacts = { lastSyncedVersion: number; localVersion: number; seenSnapshots: string[]; deviceId: string };

/** How far our OWN deviceId is excused. A file carrying our id is ours unless it sits above the
 *  version this database has actually reached — a cloned profile keeps the id while the data
 *  diverges, so the exemption has to be bounded. Written once: the hazard rule and the v1 adopt
 *  path both ask for it, and a bound that differs between them is a guard that stops guarding. */
function ownBound(sync: SyncFacts): { deviceId: string; version: number } {
  return { deviceId: sync.deviceId, version: Math.max(sync.localVersion, sync.lastSyncedVersion) };
}

/** A decoded snapshot's provenance, or undefined when it has none (older builds) or it is not
 *  shaped as one. It came off the network, and a malformed log must not throw mid-pull. */
function provenanceOf(doc: SnapshotDoc): SnapshotProvenance | undefined {
  const p = doc.incorporated as Partial<SnapshotProvenance> | undefined;
  if (!p || typeof p !== "object" || !Number.isFinite(p.watermark) || !Array.isArray(p.seen)) return undefined;
  // Never above the snapshot's own version: nobody can have incorporated files newer than
  // what they published, and a larger number would subsume files this data has never seen.
  const watermark = Math.max(0, Math.min(p.watermark as number, doc.version));
  // Same bound for the log: a key newer than the snapshot names a file it cannot contain.
  const seen = p.seen.filter((k): k is string => {
    if (typeof k !== "string") return false;
    const v = Number(k.slice(k.lastIndexOf("@") + 1));
    return Number.isFinite(v) && v <= doc.version;
  });
  return { watermark, seen };
}

/** `provenanceOf(doc)` plus the author's OWN other files in the listing at or below the loaded
 *  one: a later full export from the same database contains them. Without this, a snapshot that
 *  was the first push of a new session left its author's previous session file flagged (it sits
 *  at the author's watermark, and a file AT the watermark is a hazard). The same-device rule
 *  `unincorporatedFiles` already applies whenever the loaded file is visible; this only keeps it
 *  when that file is the one being ignored. Snapshots without provenance get nothing, so they are
 *  judged exactly as before. */
function provenanceFor(
  doc: SnapshotDoc,
  file: SnapshotMeta | undefined,
  metas: readonly SnapshotMeta[] | undefined,
): SnapshotProvenance | undefined {
  const p = provenanceOf(doc);
  if (!p || !file || !metas) return p;
  // STRICTLY below, and below the version we actually decoded (the listing may show the file
  // updated in place since). A tie is not subsumed, as in `unincorporatedFiles`: two files at one
  // device's top version can be a cloned profile with diverged data.
  const bound = Math.min(file.version, doc.version);
  const own = metas.filter((m) => m.deviceId === file.deviceId && m.id !== file.id && m.version < bound);
  return { watermark: p.watermark, seen: [...p.seen, ...own.map(snapshotKey)] };
}

/** The bookkeeping a MERGE leaves: ours, which a merge keeps, plus what the snapshot already
 *  holds (`p`, from `provenanceFor`). With no provenance it is exactly our own. The replace
 *  counterpart is `afterReplace`. */
function withProvenance(sync: SyncFacts, p: SnapshotProvenance | undefined): SyncFacts {
  if (!p) return sync;
  return {
    ...sync,
    lastSyncedVersion: Math.max(sync.lastSyncedVersion, p.watermark),
    seenSnapshots: [...sync.seenSnapshots, ...p.seen],
  };
}

/** The bookkeeping a REPLACE with `doc` leaves, for the pull's count and hold decision. With
 *  provenance it is exactly what `applyDocument` writes: the snapshot's log in place of ours, which
 *  the replace discards (keeping ours counted a file we had merged as held after its rows were
 *  gone). Without provenance it is our own bookkeeping, as it has always been judged: an emptied
 *  log there held the watermark on an ordinary catch-up from an older build's snapshot. */
function afterReplace(sync: SyncFacts, p: SnapshotProvenance | undefined): SyncFacts {
  if (!p) return sync;
  return { ...sync, lastSyncedVersion: Math.max(sync.lastSyncedVersion, p.watermark), seenSnapshots: p.seen };
}

/** A folder listing AND the moment it was taken. One value, never two fields: as `listing` +
 *  `listedAt` the write site chose the files with `??` and the timestamp with `?:` — two
 *  predicates that agreed only by coincidence — and an omitted timestamp silently defaulted to
 *  "now", which is exactly the false-freshness bug this pair was introduced to fix. */
export interface Listing {
  files: SnapshotMeta[];
  /** Which listing this device saw LATER. Ordering by wall clock instead cost four review rounds
   *  in a row: a stamp is written by the same clock that says what "now" is, so while the clock is
   *  wrong the two agree and nothing looks amiss — the impossibility only appears after a
   *  correction, by which point the bad stamp is stored and out-ranks every later look. A counter
   *  has no such failure mode, and it is the ACTUAL question being asked. */
  seq: number;
  /** When the folder answered — for display only ("Synced · 14:20"), never for ordering. Stamped
   *  as the listing RETURNS, not after the work that follows it, so it doesn't claim a freshness
   *  the folder was never asked about. */
  at: string;
}

/** How a listing is published. See `checkRemote`. */
type Recorder = (
  listing: Listing,
  sync: SyncFacts,
  ignoreIds?: readonly (string | null | undefined)[],
) => void;

export interface RemoteCheck {
  doc: SnapshotDoc;
  version: number;
  diff: DatasetDiff;
  /** Provider file id of the snapshot that was loaded. A merge needs it: acknowledging a
   *  version is only safe if the file we actually merged IS the outstanding one, and
   *  `loadLatest` can hand back THIS device's own file (it picks by version then savedAt). */
  fileId: string;
  /** PERSISTED version bookkeeping when the diff was computed, revalidated inside the write lock.
   *
   *  Replacing is a full overwrite, and the confirm window is unbounded. The UI's own staleness
   *  check reads THIS tab's in-memory state, which cannot see a sibling tab — so a second tab's
   *  never-pushed rows were deleted silently, exactly as they were on the merge path before it
   *  carried `expect`. */
  base: VersionFingerprint;
  /** True when the PERSISTED row shows unsynced work (any tab's), so the dialog warns even when
   *  this tab's in-memory `dirty` is false. */
  hasLocalChanges: boolean;
  /** The folder listing this check was made from, and when — so a later write can recount it
   *  instead of republishing a count taken before the write, and dates it from the moment the
   *  folder was actually looked at rather than the moment the user finally clicked. */
  listing: Listing | null;
  /** Other snapshots that would STILL be unincorporated after loading this one. Non-zero means
   *  loading it must not advance the synced watermark (it would jump those files), and the dialog
   *  has to say the reconciliation isn't finished — the old wording promised the opposite. */
  outstandingOthers: number;
}

export class SyncController {
  private readonly store: PortfolioStore;
  private auth: GoogleAuth | null = null;
  private clientId: string | null = null;
  private provider: DriveSyncProvider | null = null;
  private engine: SyncEngine<SnapshotDoc> | null = null;
  private engineFolderId: string | null = null;
  // Identify the engine's vault by its DEK id (not the codec object, not the KDF
  // salt), so a lock→unlock OR a password change (which re-wraps the SAME DEK
  // under a new salt) is recognised as the same vault and keeps the same session
  // file. Only a genuinely different DEK (fresh vault / different folder) starts
  // a new file.
  private engineDekId: string | null = null;
  // Holds the live session file id across a temporary teardown (lock → codec null
  // → engine null), so unlock resumes that file instead of minting a duplicate.
  private stashedSessionFileId: string | null = null;
  private codec: Codec<SnapshotDoc> | null = null;
  // The live DEK while unlocked (mirror of what the codec seals with) — kept so
  // we can embed it in self-contained backups and re-wrap it on a password change
  // without re-reading the keystore. Cleared on lock.
  private dek: CryptoKey | null = null;
  private readonly sessionStartIso: string;
  private status: SyncStatus = { phase: "no-vault" };
  private listeners = new Set<() => void>();
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveDebounceMs: number = SYNC.AUTOSAVE_DEBOUNCE_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether this session's key has been proven to decrypt the folder's data. */
  private sessionVerified = false;
  /** Whether we've confirmed (this session, since the last DEK change) that the
   *  folder holds a keyring for our current DEK — so we never publish a v2 snapshot
   *  under a DEK the folder has no keyring for. Reset whenever the DEK changes. */
  private keyringEnsured = false;

  constructor(store: PortfolioStore) {
    this.store = store;
    // Resume this tab's sync session across refreshes via sessionStorage (which
    // survives a reload but clears on tab close) → ONE snapshot file per tab
    // session instead of a new file on every refresh. Seed the engine-tracking
    // fields so the first rebuildEngine recognises the same (folder, vault) and
    // resumes the same file; a stale id is validated/dropped in runSync.
    const resumed = readSessionResume();
    this.sessionStartIso = resumed?.startIso ?? new Date().toISOString();
    if (resumed) {
      this.engineFolderId = resumed.folderId;
      this.engineDekId = resumed.dekId;
      this.stashedSessionFileId = resumed.fileId;
    }
    this.persistSession(); // pin the startIso for this tab session immediately
  }

  /** Persist this tab session's (startIso, folder, vault, file id) so a refresh
   *  resumes the same Drive file. Scoped by folder + dekId so it never resumes a
   *  file under a different vault/folder. sessionStorage failures are ignored. */
  private persistSession(): void {
    try {
      const settings = this.store.getState().settings;
      writeSessionResume({
        startIso: this.sessionStartIso,
        folderId: settings.drive?.folderId ?? null,
        dekId: settings.vaultKeyring?.dekId ?? null,
        fileId: this.engine?.getSessionFileId() ?? this.stashedSessionFileId,
      });
    } catch {
      /* sessionStorage unavailable (e.g. private mode) — lose only the resume */
    }
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getStatus = (): SyncStatus => this.status;

  private set(status: Partial<SyncStatus>): void {
    // needsAuth is a property of ONE specific error; any phase transition clears it
    // unless the patch explicitly re-asserts it — so it can't linger onto a later
    // conflict/ready state and show a misleading Reconnect button.
    const next: SyncStatus = { ...this.status, ...status };
    if (status.phase !== undefined && status.needsAuth === undefined) next.needsAuth = false;
    // `detail` is the raw text behind whatever sentence is CURRENT. A new message that doesn't
    // bring its own diagnostic clears it, so an old one can never be read as the explanation of a
    // later, unrelated failure.
    if (status.message !== undefined && status.detail === undefined) next.detail = undefined;
    this.status = next;
    for (const cb of this.listeners) cb();
  }

  // -- vault (envelope encryption) -----------------------------------------
  // See docs/MIGRATION_HISTORY.md. The passphrase derives a KEK that only WRAPS a
  // stable random DEK (the data key). The wrapped DEK lives in the folder's shared
  // keyring; the DEK encrypts every snapshot/backup. Changing the passphrase
  // re-wraps the SAME DEK → old files stay readable, the shared folder never splits.

  /** The folder's authoritative keyring: the newest that PARSES. We iterate
   *  newest-first (version, then id — same order every device/prune uses) and skip
   *  any that don't validate (corrupt or a future format), so one bad high-version
   *  keyring can't make the whole folder read as keyring-less. Null if none parse. */
  private async remoteKeyring(): Promise<Keyring | null> {
    if (!this.provider) return null;
    const metas = await this.provider.listKeyrings();
    metas.sort(compareKeyringNewestFirst); // newest first (version, then id)
    for (const m of metas) {
      // download() is OUTSIDE the try: a TRANSPORT error (401/5xx/network) must
      // PROPAGATE — callers rely on remoteKeyring() throwing (→ remoteErrored,
      // changePassword abort) rather than silently returning an older/absent
      // keyring, which could fork a DEK or reject the correct password. Only a
      // PARSE failure (corrupt / future format) is skipped to try the next one.
      const bytes = await this.provider.download(m.id);
      try {
        return parseKeyring(bytes);
      } catch {
        // corrupt / future-format keyring — fall through to the next-newest valid one
      }
    }
    return null;
  }

  /** Whether our current DEK codec can actually READ the connected folder — the
   *  folder is empty (safe to seed our keyring) or its latest snapshot decodes with
   *  our DEK. Gate keyring PUSHES on this so we never stamp our keyring onto a
   *  folder whose data belongs to a different vault (which would hijack it and lock
   *  its devices out). A v1 / foreign / undecryptable latest → false. */
  private async dekDecodesFolder(): Promise<boolean> {
    if (!this.provider || !this.codec) return false;
    const latest = latestSnapshot(await this.provider.list());
    if (!latest) return true; // empty folder — safe to seed
    const bytes = await this.provider.download(latest.id);
    if (encryptedFormat(bytes) !== "pfdb-v2") return false; // v1 / not-yet-migrated / foreign
    try {
      await this.codec.decode(bytes);
      return true;
    } catch {
      return false; // a different DEK's folder
    }
  }

  /** Whether the folder's latest snapshot is a v2 (envelope) file — i.e. an
   *  ESTABLISHED envelope vault, regardless of whether its keyring is currently
   *  visible. Minting a fresh DEK over such a folder would fork it and lock out the
   *  devices that hold the real DEK, so the fresh-mint paths refuse when this is true
   *  and no keyring is available. Transport errors propagate (never fork on a blip). */
  private async folderHasV2Snapshots(): Promise<boolean> {
    if (!this.provider) return false;
    const latest = latestSnapshot(await this.provider.list());
    if (!latest) return false; // empty folder — safe to seed a fresh vault
    return encryptedFormat(await this.provider.download(latest.id)) === "pfdb-v2";
  }

  /** Set the passphrase (first-time on this device). Joins an existing folder
   *  vault if one is present, else mints a fresh one. */
  async setupVault(passphrase: string): Promise<void> {
    await this.openVault(passphrase, true);
  }

  /** Unlock a configured (locked) vault, or join a folder that already has one. */
  async unlock(passphrase: string): Promise<void> {
    await this.openVault(passphrase, false);
  }

  /** The unified open path: adopt the authoritative keyring (local vs remote, by
   *  version) and unwrap the DEK; else migrate a legacy v1 vault; else (only when
   *  `allowCreate`) mint a fresh vault. A wrong passphrase throws before anything
   *  is committed. */
  private async openVault(passphrase: string, allowCreate: boolean): Promise<void> {
    this.rebuildProvider();
    const local = this.store.getState().settings.vaultKeyring ?? null;
    let remote: Keyring | null = null;
    let remoteErrored = false;
    if (this.provider) {
      try {
        remote = await this.remoteKeyring();
      } catch {
        remoteErrored = true; // transient — never mint a fresh vault on a network blip
      }
    }
    // Pick the authoritative keyring:
    //  - REMOTE wins if it exists and either uses a DIFFERENT DEK (the folder was
    //    reset/rotated → our local keyring is for a dead DEK; we must NEVER
    //    republish it over the folder) OR is at an equal-or-higher version
    //    (converge to the folder — incl. concurrent-change ties, where
    //    remoteKeyring already returned the deterministic (version,id) winner).
    //  - LOCAL wins only when remote is absent, or same-DEK-but-strictly-newer
    //    (a keyring we published that Drive lost → recovery re-push).
    let chosen: Keyring | null;
    let recoverPush = false;
    if (remote && local) {
      if (remote.dekId !== local.dekId || remote.version >= local.version) {
        chosen = remote;
      } else {
        chosen = local;
        recoverPush = true; // same DEK, ours is newer than Drive's → heal the folder
      }
    } else if (remote) {
      chosen = remote;
    } else {
      chosen = local;
      recoverPush = local !== null && this.provider !== null && !remoteErrored;
    }
    if (chosen) {
      const dek = await this.unwrapOrThrow(passphrase, chosen);
      await this.adoptKeyring(chosen, dek);
      // Only recover-push our keyring if our DEK actually decodes the folder's data
      // — never stamp it onto an unrelated/foreign folder (that would hijack it and
      // lock its own devices out). Empty or our-DEK folder → safe.
      if (recoverPush && (await this.dekDecodesFolder().catch(() => false))) {
        await this.pushKeyring(chosen).catch(() => {});
      }
      this.refreshPhase();
      return;
    }
    // No keyring anywhere → is there a LEGACY v1 vault to migrate? Let a TRANSPORT
    // error from remoteKdfV1 PROPAGATE (do NOT catch→null): swallowing a Drive blip
    // here would fall through to createFreshVault and fork a fresh DEK over a v1
    // folder, locking out every other device. remoteKdfV1 returns null ONLY when the
    // folder genuinely has no v1 snapshot (empty, or already v2).
    let legacyKdf = this.store.getState().settings.vaultKdf ?? null;
    if (!legacyKdf && this.provider && !remoteErrored) {
      legacyKdf = await this.remoteKdfV1();
    }
    if (legacyKdf) {
      await this.migrateFromV1(passphrase, legacyKdf);
      return;
    }
    if (remoteErrored) {
      throw new Error("Couldn't reach Google Drive to check this folder's vault — try again.");
    }
    if (!allowCreate) throw new Error("No password set yet — turn on protection first.");
    await this.createFreshVault(passphrase);
  }

  /** Derive the KEK and unwrap the keyring's DEK, or throw a clear wrong-password
   *  error (the AES-GCM auth failure IS the passphrase check). */
  private async unwrapOrThrow(passphrase: string, keyring: Keyring): Promise<CryptoKey> {
    const kek = await deriveKey(passphrase, keyring.kdf);
    try {
      return await unwrapDek(kek, keyring.wrappedDEK);
    } catch {
      throw new Error("Incorrect password — this isn't the password your data was protected with.");
    }
  }

  /** Commit a keyring + its DEK as this device's active vault (keystore + local
   *  cache + codec). Clears superseded legacy fields. */
  private async adoptKeyring(keyring: Keyring, dek: CryptoKey): Promise<void> {
    this.dek = dek;
    this.codec = createDekCodec<SnapshotDoc>(dek);
    this.keyringEnsured = false; // new DEK/keyring → re-confirm the folder carries it
    await saveVaultKey(dek);
    await this.store.saveSettings({ vaultKeyring: keyring, vaultKdf: undefined, vaultCheck: undefined });
  }

  /** Upload a keyring to the folder (+ prune old keyrings). */
  private async pushKeyring(keyring: Keyring): Promise<void> {
    if (!this.provider) return;
    await this.provider.putKeyring(keyring.version, keyring.dekId, encodeKeyring(keyring));
    void this.provider.pruneKeyrings(SYNC.KEYRING_KEEP).catch(() => {});
  }

  /** Guarantee the folder holds a keyring for our CURRENT DEK before we write any
   *  v2 snapshot under it — otherwise other devices couldn't recover the DEK to
   *  read what we push (and could fork a second DEK). Also self-heals a deleted /
   *  older / different-DEK remote keyring. Runs once per session per DEK. Network
   *  errors propagate to runSync's catch (which retries). We only call this after
   *  runSync's sessionVerified backstop has confirmed our DEK decodes the folder's
   *  latest data, so publishing our keyring here is always for the folder's true
   *  data key. */
  private async ensureRemoteKeyring(): Promise<void> {
    if (this.keyringEnsured || !this.provider) return;
    const local = this.store.getState().settings.vaultKeyring;
    if (!local) return;
    const remote = await this.remoteKeyring(); // the folder's (version,id) WINNER keyring
    if (remote && remote.dekId === local.dekId && remote.version >= local.version) {
      this.keyringEnsured = true; // folder already carries a current keyring for our DEK
      return;
    }
    // The AUTHORITATIVE (newest by version,id) keyring uses a DIFFERENT DEK at >= our
    // version → the folder was rotated to a DEK that isn't ours (a reset elsewhere). We
    // are genuinely superseded: never lift our now-stale keyring over it. Drop and
    // require re-unlock for the folder's current DEK.
    //
    // We key this off the WINNER (`remote`), NOT "any different-dekId keyring at >= our
    // version": a benign tie (concurrent migration / setup / reset-vs-reset) leaves the
    // LOSER's different-dekId keyring sitting at our SAME version, but reconcileMintRace
    // made everyone adopt the WINNER's DEK — so `remote.dekId === local.dekId` and we
    // correctly early-return above. Firing on the mere presence of the loser would
    // drop→re-unlock→drop forever (a livelock). The only case the winner-based check
    // can't catch — a concurrent change that WINS the keyring tiebreak while a reset owns
    // the newer data DEK — is caught instead by runSync's sessionVerified backstop (our
    // DEK can't decode the reset's baseline) and is the documented, non-destructive
    // change-vs-reset bound.
    if (remote && remote.dekId !== local.dekId && remote.version >= local.version) {
      await this.dropLocalVault();
      throw new Error(
        "The vault was changed on another device — reload and unlock with the current password.",
      );
    }
    // Missing, or an older keyring (same DEK we must re-assert after a deletion, or a
    // superseded different DEK where WE are the newer authoritative one) → publish ours.
    await this.pushKeyring(local);
    this.keyringEnsured = true;
  }

  /** After minting a fresh vault, converge a concurrent first-mint race: if another
   *  device won the mint (a keyring with a DIFFERENT dekId now outranks ours),
   *  adopt ITS DEK — safe because the folder is shared under the SAME password, so
   *  the same passphrase unwraps it. Returns true if we adopted a foreign winner. */
  private async reconcileMintRace(passphrase: string, minted: Keyring): Promise<boolean> {
    if (!this.provider) return false;
    const remote = await this.remoteKeyring().catch(() => null);
    if (!remote || remote.dekId === minted.dekId) return false;
    // Another device won the mint. If it used the SAME shared password, our passphrase
    // unwraps its DEK and we adopt it. If it used a DIFFERENT password, give a clear
    // message — a bare "Incorrect password" is confusing here because the user just set
    // that password on this device.
    const dek = await this.unwrapDekWith(passphrase, remote);
    if (!dek) {
      throw new Error(
        "This folder was just set up with a different password on another device — use that password, or pick a different folder.",
      );
    }
    await this.adoptKeyring(remote, dek);
    return true;
  }

  /** Try to unwrap a keyring's DEK with a passphrase; null on the wrong passphrase
   *  (does NOT throw), for callers that want to branch rather than surface the
   *  generic "Incorrect password". */
  private async unwrapDekWith(passphrase: string, keyring: Keyring): Promise<CryptoKey | null> {
    try {
      return await unwrapDek(await deriveKey(passphrase, keyring.kdf), keyring.wrappedDEK);
    } catch {
      return null;
    }
  }

  /** Mint a brand-new vault (fresh DEK + keyring). Refuses to fork over a folder
   *  that already holds a vault: if a keyring exists it adopts that (with the same
   *  passphrase); if the keyring is missing/invisible but the folder still has v2
   *  data, it refuses (rather than superseding real data and locking out the devices
   *  that hold the real DEK). */
  private async createFreshVault(passphrase: string): Promise<void> {
    if (this.provider) {
      // TOCTOU re-check. Let a TRANSPORT error PROPAGATE (no catch→null) — forking a
      // DEK because a Drive read blipped would lock out every other device.
      const existing = await this.remoteKeyring();
      if (existing) {
        const dek = await this.unwrapOrThrow(passphrase, existing).catch(() => null);
        if (!dek) {
          throw new Error("This folder is already protected with a different password — enter that one.");
        }
        await this.adoptKeyring(existing, dek);
        this.refreshPhase();
        return;
      }
      // No visible keyring, but the folder already has v2 data → an established vault
      // whose keyring is deleted or not yet propagated. Do NOT mint over it.
      if (await this.folderHasV2Snapshots()) {
        throw new Error(
          "This folder is already encrypted but its key isn't available yet — try unlocking again in a moment.",
        );
      }
    }
    const keyring = await this.mintKeyring(passphrase, newSalt(), 1);
    await this.pushKeyring(keyring).catch(() => {});
    await this.reconcileMintRace(passphrase, keyring); // converge a concurrent first-mint
    this.refreshPhase();
  }

  /** Build + adopt a keyring wrapping a FRESH DEK (new dekId). */
  private async mintKeyring(passphrase: string, kdf: KdfParams, version: number): Promise<Keyring> {
    const dek = await generateDek();
    const kek = await deriveKey(passphrase, kdf);
    const wrappedDEK = await wrapDek(kek, dek);
    const keyring: Keyring = { format: KEYRING_FORMAT, version, dekId: newId(), kdf, wrappedDEK };
    await this.adoptKeyring(keyring, dek);
    return keyring;
  }

  /** One-time migration of a legacy v1 (direct-keyed) vault to envelope. Verifies
   *  the passphrase by decoding the folder's latest v1 snapshot, ADOPTS that data if
   *  this device is behind (so a fresh/behind device can join instead of
   *  deadlocking or publishing an empty baseline over the folder), then mints a DEK,
   *  writes the keyring, and republishes the current state as the first v2 snapshot. */
  private async migrateFromV1(passphrase: string, legacyKdf: KdfParams): Promise<void> {
    const v1key = await deriveKey(passphrase, legacyKdf);
    const v1codec = createEncryptedCodec<SnapshotDoc>(v1key, legacyKdf);

    if (!this.provider) {
      // No folder — verify against the local sentinel, then mint locally.
      if (!(await this.verifyLegacy(v1key, legacyKdf))) {
        throw new Error("Incorrect password — this isn't the password your data was protected with.");
      }
      await this.mintKeyring(passphrase, legacyKdf, 1);
      this.refreshPhase();
      return;
    }

    // A device may have migrated the folder since we listed — adopt its keyring.
    // Let a transport error PROPAGATE (no catch→null): a blip that hid an existing
    // keyring would let us fork a fresh DEK below.
    const already = await this.remoteKeyring();
    if (already) {
      const dek = await this.unwrapOrThrow(passphrase, already).catch(() => null);
      if (!dek) {
        throw new Error("This folder was re-protected with a different password — enter that one.");
      }
      await this.adoptKeyring(already, dek);
      this.refreshPhase();
      return;
    }

    // Verify the passphrase by decoding the folder's latest v1 snapshot, and CAPTURE
    // its data so a behind/fresh device can adopt it.
    const metas = await this.provider.list();
    const guardMax = metas.reduce((m, x) => Math.max(m, x.version), 0);
    const latest = latestSnapshot(metas);
    let folderDoc: SnapshotDoc | null = null;
    if (latest) {
      const bytes = await this.provider.download(latest.id);
      const fmt = encryptedFormat(bytes);
      if (fmt === "pfdb-v1") {
        try {
          folderDoc = await v1codec.decode(bytes);
        } catch {
          throw new Error("Incorrect password — this isn't the password your data was protected with.");
        }
      } else if (fmt === "pfdb-v2") {
        // The folder is ALREADY migrated (v2 latest) but its keyring isn't visible to
        // us (propagation lag, or it was deleted). We must NOT fork a fresh DEK over
        // it — that would supersede the folder's real v2 data with our own. Wait for
        // the keyring to reappear (a DEK-holding device republishes it, or lag clears)
        // and unlock again.
        throw new Error(
          "This folder is already encrypted but its key isn't available yet — try unlocking again in a moment.",
        );
      }
    }
    if (!folderDoc && !(await this.verifyLegacy(v1key, legacyKdf))) {
      throw new Error("Incorrect password — this isn't the password your data was protected with.");
    }

    // If the folder holds data this device hasn't seen, ADOPT it before republishing
    // as v2 — this fixes the deadlock where a fresh/behind device could never join a
    // still-v1 folder (it can't Pull without a codec). If we ALSO have unsynced local
    // edits, that's a genuine conflict we can't auto-merge → refuse (recoverable: an
    // up-to-date device migrates the folder, then this one joins via the keyring).
    let adoptedLatest = false;
    // The fingerprint AND the data in one lock, so both checks below read the same reality.
    const { fingerprint: preAdopt } = await this.store.exportWithFingerprint();
    // Is the folder's newest file simply OUR OWN last push? A crash between a successful push and
    // `markSynced` leaves exactly that: our file at the folder max, our watermark one behind. Its
    // content came from this database, so there is nothing to adopt and nothing at risk — but the
    // "unsynced changes" refusal fired on it and threw on EVERY unlock, so the device could never
    // migrate and had no way out (the message told a single-device user to "sync on an up-to-date
    // device first"). Bounded by version, so a file AHEAD of us — a diverged clone, or our own
    // push followed by further local edits — is not waved through.
    const latestIsOurOwn =
      !!latest && latest.deviceId === this.store.getState().settings.deviceId && latest.version <= preAdopt.localVersion;
    if (folderDoc && guardMax > preAdopt.lastSyncedVersion && !latestIsOurOwn) {
      // "Unsynced changes" read from the PERSISTED row, not this tab's memory. The app stays
      // editable while locked and nothing propagates state between tabs, so a second tab can be
      // recording expenses while this one sits on the unlock screen: in-memory `dirty` was false,
      // the refusal never fired, and the replace below deleted that tab's rows — then the
      // baseline superseded them folder-wide.
      if (preAdopt.localVersion > preAdopt.lastSyncedVersion) {
        throw new Error(
          "This device has unsynced changes and the shared folder has newer data — sync on an up-to-date device first, then unlock here.",
        );
      }
      // Record WHICH file we adopted — its data is provably ours now, and without the key it
      // would stay flagged as unincorporated and block this device's baseline push.
      //
      // `expect` for the same reason the union loop below carries one: this is a full replace, so
      // a write landing between the read and the write (the other tab again, an autopay
      // reconcile) would be absent from what we adopt and invisible to the check.
      await this.store.applyDocument(folderDoc, {
        seenSnapshotKey: latest ? snapshotKey(latest) : undefined,
        expect: preAdopt,
      }); // adopt the folder's latest v1 data → now current
      adoptedLatest = true;
    }

    // Every file AT `guardMax` must be accounted for before the baseline declares that version
    // superseded. A version COLLISION means several files share it and none is "the latest" —
    // each can hold records the others lack — and we still hold the v1 codec, so unioning them
    // needs no user step.
    //
    // `latest` is in this loop too whenever the adopt above did NOT run (we weren't behind, or
    // the file isn't decodable v1). Claiming its key unconditionally was silent data loss: with
    // `guardMax === lastSyncedVersion` — a peer's concurrent push landing after our TOCTOU
    // re-list — or with a latest in a format we can't read at all, the baseline published
    // straight over a file whose rows were never read, and the claim defeated the very hazard
    // rule meant to catch it.
    //
    // The set is files at `guardMax` PLUS every hazard above our watermark — not just the
    // collision set. `bumpVersionAbove(guardMax)` moves the watermark to `guardMax`, which
    // supersedes a peer file sitting BETWEEN our old watermark and it; those rows were never read
    // and would be lost with no prompt (confirmed by probe, and it happens with a foreign max too,
    // so it long predates this loop). Unioning such a file can resurrect rows deleted since —
    // merging never deletes — but that is recoverable by deleting them again, whereas losing a
    // peer's only copy is not. Files strictly BELOW our watermark are genuinely superseded and are
    // deliberately NOT unioned, so no ancient deletions come back.
    //
    // Anything we cannot decode or fetch is left UNRECORDED, so the ordinary push guard keeps
    // protecting it — a blocked push beats a silent overwrite.
    const incorporated: string[] = adoptedLatest && latest ? [snapshotKey(latest)] : [];
    const unreadable: { key: string; reason: "format" | "error" }[] = [];
    let mustAccountCount = 0;
    if (this.provider) {
      const stored = await this.store.persistedSyncState();
      const seenAlready = new Set(stored.seenSnapshots);
      const own = ownBound(stored); // the same bound the hazard rule applies, not a second copy
      // The SAME rule as the push guard, asked for rather than restated: two copies of "what
      // counts as unread" is how the migration guard and the push guard came to disagree.
      const hazards = this.hazards(metas, { ...stored, lastSyncedVersion: preAdopt.lastSyncedVersion });
      const mustAccount = [
        ...new Map(
          [...metas.filter((m) => m.version === guardMax), ...hazards].map((m) => [m.id, m]),
        ).values(),
      ].filter((m) => !(adoptedLatest && m.id === latest?.id));
      mustAccountCount = mustAccount.length + (adoptedLatest && latest ? 1 : 0);
      for (const file of mustAccount) {
        const key = snapshotKey(file);
        if (baselineClaim(file, { own, seen: seenAlready }) !== "must-read") {
          incorporated.push(key); // ours (same database), or already incorporated
          continue;
        }
        try {
          const bytes = await this.provider.download(file.id);
          if (encryptedFormat(bytes) !== "pfdb-v1") {
            unreadable.push({ key, reason: "format" }); // not ours to read → leave it guarded
            continue;
          }
          const doc = await v1codec.decode(bytes);
          // Fingerprint WITH the data, and revalidated inside the write lock: this is a full
          // replace, so a write landing between the read and the write (another tab, an autopay
          // reconcile) would otherwise be absent from the plan and invisible to the check —
          // deleted silently.
          const { doc: local, fingerprint } = await this.store.exportWithFingerprint();
          const merged = applyChoices(planMerge(local.data, doc.data), {});
          await this.store.applyDocument(
            { schemaVersion: local.schemaVersion, version: Math.max(local.version, doc.version), data: merged },
            { dirty: true, seenSnapshotKey: key, expect: fingerprint },
          );
          incorporated.push(key);
        } catch {
          // Undecodable, unreachable, or raced by a concurrent write → don't claim it.
          unreadable.push({ key, reason: "error" });
        }
      }
    }

    // STOP HERE if anything at the floor is unaccounted for — before minting a keyring.
    //
    // Leaving it unclaimed is the right call (a blocked push beats a silent overwrite), but
    // letting the migration FINISH around it was a trap: the keyring was minted and adopted and
    // `vaultKdf` cleared, so this device held only a v2 codec while a v1 file blocked its every
    // push. "Pull latest" cannot decode that file, re-unlocking no longer re-runs the migration
    // (the keyring is now set), and the error even blamed another device for still upgrading — a
    // permanently dead sync whose only exit was deleting the file in Drive by hand. One transient
    // 503 was enough. Refusing instead leaves the device on v1, forks no DEK, and stays
    // retryable.
    if (incorporated.length < mustAccountCount) {
      throw new Error(
        unreadable.some((u) => u.reason === "format")
          ? "One of the shared folder's snapshots was written by a different version of this app, so the encryption upgrade was not started here. Update this device (or finish the upgrade on the device that wrote it), then unlock again."
          : "Couldn't read one of the shared folder's snapshots just now, so the encryption upgrade was not started — nothing has changed. Check the connection and unlock again.",
      );
    }

    // Reuse the legacy salt for the KEK (no need to change it) — the DEK is fresh.
    const minted = await this.mintKeyring(passphrase, legacyKdf, 1);
    await this.pushKeyring(minted);
    // A device that migrated concurrently may have won — adopt its DEK and let it
    // publish the baseline (never fork a second DEK for the folder).
    if (await this.reconcileMintRace(passphrase, minted)) {
      this.refreshPhase();
      return;
    }
    // Floor the baseline at the version our guard validated (NOT a fresh re-list):
    // if a snapshot landed after the guard, runSync's own pull-before-push guard
    // then catches it instead of us silently superseding it.
    // Only the keys of files we ACTUALLY incorporated, from the SAME listing the guard validated
    // (not a fresh one) — so a snapshot that landed afterwards, or a sibling we couldn't decode,
    // is left to runSync's own guard rather than silently superseded. Our own files, and
    // everything strictly below the floor, need no key.
    await this.publishBaseline(guardMax, incorporated);
  }

  /** Verify a legacy v1 key against the latest v1 snapshot (or the local sentinel).
   *  True when there is genuinely nothing to verify against (brand-new). */
  private async verifyLegacy(key: CryptoKey, kdf: KdfParams): Promise<boolean> {
    if (this.provider) {
      const latest = latestSnapshot(await this.provider.list());
      if (latest) {
        const bytes = await this.provider.download(latest.id);
        if (encryptedFormat(bytes) === "pfdb-v1") {
          try {
            await createEncryptedCodec<SnapshotDoc>(key, kdf).decode(bytes);
            return true;
          } catch {
            return false;
          }
        }
      }
    }
    const check = this.store.getState().settings.vaultCheck;
    if (check) {
      try {
        return (await decryptJson<string>(key, check)) === VAULT_SENTINEL;
      } catch {
        return false;
      }
    }
    // Fail CLOSED: migration only runs when a v1 vault exists, which for any real
    // v1 device means there's ciphertext (a snapshot or the local sentinel) to
    // verify against. Nothing to verify → treat as wrong, never accept an arbitrary
    // passphrase and re-mint the vault under it.
    return false;
  }

  /** Publish the current local state as a fresh v2 baseline snapshot, lifting the
   *  version above the folder's max so its latest becomes DEK-readable. Used by
   *  migration and by a fresh-DEK password reset.
   *
   *  `floor`: when the caller already validated the folder's max version (e.g.
   *  migration's current-device guard), pass it so a snapshot that lands AFTER that
   *  check isn't silently marked superseded — runSync's own pull-before-push guard
   *  then catches it. Omit (deliberate reset) to supersede everything now present. */
  private async publishBaseline(floor?: number, supersededKeys?: readonly string[]): Promise<void> {
    this.refreshPhase(); // engine now seals with the (new) DEK; new dekId → fresh session file
    if (!this.engine || !this.provider) return; // no folder → local IS the source of truth
    this.sessionVerified = true; // our DEK is authoritative for this new baseline
    let max = floor;
    let keys = supersededKeys;
    if (max === undefined) {
      // No caller-validated floor → this listing defines both the floor AND what is superseded.
      const metas = await this.engine.list();
      max = metas.reduce((m, x) => Math.max(m, x.version), 0);
      keys = metas.map(snapshotKey);
    }
    // The keys matter as much as the floor: since a file AT the watermark counts as a hazard,
    // a baseline that recorded only the number could never be published.
    await this.store.bumpVersionAbove(max, keys ?? []);
    await this.syncNow();
  }

  async lock(): Promise<void> {
    await clearVaultKey();
    this.codec = null;
    this.dek = null;
    this.keyringEnsured = false;
    this.refreshPhase(); // also tears down the engine (no codec → no engine)
  }

  /** Restore the DEK from this device's keystore (no passphrase needed) after a
   *  refresh. Only for a v2 vault — a legacy device (no cached keyring) is left for
   *  unlock (which migrates). ALWAYS refreshes the phase (even when it can't
   *  restore) so a configured-but-locked device — including a LOCAL-ONLY one with no
   *  Drive client id, where nothing else refreshes the phase on boot — shows "locked"
   *  (or "no-vault"), not the misleading setup screen for a vault that exists. */
  async restoreFromKeystore(): Promise<boolean> {
    const hasVault = this.store.getState().settings.vaultKeyring !== undefined;
    const stored = hasVault ? await loadVaultKey() : null;
    if (stored) {
      this.dek = stored.key;
      this.codec = createDekCodec<SnapshotDoc>(stored.key);
      this.keyringEnsured = false; // re-confirm the folder carries our keyring on next sync
    }
    this.refreshPhase(); // derive phase from settings: ready (codec) / locked / no-vault
    return stored !== null;
  }

  /** Change the password while UNLOCKED (also the forgot-password recovery path,
   *  since it needs only the held DEK, not the old passphrase): re-wrap the SAME
   *  DEK under the new passphrase and publish a new keyring version. No snapshot is
   *  rewritten — every old file stays readable, and other devices keep syncing
   *  (they just need the new password at their next unlock). */
  async changePassword(newPassphrase: string): Promise<void> {
    if (!this.dek) throw new Error("Unlock first to change the password.");
    this.rebuildProvider();
    const local = this.store.getState().settings.vaultKeyring;
    if (!local) throw new Error("No vault to change — set a password first.");
    let baseVer = local.version;
    if (this.provider) {
      // Let a network error propagate (abort) rather than publishing blind.
      const remote = await this.remoteKeyring();
      if (remote) {
        // If the folder's DEK was rotated on another device (a reset), our held DEK
        // is stale — re-wrapping it would enshrine the WRONG DEK as the folder's
        // latest keyring and make everyone's snapshots unreadable. Refuse; the user
        // must reload/unlock for the folder's current DEK first.
        if (remote.dekId !== local.dekId) {
          throw new Error(
            "The folder's encryption changed on another device — reload and unlock before changing the password.",
          );
        }
        baseVer = Math.max(baseVer, remote.version);
      }
    }
    const kdf = newSalt();
    const kek = await deriveKey(newPassphrase, kdf);
    const wrappedDEK = await wrapDek(kek, this.dek);
    // SAME dekId — this is a re-wrap of the existing DEK, not a new vault.
    const keyring: Keyring = {
      format: KEYRING_FORMAT,
      version: baseVer + 1,
      dekId: local.dekId,
      kdf,
      wrappedDEK,
    };
    // Cache locally first so a failed upload doesn't lose the new password on this
    // device (the DEK is unchanged regardless). Reset keyringEnsured so that if the
    // Drive upload below fails transiently, the NEXT sync's ensureRemoteKeyring still
    // re-verifies and repairs the folder's keyring (rather than skipping it and
    // leaving Drive on the old keyring while this device is on the new password).
    await this.store.saveSettings({ vaultKeyring: keyring });
    this.keyringEnsured = false;
    if (this.provider) {
      const res = await this.provider.putKeyring(keyring.version, keyring.dekId, encodeKeyring(keyring));
      // TOCTOU: another device may have changed the password at the same version.
      // Both wrap the SAME DEK, so no data is at risk; the folder just converges to
      // one winning keyring. Adopt the authoritative latest so this device agrees
      // with the rest on which password is current.
      // Seed with the file we just wrote, so read-after-write lag returning an empty
      // list can't throw, and use the shared newest-keyring order so this agrees
      // with getLatestKeyring/prune on who won.
      const all = await this.provider.listKeyrings();
      // Concurrent DESTRUCTIVE RESET detection: a same-or-higher-version keyring with a
      // DIFFERENT dekId (visible cheaply via the mirrored appProperty) means the folder's
      // DEK is being rotated. Our old-DEK keyring must NOT stay authoritative over the
      // new-DEK data — even if we'd win the (version,id) tiebreak, and even before the
      // reset's baseline snapshot is visible (which is why dekDecodesFolder alone isn't
      // enough here). Drop and require re-unlock; the reset device re-lifts its keyring
      // above ours via ensureRemoteKeyring on its NEXT sync (not inside resetPassword).
      if (all.some((k) => k.id !== res.id && k.version >= res.version && k.dekId && k.dekId !== local.dekId)) {
        void this.provider.pruneKeyrings(SYNC.KEYRING_KEEP).catch(() => {});
        await this.dropLocalVault();
        throw new Error(
          "The vault was reset on another device — reload and unlock with the new password.",
        );
      }
      const winner = newestKeyring([res, ...all]) ?? res;
      if (winner.id !== res.id) {
        void this.provider.pruneKeyrings(SYNC.KEYRING_KEEP).catch(() => {});
        const remoteWinner = await this.remoteKeyring().catch(() => null);
        if (remoteWinner && remoteWinner.dekId !== local.dekId) {
          // A concurrent RESET rotated the DEK — our held DEK is now stale. Drop the
          // local vault (clears dek/codec/keyring) so state can't desync; the user
          // re-unlocks for the folder's current DEK.
          await this.dropLocalVault();
          throw new Error(
            "The vault was reset on another device — reload and unlock with the new password.",
          );
        }
        // Concurrent SAME-DEK change: our DEK is still correct; adopt the winner's
        // keyring so this device agrees on the current password, then report it.
        if (remoteWinner) await this.store.saveSettings({ vaultKeyring: remoteWinner });
        this.refreshPhase();
        throw new Error(
          "The password was also changed on another device at the same time — that one won. Use it (or change again).",
        );
      }
      // We WON the tiebreak. A concurrent destructive RESET (different dekId) is
      // already caught above by the `all.some(...)` dekId check, and if its keyring
      // only becomes visible later, our next runSync's ensureRemoteKeyring detects the
      // different-dekId keyring and drops. We deliberately do NOT re-check
      // dekDecodesFolder() here: it returns false for a merely v1 latest (the
      // documented interrupted-migration window) too, which would spuriously drop a
      // perfectly valid same-DEK password change and show a false "vault was reset".
      void this.provider.pruneKeyrings(SYNC.KEYRING_KEEP).catch(() => {});
    }
    this.refreshPhase();
  }

  /** Forgotten-password reset. If this device still holds the DEK, re-key
   *  non-destructively (all old files stay readable) via changePassword. Otherwise
   *  mint a FRESH vault from the local plaintext and publish a new baseline —
   *  OLD-DEK Drive snapshots/backups become unreadable (unrecoverable without the
   *  old password). Guarded so it can only run when THIS device holds the folder's
   *  latest, so it can never orphan newer shared data. No local data is lost. */
  async resetPassword(newPassphrase: string): Promise<void> {
    this.rebuildProvider();
    if (!this.dek) {
      const stored = this.store.getState().settings.vaultKeyring ? await loadVaultKey() : null;
      if (stored) {
        this.dek = stored.key;
        this.codec = createDekCodec<SnapshotDoc>(stored.key);
      }
    }
    if (this.dek) {
      await this.changePassword(newPassphrase);
      return;
    }
    // No DEK available → the folder's OLD-DEK data can't be decoded and will be
    // SUPERSEDED by this device's local state. Only allow that when THIS device
    // already holds the folder's latest version — otherwise publishing our (possibly
    // stale) local state would ORPHAN newer shared data (data loss). Behind → refuse
    // and point the user at a non-destructive recovery. Let a transport error
    // propagate (never reset blind).
    if (this.provider) {
      const folderMax = (await this.provider.list()).reduce((m, x) => Math.max(m, x.version), 0);
      // Stored watermark: a sibling tab may have pulled since this tab loaded, and refusing a
      // reset on a stale reading sends the user down a recovery path they don't need.
      if (folderMax > (await this.store.persistedSyncState()).lastSyncedVersion) {
        throw new Error(
          "This device's data is behind the shared folder, so resetting here would lose the newer changes. " +
            "Reset from a device that's up to date, or use “Change password” on a device that's still unlocked (keeps everything). " +
            "If no device can open it, disconnect this folder in Settings first — reset then starts a fresh vault from this device's data.",
        );
      }
    }
    // Fresh vault from local data (old-DEK files become unreadable, but no local data lost).
    let baseVer = this.store.getState().settings.vaultKeyring?.version ?? 0;
    if (this.provider) {
      const remote = await this.remoteKeyring().catch(() => null);
      if (remote) baseVer = Math.max(baseVer, remote.version);
    }
    const keyring = await this.mintKeyring(newPassphrase, newSalt(), baseVer + 1);
    await this.pushKeyring(keyring).catch(() => {});
    await this.publishBaseline();
  }

  // -- drive ---------------------------------------------------------------
  // Note: configuring Drive / picking a folder does NOT require a vault — you
  // can connect a folder and only later set a passphrase (or vice versa). The
  // engine (which encrypts) only comes alive once BOTH provider and codec exist.
  configureDrive(clientId: string): void {
    // Reuse the existing auth (and its session) if the client id is unchanged —
    // recreating it would reset the session file and create a duplicate.
    if (!this.auth || this.clientId !== clientId) {
      this.auth = new GoogleAuth(clientId);
      this.clientId = clientId;
    }
    this.refreshPhase();
  }

  /** A GOOGLEFINANCE price oracle bound to this session's OAuth, or null when
   *  Drive isn't configured (no client id yet). The sheet id is persisted in
   *  device-local settings via the store. */
  priceOracle(): SheetsOracle | null {
    if (!this.auth) return null;
    return new SheetsOracle(this.auth, {
      getSheetId: () => this.store.getState().settings.priceSheetId,
      setSheetId: (id) => this.store.saveSettings({ priceSheetId: id }),
    });
  }

  /** Interactive: consent + folder picker. Returns the chosen folder. */
  async connectFolder(apiKey: string): Promise<{ id: string; name: string } | null> {
    if (!this.auth) throw new Error("configure the Drive client id first");
    const token = await this.auth.getToken(true);
    const folder = await pickFolder(apiKey, token);
    if (!folder) return null;
    await this.store.saveSettings({ drive: { folderId: folder.id, folderName: folder.name } });
    await this.reconcileVaultWithFolder();
    this.refreshPhase();
    return folder;
  }

  /** Explicit user re-auth (opens the consent popup) WITHOUT re-picking the folder
   *  — for when the stored token expired or was revoked and background sync started
   *  failing. Refreshes the token, then resyncs any pending changes. */
  async reconnect(): Promise<void> {
    if (!this.auth) throw new Error("configure the Drive client id first");
    await this.auth.getToken(true); // interactive popup — user-initiated
    this.refreshPhase();
    if (this.engine && this.store.getState().dirty) await this.syncNow();
  }

  /** If the connected folder's vault uses a DIFFERENT DEK than ours (its keyring's
   *  dekId differs), our key can't decrypt the folder — drop the local vault so the
   *  user unlocks for THIS folder rather than writing forked snapshots under the
   *  wrong key. Falls back to the legacy salt comparison for a not-yet-migrated
   *  folder. Safe to call on startup and after a folder change. */
  async reconcileVaultWithFolder(): Promise<void> {
    this.rebuildProvider();
    if (!this.provider) return;
    const local = this.store.getState().settings.vaultKeyring;
    if (local) {
      let remote: Keyring | null;
      try {
        remote = await this.remoteKeyring();
      } catch {
        return; // transient — the pre-push backstop still prevents poisoning
      }
      if (remote) {
        if (remote.dekId !== local.dekId) await this.dropLocalVault();
        return;
      }
      // No keyring on the folder. If its latest snapshot is nonetheless a LEGACY v1
      // file, this is a folder we don't own an envelope vault on — either a foreign
      // v1 folder we mis-connected to, or a legacy folder we haven't migrated. Our v2
      // DEK doesn't belong here; drop so unlock re-derives (migrateFromV1 for our own
      // v1 data, or a clean adopt), rather than later stamping our keyring and
      // overwriting that folder's data. (A v2 latest with a deleted keyring is OUR
      // data — leave it; openVault/ensureRemoteKeyring recover it. Empty folder: fine.)
      try {
        const latest = latestSnapshot(await this.provider.list());
        if (latest && encryptedFormat(await this.provider.download(latest.id)) === "pfdb-v1") {
          await this.dropLocalVault();
        }
      } catch {
        // transient — leave the vault; the pre-push guards still prevent poisoning
      }
      return;
    }
    // Legacy (pre-envelope) vault: compare KDF salts as before.
    const localKdf = this.store.getState().settings.vaultKdf;
    if (!localKdf) return;
    let remote: KdfParams | null;
    try {
      remote = await this.remoteKdfV1();
    } catch {
      return;
    }
    if (remote && remote.salt !== localKdf.salt) await this.dropLocalVault();
  }

  /** Forget this device's vault (key + cached keyring + codec) so the user must
   *  unlock for the current folder. */
  private async dropLocalVault(): Promise<void> {
    await this.store.saveSettings({ vaultKeyring: undefined, vaultKdf: undefined, vaultCheck: undefined });
    await clearVaultKey();
    this.codec = null;
    this.dek = null;
    this.refreshPhase();
  }

  /** Provider needs only auth + folder (no vault) — so it can fetch the salt
   *  for a fresh-device unlock. */
  private rebuildProvider(): void {
    const folderId = this.store.getState().settings.drive?.folderId;
    this.provider = this.auth && folderId ? new DriveSyncProvider(this.auth, folderId) : null;
  }

  /** Engine needs provider + codec (it encrypts). Preserves the session file
   *  across rebuilds ONLY while the folder is unchanged — re-picking a folder
   *  must start a fresh file in the NEW folder, not keep mutating the old one. */
  private rebuildEngine(): void {
    const { settings } = this.store.getState();
    const folderId = settings.drive?.folderId ?? null;
    // Identify the vault by its DEK id, NOT the codec object and NOT the KDF salt.
    // The DEK encrypts the snapshots and is stable across password changes, so a
    // lock→unlock OR a password change (same DEK, new salt) keeps the SAME session
    // file. Only a genuinely different DEK (different folder, fresh vault, restored
    // backup with a new DEK) must start a fresh file, since the old file's bytes
    // were sealed with a different DEK.
    const dekId = this.codec ? (settings.vaultKeyring?.dekId ?? null) : null;
    // When locked (codec null → dekId null) we compare against the LAST ACTIVE
    // dekId, so a later unlock with the same DEK still matches and resumes.
    const sameTarget =
      this.codec !== null && folderId === this.engineFolderId && dekId === this.engineDekId;
    // Stash the live session id whenever an engine exists, so it survives the
    // codec-null gap during a lock.
    if (this.engine) this.stashedSessionFileId = this.engine.getSessionFileId();
    const prevSession = sameTarget ? this.stashedSessionFileId : null;
    this.engineFolderId = folderId;
    if (dekId !== null) this.engineDekId = dekId; // keep prior dekId while locked
    if (!sameTarget) this.sessionVerified = false; // new vault/folder — re-verify before push
    if (!this.provider || !this.codec) {
      this.engine = null;
      return;
    }
    this.engine = new SyncEngine<SnapshotDoc>({
      provider: this.provider,
      codec: this.codec,
      versionOf: (doc) => doc.version,
      author: settings.author,
      deviceId: settings.deviceId,
      schemaVersion: SCHEMA.version,
    });
    if (prevSession) this.engine.setSessionFileId(prevSession);
  }

  private refreshPhase(): void {
    this.rebuildProvider();
    this.rebuildEngine();
    // AFTER the rebuild, so the engine is already pointing at the new folder and the switch is
    // noticed now rather than on the next observation.
    this.forgetOtherFolder();
    if (!this.codec) {
      // Distinguish a configured-but-LOCKED vault (DEK dropped from this browser,
      // but the cached keyring remains) from a device that has NEVER set a
      // passphrase — so the UI can say "unlock" instead of the misleading "set a
      // passphrase". A legacy v1 device (vaultKdf, not yet migrated) also counts as
      // configured → its unlock migrates it. Without this, locking looked like no-vault.
      const s = this.store.getState().settings;
      const configured = s.vaultKeyring !== undefined || s.vaultKdf !== undefined;
      this.set({ phase: configured ? "locked" : "no-vault" });
      return;
    }
    this.set({ phase: this.engine ? "ready" : "no-folder" });
    // Becoming ready with an already-dirty store should kick off a push.
    this.scheduleAutosave();
  }

  // -- push / pull ---------------------------------------------------------
  private inFlightSync: Promise<void> | null = null;
  /** Serializes sync OPERATIONS (a push and a pull-apply) so they never run
   *  interleaved — a pull's applyDocument must not land mid-push, and vice
   *  versa. (syncNow additionally coalesces concurrent push requests.) */
  private opChain: Promise<void> = Promise.resolve();
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Coalesce overlapping syncs (autosave + manual button + retry) into one
   *  in-flight push, so they can't race to engine.push. Any edit that lands
   *  during the push is picked up by the post-sync scheduleAutosave. */
  syncNow(): Promise<void> {
    if (this.inFlightSync) return this.inFlightSync;
    this.inFlightSync = this.serialize(() => this.runSync()).finally(() => {
      this.inFlightSync = null;
    });
    return this.inFlightSync;
  }

  private async runSync(): Promise<void> {
    if (!this.engine) throw new Error("sync not ready");
    this.set({ phase: "syncing" });
    try {
      const deviceId = this.store.getState().settings.deviceId;
      const metas = await this.engine.list();
      // Validate a resumed session file (from sessionStorage across a refresh, or
      // a prior session): drop it unless it still exists AND belongs to THIS
      // device. This stops us updating a file that was pruned/deleted (404) OR —
      // if sessionStorage was tampered/stale — overwriting another device's file
      // under our key. Dropping it makes the next push CREATE a fresh file.
      let sessionFileId = this.engine.getSessionFileId();
      if (sessionFileId) {
        const own = metas.find((m) => m.id === sessionFileId);
        if (!own || own.deviceId !== deviceId) {
          this.engine.setSessionFileId(null);
          sessionFileId = null;
        }
      }
      // Everything EXCEPT this session's own file. Which of those count as HAZARDS is decided by
      // `unincorporatedFiles`, which also excuses files bearing THIS deviceId — so this comment
      // no longer says what it used to ("we deliberately do NOT narrow this to other-device
      // files"); that rule is gone and the reasoning has changed:
      //
      //  - For real tabs the exemption is sound: tabs share one IndexedDB and `exportDocument`
      //    reads the DATABASE, so any tab's push already carries every tab's rows — and the
      //    cross-tab write lock closes the interleaving window that once let two tabs clobber
      //    each other. It also drops a false alarm: a crash between a successful push and
      //    `markSynced` leaves our own file above the watermark, which used to demand a
      //    pointless "review" of our own data and now simply re-publishes.
      //  - It is NOT sound for a CLONED profile (a copied IndexedDB keeps the deviceId while the
      //    data diverges), so the exemption is BOUNDED BY VERSION: a file carrying our deviceId is
      //    excused only up to the version this database has actually reached. A twin that edited
      //    and pushed past us sits above that, so the guard still fires and its rows get reviewed.
      const others = metas.filter((m) => m.id !== sessionFileId);
      // Record the listing HERE, immediately: it is the observation, and the checks below (vault
      // verification, keyring repair) can throw without making it any less true.
      this.observed(this.newListing(metas), await this.store.persistedSyncState(), [sessionFileId]);

      // Was the vault ROTATED under us by another tab? Tabs share the settings row, and a
      // settings write now (correctly) reads that row — so this tab's `state.settings` can hold
      // ANOTHER tab's freshly rotated keyring while `this.codec` still seals with our OLD DEK.
      // Both keyring checks compare against those same settings, so neither can notice, and
      // `sessionVerified`/`keyringEnsured` were latched true earlier in the session. Left alone,
      // this tab publishes a snapshot nobody — including itself after a reload — can decode,
      // taking the whole shared folder down with no in-app recovery.
      //
      // `engineDekId` is the DEK id our codec was actually built for, so a mismatch means the
      // row moved on without us: force the verification below to run, which fails against the
      // folder's new baseline and asks for the passphrase instead of publishing.
      const storedDekId = this.store.getState().settings.vaultKeyring?.dekId ?? null;
      if (this.codec && storedDekId !== null && storedDekId !== this.engineDekId) {
        this.sessionVerified = false;
        this.keyringEnsured = false;
      }

      // Backstop: never push under a key that can't decrypt the folder's
      // existing data (guards against any stale/mismatched codec slipping
      // through). Verify once per session against the latest other snapshot.
      // ONLY a pfdb-v2 file that fails to decode means a WRONG DEK — a v1 (legacy /
      // not-yet-fully-migrated) latest is NOT a mismatch; treating it as one would
      // wedge a folder whose migration was interrupted (keyring written, v2 baseline
      // not). Skipping it here lets this session PUBLISH the v2 baseline (completing
      // the migration), still protected by the data-loss version guard below.
      if (!this.sessionVerified && this.provider && this.codec && others.length > 0) {
        const latest = latestSnapshot(others)!; // others.length > 0 guaranteed above
        const bytes = await this.provider.download(latest.id);
        if (encryptedFormat(bytes) === "pfdb-v2") {
          try {
            await this.codec.decode(bytes);
          } catch {
            this.set({
              phase: "error",
              message: "Vault doesn't match this folder — re-enter the passphrase for it.",
            });
            return;
          }
        }
      }
      this.sessionVerified = true;

      // Self-heal: guarantee the folder holds a keyring for our DEK BEFORE we write
      // a snapshot under it — otherwise a device that joins couldn't recover the DEK
      // to read what we push (and might fork a second one). Also run this before the
      // clean no-op return so Sync now can repair a missing/deleted keyring even when
      // there are no local edits. Safe here: we only reach this point after the
      // sessionVerified backstop confirmed our DEK decodes the folder's latest data.
      // A network failure throws → caught below → retried.
      await this.ensureRemoteKeyring();

      // Nothing local to contribute AND the folder already has data → no-op.
      // (This stops a fresh device from publishing its empty/old state over
      // populated shared data. But we DO seed a brand-new EMPTY folder even from
      // a clean local doc — e.g. right after restoring a backup.)
      if (!this.store.getState().dirty && others.length > 0) {
        this.set({ phase: "ready", message: "nothing to sync" });
        return;
      }

      // Max version across ALL other files (this device's prior files, another TAB
      // on this device, or another device). Used both to keep our next version
      // unique AND as the data-loss guard below — any file not written by THIS
      // session is a potential concurrent edit.
      const remoteMax = others.reduce((max, m) => Math.max(max, m.version), 0);

      // DATA-LOSS GUARD: if ANY other session advanced beyond what THIS session has
      // synced, it pushed changes we haven't seen. Pushing now would silently
      // overwrite them (we have no auto-merge). Refuse and send the user to "Pull
      // latest" to review the diff. Compared against `others` (every file except
      // this session's own), NOT just other-device files — a second tab on the same
      // profile is an independent writer and must trip this too. Normally our own
      // prior files are <= lastSynced so only a genuinely-unseen newer file exceeds
      // it; the lone exception is a post-push/pre-markSynced crash leaving an own
      // file above lastSynced, which here fires a benign reviewed Pull of our own
      // data (no silent overwrite either way).
      // Not `remoteMax > lastSynced`: a scalar watermark can't express "I merged that file",
      // so a device holding two files above our mark could never be cleared and the merge was
      // unpublishable forever, with the destructive replace as the only exit. A file is a
      // hazard only if it is unincorporated — see unincorporatedFiles for the three
      // subsumption rules.
      // EVERY input from the PERSISTED row, not this tab's memory. A sibling tab's merge or pull
      // updates the shared database and the stored log; judging from stale memory re-flags a file
      // that tab already incorporated, the guard refuses, and since that path returns without
      // scheduling a retry (autosave is gated on `phase === "ready"`) this tab silently stops
      // syncing until a reload. The same staleness once made our OWN file look like a clone.
      const sync = await this.store.persistedSyncState();
      const unmerged = this.hazards(others, sync);
      if (unmerged.length > 0) {
        this.set({
          phase: "error",
          message: "Remote has newer changes — Pull latest and review before syncing.",
        });
        return;
      }

      // Lift our version above everything already in the folder so we don't mint
      // a colliding version number (ours included, to stay unambiguous).
      await this.store.reconcileVersion(remoteMax);

      // With provenance, so a device loading this file knows which older files it already holds.
      const doc = await this.store.exportForPublish();
      const meta = await this.engine.push(doc, this.sessionStartIso, new Date().toISOString());

      // TOCTOU guard: the pre-push list() and the push() aren't atomic on Drive,
      // so ANOTHER WRITER (another device, or another tab on this profile) could
      // have written within that window (both minting the same version). Re-list
      // and, if any OTHER file is now at our version or higher, treat it as a
      // conflict — DON'T mark synced (stay dirty so the user reconciles via Pull
      // latest). Neither side's snapshot is lost (files are immutable); this just
      // stops us from believing we won. Exclude THIS session's prior file AND the
      // file we just wrote (persistSession hasn't recorded meta.id as our session
      // yet) so they never self-trigger.
      const after = (await this.engine.list()).filter(
        (m) => m.id !== sessionFileId && m.id !== meta.id,
      );
      if (after.some((m) => m.version >= meta.version)) {
        // `after` proves another device just published — record it, or the notice stays silent
        // about a file we now know is unread.
        this.observed(this.newListing(after), await this.store.persistedSyncState(), [sessionFileId, meta.id]);
        this.set({
          phase: "error",
          message: "Sync conflict — another device synced at the same time. Pull latest to reconcile.",
        });
        return;
      }

      // Prune the acknowledgement log to files the folder still holds — otherwise it is bounded
      // only by a cap, and past the cap the oldest acknowledgement is dropped and the guard can
      // never clear. `after` is the post-push listing (our own files are exempt by deviceId).
      await this.store.markSynced(meta.version, after.map(snapshotKey));
      // Measure the post-push listing rather than asserting "we are level" — same rule, one place.
      this.observed(this.newListing(after), await this.store.persistedSyncState(), [sessionFileId, meta.id]);
      // Record this session's file id (only now, on confirmed success) so a
      // refresh resumes it rather than minting a new file.
      this.persistSession();
      this.set({ phase: "ready", message: `synced v${meta.version}` });
      // Housekeeping: cap the folder at SNAPSHOT_KEEP files — but ONLY delete
      // THIS device's own superseded files (never a foreign device's, which may
      // hold unmerged edits), and never the file we just wrote (meta.id).
      // Fire-and-forget — a pruning failure must not affect the successful sync.
      void this.engine.prune(SYNC.SNAPSHOT_KEEP, meta.id, deviceId).catch(() => {});
      // An edit that landed during the push leaves the store dirty — pick it up.
      this.scheduleAutosave();
    } catch (e) {
      // A THROWN error here is a transport/unexpected failure (the intentional
      // data-loss guard and conflict path use `return`, not throw).
      const authNeeded = e instanceof SignInRequiredError;
      this.set({
        phase: "error",
        message: authNeeded
          ? `${SYNC_TEXT.authExpired} — click Reconnect to resume sync.`
          : "Couldn't sync just now — your changes are saved on this device, and syncing will retry.",
        detail: String(e),
        needsAuth: authNeeded,
      });
      // Retry a TRANSIENT Drive blip so autosave isn't wedged forever (local data
      // stays durable meanwhile) — but do NOT auto-retry a sign-in failure: it
      // can't succeed without the user, and looping would churn + flicker the
      // Reconnect button. The user's Reconnect click resumes sync.
      if (!authNeeded) this.scheduleRetry();
      throw e;
    }
  }

  /** Retry a transient sync failure later (local data is safe regardless). */
  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.engine && this.store.getState().dirty) {
        void this.syncNow().catch(() => {
          /* surfaced via status; a further failure reschedules another retry */
        });
      }
    }, SYNC.AUTOSAVE_RETRY_MS);
  }

  /** Look at the shared folder ONCE, on app start, before the user can touch anything.
   *
   *  A just-opened device is the most likely to be stale, and finding that out only after an edit
   *  turns a free fast-forward into a merge the user has to reason about. So this runs first and
   *  the shell blocks on it.
   *
   *  Read-only apart from ONE write, and that write is deliberately hard to reach: local must be
   *  clean AND the incoming snapshot must be a pure addition. Anything removed or modified goes to
   *  the user, because another device restoring an old backup and publishing it looks exactly like
   *  "just catch up" — and adopting it silently would drop rows. Composed entirely from the
   *  existing, reviewed pieces (`hazards`, `checkRemote`, `applyRemote`); it adds no sync rules.
   *
   *  Never pushes: publishing local work stays with the guarded autosave path. */
  async startupCheck(timeoutMs = 8000): Promise<StartupCheck> {
    const settings = this.store.getState().settings;
    if (!settings.drive?.folderId || !this.provider) return { kind: "no-folder" }; // local-only
    /** Record a listing and report what it showed.
     *
     *  Two jobs, both load-bearing. It refuses to publish once the run is abandoned — a run we
     *  stopped waiting for must never write over newer facts. And it sets `listed`, which is what
     *  makes "we couldn't see the folder" a statement about THIS run rather than a default: a
     *  listing that succeeded is not retracted just because a later step timed out or the token
     *  expired mid-download. `behind` is still returned when abandoned so the run can finish its
     *  own reasoning without publishing. */
    const note = (
      listing: Listing,
      sync: SyncFacts,
      ignore: readonly (string | null | undefined)[] = [],
    ): number => {
      listed = true;
      return abandoned
        ? this.hazards(listing.files, sync, ignore).length
        : this.observed(listing, sync, ignore);
    };
    // `Promise.race` cannot cancel work. Without this flag the losing run kept going and applied a
    // snapshot AFTER we had already reported "unavailable" and dropped the overlay — the user
    // could be typing into data that was about to be replaced.
    let abandoned = false;
    /** Did this run ever get a listing? A failed READ is not an unreachable folder. */
    let listed = false;
    /** Did it ever ASK for one? An IndexedDB failure on the first line of the run is not the
     *  folder's fault, and reporting it as "couldn't reach the shared folder" sends the user to
     *  check their connection over a problem that has nothing to do with it. With nothing to say,
     *  we say nothing. */
    let looked = false;

    const run = async (): Promise<StartupCheck> => {
      const sync = await this.store.persistedSyncState();
      // A locked vault can still LIST — file metadata isn't encrypted — so we can tell the user
      // they're behind even though nothing can be decoded until they unlock.
      if (!this.codec || !this.engine) {
        looked = true;
        const metas = await this.provider!.list();
        return note(this.newListing(metas), sync) > 0 ? { kind: "locked-behind" } : { kind: "up-to-date" };
      }
      looked = true;
      const metas = await this.engine.list();
      if (note(this.newListing(metas), sync, [this.engine.getSessionFileId()]) === 0) {
        return { kind: "up-to-date" };
      }

      if (abandoned) return { kind: "review" }; // stop working; the caller has moved on
      let remote;
      try {
        // Guarded recorder: this download can outlive the deadline, and its listing must not be
        // republished over whatever the user has done since.
        remote = await this.checkRemote(note);
      } catch (e) {
        if (e instanceof SignInRequiredError) throw e; // genuinely transport → outer catch
        // The listing above succeeded, so the folder IS reachable: this is the snapshot's
        // problem, not the network's. Keep the real message (e.g. "another device is still
        // finishing the encryption upgrade") and send the user to review rather than claiming
        // we're offline.
        if (!abandoned) {
          // A dropped connection mid-download and an unreadable snapshot are different problems
          // and deserve different sentences; only the second is the snapshot's fault.
          const dropped = e instanceof TypeError;
          this.set({
            problem: {
              text: dropped
                ? "Couldn't finish downloading your other device's latest changes — check your connection and try again."
                : "Couldn't read the newest snapshot from your other device — it may still be uploading, or was written by a different version of the app.",
              detail: String(e),
            },
          });
        }
        return { kind: "review" };
      }
      if (!remote) return { kind: "up-to-date" };
      // Everything past here is a decision about OUR data, not transport — so a failure must fall
      // through to "a human should look at this", never to "the folder is unreachable".
      const pureAddition = remote.diff.summary.removed === 0 && remote.diff.summary.modified === 0;
      // A snapshot can carry collections this build has no store for (a peer on a newer build).
      // `importAll` SKIPS those, so applying it would drop their rows while recording the file as
      // incorporated, and our next push would publish without them. The merge path drops them too
      // — it is not a workaround — but it at least puts a human in front of the decision, and the
      // peer keeps its own copy either way. So: never automatically.
      const known = new Set(SCHEMA.collections.map((c) => c.name));
      const knownSchema =
        remote.doc.schemaVersion <= SCHEMA.version &&
        Object.keys(remote.doc.data).every((name) => known.has(name));
      if (!remote.hasLocalChanges && pureAddition && knownSchema && !abandoned) {
        try {
          await this.applyRemote(remote.doc, remote.fileId, remote.outstandingOthers, remote.base, {
            listing: remote.listing,
            // The write can still land after the race timed out (nothing can cancel it), so the
            // acknowledgement has to come from live status — the shell's one-shot result is
            // already "unavailable" by then and would say nothing at all.
            announce: true,
          });
          // No note here: applyRemote records the observation AFTER its write.
          return { kind: "applied" };
        } catch {
          // A refused write (a sibling tab got there first) is a reconciliation matter.
          return { kind: "review" };
        }
      }
      return { kind: "review" };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    try {
      const timeout = new Promise<StartupCheck>((resolve) => {
        timer = setTimeout(() => {
          if (settled) return; // a dead run must never speak again
          abandoned = true;
          // Only if we never saw the folder. A deadline reached while DOWNLOADING says nothing
          // about reachability — the listing already proved otherwise, and overwriting its count
          // with "unreachable" both states a falsehood and hides the "you're behind" warning this
          // whole check exists to give, right as the overlay drops and editing becomes possible.
          if (looked && !listed) this.observedUnreachable();
          resolve({ kind: "unavailable" });
        }, timeoutMs);
      });
      return await Promise.race([run(), timeout]);
    } catch (e) {
      // Transport only. Deliberately does NOT set `phase`: autosave is gated on phase === "ready",
      // so failing a read here used to stop this tab syncing for the whole session — with no
      // retry scheduled — before the user had done anything at all.
      const needsAuth = e instanceof SignInRequiredError;
      this.set({ needsAuth });
      // Same rule as the timeout: a token that expires mid-DOWNLOAD leaves the listing standing.
      // `needsAuth` still tells the user what to fix; the count tells them what is at stake.
      if (looked && !listed) this.observedUnreachable();
      return { kind: "unavailable" };
    } finally {
      // MUST be finally: on the reject path the old placement left the timer armed.
      settled = true;
      if (timer) clearTimeout(timer);
    }
  }

  /** Record what a listing showed. The ONLY writer of `lastCheck`.
   *
   *  Takes the listing itself — never a pre-computed number — so a count can never be published
   *  without the observation behind it, and never survive a write that invalidates it (the caller
   *  passes post-write `sync` state where that matters). `null` means we tried and couldn't see
   *  the folder. `at` exists so an observation made earlier (a merge preview) keeps its own
   *  timestamp instead of borrowing the moment it happens to be published. */
  private observed(
    listing: Listing,
    sync: SyncFacts,
    ignoreIds: readonly (string | null | undefined)[] = [],
  ): number {
    // Adopt or forget FIRST: publishing an observation is also the moment we learn which folder
    // our observations are about, so a switch noticed here can't be missed by a phase refresh that
    // never happened.
    this.forgetOtherFolder();
    // NEWEST FILES × NEWEST STATE. Neither half is optional, and the two arrive separately:
    //
    //  - A caller can hold a listing for as long as a dialog stays open, then hand it over after a
    //    write. Its FILE SET has never heard of anything published since, so recounting it alone
    //    reported 0 and retired a "2 to load" warning while the file was genuinely unread.
    //  - But that caller has just CHANGED the state the count depends on (a merge acknowledges a
    //    file; a replace resets the seen-log), so the standing count is stale too — keeping it
    //    nagged the user about the very file they had just merged.
    //
    // So: the newest FILE SET we have seen, recounted against the state we were just handed. One
    // rule, in the one writer. "Newest" is by sequence — see `Listing.seq`.
    const standing = this.lastListing;
    // `applyRemote({ listing })` is public and `Listing` is exported, so a sequence this controller
    // never minted can arrive. It is DEMOTED rather than refused — refusing only works when there
    // is something to compare against, and with nothing remembered yet the impostor would become
    // the baseline and out-rank every real look from then on. Permanently, where the timestamp
    // scheme this replaced at least healed as wall time caught up.
    const incoming: Listing = listing.seq <= this.listingSeq ? listing : { ...listing, seq: 0 };
    const newest = standing && standing.seq > incoming.seq ? standing : incoming;
    const behind = this.hazards(newest.files, sync, ignoreIds).length;
    this.lastListing = newest;
    // Returns the count so no caller recomputes it with a hand-copied ignore list — two lists that
    // must agree, written out twice, is how the published count and the returned one diverged in
    // the first place. The published stamp is display-only, and never claims the future: a clock
    // that ran fast is the user's problem to fix, not something to render as "synced at 3pm".
    const now = this.nowIso();
    this.set({ lastCheck: { at: newest.at > now ? now : newest.at, behind }, problem: undefined });
    return behind;
  }

  /** The most recent folder listing we have seen, kept OUT of `SyncStatus` because it is evidence,
   *  not something the UI renders. Cleared whenever it stops describing the folder we sync with. */
  private lastListing: Listing | null = null;

  /** The wall clock, as one seam — used for the DISPLAY stamp and nothing else. Kept as a seam so
   *  tests can prove that a wrong clock changes nothing that matters. */
  private nowIso(): string {
    return new Date().toISOString();
  }

  private listingSeq = 0;

  /** Every listing is created here, by this one controller — which is exactly what makes `seq` a
   *  total order over "which look happened first". Nothing else may mint one. */
  private newListing(files: readonly SnapshotMeta[]): Listing {
    return { files: [...files], seq: ++this.listingSeq, at: this.nowIso() };
  }

  /** Drop everything we know about the folder's contents. Every observation is a statement about
   *  ONE folder, so pointing this device at another makes them all false — and the pill would go
   *  on reporting a count, and a "checked at", for a folder we no longer sync with. */
  private forgetFolderObservations(): void {
    this.lastListing = null;
    this.set({ lastCheck: undefined, problem: undefined });
  }

  /** The folder our published observations describe, so a change of folder can be NOTICED rather
   *  than announced. Hanging this off `refreshPhase` covers every route — the folder picker, a
   *  sibling tab's pick arriving through the settings row, a re-pick after a disconnect — instead
   *  of the one method that happens to change it today. */
  private observedFolderId: string | undefined;

  private forgetOtherFolder(): void {
    // `engineFolderId`, not the settings row: settings change first and then await network work,
    // so during that window a listing still comes from the OLD folder.
    const folderId = this.engineFolderId ?? undefined;
    const previous = this.observedFolderId;
    this.observedFolderId = folderId;
    // First sight of a folder ADOPTS it: a fresh controller has published nothing to invalidate,
    // and a needless clear would still notify every subscriber (a render) to say nothing.
    if (previous === undefined || previous === folderId) return;
    this.forgetFolderObservations();
  }

  /** We tried to look and couldn't. Its own method because "we have no listing to count" is NOT
   *  the same fact as "the folder is unreachable" — conflating them let a successful pull whose
   *  bookkeeping listing failed announce that the folder was offline, and suppress the very
   *  "you're still behind" warning the gate exists to give. */
  private observedUnreachable(): void {
    this.set({ lastCheck: { at: this.nowIso(), unreachable: true } });
  }

  /** Files that may still hold records this device has never read.
   *
   *  The push guard, the pull-target choice, the pull's watermark decision and the startup check
   *  all ask this same question; `ignoreIds` is the only thing that differs (this session's own
   *  file, or the file being applied). Keeping the rule in one place is what stops four copies of
   *  the same four arguments from drifting apart. Takes the listing as an argument so no caller
   *  lists the folder twice. */
  private hazards(
    metas: readonly SnapshotMeta[],
    sync: SyncFacts,
    ignoreIds: readonly (string | null | undefined)[] = [],
  ): SnapshotMeta[] {
    const skip = new Set(ignoreIds.filter((id): id is string => !!id));
    return unincorporatedFiles(
      metas.filter((m) => !skip.has(m.id)),
      sync.lastSyncedVersion,
      new Set(sync.seenSnapshots),
      ownBound(sync),
    );
  }

  /** Download the latest snapshot and diff it against local — for the confirm UI.
   *
   *  `record` is how the listing gets published. It is a parameter because the startup check must
   *  be able to substitute a guarded recorder: this method publishes from INSIDE the download,
   *  which for an abandoned run lands after the caller has moved on — a dead run republishing its
   *  pre-download count over a live one. */
  async checkRemote(
    record: Recorder = (l, sync, ignore) => this.observed(l, sync, ignore),
  ): Promise<RemoteCheck | null> {
    if (!this.engine) throw new Error("sync not ready");
    let loaded;
    let outstandingOthers = 0;
    let listing: Listing | null = null;
    try {
      // Target the newest file that still needs reconciling, NOT unconditionally the folder's
      // max. Versions are monotonic per device, so a device can hold an unmerged file BELOW
      // the max; always loading the max made that file unreachable — merging the max changed
      // nothing, it stayed outstanding, and the guard refused forever. Falls back to the max
      // once nothing is outstanding (the plain catch-up / acknowledge case).
      const metas = await this.engine.list();
      // Created as the folder ANSWERS, not after the download that follows it. A download that
      // then fails consumes this sequence without recording it — gaps are fine, only the ORDER of
      // the listings that do get recorded matters.
      const seen = this.newListing(metas);
      const sync = await this.store.persistedSyncState(); // stored, not this tab's memory
      const unmerged = this.hazards(metas, sync, [this.engine?.getSessionFileId()]);
      const target = latestSnapshot(unmerged.length > 0 ? unmerged : metas);
      loaded = target ? await this.engine.loadFile(target) : null;
      // Everything that would remain unread after loading `target`, counting what the target
      // itself already holds (its provenance). Without that, loading a file that contains every
      // other device's data still reported all of them outstanding.
      outstandingOthers =
        target && loaded
          ? this.hazards(metas, afterReplace(sync, provenanceFor(loaded.doc, target, metas)), [this.engine?.getSessionFileId(), target.id]).length
          : 0;
      listing = seen;
      record(seen, sync, [this.engine?.getSessionFileId()]);
    } catch (e) {
      // If the latest is a legacy v1 file, another device hasn't finished the
      // encryption upgrade — our DEK-only codec can't decode it. Its edit isn't lost
      // (it lives in that device's local data and syncs when it reloads); surface a
      // clear, transient message instead of the raw "not a pfdb-v2 file".
      if (this.provider) {
        const latest = latestSnapshot(await this.provider.list().catch(() => []));
        if (latest && encryptedFormat(await this.provider.download(latest.id).catch(() => new Uint8Array())) === "pfdb-v1") {
          throw new Error(
            "Another device is still finishing the encryption upgrade — its change will sync once that device reloads. Try again shortly.",
          );
        }
      }
      throw e;
    }
    if (!loaded) return null;
    // Data AND fingerprint in one lock, so the diff the user approves and the check that gates
    // the write describe the same reality.
    const { doc: local, fingerprint } = await this.store.exportWithFingerprint();
    return {
      doc: loaded.doc,
      version: loaded.meta.version,
      diff: diffDatasets(local.data, loaded.doc.data),
      fileId: loaded.meta.id,
      outstandingOthers,
      base: fingerprint,
      hasLocalChanges: fingerprint.localVersion > fingerprint.lastSyncedVersion,
      // The listing this diff was chosen from. `applyRemote` recounts it against POST-write state
      // rather than trusting a number measured before the write reset the seen-log.
      listing,
    };
  }

  /**
   * PLAN a merge of the remote snapshot into local data — pure, nothing is written. The
   * caller shows `conflicts` (records both devices changed differently) for the user to
   * decide on, then passes this SAME preview to `commitMerge`. Splitting preview from
   * commit is what lets the UI ask about conflicts instead of resolving them silently.
   *
   * The preview also captures the version bookkeeping the commit needs:
   *  - `base`: local version/lastSynced when the plan was computed. `commitMerge`
   *    re-verifies these INSIDE its lock, because the plan is committed after an unbounded
   *    user-interaction window and the write is a full replace — anything written locally
   *    in between (a second tab, the hourly FX refresh triggering autopay reconcile) would
   *    otherwise be silently deleted rather than merged.
   *  - `seenRemoteVersion`: the remote version this merge reconciles, recorded so the push
   *    guard stops refusing. It is null when ANOTHER remote file shares the folder's max
   *    version: that sibling has NOT been merged, so claiming to have seen its version
   *    would silently supersede it — the guard must keep firing until it's merged too.
   */
  async previewMerge(doc: SnapshotDoc, docFileId?: string): Promise<MergePreview> {
    // Data AND its fingerprint together, in one lock. Captured separately, a write landing
    // between them would be both absent from the plan and invisible to the commit-time check,
    // so committing the plan would delete it silently.
    const { doc: local, fingerprint: base } = await this.store.exportWithFingerprint();
    const plan = planMerge(local.data, doc.data);
    const watermark = base.lastSyncedVersion;
    const seenKey = docFileId ? snapshotKey({ id: docFileId, version: doc.version }) : null;

    // Can this merge be PUBLISHED once committed? The push guard refuses while any file may
    // still hold records we've never read, so the honest condition is "nothing unincorporated
    // is left once this file is recorded".
    //
    // Recording the FILE (`seenKey`) rather than only a version is what makes this converge:
    //  - three devices, files A@4 and B@5, our mark at 3 — merging B@5 can't move a scalar
    //    watermark past A@4, so the old code left the merge unpublishable forever; now each
    //    merge records its own file and the second one clears the guard;
    //  - a version COLLISION can't be misread: `loadLatest` picks by version then savedAt and
    //    doesn't skip our own file, so a device is sometimes handed ITS OWN snapshot. Keying by
    //    file id means acknowledging that says nothing about a sibling's unmerged rows at the
    //    same version number.
    let seenRemoteVersion: number | null = null;
    let outstandingOthers = 0;
    let ackBlocked: MergePreview["ackBlocked"] = null;
    // What the merged snapshot already holds; widened with its author's own files once listed.
    let inherit = provenanceOf(doc);
    let listing: Listing | null = null;
    if (!this.engine) {
      // No folder configured/reachable at all: we cannot see what else exists, so we make no
      // claim. (An engine that lists an EMPTY folder is different — that IS evidence.)
      ackBlocked = "unavailable";
      return { doc, plan, base, seenRemoteVersion, seenKey, outstandingOthers, ackBlocked, listing, inherit };
    }
    try {
      const sessionFileId = this.engine.getSessionFileId();
      const files = await this.engine.list();
      listing = this.newListing(files);
      inherit = provenanceFor(doc, files.find((f) => f.id === docFileId), files);
      const others = files.filter((f) => f.id !== sessionFileId);
      // The acknowledgement log from STORAGE too: `base` is persisted, but a sibling tab's merge
      // records a key that this tab's memory would not have.
      const sync = await this.store.persistedSyncState();
      // The preview's own watermark, plus everything the merged snapshot had already incorporated
      // (the union now holds that too).
      const after = withProvenance({ ...sync, lastSyncedVersion: watermark }, inherit);
      const seen = new Set(after.seenSnapshots);
      if (seenKey) seen.add(seenKey); // what this merge is about to incorporate
      // Deliberately NOT `hazards()`: this is the HYPOTHETICAL count after the merge — the
      // preview's own watermark, `seenKey` already added, and this document's version folded into
      // the bound. Same own-device rule though, so it asks `ownBound` for the shape rather than
      // writing a third copy of it.
      const outstanding = unincorporatedFiles(
        others,
        after.lastSyncedVersion,
        seen,
        ownBound({ ...sync, localVersion: Math.max(local.version, sync.localVersion) }),
      );
      outstandingOthers = outstanding.length;
      if (outstanding.length > 0) {
        ackBlocked = "outstanding";
      } else {
        // Nothing can hold unseen data any more, so the watermark may move up to the folder's
        // max — but only to a version the folder ACTUALLY contains. Advancing it to the merged
        // doc's own number (a backup file's, say) would claim to have superseded remote
        // versions that were never there, and a later push at a lower number would then slip
        // past the guard. Purely an optimisation: it prunes the seen-log, and publishability
        // rests on `outstanding` either way.
        const folderMax = files.reduce((m, f) => Math.max(m, f.version), 0);
        seenRemoteVersion = folderMax > watermark ? folderMax : null;
      }
    } catch {
      // Listing failed: we can't tell what else is out there. The merge is still saved
      // locally, and the push guard re-checks the folder when it next succeeds — so this is
      // "unknown", not "refused", and must not be reported as another device's doing.
      seenRemoteVersion = null;
      ackBlocked = "unavailable";
      listing = null;
    }
    return {
      inherit,
      listing,
      doc,
      plan,
      base,
      seenRemoteVersion,
      seenKey,
      outstandingOthers,
      ackBlocked,
    };
  }

  /**
   * Commit a previewed merge with the user's per-conflict choices. Everything that didn't
   * clash is already unioned in the plan; `choices` only redirects the conflicts.
   *
   * The result is DIRTY (nobody has this combination yet) AND marked as having seen the
   * remote it reconciled — both halves are required, or the push guard refuses forever and
   * the merged data can never leave this device.
   */
  async commitMerge(
    preview: MergePreview,
    choices: Record<string, ConflictChoice> = {},
  ): Promise<{ publishable: boolean }> {
    return this.serialize(async () => {
      const data = applyChoices(preview.plan, choices);
      const local = await this.store.exportDocument();
      await this.store.applyDocument(
        {
          // Our OWN schema version: `data` is a mix of local and remote records written by
          // this build, so labelling it with the remote's would be a lie.
          schemaVersion: local.schemaVersion,
          version: Math.max(preview.doc.version, local.version),
          data,
        },
        {
          dirty: true,
          seenRemoteVersion: preview.seenRemoteVersion ?? undefined,
          seenSnapshotKey: preview.seenKey ?? undefined,
          inherit: preview.inherit,
          // Compare-and-apply against PERSISTED state, inside the same lock as the write.
          // Checking here rather than out in this method is what makes it airtight: the write
          // is a full replace, and a check performed before `exportDocument` can't see a write
          // that lands during it, nor anything a SECOND TAB wrote (shared DB, separate state).
          expect: preview.base,
        },
      );
      this.refreshPhase(); // clear the conflict phase so autosave resumes
      // The merge just incorporated one file; what's left is what the preview counted.
      this.set({
        message: "merged",
      });
      // The preview's listing, recounted against POST-merge state and stamped with the moment it
      // was actually taken. Publishing `preview.outstandingOthers` under `new Date()` claimed a
      // freshness no check had — the modal window between them is unbounded.
      if (preview.listing) {
        this.observed(preview.listing, await this.store.persistedSyncState(), [
          this.engine?.getSessionFileId(),
        ]);
      }
      // Honest about what happens next: with another unincorporated file still out there the
      // push guard WILL refuse, so the UI must not promise "tap Sync now". A failed listing is
      // reported separately — the merge is saved and the guard re-checks on the next attempt.
      return { publishable: preview.ackBlocked === null };
    });
  }

  async applyRemote(
    doc: SnapshotDoc,
    docFileId?: string,
    outstandingOthers = 0,
    expect?: VersionFingerprint,
    opts: { announce?: boolean; listing?: Listing | null } = {},
  ): Promise<void> {
    // Serialized against syncNow so a push can't be mid-flight when we replace
    // local data (which would otherwise interleave the controller's push
    // bookkeeping with applyDocument).
    await this.serialize(async () => {
      // Record WHICH file this was, not just its version: a pull sets the watermark to
      // `doc.version`, and another device's concurrent push can sit at exactly that number.
      // Without the key, that sibling would look already-incorporated and we'd publish over it.
      // L1: re-derive the outstanding count INSIDE the operation rather than trusting the one
      // computed before the dialog opened. A peer file landing during the confirm window at a
      // version between our watermark and this doc's would otherwise be subsumed with no merge
      // ever offered. A failed listing keeps the conservative answer (hold the watermark).
      let holdWatermark = outstandingOthers > 0;
      let inherit = provenanceOf(doc); // widened below once the listing is in hand
      let listed: Listing | null = null; // our own listing, kept for the post-write recount
      if (this.engine) {
        try {
          const sync = await this.store.persistedSyncState();
          const metas = await this.engine.list();
          listed = this.newListing(metas);
          inherit = provenanceFor(doc, metas.find((m) => m.id === docFileId), metas);
          // Same basis as the dialog's count (checkRemote), so the two cannot disagree.
          holdWatermark =
            this.hazards(metas, afterReplace(sync, inherit), [this.engine.getSessionFileId(), docFileId]).length > 0;
        } catch {
          holdWatermark = true;
        }
      }
      await this.store.applyDocument(doc, {
        seenSnapshotKey: docFileId ? snapshotKey({ id: docFileId, version: doc.version }) : undefined,
        // With other files still unread, the watermark must stay put — the seen-key clears the one
        // file we actually loaded, and nothing else.
        holdWatermark,
        inherit,
        // Compare-and-apply: this is a full replace and the review window is unbounded.
        expect,
      }); // also records the synced version
      // Re-derive the phase: a prior conflict / data-loss-guard / vault-mismatch
      // left phase="error", which gates out scheduleAutosave — so without this a
      // Pull that RESOLVES the conflict would leave autosave wedged forever and
      // subsequent edits would never reach Drive. refreshPhase restores "ready"
      // (engine+codec present) and reschedules autosave for any pending edits.
      this.refreshPhase();
      this.set({
        message: `loaded v${doc.version}`,
        ...(opts.announce ? { appliedVersion: doc.version } : {}),
      });
      // AFTER the write, recounted against POST-write state. A replace resets the seen-log, which
      // resurrects previously acknowledged files — so any number measured before the write is
      // wrong, including the caller's. What the caller's listing gives us is the FILES; the count
      // is derived here, from them, afterwards. Falling back to its pre-write figure (as this did)
      // could report 0 while a resurrected file sat unread.
      // With no listing at all (engine torn down mid-flow) we simply say nothing: the previous
      // observation may be stale, but an overstated count nags, whereas claiming the folder is
      // unreachable is a falsehood that also HIDES the outstanding-file warning.
      //
      // The caller's listing keeps the caller's TIMESTAMP. Its window is unbounded — a diff can
      // sit open on screen for half an hour — so publishing it under `new Date()` claimed a
      // freshness nothing had: a green "Synced · 14:30" over a 14:05 listing, while a file
      // published at 14:20 sat unread and unmentioned.
      const seen = listed ?? opts.listing;
      if (seen) {
        this.observed(seen, await this.store.persistedSyncState(), [
          this.engine?.getSessionFileId(),
          docFileId,
        ]);
      }
    });
  }

  /** Read the KDF salt from the latest LEGACY (pfdb-v1) snapshot header without a
   *  key — for detecting/migrating a pre-envelope folder. Ignores v2 snapshots
   *  (they carry no per-file KDF). */
  async remoteKdfV1(): Promise<KdfParams | null> {
    if (!this.provider) return null;
    const latest = latestSnapshot(await this.provider.list());
    if (!latest) return null;
    const bytes = await this.provider.download(latest.id);
    if (encryptedFormat(bytes) !== "pfdb-v1") return null;
    const header = JSON.parse(bytesToUtf8(bytes)) as { kdf?: KdfParams };
    return header.kdf ?? null;
  }

  // -- local backup file ---------------------------------------------------
  hasVault(): boolean {
    return this.codec !== null;
  }

  /** Serialise the whole document to a downloadable file. Encrypted backups are
   *  SELF-CONTAINED: the body is DEK-sealed and the current keyring (wrapped DEK +
   *  its KDF) is embedded, so a fresh device can restore with just the passphrase.
   *  No vault → portable plaintext. */
  async exportBackup(): Promise<Uint8Array> {
    const doc = await this.store.exportDocument();
    const { vaultKeyring, vaultKdf } = this.store.getState().settings;
    // A vault is configured (envelope keyring OR a legacy v1 salt) — never silently
    // emit PLAINTEXT for it. If it's locked on this device (no DEK / not yet
    // migrated), require unlock rather than exporting the data in the clear.
    if (vaultKeyring || vaultKdf) {
      if (!this.dek || !vaultKeyring) {
        throw new Error("Unlock with your password first to export an encrypted backup.");
      }
      return encodeBackup(this.dek, doc, {
        dekId: vaultKeyring.dekId,
        kdf: vaultKeyring.kdf,
        wrappedDEK: vaultKeyring.wrappedDEK,
      });
    }
    return createPlainCodec<SnapshotDoc>().encode(doc); // no vault configured → portable plaintext
  }

  /** Adopt a vault after a CONFIRMED backup restore: prefer the connected folder's
   *  existing keyring (so the restored data republishes under the folder's own DEK
   *  and we never rotate/hijack it or lock its devices out); fall back to the
   *  backup's own DEK / a freshly minted one only when there's no folder keyring or
   *  the restore passphrase can't unwrap it. */
  private async adoptForRestore(passphrase: string, fallback: () => Promise<void>): Promise<void> {
    this.rebuildProvider();
    if (this.provider) {
      const remote = await this.remoteKeyring().catch(() => null);
      if (remote) {
        const dek = await this.unwrapOrThrow(passphrase, remote).catch(() => null);
        if (dek) {
          await this.adoptKeyring(remote, dek);
          this.refreshPhase();
          return;
        }
      }
    }
    await fallback();
    this.refreshPhase();
  }

  /** DECODE-ONLY preview of a picked backup file (no side effects). Returns the
   *  document plus, for an encrypted file opened with a fresh passphrase, an
   *  `adopt` callback that switches this device to the file's vault. Adoption is
   *  deferred to the caller so it only happens AFTER the restore is confirmed —
   *  previewing then cancelling must NOT change the active vault.
   *  - Plain files: decode directly.
   *  - Encrypted + our DEK already loaded: decode with it (no adoption needed).
   *  - Encrypted + passphrase: pfdb-v2 → unwrap the DEK from the file's EMBEDDED
   *    keyring; legacy pfdb-v1 → derive the direct key from the file's KDF, then
   *    adopt migrates this device onto a fresh v2 keyring. Adoption is returned,
   *    not applied. */
  async previewBackup(
    bytes: Uint8Array,
    passphrase?: string,
  ): Promise<{ doc: SnapshotDoc; adopt?: () => Promise<void> }> {
    if (!isEncryptedFile(bytes)) {
      return { doc: await createPlainCodec<SnapshotDoc>().decode(bytes) };
    }
    if (this.codec) {
      try {
        return { doc: await this.codec.decode(bytes) }; // current DEK already opens it
      } catch (e) {
        if (!passphrase) throw e; // wrong vault open and no passphrase to retry
      }
    }
    if (!passphrase) {
      throw new Error("This backup is encrypted — enter its passphrase to restore.");
    }
    const fmt = encryptedFormat(bytes);
    if (fmt === "pfdb-v2") {
      const embedded = readEmbeddedKeyring(bytes);
      if (!embedded) {
        throw new Error("This backup can't be opened on a new device — it's missing its keyring.");
      }
      const kek = await deriveKey(passphrase, embedded.kdf);
      let dek: CryptoKey;
      try {
        dek = await unwrapDek(kek, embedded.wrappedDEK);
      } catch {
        throw new Error("Incorrect passphrase for this backup.");
      }
      const codec = createDekCodec<SnapshotDoc>(dek);
      const doc = await codec.decode(bytes);
      // Fallback keyring (used only when NOT restoring into a folder that already
      // has one): wrap this backup's DEK, PRESERVING its dekId if the backup carries
      // one — so restoring onto the folder it came from keeps the folder's data
      // identity instead of looking like a DEK rotation.
      const keyring: Keyring = {
        format: KEYRING_FORMAT,
        version: 1,
        dekId: embedded.dekId ?? newId(),
        kdf: embedded.kdf,
        wrappedDEK: embedded.wrappedDEK,
      };
      const adopt = (): Promise<void> =>
        this.adoptForRestore(passphrase, () => this.adoptKeyring(keyring, dek));
      return { doc, adopt };
    }
    // Legacy pfdb-v1 backup: derive the direct key from the file's own KDF.
    const header = JSON.parse(bytesToUtf8(bytes)) as { kdf?: KdfParams };
    if (!header.kdf) throw new Error("backup is missing its key parameters");
    const kdf = header.kdf;
    const key = await deriveKey(passphrase, kdf);
    const doc = await createEncryptedCodec<SnapshotDoc>(key, kdf).decode(bytes); // throws if wrong
    // Adopt the folder's keyring if present; else mint a fresh v2 keyring from this
    // passphrase + the file's salt.
    const adopt = (): Promise<void> =>
      this.adoptForRestore(passphrase, async () => {
        await this.mintKeyring(passphrase, kdf, 1);
      });
    return { doc, adopt };
  }

  // -- autosave ------------------------------------------------------------
  /** Debounce-push when ready and dirty. Called both on every store change AND
   *  when the phase becomes ready — so a store that's ALREADY dirty when sync
   *  turns on (e.g. unsynced edits rehydrated after a reload) still autosaves
   *  without waiting for the next edit. */
  private scheduleAutosave(): void {
    // Only when idle-ready — never mid-sync (emits during a push must not queue
    // a redundant follow-up; syncNow re-checks for mid-sync edits itself).
    if (this.status.phase !== "ready") return;
    if (!this.store.getState().dirty) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      void this.syncNow().catch(() => {
        /* surfaced via status */
      });
    }, this.autosaveDebounceMs);
  }

  /** One snapshot per session: debounce-push whenever the store goes dirty. */
  startAutosave(debounceMs = 4000): () => void {
    this.autosaveDebounceMs = debounceMs;
    return this.store.subscribe(() => this.scheduleAutosave());
  }
}
