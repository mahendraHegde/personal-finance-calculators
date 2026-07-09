// Browser-only orchestration of vault unlock + Google Drive sync on top of the
// (framework-agnostic) store. Kept separate from the store so the store stays
// testable and the Google/crypto code is isolated.
//
// Flow: setup/unlock vault → configure Drive (client id + api key) → pick the
// shared folder → push session snapshots (autosave) / pull-and-diff on demand.

import { latestSnapshot, type Codec } from "../../../lib/sync/types";
import { SyncEngine } from "../../../lib/sync/engine";
import { diffDatasets, type DatasetDiff } from "../../../lib/sync/diff";
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
import type { SnapshotDoc } from "../model/types";
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

export interface SyncStatus {
  phase: SyncPhase;
  message?: string;
  remoteVersion?: number;
  /** True only when the error is specifically a sign-in/token failure — the UI
   *  shows "Reconnect Google" for this, NOT for a conflict / data-loss / vault
   *  error (those need "Pull latest", and Reconnect can't resolve them). */
  needsAuth?: boolean;
}

export interface RemoteCheck {
  doc: SnapshotDoc;
  version: number;
  diff: DatasetDiff;
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
    if (folderDoc && guardMax > this.store.getState().settings.lastSyncedVersion) {
      if (this.store.getState().dirty) {
        throw new Error(
          "This device has unsynced changes and the shared folder has newer data — sync on an up-to-date device first, then unlock here.",
        );
      }
      await this.store.applyDocument(folderDoc); // adopt the folder's latest v1 data → now current
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
    await this.publishBaseline(guardMax);
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
  private async publishBaseline(floor?: number): Promise<void> {
    this.refreshPhase(); // engine now seals with the (new) DEK; new dekId → fresh session file
    if (!this.engine || !this.provider) return; // no folder → local IS the source of truth
    this.sessionVerified = true; // our DEK is authoritative for this new baseline
    const max = floor ?? (await this.engine.list()).reduce((m, x) => Math.max(m, x.version), 0);
    await this.store.bumpVersionAbove(max);
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
      if (folderMax > this.store.getState().settings.lastSyncedVersion) {
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
      // Everything EXCEPT this session's own file. A file written by any other
      // session — another device, OR another TAB on this same browser profile
      // (which shares this device's id via persisted settings but is a genuinely
      // independent writer) — is a potential concurrent edit. We deliberately do
      // NOT narrow this to other-device files: doing so let two tabs on one profile
      // overwrite each other silently (each invisible to the other's guard). In
      // normal operation our own prior-session files sit at version <= lastSynced
      // (we wrote them), so they don't trip the guard below. The one exception — a
      // crash BETWEEN a successful push and markSynced can leave an own file ABOVE
      // lastSynced — trips a benign, REVIEWED "Pull latest" that loads our own data
      // and converges. The guard never silently overwrites, so that is safe.
      const others = metas.filter((m) => m.id !== sessionFileId);

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
      const lastSynced = this.store.getState().settings.lastSyncedVersion;
      if (remoteMax > lastSynced) {
        this.set({
          phase: "error",
          message: "Remote has newer changes — Pull latest and review before syncing.",
        });
        return;
      }

      // Lift our version above everything already in the folder so we don't mint
      // a colliding version number (ours included, to stay unambiguous).
      await this.store.reconcileVersion(remoteMax);

      const doc = await this.store.exportDocument();
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
        this.set({
          phase: "error",
          message: "Sync conflict — another device synced at the same time. Pull latest to reconcile.",
        });
        return;
      }

      await this.store.markSynced(meta.version);
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
        message: authNeeded ? "Google sign-in needed — click Reconnect to resume sync." : String(e),
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

  /** Download the latest snapshot and diff it against local — for the confirm UI. */
  async checkRemote(): Promise<RemoteCheck | null> {
    if (!this.engine) throw new Error("sync not ready");
    let loaded;
    try {
      loaded = await this.engine.loadLatest();
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
    const local = await this.store.exportDocument();
    return {
      doc: loaded.doc,
      version: loaded.meta.version,
      diff: diffDatasets(local.data, loaded.doc.data),
    };
  }

  async applyRemote(doc: SnapshotDoc): Promise<void> {
    // Serialized against syncNow so a push can't be mid-flight when we replace
    // local data (which would otherwise interleave the controller's push
    // bookkeeping with applyDocument).
    await this.serialize(async () => {
      await this.store.applyDocument(doc); // also records the synced version
      // Re-derive the phase: a prior conflict / data-loss-guard / vault-mismatch
      // left phase="error", which gates out scheduleAutosave — so without this a
      // Pull that RESOLVES the conflict would leave autosave wedged forever and
      // subsequent edits would never reach Drive. refreshPhase restores "ready"
      // (engine+codec present) and reschedules autosave for any pending edits.
      this.refreshPhase();
      this.set({ message: `loaded v${doc.version}` });
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
