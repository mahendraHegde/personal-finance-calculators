// Shows what an incoming snapshot will change BEFORE it replaces local data.
//
// Performance on large diffs (years of transactions): collections are collapsed
// by default, so the initial render is just a handful of summary rows regardless
// of diff size. Expanding a collection renders at most ROW_CAP rows inside a
// bounded, scrollable box (with a "+N more" note), so the DOM stays small and
// scrolling stays smooth even for thousands of changes.

import { useState } from "react";
import type { CollectionDiff, DatasetDiff, Keyed } from "../../../lib/sync/diff";
import { UI } from "../../../config";
import { Badge, Button, Modal } from "./components";
import { collectionLabel, humanField, money_, showValue, type DisplayContext } from "./merge-labels";

const ROW_CAP = UI.DIFF_ROW_CAP; // max records rendered per section — keeps the DOM bounded

/** Compact display of any field value (objects truncated). */
function val(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  }
  return String(v);
}

/** Best-effort one-line label for a record, across any collection.
 *
 *  `display` supplies the currency for a record that doesn't carry one (a holding event's money
 *  is in its parent holding's currency); without it the amount is shown as a plain number,
 *  which is the only honest option — never a guessed symbol. */
function summarize(rec: Keyed, display?: DisplayContext): string {
  const r = rec as unknown as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.date === "string") parts.push(r.date);
  if (typeof r.name === "string" && r.name) parts.push(r.name);
  if (typeof r.type === "string") parts.push(r.type);
  if (typeof r.amount === "number") {
    parts.push(display ? money_(r.amount, rec, display) : String(r.amount));
  }
  if (r.units !== undefined && r.price !== undefined) parts.push(`${val(r.units)}×${val(r.price)}`);
  if (typeof r.note === "string" && r.note) parts.push(`"${r.note}"`);
  return parts.length ? parts.join(" · ") : rec.id;
}

function MoreNote({ count }: { count: number }) {
  if (count <= ROW_CAP) return null;
  return <li className="py-1 italic text-slate-400">+{count - ROW_CAP} more not shown</li>;
}

