// Settings: display currency, FX refresh + overrides, vault passphrase, local
// encrypted backup/restore, and Google Drive shared-folder sync.

import { useCallback, useEffect, useMemo, useState } from "react";
import { humanError, syncSituation, SYNC_TONE_COLOR } from "./sync-readings";
import { fetchUsdRates } from "../../../lib/fx/fx-service";
import { diffDatasets, type DatasetDiff } from "../../../lib/sync/diff";
import { conflictKey } from "../../../lib/sync/merge";
import type { Keyed } from "../../../lib/sync/diff";
import { makeNameResolver, type DisplayContext, type RecordResolver } from "./merge-labels";
import { isEncryptedFile } from "../../../lib/crypto/codec";
import { formatDate, todayIso } from "../../../lib/util/format";
import { usePortfolio, useSyncStatus } from "../state/context";
import type { PortfolioState } from "../state/store";
import type { MergePreview } from "../state/sync-controller";
import type { ImportBatch, SnapshotDoc } from "../model/types";
import { Badge, Button, Card, Field, Modal, NumberInput, Select, SectionTitle, TextInput } from "./components";
import { CURRENCY_CHOICES } from "./helpers";
import { DiffModal } from "./DiffModal";
import { MergeModal } from "./MergeModal";

// Plain-language labels for the internal sync phases (the user shouldn't see
// raw ids like "no-vault" / "no-folder").

interface PendingLoad {
  doc: SnapshotDoc;
  version: number;
  diff: DatasetDiff;
  apply: () => Promise<void>;
  /** Keep BOTH sides instead of replacing local. Absent for a backup restore (there the
   *  user is deliberately rolling back to a file, not reconciling two live devices). */
  merge?: () => Promise<void>;
  /** From the backup-restore flow — changes the wording (a roll-back, not a catch-up). */
  isRestore?: boolean;
  /** Snapshots that will STILL be unreconciled after loading this one. The dialog must not call
   *  that "bringing this device up to date". */
  outstandingOthers?: number;
  /** From the PERSISTED row, so a sibling tab's unsynced work is visible here too. */
  hasLocalChanges?: boolean;
}

/** Name/value formatter for the diff dialog: looks records up in LOCAL state first, then in
 *  the incoming snapshot, so ids from either side resolve to something readable. */
function makeDisplay(state: PortfolioState, doc: SnapshotDoc): DisplayContext {
  // Indexed, like MergeModal's resolver: a diff of a few thousand rows asks for many ids, and a
  // pair of linear scans per lookup (local, then the snapshot) is quadratic in the diff size.
  const index = new Map<string, Map<string, Keyed>>();
  const add = (collection: string, records: readonly Keyed[]): void => {
    let byId = index.get(collection);
    if (!byId) {
      byId = new Map();
      index.set(collection, byId);
    }
    for (const r of records) if (!byId.has(r.id)) byId.set(r.id, r); // local wins over the snapshot
  };
  add("accounts", state.accounts);
  add("categories", state.categories);
  add("people", state.people);
  add("holdings", state.holdings);
  // `?? []` because the old resolver coerced a null/absent collection to an empty list, and
  // `diffDatasets` tolerates one — so a snapshot with `{accounts: null}` would stage a diff and
  // then throw at render time.
  for (const [collection, records] of Object.entries(doc.data)) add(collection, (records ?? []) as Keyed[]);
  const record: RecordResolver = (collection, id) => index.get(collection)?.get(id);
  return { record, name: makeNameResolver(record) };
}

