// Settings: display currency, FX refresh + overrides, vault passphrase, local
// encrypted backup/restore, and Google Drive shared-folder sync.

import { useState } from "react";
import { fetchUsdRates } from "../../../lib/fx/fx-service";
import { diffDatasets, type DatasetDiff } from "../../../lib/sync/diff";
import { isEncryptedFile } from "../../../lib/crypto/codec";
import { formatDate, todayIso } from "../../../lib/util/format";
import { usePortfolio, useSyncStatus } from "../state/context";
import type { SyncPhase } from "../state/sync-controller";
import type { SnapshotDoc } from "../model/types";
import { Badge, Button, Card, Field, Modal, NumberInput, Select, SectionTitle, TextInput } from "./components";
import { CURRENCY_CHOICES } from "./helpers";
import { DiffModal } from "./DiffModal";

// Plain-language labels for the internal sync phases (the user shouldn't see
// raw ids like "no-vault" / "no-folder").
const PHASE_LABEL: Record<SyncPhase, string> = {
  "no-vault": "No password",
  locked: "Locked",
  "no-folder": "No folder picked",
  ready: "Connected",
  syncing: "Syncing…",
  error: "Sync error",
};

interface PendingLoad {
  doc: SnapshotDoc;
  version: number;
  diff: DatasetDiff;
  apply: () => Promise<void>;
}

export function Settings() {
  const { state, store, sync } = usePortfolio();
  const status = useSyncStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLoad | null>(null);
  const [restoreBytes, setRestoreBytes] = useState<Uint8Array | null>(null);

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(String(e));
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
      {msg && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{msg}</div>}

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
          {sync.hasVault()
            ? "Backups are encrypted with your password."
            : "Set a password above to encrypt backups (otherwise they're saved unprotected)."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
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

      <Card>
        <SectionTitle>Google Drive sync</SectionTitle>
        <p className="mb-3 text-sm text-slate-500">
          Optional. The app works fully offline with no account — connect Drive only if you want a
          shared, multi-device copy.
        </p>
        <div className="mb-2">
          <Badge tone={status.phase === "ready" ? "green" : status.phase === "error" ? "red" : "slate"}>
            {PHASE_LABEL[status.phase]}
          </Badge>
          {status.message && <span className="ml-2 text-xs text-slate-500">{status.message}</span>}
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
                if (folder) setMsg(`Connected folder: ${folder.name}`);
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
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                run("pull", async () => {
                  // Baseline = local state the diff was computed against. If local
                  // changes while the preview modal is open — an edit (bumps
                  // version) or an autosave push (bumps lastSyncedVersion) — the
                  // diff is stale; abort the apply rather than overwriting newer
                  // data with the previewed snapshot. (Stops a lost-update.)
                  const b = store.getState();
                  const baseV = b.version;
                  const baseSynced = b.settings.lastSyncedVersion;
                  const remote = await sync.checkRemote();
                  if (!remote) {
                    setMsg("No snapshot in the folder yet.");
                    return;
                  }
                  setPending({
                    doc: remote.doc,
                    version: remote.version,
                    diff: remote.diff,
                    apply: async () => {
                      const now = store.getState();
                      if (now.version !== baseV || now.settings.lastSyncedVersion !== baseSynced) {
                        throw new Error(
                          "Your data changed since this preview — tap Pull latest again to review the current diff.",
                        );
                      }
                      await sync.applyRemote(remote.doc);
                    },
                  });
                })
              }
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
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            void run("apply", () => p.apply());
          }}
        />
      )}

      {restoreBytes && (
        <RestorePassphraseModal
          onClose={() => setRestoreBytes(null)}
          onSubmit={(p) => void doRestore(restoreBytes, p)}
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
  onSubmit: (passphrase: string) => void;
}) {
  const [pass, setPass] = useState("");
  return (
    <Modal title="Restore encrypted backup" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">
          This file is encrypted. Enter the passphrase it was saved with to decrypt and restore it.
        </p>
        <TextInput value={pass} onChange={setPass} type="password" placeholder="Backup passphrase" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!pass} onClick={() => onSubmit(pass)}>
            Decrypt &amp; restore
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
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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
        ⚠️ There's no “forgot password”. If you lose it, those encrypted backups can't be opened, so
        keep it somewhere safe. (Your normal data inside this app isn't affected.)
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
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-green-700">
          Protected — your backups and Google Drive sync are encrypted.
        </span>
        <Button variant="ghost" onClick={() => void sync.lock()}>
          Require password again
        </Button>
      </div>
      <p className="text-xs text-slate-400">
        Removes the password from this device until you type it again here. Nothing is deleted.
      </p>
      {lifecycle}
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