function CollectionSection({
  name,
  d,
  display,
}: {
  name: string;
  d: CollectionDiff<Keyed>;
  display?: DisplayContext;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-slate-700">
          <span className="mr-1 inline-block w-3 text-slate-400">{open ? "▾" : "▸"}</span>
          {collectionLabel(name)}
        </span>
        <span className="text-xs text-slate-500">
          +{d.added.length} / ~{d.modified.length} / −{d.removed.length}
        </span>
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-slate-50 p-2 text-xs">
          <ul className="space-y-0.5">
            {d.added.slice(0, ROW_CAP).map((r) => (
              <li key={`a-${r.id}`} className="text-green-700">
                + {summarize(r, display)}
              </li>
            ))}
            <MoreNote count={d.added.length} />
            {d.modified.slice(0, ROW_CAP).map((m) => (
              <li key={`m-${m.id}`} className="text-amber-700">
                ~ {summarize(m.after, display)}
                <ul className="ml-4 text-slate-500">
                  {m.changes.map((f) => {
                    const before = (m.before as unknown as Record<string, unknown>)[f];
                    const after = (m.after as unknown as Record<string, unknown>)[f];
                    return (
                      <li key={f}>
                        {display ? humanField(f) : f}:{" "}
                        {display ? showValue(f, before, m.before, display, after) : val(before)} →{" "}
                        {display ? showValue(f, after, m.after, display, before) : val(after)}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            <MoreNote count={d.modified.length} />
            {d.removed.slice(0, ROW_CAP).map((r) => (
              <li key={`r-${r.id}`} className="text-red-700">
                − {summarize(r, display)}
              </li>
            ))}
            <MoreNote count={d.removed.length} />
          </ul>
        </div>
      )}
    </li>
  );
}

export function DiffModal({
  diff,
  remoteVersion,
  onConfirm,
  onMerge,
  onCancel,
  hasLocalChanges,
  display,
  isRestore,
  outstandingOthers,
}: {
  diff: DatasetDiff;
  remoteVersion: number;
  onConfirm: () => void;
  /** Keep BOTH sides instead of replacing local (see planMerge). Offered when this device
   *  has unsynced work the incoming snapshot would overwrite or drop. */
  onMerge?: () => void;
  onCancel: () => void;
  /** True when this device has edits it hasn't synced yet. WITHOUT this, a "modified" record
   *  is indistinguishable from a purely one-sided remote edit, and the dialog wrongly accused
   *  a clean device of having competing changes while styling the correct action as
   *  destructive. Clean device ⇒ this is a fast-forward: replacing is right and safe. */
  hasLocalChanges?: boolean;
  /** Name/value formatter, so the detail rows read as names and sentences rather than UUIDs
   *  and JSON. Optional: without it the rows fall back to the raw compact rendering. */
  display?: DisplayContext;
  /** A backup RESTORE is a deliberate roll-back, not a catch-up — the wording must not tell
   *  the user they're being "brought up to date". */
  isRestore?: boolean;
  /** Snapshots that will still be unreconciled AFTER this load. Loading one file out of several
   *  is not "up to date", and the button used to say it was — while offering no Merge, because
   *  the loss check only ever looked at OUR rows. */
  outstandingOthers?: number;
}) {
  const rows = Object.entries(diff.collections).filter(
    ([, d]) => d.added.length || d.removed.length || d.modified.length,
  );
  // Two distinct dangers, and conflating them cost real data:
  //
  //  - `removed > 0` means the snapshot LACKS records this device has. That destroys data
  //    whether or not we have unsynced edits — e.g. the other device restored an old backup
  //    and published it. The older snapshot still holding those rows is unreachable through
  //    the UI (only the highest version is ever loaded), so replacing here is unrecoverable.
  //  - `modified > 0` only endangers us when we have UNSYNCED edits of our own; with a clean
  //    device it just means the other side edited a record, and adopting it is correct.
  // One name for the destructive action, so the warning and the button can't drift apart —
  // the body called the file "this backup" while the button said "Replace with snapshot".
  const replaceLabel = isRestore ? "Replace with this backup" : "Replace with snapshot";
  // ONE noun for the file throughout. "Snapshot" is this app's word for a Drive sync file, so
  // using it in a restore's title and warning headline — beside a body that says "this backup" —
  // let the most consequential warning read as being about something else entirely.
  const fileNoun = isRestore ? "backup" : "snapshot";
  const moreToReconcile = (outstandingOthers ?? 0) > 0;
  const snapshotMissesRecords = diff.summary.removed > 0;
  const wouldOverwriteOurEdits = !!hasLocalChanges && diff.summary.modified > 0;
  const wouldLoseLocal = snapshotMissesRecords || wouldOverwriteOurEdits;
  // Merge is worth offering in two situations: replacing would lose our rows, OR other snapshots
  // are still unreconciled (there a replace provably cannot converge — it resets the
  // reconciled-log to the one file it loaded — while a merge accumulates and clears the guard).
  // The identical-data case belongs in the second: `previewMerge` handles a zero-conflict doc
  // fine, commits dirty, and PRESERVES earlier acknowledgements, which the replace discards.
  const mergeOffered = !!onMerge && ((diff.summary.changed && wouldLoseLocal) || moreToReconcile);

  return (
    <Modal title={isRestore ? "Restore this backup?" : `Load snapshot v${remoteVersion}?`} onClose={onCancel}>
      <div className="space-y-4">
        {/* Rendered for BOTH branches: the identical-data case needs it MOST, because there the
            only other text says the load unblocks syncing — which it doesn't while anything is
            still unreconciled. */}
        {moreToReconcile && (
          <p className="rounded-lg bg-blue-50 p-3 text-xs text-blue-900">
            Heads up: {outstandingOthers} other snapshot{outstandingOthers === 1 ? "" : "s"} in the shared folder
            {outstandingOthers === 1 ? " hasn't" : " haven't"} been reconciled on this device yet, and syncing
            stays blocked until {outstandingOthers === 1 ? "it is" : "they are"}.{" "}
            {mergeOffered ? (
              <>
                <b>Merge — keep both</b> is the way through: it combines this snapshot with what's here and
                counts it as reconciled. Replacing only swaps which snapshot this device holds, so repeating it
                can never finish — you'd come back to this screen every time.
              </>
            ) : (
              <>
                Use <b>Pull latest</b> and choose <b>Merge — keep both</b> for{" "}
                {outstandingOthers === 1 ? "it" : "each of them"}: replacing only swaps which snapshot this
                device holds, so it can never finish on its own.
              </>
            )}
          </p>
        )}
        {diff.summary.changed ? (
          <>
            <p className="text-sm text-slate-600">
              {wouldLoseLocal
                ? isRestore
                  ? "Restoring this backup replaces your local data. Tap a section to see exactly what changes:"
                  : "This will replace your local data. Tap a section to see exactly what changes:"
                : hasLocalChanges
                  ? // Dirty, yet nothing shows as modified/removed — the classic case is a local
                    // DELETE, which appears as an "added" record coming back. Never tell this
                    // user they have no unsynced changes — and name the right SOURCE: on a
                    // restore the rows come back from the file they picked, not from a device.
                    `You have unsynced changes on this device. Nothing of yours would be overwritten, but anything you deleted here that still exists ${isRestore ? "in this backup" : "on the other device"} will come back. Tap a section to see what changes:`
                  : isRestore
                    ? "Restoring this backup replaces what's here with the backup's contents. Tap a section to see what changes:"
                    : moreToReconcile
                      ? // "brings it up to date" is FALSE while other snapshots are unreconciled —
                        // and it was the first, largest text on the screen, directly above the note
                        // saying the opposite. Keep the reassurance (nothing of theirs is at risk),
                        // drop the completeness claim; the note below supplies the rest.
                        "This device has no unsynced changes, so nothing of yours is at risk here. Tap a section to see what changes:"
                      : "This device has no unsynced changes, so this just brings it up to date. Tap a section to see what changes:"}
            </p>
            {/* NOT gated on `onMerge`: a restore is offered no merge, and it was exactly the
                restore path — an older backup missing rows this device has — that showed the
                bare "replaces your local data" with no count and no unrecoverable warning,
                while the identical situation via Pull latest shouted it. */}
            {wouldLoseLocal && (
              <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                {snapshotMissesRecords ? (
                  <>
                    <b>
                      This {fileNoun} is missing {diff.summary.removed} record
                      {diff.summary.removed === 1 ? "" : "s"} that exist{diff.summary.removed === 1 ? "s" : ""} on
                      this device.
                    </b>{" "}
                    “{replaceLabel}” deletes {diff.summary.removed === 1 ? "it" : "them"} here, and{" "}
                    {diff.summary.removed === 1 ? "it can't" : "they can't"} be recovered from the app
                    afterwards.
                  </>
                ) : (
                  <>
                    <b>You have changes on this device that haven't synced yet.</b> “{replaceLabel}”
                    discards them — {diff.summary.modified} record
                    {diff.summary.modified === 1 ? "" : "s"} would be overwritten.
                  </>
                )}
                {onMerge && " “Merge” keeps both sides instead, asking you only about items that differ."}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Badge tone="green">+{diff.summary.added} added</Badge>
              <Badge tone="amber">{diff.summary.modified} modified</Badge>
              <Badge tone="red">−{diff.summary.removed} removed</Badge>
            </div>
            <ul className="divide-y divide-slate-100 text-sm">
              {rows.map(([name, d]) => (
                <CollectionSection key={name} name={name} d={d} display={display} />
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-slate-600">
            {isRestore
              ? // A restore does NOT advance the synced version (store.applyDocument: "a plain
                // restore acknowledges nothing"), so it cannot unblock a sync — promising that
                // here would be false.
                "This backup holds exactly the data you already have, so loading it changes nothing."
              : moreToReconcile
                ? // Identical data, but other snapshots are unreconciled. Merging records this one
                  // and KEEPS what was reconciled before; loading it replaces — which changes no
                  // data here, yet resets the reconciled-log to this single file, undoing earlier
                  // merges. Say that, since the two buttons are not equivalent.
                  "The data is identical to what you have, so there's nothing to choose. Use Merge — keep both to count this snapshot as reconciled; loading it instead would drop the record of any snapshot you'd already merged."
                : 'The data is identical to what you have. You can still load it to acknowledge this newer version — that re-enables syncing (it was blocked on "Remote has newer changes").'}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Keep local
          </Button>
          {/* Offered whenever replacing would LOSE something — including on a clean device, where a
              snapshot missing our records is exactly the unrecoverable case — AND whenever other
              snapshots are still unreconciled, because there a replace cannot converge at all and
              merging is the only action that clears the guard. */}
          {mergeOffered && (
            <Button onClick={onMerge}>Merge — keep both</Button>
          )}
          {/* Always enabled: even an identical newer version must be loadable so
              the user can acknowledge it (advancing the synced version) and
              un-stick a sync blocked by a newer remote. Styled destructive ONLY when local
              work would actually be lost. */}
          {/* When Merge is the recommended route, the replace must not share its visual weight —
              it sat last (thumb-reachable on mobile) in the same blue as the action the note says
              "can never finish". */}
          <Button
            variant={wouldLoseLocal ? "danger" : mergeOffered ? "ghost" : "primary"}
            onClick={onConfirm}
          >
            {!diff.summary.changed
              ? isRestore
                ? "Restore this backup"
                : moreToReconcile
                  ? "Load this snapshot" // nothing is acknowledged while the watermark is held
                  : "Acknowledge version"
              : wouldLoseLocal
                ? replaceLabel
                : isRestore
                  ? "Restore this backup"
                  : moreToReconcile
                    ? "Load this snapshot"
                    : "Bring this device up to date"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
