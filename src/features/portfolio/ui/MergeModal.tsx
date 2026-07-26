// Reconcile two devices that both have changes — the plain-language version of a merge.
//
// The design rule: the user should never have to understand ids, collections, versions or
// timestamps. They see (1) exactly what will happen, in counts of real things ("12 of your
// transactions kept, 4 from the other device added"), and (2) the handful of items both
// devices changed differently, each with a straight two-way choice showing the actual
// values. Everything that doesn't clash is merged without asking.

import React, { memo, useCallback, useMemo, useState, useTransition } from "react";
import type { Keyed } from "../../../lib/sync/diff";
import { conflictKey, type ConflictChoice, type MergeConflict, type MergePlan } from "../../../lib/sync/merge";
import { Badge, Button, Modal } from "./components";
import {
  describe,
  describeChanges,
  humanField,
  label,
  makeNameResolver,
  showValue,
  type DisplayContext,
  type RecordResolver,
} from "./merge-labels";

export function MergeModal({
  plan,
  onCancel,
  onConfirm,
  busy,
  outstandingOthers = 0,
  ackUnavailable = false,
}: {
  plan: MergePlan;
  onCancel: () => void;
  onConfirm: (choices: Record<string, ConflictChoice>) => void;
  busy?: boolean;
  /** Snapshots this merge does NOT include, already known from the preview. Promising
   *  "tap Sync now" here and then reporting the opposite after the commit made the dialog
   *  contradict the very screen it returns to. */
  outstandingOthers?: number;
  /** The folder listing failed, so publishability is unknown rather than refused. */
  ackUnavailable?: boolean;
}) {
  // Start from the plan's suggestions; the user only changes what they disagree with.
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const choiceFor = (c: MergeConflict): ConflictChoice => choices[conflictKey(c)] ?? c.suggestion;
  // Stable identity, or every memoised row would re-render on each keystroke of state.
  const set = useCallback((c: MergeConflict, v: ConflictChoice): void => {
    setChoices((prev) => ({ ...prev, [conflictKey(c)]: v }));
  }, []);
  // Applying a choice to every conflict repaints the whole list — measured at 2.1–3.4 s for
  // 300 rows on a throttled phone. Marked as a transition and shown as pending so the two
  // buttons say "applying…" instead of looking dead while React works.
  const [applying, startApplying] = useTransition();
  const setAll = (v: ConflictChoice): void => {
    startApplying(() => {
      setChoices(Object.fromEntries(plan.conflicts.map((c) => [conflictKey(c), v])));
    });
  };

  // Group the "what will happen" counts by kind of thing, so the summary talks about
  // transactions and accounts rather than totals.
  const byCollection = useMemo(() => {
    const rows: Array<{ collection: string; mine: number }> = [];
    for (const [collection, records] of Object.entries(plan.merged)) {
      if (collection === "settings" || collection === "fxRates") continue; // device-local noise
      const adopted = plan.conflicts.filter((c) => c.collection === collection).length;
      if (records.length === 0 && adopted === 0) continue;
      rows.push({ collection, mine: records.length });
    }
    return rows;
  }, [plan]);

  const s = plan.summary;
  const keepingTheirs = plan.conflicts.filter((c) => choiceFor(c) === "theirs").length;
  // How each default was actually arrived at. `suggestionFromTimestamps` is the ONLY case where
  // recency decided anything; everything else — no timestamps on either side (all collections but
  // transactions), or two identical timestamps — falls back to this device's copy.
  const pickedByRecency = plan.conflicts.filter((c) => c.suggestionFromTimestamps).length;
  // Ties DID carry edit times — they just don't establish a newer copy, and their own row note
  // says so ("edited at the same moment … neither is newer"). They therefore get their OWN clause:
  // folding them in with the untimestamped ones told the user they had no edit time (contradicting
  // the row), and in a mix the paired counts implied a partition that was simply false.
  const tied = plan.conflicts.filter((c) => c.timestampsEqual).length;
  const untimed = s.conflicts - pickedByRecency - tied;
  // How the STARTING selection was arrived at, in the past tense — one clause per REASON, so no
  // clause ever speaks for records it doesn't describe. Phrased whole so the singular reads as a
  // sentence ("It carried an edit time…", not "1 of them carry…").
  const subject = (n: number): string =>
    n === s.conflicts ? (n === 1 ? "It" : "All of them") : `${n} of them`;
  const startedClauses: React.ReactNode[] = [];
  if (pickedByRecency > 0) {
    startedClauses.push(
      <>
        {subject(pickedByRecency)} carried {pickedByRecency === 1 ? "an edit time" : "edit times"} on both
        sides, so the more recently edited copy was pre-selected
      </>,
    );
  }
  if (tied > 0) {
    startedClauses.push(
      <>
        {subject(tied)} {tied === 1 ? "was" : "were"} edited at the same moment on both devices, so{" "}
        {tied === 1 ? "it" : "they"} started on this device's copy — neither copy is newer
      </>,
    );
  }
  if (untimed > 0) {
    startedClauses.push(
      <>
        {subject(untimed)} {untimed === 1 ? "has" : "have"} no edit time to compare, so{" "}
        {untimed === 1 ? "it" : "they"} started on this device's copy —{" "}
        <b>
          a newer copy on the other device would not have been picked for{" "}
          {untimed === 1 ? "that one" : "those"}
        </b>
      </>,
    );
  }
  // Singular reads as a sentence, not as "all 1 currently keep…".
  const currentStance =
    s.conflicts === 1 ? (
      keepingTheirs === 1 ? (
        <>
          it takes <b>the other device's</b> version
        </>
      ) : (
        <>
          it keeps <b>this device's</b> version
        </>
      )
    ) : keepingTheirs === 0 ? (
      <>
        {s.conflicts === 2 ? "both" : `all ${s.conflicts}`} keep <b>this device's</b> version
      </>
    ) : keepingTheirs === s.conflicts ? (
      <>
        {s.conflicts === 2 ? "both" : `all ${s.conflicts}`} take <b>the other device's</b> version
      </>
    ) : (
      <>
        {keepingTheirs} of {s.conflicts} {keepingTheirs === 1 ? "takes" : "take"} <b>the other device's</b>{" "}
        version and {s.conflicts - keepingTheirs} {s.conflicts - keepingTheirs === 1 ? "keeps" : "keep"} this
        device's
      </>
    );

  // Record lookup over the merged plan (it already holds every account/category/person/
  // investment either device has), and the shared name/value formatter on top of it.
  const display = useMemo<DisplayContext>(() => {
    const byCollection = new Map<string, Map<string, Keyed>>();
    for (const [collection, records] of Object.entries(plan.merged)) {
      byCollection.set(collection, new Map(records.map((r) => [r.id, r])));
    }
    const record: RecordResolver = (collection, id) => byCollection.get(collection)?.get(id);
    return { record, name: makeNameResolver(record) };
  }, [plan.merged]);

  return (
    <Modal title="Combine both devices" onClose={onCancel} wide>
      <div className="space-y-4">
        {/* ---------- what will happen ---------- */}
        <div className="rounded-lg bg-blue-50 p-3 text-sm text-slate-700">
          <p className="font-medium text-slate-800">Merging keeps everything from both devices.</p>
          <p className="mt-1 text-xs text-slate-600">
            Nothing is deleted: every item on this device stays, and anything only the other device has is
            added.{" "}
            {s.conflicts === 0
              ? "No item differs between the two, so there's nothing to decide."
              : `${s.conflicts} item${s.conflicts === 1 ? "" : "s"} differ${s.conflicts === 1 ? "s" : ""} between the two devices.`}
          </p>
          {/* The DEFAULT outcome, stated here and not only in a counter far below the fold: doing
              nothing can replace many of this device's records, and "kept except where you pick"
              said the opposite of what the button does.
              It must describe what ACTUALLY decided each default, per conflict. Only
              `Transaction` carries `updatedAt`, so for accounts, categories, people, investments
              and investment transactions there is no comparison to make and the default is
              simply this device's copy — announcing "the more recently edited copy is selected"
              over those told the user the app had checked something it never looked at, and
              supplied a false justification for discarding a genuinely newer edit. */}
          {s.conflicts > 0 && (
            <p className="mt-1 text-xs text-slate-600">
              Right now {currentStance}.{" "}
              {/* The live outcome above, then how the STARTING selection was made — in the past
                  tense and clearly about the start. Written in the present it contradicted the
                  first sentence the moment the user tapped All theirs: the block said they'd
                  taken the other device's version AND that they "default to this device's copy". */}
              {startedClauses.length > 0 && (
                <>
                  How those were pre-selected:{" "}
                  {startedClauses.map((clause, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && "; "}
                      {clause}
                    </React.Fragment>
                  ))}
                  .{" "}
                </>
              )}
              Check {s.conflicts === 1 ? "it" : "them"} below
              {keepingTheirs > 0 ? (
                <>
                  {" "}
                  — or use <b>All mine</b> to keep this device's throughout.
                </>
              ) : (
                <>
                  {" "}
                  — or use <b>All theirs</b> to take the other device's throughout.
                </>
              )}
            </p>
          )}
          {/* Merging cannot tell "deleted here" from "not seen here yet", so it never deletes.
              That means deletions come back — the user must be told, not surprised. */}
          <p className="mt-1 text-xs text-slate-600">
            One thing to know: because merging never deletes, anything you deleted on one device that still
            exists on the other <b>will come back</b>. Delete it again afterwards if you don't want it.
          </p>
        </div>

        {/* Honest headline numbers. Deliberately NOT "kept from this device" — records that
            exist on both sides aren't in `onlyHere`, so that label would undercount what
            survives and make merging look lossy when it isn't. */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-slate-50 p-2">
            <div className="text-lg font-semibold text-slate-800">{s.totalAfter}</div>
            <div className="text-xs text-slate-500">items after merging</div>
          </div>
          <div className="rounded-lg bg-green-50 p-2">
            <div className="text-lg font-semibold text-green-700">+{s.onlyOther}</div>
            <div className="text-xs text-slate-500">new from the other device</div>
          </div>
          <div className="rounded-lg bg-amber-50 p-2">
            <div className="text-lg font-semibold text-amber-700">{s.conflicts}</div>
            <div className="text-xs text-slate-500">need your choice</div>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Of those, {s.onlyHere} exist{s.onlyHere === 1 ? "s" : ""} only on this device (kept as-is) and{" "}
          {s.identical} {s.identical === 1 ? "is" : "are"} already the same on both.
        </p>

        {byCollection.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {byCollection.map((r) => (
              <li key={r.collection} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-slate-600">After merging, {label(r.collection, r.mine)}</span>
                <span className="shrink-0 font-medium text-slate-800">{r.mine}</span>
              </li>
            ))}
          </ul>
        )}

        {/* ---------- conflicts ---------- */}
        {plan.conflicts.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-medium text-slate-700">
                {/* Not "changed on both devices": with no common starting point we can't know
                    which side changed it, only that the two now differ. */}
                These differ between your devices — pick a version
                {keepingTheirs > 0 && (
                  <span className="ml-1 text-xs font-normal text-slate-500">
                    ({plan.conflicts.length - keepingTheirs} yours, {keepingTheirs} theirs)
                  </span>
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={applying} onClick={() => setAll("mine")}>
                  {applying ? "applying…" : "All mine"}
                </Button>
                <Button variant="ghost" disabled={applying} onClick={() => setAll("theirs")}>
                  {applying ? "applying…" : "All theirs"}
                </Button>
              </div>
            </div>
            {/* Scrolls INSIDE its own box: an unbounded list put the commit button ~130
                screens below the bulk actions on a phone. */}
            <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {plan.conflicts.map((c) => (
                <ConflictRow
                  key={conflictKey(c)}
                  conflict={c}
                  chosen={choiceFor(c)}
                  onChoose={set}
                  display={display}
                />
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-slate-500">
          {outstandingOthers > 0 ? (
            <>
              After merging, this device holds the combined data. {outstandingOthers} other snapshot
              {outstandingOthers === 1 ? "" : "s"} still {outstandingOthers === 1 ? "holds" : "hold"} changes
              this merge doesn't include, so it can't be sent to your other devices yet — each one needs its
              own <b>Pull latest</b> and merge, so {outstandingOthers === 1 ? "one more round" : `${outstandingOthers} more rounds`}.
            </>
          ) : ackUnavailable ? (
            <>
              After merging, this device holds the combined data. We couldn't check the shared folder just
              now, so <b>Sync now</b> will send it as soon as the folder is reachable.
            </>
          ) : (
            <>
              After merging, this device holds the combined data — tap <b>Sync now</b> to send it to your
              other devices.
            </>
          )}{" "}
          There's no one-tap undo, so if you want a way back, download a backup first (Settings → Backup
          &amp; restore).
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => onConfirm(choices)}>
            {busy ? "Merging…" : "Merge and keep both"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** One conflict. Memoised on its own choice: tapping a card must not re-render the whole
 *  list — with 300 conflicts that measured over a second per tap on a mid-range phone. */
const ConflictRow = memo(function ConflictRow({
  conflict: c,
  chosen,
  onChoose,
  display,
}: {
  conflict: MergeConflict;
  chosen: ConflictChoice;
  onChoose: (c: MergeConflict, side: ConflictChoice) => void;
  display: DisplayContext;
}) {
  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber">{label(c.collection, 1)}</Badge>
        <span className="text-xs text-slate-500">differs in {describeChanges(c.changedFields)}</span>
      </div>
      {/* Which record this is — shown ONCE, since both sides are the same record. */}
      <div className="mt-0.5 break-words text-sm text-slate-700">{describe(c.collection, c.mine, display)}</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {(["mine", "theirs"] as ConflictChoice[]).map((side) => {
          const rec = side === "mine" ? c.mine : c.theirs;
          const active = chosen === side;
          return (
            <button
              key={side}
              onClick={() => onChoose(c, side)}
              aria-pressed={active}
              className={`rounded-lg border p-2 text-left text-sm transition ${
                active
                  ? "border-blue-500 bg-blue-50 text-slate-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {side === "mine" ? "This device" : "Other device"}
                </span>
                {active && <span className="text-xs font-medium text-blue-600">✓ keeping</span>}
              </div>
              {/* The DIFFERING values — the whole point of the choice. A fixed summary here
                  made both options render identically for most real conflicts, and raw ids
                  made them unreadable; values are resolved to names. */}
              <dl className="mt-1 space-y-0.5">
                {c.differences.map((d) => {
                  // Pass the OTHER side's value so nested objects compare the union of their keys.
                  const shown = showValue(
                    d.field,
                    side === "mine" ? d.mine : d.theirs,
                    rec,
                    display,
                    side === "mine" ? d.theirs : d.mine,
                  );
                  const isColour = d.field === "color" && /^#[0-9a-f]{3,8}$/i.test(shown);
                  return (
                    <div key={d.field} className="flex flex-wrap items-center gap-x-1 text-xs">
                      <dt className="text-slate-500">{humanField(d.field)}:</dt>
                      <dd className="flex items-center gap-1 break-words font-medium text-slate-800">
                        {isColour && (
                          <span
                            aria-hidden
                            className="inline-block h-3 w-3 shrink-0 rounded-full border border-slate-300"
                            style={{ backgroundColor: shown }}
                          />
                        )}
                        {shown}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </button>
          );
        })}
      </div>
      {c.suggestionFromTimestamps && (
        <p className="mt-1 text-xs text-slate-400">
          Suggested: the {c.suggestion === "mine" ? "copy on this device" : "other device's copy"} was edited
          more recently.
        </p>
      )}
      {c.timestampsEqual && (
        <p className="mt-1 text-xs text-slate-400">
          Both were edited at the same moment — this device's copy is pre-selected, but neither is newer.
        </p>
      )}
    </li>
  );
});
