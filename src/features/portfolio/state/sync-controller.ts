// Browser-only orchestration of vault unlock + Google Drive sync on top of the
// (framework-agnostic) store. Kept separate from the store so the store stays
// testable and the Google/crypto code is isolated.
//
// Flow: setup/unlock vault → configure Drive (client id + api key) → pick the
// shared folder → push session snapshots (autosave) / pull-and-diff on demand.

import { latestSnapshot, type Codec } from "../../../lib/sync/types";
import { SyncEngine } from "../../../lib/sync/engine";
import { diffDatasets, type DatasetDiff } from "../../../lib/sync/diff";
import { createEncryptedCodec, createPlainCodec, isEncryptedFile } from "../../../lib/crypto/codec";
import { bytesToUtf8 } from "../../../lib/crypto/base64";
import type { EncryptedBlob, KdfParams } from "../../../lib/crypto/vault";
import { decryptJson, deriveKey, encryptJson, newSalt } from "../../../lib/crypto/vault";
import { clearVaultKey, loadVaultKey, saveVaultKey } from "../../../lib/crypto/keystore";
import { GoogleAuth, pickFolder, SignInRequiredError } from "../../../lib/google/drive-auth";
import { DriveSyncProvider } from "../../../lib/google/drive-provider";
import { SheetsOracle } from "../../../lib/google/sheets-oracle";
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
const SESSION_RESUME_KEY = "pf-sync-session";
interface SessionResume {
  startIso: string;
  folderId: string | null;
  salt: string | null;
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
  // Identify the engine's vault by its KDF salt (not the codec object), so a
  // lock→unlock that re-creates the codec with the SAME password is recognised
  // as the same vault and keeps the same session file.
  private engineVaultSalt: string | null = null;
  // Holds the live session file id across a temporary teardown (lock → codec null
  // → engine null), so unlock resumes that file instead of minting a duplicate.
  private stashedSessionFileId: string | null = null;
  private codec: Codec<SnapshotDoc> | null = null;
  private readonly sessionStartIso: string;
  private status: SyncStatus = { phase: "no-vault" };
  private listeners = new Set<() => void>();
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveDebounceMs: number = SYNC.AUTOSAVE_DEBOUNCE_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether this session's key has been proven to decrypt the folder's data. */
  private sessionVerified = false;

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
      this.engineVaultSalt = resumed.salt;
      this.stashedSessionFileId = resumed.fileId;
    }
    this.persistSession(); // pin the startIso for this tab session immediately
  }

  /** Persist this tab session's (startIso, folder, vault, file id) so a refresh
   *  resumes the same Drive file. Scoped by folder + salt so it never resumes a
   *  file under a different vault/folder. sessionStorage failures are ignored. */
  private persistSession(): void {
    try {
      const settings = this.store.getState().settings;
      writeSessionResume({
        startIso: this.sessionStartIso,
        folderId: settings.drive?.folderId ?? null,
        salt: settings.vaultKdf?.salt ?? null,
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

  // -- vault ---------------------------------------------------------------
  /** Set the passphrase. Reuses an existing salt (persisted locally, or read
   *  from a connected folder's snapshots) so this never FORKS an existing vault
   *  with a fresh salt that other devices would then reject. */
  async setupVault(passphrase: string): Promise<void> {
    this.rebuildProvider();
    let kdf = this.store.getState().settings.vaultKdf;
    // If a folder is connected, let a network error PROPAGATE rather than
    // silently minting a fresh salt — remoteKdf() returns null only when the
    // folder genuinely has no snapshots (a true first device). Forking the
    // vault on a transient failure would lock other devices out.
    if (!kdf && this.provider) kdf = (await this.remoteKdf()) ?? undefined;
    if (!kdf) kdf = newSalt();
    await this.store.saveSettings({ vaultKdf: kdf });
    await this.activateKey(passphrase, kdf);
  }

  /** Unlock using the persisted salt, or — on a fresh device that has a folder
   *  connected — the salt read from the latest snapshot's header. */
  async unlock(passphrase: string, kdf?: KdfParams): Promise<void> {
    this.rebuildProvider();
    let params = kdf ?? this.store.getState().settings.vaultKdf;
    if (!params && this.provider) params = (await this.remoteKdf()) ?? undefined;
    if (!params) throw new Error("No password set yet — turn on protection first.");
    if (!this.store.getState().settings.vaultKdf) await this.store.saveSettings({ vaultKdf: params });
    await this.activateKey(passphrase, params);
  }

  private async activateKey(passphrase: string, kdf: KdfParams): Promise<void> {
    const key = await deriveKey(passphrase, kdf);
    // Prove the passphrase is correct BEFORE committing the key — a wrong one
    // must never become "ready" and then write snapshots under the wrong key.
    if (!(await this.verifyPassphrase(key, kdf))) {
      throw new Error("Incorrect password — this isn't the password your data was protected with.");
    }
    await saveVaultKey(key, kdf);
    this.codec = createEncryptedCodec<SnapshotDoc>(key, kdf);
    await this.ensureVaultCheck(key);
    this.refreshPhase();
  }

  /** Verify a derived key by decrypting existing ciphertext: the latest folder
   *  snapshot if a folder is connected, else a local verification token. Returns
   *  true when there's genuinely nothing to verify against (a brand-new vault). */
  private async verifyPassphrase(key: CryptoKey, kdf: KdfParams): Promise<boolean> {
    if (this.provider) {
      const metas = await this.provider.list(); // network errors propagate
      const latest = latestSnapshot(metas); // deterministic (version, savedAt, id)
      if (latest) {
        const bytes = await this.provider.download(latest.id);
        if (isEncryptedFile(bytes)) {
          try {
            await createEncryptedCodec<SnapshotDoc>(key, kdf).decode(bytes);
            return true;
          } catch {
            return false; // wrong key/salt for the folder's snapshots
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
    return true; // brand-new vault — nothing to verify against
  }

  /** Stash a known sentinel encrypted with the key, enabling offline passphrase
   *  verification on this device later. */
  private async ensureVaultCheck(key: CryptoKey): Promise<void> {
    if (this.store.getState().settings.vaultCheck) return;
    const blob: EncryptedBlob = await encryptJson(key, VAULT_SENTINEL);
    await this.store.saveSettings({ vaultCheck: blob });
  }

  async lock(): Promise<void> {
    await clearVaultKey();
    this.codec = null;
    this.refreshPhase(); // also tears down the engine (no codec → no engine)
  }

  async restoreFromKeystore(): Promise<boolean> {
    const stored = await loadVaultKey();
    if (!stored) return false;
    this.codec = createEncryptedCodec<SnapshotDoc>(stored.key, stored.kdf);
    this.refreshPhase();
    return true;
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

  /** If the connected folder's snapshots use a different salt than our local
   *  vault, our key can't decrypt them — drop the local vault so the user
   *  unlocks for THIS folder, rather than silently writing forked snapshots
   *  under the wrong key. Safe to call on startup and after a folder change. */
  async reconcileVaultWithFolder(): Promise<void> {
    this.rebuildProvider();
    if (!this.provider) return;
    let remote: KdfParams | null = null;
    try {
      remote = await this.remoteKdf();
    } catch {
      return; // transient — the pre-push backstop still prevents poisoning
    }
    const localKdf = this.store.getState().settings.vaultKdf;
    if (remote && localKdf && remote.salt !== localKdf.salt) {
      await this.store.saveSettings({ vaultKdf: undefined, vaultCheck: undefined });
      await clearVaultKey();
      this.codec = null;
      this.refreshPhase(); // tear down the engine; user must unlock for this folder
    }
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
    // Identify the vault by its KDF salt, NOT the codec object. A successful
    // unlock only sets the codec AFTER verifying the passphrase, so an unchanged
    // salt guarantees the SAME key — meaning a lock→unlock (or any codec
    // re-creation with the same password) can safely keep patching the SAME
    // session file. Only a genuinely different vault (new salt: different folder,
    // restored backup, changed passphrase) must start a fresh file, since the old
    // file's bytes were written under a different key.
    const salt = this.codec ? (settings.vaultKdf?.salt ?? null) : null;
    // When locked (codec null → salt null) we compare against the LAST ACTIVE
    // salt, so a later unlock with the same salt still matches and resumes.
    const sameTarget =
      this.codec !== null && folderId === this.engineFolderId && salt === this.engineVaultSalt;
    // Stash the live session id whenever an engine exists, so it survives the
    // codec-null gap during a lock.
    if (this.engine) this.stashedSessionFileId = this.engine.getSessionFileId();
    const prevSession = sameTarget ? this.stashedSessionFileId : null;
    this.engineFolderId = folderId;
    if (salt !== null) this.engineVaultSalt = salt; // keep prior salt while locked
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
      // Distinguish a configured-but-LOCKED vault (key dropped from this browser,
      // but the salt/verification token remain) from a device that has NEVER set
      // a passphrase — so the UI can say "unlock" instead of the misleading "set
      // a passphrase". Without this, locking looked identical to no-vault.
      const configured = this.store.getState().settings.vaultKdf !== undefined;
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

      // Nothing local to contribute AND the folder already has data → no-op.
      // (This stops a fresh device from publishing its empty/old state over
      // populated shared data. But we DO seed a brand-new EMPTY folder even from
      // a clean local doc — e.g. right after restoring a backup.)
      if (!this.store.getState().dirty && others.length > 0) {
        this.set({ phase: "ready", message: "nothing to sync" });
        return;
      }

      // Backstop: never push under a key that can't decrypt the folder's
      // existing data (guards against any stale/mismatched codec slipping
      // through). Verify once per session against the latest other snapshot.
      if (!this.sessionVerified && this.provider && this.codec && others.length > 0) {
        const latest = latestSnapshot(others)!; // others.length > 0 guaranteed above
        const bytes = await this.provider.download(latest.id);
        if (isEncryptedFile(bytes)) {
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
    const loaded = await this.engine.loadLatest();
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

  /** Read the salt from the latest snapshot header without a key (for a fresh
   *  device that needs the shared salt to unlock). */
  async remoteKdf(): Promise<KdfParams | null> {
    if (!this.provider) return null;
    const metas = await this.provider.list();
    const latest = latestSnapshot(metas); // deterministic (version, savedAt, id)
    if (!latest) return null;
    const bytes = await this.provider.download(latest.id);
    if (!isEncryptedFile(bytes)) return null;
    const header = JSON.parse(bytesToUtf8(bytes)) as { kdf?: KdfParams };
    return header.kdf ?? null;
  }

  // -- local backup file ---------------------------------------------------
  hasVault(): boolean {
    return this.codec !== null;
  }

  /** Serialise the whole document to a downloadable file (encrypted if a vault
   *  is set, else portable plaintext). */
  async exportBackup(): Promise<Uint8Array> {
    const doc = await this.store.exportDocument();
    const codec = this.codec ?? createPlainCodec<SnapshotDoc>();
    return codec.encode(doc);
  }

  /** DECODE-ONLY preview of a picked backup file (no side effects). Returns the
   *  document plus, for an encrypted file opened with a fresh passphrase, an
   *  `adopt` callback that switches this device to the file's vault. Adoption is
   *  deferred to the caller so it only happens AFTER the restore is confirmed —
   *  previewing then cancelling must NOT change the active vault.
   *  - Plain files: decode directly.
   *  - Encrypted + open vault: decode with it (no adoption needed).
   *  - Encrypted + passphrase: derive the key from the file's OWN header KDF
   *    (disaster recovery on a fresh browser); adoption is returned, not applied. */
  async previewBackup(
    bytes: Uint8Array,
    passphrase?: string,
  ): Promise<{ doc: SnapshotDoc; adopt?: () => Promise<void> }> {
    if (!isEncryptedFile(bytes)) {
      return { doc: await createPlainCodec<SnapshotDoc>().decode(bytes) };
    }
    if (this.codec) {
      try {
        return { doc: await this.codec.decode(bytes) }; // current vault already matches
      } catch (e) {
        if (!passphrase) throw e; // wrong vault open and no passphrase to retry
      }
    }
    if (!passphrase) {
      throw new Error("This backup is encrypted — enter its passphrase to restore.");
    }
    const header = JSON.parse(bytesToUtf8(bytes)) as { kdf?: KdfParams };
    if (!header.kdf) throw new Error("backup is missing its key parameters");
    const kdf = header.kdf;
    const key = await deriveKey(passphrase, kdf);
    const codec = createEncryptedCodec<SnapshotDoc>(key, kdf);
    const doc = await codec.decode(bytes); // throws if the passphrase is wrong
    const adopt = async (): Promise<void> => {
      await this.store.saveSettings({ vaultKdf: kdf, vaultCheck: undefined });
      await saveVaultKey(key, kdf);
      this.codec = codec;
      await this.ensureVaultCheck(key);
      this.refreshPhase();
    };
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