export function Settings({
  reviewRequest = 0,
  onReviewHandled,
}: { reviewRequest?: number; onReviewHandled?: () => void } = {}) {
  const { state, store, sync } = usePortfolio();
  const status = useSyncStatus();
  const { pill } = syncSituation(status);
  const [busy, setBusy] = useState<string | null>(null);
  // Messages carry a tone: a merge SUCCESS must not appear in the same amber banner used
  // for thrown errors (it read as a warning).
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [pending, setPending] = useState<PendingLoad | null>(null);
  const [restoreBytes, setRestoreBytes] = useState<Uint8Array | null>(null);
  /** A previewed merge awaiting the user's conflict choices. Carries the version
   *  bookkeeping commitMerge revalidates, so a stale plan can never be written. */
  const [mergePlan, setMergePlan] = useState<MergePreview | null>(null);
  // The startup gate (or the "Review now" notice) asks for the review by bumping a counter the
  // SHELL owns. Consuming it there — not in a ref here — is what stops the dialog re-opening
  // every time this tab is revisited, since this component unmounts on tab change.
  useEffect(() => {
    if (reviewRequest > 0) {
      openPullReview();
      onReviewHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires per request, by design
  }, [reviewRequest]);

  /** Stage the folder's newest unreconciled snapshot for review. Shared by the "Pull latest"
   *  button and the startup gate, so both go through the same staleness guard. */
  const openPullReview = useCallback(
    () =>
      run("pull", async () => {
        // Baseline = local state the diff was computed against. If local
        // changes while the preview modal is open — an edit (bumps
        // version) or an autosave push (bumps lastSyncedVersion) — the
        // diff is stale; abort the apply rather than overwriting newer
        // data with the previewed snapshot. (Stops a lost-update.)
        const b = store.getState();
        const baseV = b.version;
        const baseSynced = b.settings.lastSyncedVersion;
        // Both actions below are computed from data as it was WHEN THE DIFF WAS TAKEN,
        // and the modal can sit open indefinitely. One guard, so the two paths cannot
        // come to disagree about what "stale" means.
        const assertFresh = (): void => {
          const now = store.getState();
          if (now.version !== baseV || now.settings.lastSyncedVersion !== baseSynced) {
            throw new Error(
              "Your data changed since this preview — tap Pull latest again to review the current diff.",
            );
          }
        };
        const remote = await sync.checkRemote();
        if (!remote) {
          setMsg({ text: "No snapshot in the folder yet.", tone: "info" });
          return;
        }
        setPending({
          doc: remote.doc,
          version: remote.version,
          diff: remote.diff,
          outstandingOthers: remote.outstandingOthers,
          hasLocalChanges: remote.hasLocalChanges,
          apply: async () => {
            assertFresh();
            // `remote.base` is the real guard (persisted, revalidated in the write
            // lock); the in-memory check above is just a fast early exit.
            // Hand over the listing this diff was chosen from, so the post-write recount
            // has something to count even if its own re-listing fails.
            await sync.applyRemote(remote.doc, remote.fileId, remote.outstandingOthers, remote.base, {
              listing: remote.listing,
            });
          },
          // The merge is computed from live local data too, so the same guard applies.
          merge: async () => {
            assertFresh();
            setMergePlan(await sync.previewMerge(remote.doc, remote.fileId));
          },
        });
      }),
    [store, sync],
  );

  // Built once per staged snapshot, not on every render (it indexes every account/category/
  // person/holding on both sides).
  const display = useMemo(
    () => (pending ? makeDisplay(state, pending.doc) : undefined),
    [pending, state],
  );

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: humanError(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  // Decode a picked backup → stage a diff to confirm. `passphrase` is supplied
  // for an encrypted file restored on a fresh browser (no open vault).
  const doRestore = (bytes: Uint8Array, passphrase?: string): Promise<void> =>
    run("restore", async () => {
      // Preview only — no vault change until the user confirms.
      let preview;
      try {
        preview = await sync.previewBackup(bytes, passphrase);
      } catch (e) {
        // An encrypted backup we couldn't open with the CURRENT vault — e.g. it
        // was encrypted under a different salt (an older backup from before a
        // vault change, or a different family folder). Rather than dead-ending,
        // offer to enter the FILE's own passphrase (previewBackup then derives the
        // key from the file's header KDF). Only fall back if we haven't already
        // tried a passphrase — otherwise it's a genuine wrong-passphrase/corrupt
        // failure that should surface.
        if (isEncryptedFile(bytes) && !passphrase) {
          setRestoreBytes(bytes);
          return;
        }
        throw e;
      }
      const { doc, adopt } = preview;
      const local = await store.exportDocument();
      setPending({
        doc,
        version: doc.version,
        diff: diffDatasets(local.data, doc.data),
        isRestore: true,
        apply: async () => {
          // Restored state should be publishable, so keep it dirty.
          await store.applyDocument(doc, { dirty: true });
          if (adopt) await adopt(); // adopt the file's vault only now
        },
      });
      setRestoreBytes(null);
    });

  const onPickedBackup = (bytes: Uint8Array): void => {
    // Encrypted file but no vault open → ask for the file's passphrase first.
    if (isEncryptedFile(bytes) && !sync.hasVault()) {
      setRestoreBytes(bytes);
      return;
    }
    void doRestore(bytes);
  };

  const drive = state.settings.drive ?? {};

  return (
    <div className="space-y-6">
      {msg && (
        <div
          className={`rounded-lg p-3 text-sm ${
            msg.tone === "error" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-slate-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      <Card>
        <SectionTitle>Display currency</SectionTitle>
        <div className="max-w-xs">
          <Select
            value={state.settings.displayCurrency}
            onChange={(v) => void store.saveSettings({ displayCurrency: v })}
            options={CURRENCY_CHOICES.map((c) => ({ value: c, label: c }))}
          />
        </div>
      </Card>

      <FxSection
        onRefresh={() =>
          run("fx", async () => {
            const table = await fetchUsdRates();
            await store.cacheFxRates(table);
          })
        }
        busy={busy === "fx"}
      />

      <Card>
        <SectionTitle>Backup password</SectionTitle>
        <VaultSection />
      </Card>

      <Card>
        <SectionTitle>Backup &amp; restore</SectionTitle>
        <p className="mb-3 text-sm text-slate-500">
          {status.phase === "locked"
            ? "Locked — unlock above to download an encrypted backup."
            : sync.hasVault()
              ? "Backups are encrypted with your password."
              : "Set a password above to encrypt backups (otherwise they're saved unprotected)."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            // Disabled while locked: a configured vault must be unlocked to encrypt
            // the backup — we never emit it as plaintext (exportBackup also refuses).
            disabled={status.phase === "locked"}
            onClick={() =>
              run("backup", async () => {
                const bytes = await sync.exportBackup();
                downloadBytes(bytes, `portfolio-${todayIso()}.pfdb`);
              })
            }
          >
            Download backup
          </Button>
          <RestoreButton onPicked={onPickedBackup} />
        </div>
      </Card>

      <ImportHistoryCard />

      <Card>
        <SectionTitle>Google Drive sync</SectionTitle>
        <p className="mb-3 text-sm text-slate-500">
          Optional. The app works fully offline with no account — connect Drive only if you want a
          shared, multi-device copy.
        </p>
        <div className="mb-2">
          {/* The header pill, verbatim — one reading, not a second one alongside it. This row
              used to pair a PHASE badge with raw `status.message` ("synced v4", "merged"), which
              could read green "Connected" beside an amber "Behind — 2 to load" in the header. */}
          <Badge tone={SYNC_TONE_COLOR[pill.tone]} title={pill.title}>
            {pill.label}
          </Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="OAuth client ID">
            {/* Single-field patches — saveSettings deep-merges `drive`, so
                pasting client id then api key won't clobber each other. */}
            <TextInput
              value={drive.clientId ?? ""}
              onChange={(v) => void store.saveSettings({ drive: { clientId: v } })}
              placeholder="xxx.apps.googleusercontent.com"
            />
          </Field>
          <Field label="API key (for Picker)">
            <TextInput
              value={drive.apiKey ?? ""}
              onChange={(v) => void store.saveSettings({ drive: { apiKey: v } })}
              placeholder="AIza…"
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              run("connect", async () => {
                if (!drive.clientId) throw new Error("enter the OAuth client ID first");
                if (!drive.apiKey) throw new Error("enter the API key first");
                sync.configureDrive(drive.clientId);
                const folder = await sync.connectFolder(drive.apiKey);
                if (folder) setMsg({ text: `Connected folder: ${folder.name}`, tone: "info" });
              })
            }
          >
            {drive.folderId ? "Re-pick folder" : "Connect & pick folder"}
          </Button>
          {drive.folderName && <span className="text-xs text-slate-500">Folder: {drive.folderName}</span>}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Connecting Drive also enables the <b>Google Finance</b> live-price source for stocks, ETFs
          and funds (it uses your own Sheet). For that, enable the <b>Google Sheets API</b> in the
          same Google Cloud project as the client ID above.
        </p>
        {drive.folderId &&
          status.phase !== "ready" &&
          status.phase !== "syncing" &&
          status.phase !== "error" && (
            <p className="mt-3 text-xs text-amber-700">
              Folder connected.{" "}
              {status.phase === "locked"
                ? "Unlock your vault above to enable sync."
                : "Set a passphrase above to enable encrypted sync."}
            </p>
          )}
        {/* Keep Sync/Pull available on "error" too, so a transient Drive failure
            leaves a retry path instead of bricking sync. */}
        {drive.folderId &&
          (status.phase === "ready" || status.phase === "syncing" || status.phase === "error") && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy !== null} onClick={() => run("sync", () => sync.syncNow())}>
              Sync now
            </Button>
            {/* Only for a sign-in/token failure — NOT a conflict/data-loss error
                (which needs Pull latest, and Reconnect can't resolve). */}
            {status.needsAuth && (
              <Button disabled={busy !== null} onClick={() => run("reconnect", () => sync.reconnect())}>
                Reconnect Google
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={openPullReview}
            >
              Pull latest
            </Button>
          </div>
        )}
      </Card>

      {pending && (
        <DiffModal
          diff={pending.diff}
          remoteVersion={pending.version}
          // Whether THIS device has edits it hasn't pushed. Decides whether replacing is a
          // safe fast-forward or would discard local work.
          hasLocalChanges={pending.hasLocalChanges ?? state.dirty}
          isRestore={pending.isRestore}
          // Resolve ids from BOTH sides: a category that exists only in the incoming snapshot
          // must still render as a name, not a UUID.
          display={display}
          outstandingOthers={pending.outstandingOthers ?? 0}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            void run("apply", () => p.apply());
          }}
          onMerge={
            pending.merge
              ? () => {
                  const p = pending;
                  setPending(null);
                  void run("merge-preview", () => p.merge!());
                }
              : undefined
          }
        />
      )}

      {mergePlan && (
        <MergeModal
          plan={mergePlan.plan}
          outstandingOthers={mergePlan.outstandingOthers}
          ackUnavailable={mergePlan.ackBlocked === "unavailable"}
          busy={busy === "merge"}
          onCancel={() => setMergePlan(null)}
          onConfirm={(choices) => {
            const m = mergePlan;
            void run("merge", async () => {
              const { publishable } = await sync.commitMerge(m, choices);
              setMergePlan(null);
              const s = m.plan.summary;
              const theirsChosen = m.plan.conflicts.filter(
                (c) => (choices[conflictKey(c)] ?? c.suggestion) === "theirs",
              ).length;
              // State the OUTCOME in totals the user can verify against the app, and be
              // explicit about how each conflict went — a merge must never be a black box.
              setMsg({
                tone: "info",
                text:
                  `Merged: ${s.totalAfter} items now, including ${s.onlyOther} added from the other device.` +
                  (s.conflicts > 0
                    ? ` ${s.conflicts} differed between the devices — you kept ${s.conflicts - theirsChosen} from this one and ${theirsChosen} from the other.`
                    : "") +
                  " Nothing was deleted (anything you'd deleted here but still on the other device has come back)." +
                  (publishable
                    ? " Tap Sync now to send the combined data to your other devices."
                    : m.ackBlocked === "outstanding"
                      ? ` It's saved on this device, but ${m.outstandingOthers} other snapshot${m.outstandingOthers === 1 ? "" : "s"} also ${m.outstandingOthers === 1 ? "holds" : "hold"} changes this merge didn't include, so it can't be published yet. Tap Pull latest and merge again to bring ${m.outstandingOthers === 1 ? "that one" : "those"} in too.`
                      : " It's saved on this device. We couldn't check the shared folder just now, so Sync now will publish it as soon as the folder is reachable."),
              });
            });
          }}
        />
      )}

      {restoreBytes && (
        <RestorePassphraseModal
          onClose={() => setRestoreBytes(null)}
          onSubmit={async (p) => {
            // Throws on a wrong passphrase → shown INSIDE the modal (not the page
            // banner behind it). On success, stage the diff and unmount the modal.
            const { doc, adopt } = await sync.previewBackup(restoreBytes, p);
            const local = await store.exportDocument();
            setPending({
              doc,
              version: doc.version,
              diff: diffDatasets(local.data, doc.data),
              isRestore: true, // same roll-back as doRestore — the wording must match
              apply: async () => {
                await store.applyDocument(doc, { dirty: true });
                if (adopt) await adopt();
              },
            });
            setRestoreBytes(null);
          }}
        />
      )}
    </div>
  );
}

function RestorePassphraseModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (passphrase: string) => Promise<void>;
}) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (!pass || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pass); // on success the caller unmounts this modal (no need to reset busy)
    } catch (e) {
      setErr(humanError(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Restore encrypted backup" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">
          This file is encrypted. Enter the passphrase it was saved with to decrypt and restore it.
        </p>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <TextInput value={pass} onChange={setPass} type="password" placeholder="Backup passphrase" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!pass || busy} onClick={() => void submit()}>
            {busy ? "Decrypting…" : "Decrypt & restore"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Set a new password. Two modes:
 *  - "change" (unlocked): re-wraps the SAME data key, so every existing backup and
 *    synced snapshot stays readable — nothing is re-encrypted or orphaned.
 *  - "reset" (locked / forgotten): if this device still holds the key it's the same
 *    non-destructive re-wrap; if not, the vault is re-created from this device's
 *    local data and OLD-password Drive/backup files can no longer be opened. */
function PasswordChangeModal({
  mode,
  onClose,
  onSubmit,
}: {
  mode: "change" | "reset";
  onClose: () => void;
  onSubmit: (newPassphrase: string) => Promise<void>;
}) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = pass.length > 0 && pass === confirm;
  const submit = async (): Promise<void> => {
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pass);
      onClose();
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={mode === "change" ? "Change password" : "Reset password"} onClose={onClose}>
      <div className="space-y-3">
        {mode === "change" ? (
          <>
            <p className="text-sm text-slate-600">
              Choose a new password for your encrypted backups &amp; Google Drive sync. All your
              existing backups and synced data stay readable — only the password that unlocks them
              changes.
            </p>
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Your other devices will need this new password the next time they unlock.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              Set a new password without the old one. If this device still holds the key, everything
              stays readable. If not, the vault is re-created from this device's local data.
            </p>
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ⚠️ If any other device still has this open, use <b>Change password</b> there instead —
              it keeps <b>everything</b> readable. Reset only if no device has it: backups and Drive
              snapshots made with the OLD password can then no longer be opened (your data inside this
              app is not lost).
            </p>
          </>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Field label="New password">
          <TextInput value={pass} onChange={setPass} type="password" placeholder="New password" />
        </Field>
        <Field label="Confirm new password">
          <TextInput value={confirm} onChange={setConfirm} type="password" placeholder="Re-enter it" />
        </Field>
        {confirm.length > 0 && pass !== confirm && (
          <p className="text-xs text-red-600">Passwords don't match.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? "Setting…" : mode === "change" ? "Change password" : "Reset password"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FxSection({ onRefresh, busy }: { onRefresh: () => void; busy: boolean }) {
  const { state, store } = usePortfolio();
  const overrides = state.settings.fxOverrides;
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>Exchange rates</SectionTitle>
        <Button variant="ghost" onClick={onRefresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh rates"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-slate-400">
        Anchored to USD. Last updated:{" "}
        {state.settings.fxUpdatedAt ? formatDate(state.settings.fxUpdatedAt) : "never"}.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {CURRENCY_CHOICES.filter((c) => c !== "USD").map((c) => (
          <Field key={c} label={`${c} per USD`}>
            <NumberInput
              value={String(overrides[c] ?? state.fx.rates[c] ?? "")}
              onChange={(v) =>
                // Race-proof per-key update (reads latest overrides in the store,
                // not a stale closure); empty/non-positive clears back to "auto".
                void store.setFxOverride(c, v.trim() === "" ? null : Number(v))
              }
              placeholder="auto"
            />
          </Field>
        ))}
      </div>
    </Card>
  );
}

function VaultSection() {
  const { state, sync } = usePortfolio();
  const status = useSyncStatus();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "change" = re-key while unlocked (keeps everything); "reset" = forgotten-password
  // path from the locked screen.
  const [pwModal, setPwModal] = useState<"change" | "reset" | null>(null);
  // "Join existing" only makes sense when a shared Drive folder is connected —
  // that's the only place an already-created password could exist to unlock.
  const hasFolder = Boolean(state.settings.drive?.folderId);

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setPass("");
    } catch (e) {
      // Show just the message (no techy "Error:" prefix) for end users.
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  // "change" re-wraps the same data key (nothing orphaned); "reset" is the
  // forgotten-password path (non-destructive if the key is still held, else fresh).
  const pwModalEl = pwModal ? (
    <PasswordChangeModal
      mode={pwModal}
      onClose={() => setPwModal(null)}
      onSubmit={(p) => (pwModal === "change" ? sync.changePassword(p) : sync.resetPassword(p))}
    />
  ) : null;

  // Shared, plain-language explanation of what the password does.
  const lifecycle = (
    <div className="space-y-1 text-xs text-slate-500">
      <p>
        Add a password so your backups and the copy synced to Google Drive are encrypted — only
        someone with this password can open them. We never store it or send it anywhere.
      </p>
      <p>
        You set it <b>once</b>. It then stays open on this device, even after you refresh or reopen
        the tab. You can <b>require the password again</b> here at any time (e.g. on a shared
        computer) — your data stays safe, and you reopen it by typing the same password.
      </p>
      <p className="text-amber-700">
        ⚠️ Forgot it? While it's open on this device you can change it here without the old one, and
        everything stays readable. If it's locked on every device and no one remembers it, only the
        encrypted Drive/backup copies can't be opened — your data inside this app stays.
      </p>
    </div>
  );

  // LOCKED: a password is already set, but it's closed on this device. The only
  // action that makes sense is to re-type the SAME password — not make a new one.
  if (status.phase === "locked") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          🔒 Locked on this device. Type your password to open your encrypted backups & sync.
        </p>
        {lifecycle}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex gap-2">
          <div className="flex-1">
            <TextInput value={pass} onChange={setPass} type="password" placeholder="Your password" />
          </div>
          <Button disabled={!pass || busy} onClick={() => void act(() => sync.unlock(pass))}>
            Unlock
          </Button>
        </div>
        <p className="text-xs text-slate-400">
          “Incorrect password” just means it doesn't match the one you set — there's no other way to
          check it, since the password is never stored.
        </p>
        <button
          onClick={() => setPwModal("reset")}
          className="text-left text-xs text-slate-500 underline hover:text-slate-700"
        >
          Forgot your password? Reset it.
        </button>
        {pwModalEl}
      </div>
    );
  }

  // NO PASSWORD YET: turn it on. Only offer "I already have one" when a shared
  // folder is connected (otherwise there's nothing to unlock and it just errors).
  if (status.phase === "no-vault") {
    return (
      <div className="space-y-3">
        {lifecycle}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex gap-2">
          <div className="flex-1">
            <TextInput value={pass} onChange={setPass} type="password" placeholder="Choose a password" />
          </div>
          <Button disabled={!pass || busy} onClick={() => void act(() => sync.setupVault(pass))}>
            Turn on protection
          </Button>
          {hasFolder && (
            <Button
              variant="ghost"
              disabled={!pass || busy}
              onClick={() => void act(() => sync.unlock(pass))}
            >
              I already have one
            </Button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          {hasFolder
            ? "First time? Choose a password to turn on protection. Already set one on this shared Google Drive folder (e.g. on another device)? Type it and choose “I already have one.”"
            : "First time? Choose a password to turn on protection for your backups."}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-green-700">
          Protected — your backups and Google Drive sync are encrypted.
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setPwModal("change")}>
            Change password
          </Button>
          <Button variant="ghost" onClick={() => void sync.lock()}>
            Require password again
          </Button>
        </div>
      </div>
      <p className="text-xs text-slate-400">
        “Require password again” removes the password from this device until you type it again here
        (nothing is deleted). “Change password” sets a new one — all your existing backups and synced
        data stay readable.
      </p>
      {lifecycle}
      {pwModalEl}
    </div>
  );
}

function RestoreButton({ onPicked }: { onPicked: (bytes: Uint8Array) => void }) {
  return (
    <label className="cursor-pointer rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200">
      Restore from file
      <input
        type="file"
        accept=".pfdb,application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const buf = await file.arrayBuffer();
          onPicked(new Uint8Array(buf));
          e.target.value = "";
        }}
      />
    </label>
  );
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Recent CSV imports, each undoable. The list is device-local (never synced/backed up)
 *  and read on demand — it isn't part of the reactive portfolio state. */
function ImportHistoryCard() {
  const { store } = usePortfolio();
  const [batches, setBatches] = useState<ImportBatch[] | null>(null); // null = loading
  const [busy, setBusy] = useState<string | null>(null); // id being undone
  const [err, setErr] = useState<string | null>(null);

  const reload = (): void => {
    void store.listImportBatches().then(setBatches);
  };
  useEffect(() => {
    void store.listImportBatches().then(setBatches);
  }, [store]);

  // One history list covers both importers, so describe each batch by its own kind.
  const summarise = (b: ImportBatch): string =>
    b.kind === "transactions"
      ? [
          `${b.counts.transactions ?? 0} transaction${(b.counts.transactions ?? 0) === 1 ? "" : "s"}`,
          (b.counts.accounts ?? 0) > 0 ? `${b.counts.accounts} new account${b.counts.accounts === 1 ? "" : "s"}` : "",
          (b.counts.categories ?? 0) > 0 ? `${b.counts.categories} new categor${b.counts.categories === 1 ? "y" : "ies"}` : "",
          (b.counts.people ?? 0) > 0 ? `${b.counts.people} new person/people` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : [
          `${b.counts.events} investment transaction${b.counts.events === 1 ? "" : "s"}`,
          b.counts.holdings > 0 ? `${b.counts.holdings} new holding${b.counts.holdings === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(" · ");

  const undo = (b: ImportBatch): void => {
    // Be exact: undo removes every row the import added — INCLUDING ones you have since
    // edited or re-categorised (they're still that import's rows). Only records the import
    // never created, and accounts/categories something else still uses, are kept.
    if (
      !window.confirm(
        `Undo this import? It removes everything it added (${summarise(b)}), including rows you've edited since. Records you created yourself are untouched.`,
      )
    )
      return;
    setBusy(b.id);
    setErr(null);
    void store
      .undoImportBatch(b.id)
      .then(reload)
      .catch(() => setErr("Couldn't undo that import — please try again."))
      .finally(() => setBusy(null));
  };

  if (batches !== null && batches.length === 0) return null; // nothing imported yet → hide the section

  // The undo log stamps a full ISO timestamp; show the LOCAL calendar day (not UTC).
  const localDay = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  return (
    <Card>
      <SectionTitle>Import history</SectionTitle>
      <p className="mb-3 text-sm text-slate-500">
        Recent CSV imports (this device only). Undo removes exactly what an import added and restores anything it replaced —
        your other holdings and manually-added transactions are left alone.
      </p>
      {err && <p className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      {batches === null ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {batches.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-700" title={b.label}>
                  {b.label}
                </div>
                <div className="text-xs text-slate-400">
                  {formatDate(localDay(b.createdAt))} · {summarise(b)}
                </div>
              </div>
              <Button variant="ghost" disabled={busy !== null} onClick={() => undo(b)}>
                {busy === b.id ? "Undoing…" : "Undo"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
