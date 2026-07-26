// Two-sided sync reconciliation — the "git merge" for this app, minus the jargon.
//
// The sync engine refuses to push when another device advanced beyond what this one last
// synced: pushing would silently overwrite changes it never saw. Replacing local data is
// the only other option, which throws away this device's work. Neither is acceptable when
// both sides have real edits, so this module merges.
//
// The model mirrors what a version-control merge does, and what actually happens in
// practice (two devices each ADD rows — different transactions, a new account):
//
//   1. AUTO-MERGE everything that doesn't clash. A record only one side has is kept. This
//      is the overwhelming majority and needs no user involvement at all.
//   2. A record BOTH sides changed differently is a CONFLICT. It is never resolved
//      silently — it's returned for the user to choose, with a suggestion (the newer copy
//      when both carry `updatedAt`, else this device's).
//
// Deliberate non-goal: deletions. Without a tombstone log, "deleted here" and "not seen
// here yet" are indistinguishable, so a merge never deletes — a row you deleted on one
// device while the other still had it comes back. That's the recoverable direction (delete
// it again) and it's reported, unlike silent data loss.

import type { Keyed } from "./diff";

/** Which side a conflict was resolved in favour of. */
export type ConflictChoice = "mine" | "theirs";

/** One field that genuinely differs, with BOTH values — so the UI can show the user what
 *  they're actually choosing between instead of a generic summary that renders identically
 *  on both sides. */
export interface FieldDifference {
  field: string;
  mine: unknown;
  theirs: unknown;
}

export interface MergeConflict {
  /** Collection name, e.g. "transactions" — the UI turns this into a human label. */
  collection: string;
  id: string;
  /** This device's copy. */
  mine: Keyed;
  /** The other device's copy. */
  theirs: Keyed;
  /** Field names that actually differ (bookkeeping excluded), for a short summary. */
  changedFields: string[];
  /** The differing fields WITH both values — what the choice is really about. */
  differences: FieldDifference[];
  /** Pre-selected side: the newer copy when both are timestamped, else "mine". */
  suggestion: ConflictChoice;
  /** True when the suggestion came from timestamps rather than the fallback. */
  suggestionFromTimestamps: boolean;
  /** True when both timestamps exist and are EQUAL — the suggestion is then arbitrary, and
   *  the UI must not claim one side "was edited more recently". */
  timestampsEqual: boolean;
}

export interface MergePlan {
  /** The merged dataset with every conflict resolved by its SUGGESTION. Apply choices on
   *  top of this with `applyChoices`. */
  merged: Record<string, Keyed[]>;
  /** Records both sides changed differently — the only thing to ask the user about. */
  conflicts: MergeConflict[];
  summary: {
    /** Records ONLY this device had. Kept — but note this is not "how many of mine
     *  survive": records present on both sides are counted in `identical`/`conflicts`
     *  instead. Displaying this as "kept from this device" would undercount badly. */
    onlyHere: number;
    /** Records ONLY the other device had — adopted (the visible gain from merging). */
    onlyOther: number;
    /** Records byte-identical on both sides. */
    identical: number;
    /** Records needing a decision (= conflicts.length). */
    conflicts: number;
    /** Total records after merging, across all collections — the honest headline number. */
    totalAfter: number;
  };
}

/** Stable stringify (sorted keys) so field ORDER never looks like a difference. */
function stableString(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/** A record's last-edit time as a comparable instant, or undefined when it has none / the
 *  value isn't a real date. Parsed rather than compared as text: a stamp with a non-UTC
 *  offset ("2026-01-02T04:00:00+05:30") sorts wrongly as a string and could hand a record to
 *  the older copy while telling the user it was "edited more recently"; unparseable text
 *  must count as no timestamp at all, not as a winner. */
function updatedAt(rec: Keyed): number | undefined {
  const v = (rec as unknown as Record<string, unknown>).updatedAt;
  if (typeof v !== "string" || v === "") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Fields that record WHO/WHEN a row was written rather than what it says. Two devices
 *  independently materialising the same record (e.g. an autopay transfer, which has a
 *  deterministic id) differ only here — that is NOT a difference worth asking a human
 *  about, and treating it as one manufactured dozens of undecidable "conflicts" whose two
 *  options rendered identically. */
const BOOKKEEPING = new Set(["updatedAt", "author"]);

/** `false` and "field absent" mean the same thing for the app's optional boolean flags
 *  (`archived`, `excludeFromBalance`, …). One code path writes an explicit `archived: false`
 *  (un-archiving) while every other copy simply omits the key, which otherwise produced a
 *  "conflict" whose two options both meant "not archived" — undecidable by construction. */
const sameEmptiness = (a: unknown, b: unknown): boolean =>
  (a === undefined || a === false) && (b === undefined || b === false);

/** Fields that genuinely differ, with both values. Excludes `id` and bookkeeping. */
function differencesBetween(a: Keyed, b: Keyed): FieldDifference[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: FieldDifference[] = [];
  for (const k of keys) {
    if (k === "id" || BOOKKEEPING.has(k)) continue;
    const av = (a as unknown as Record<string, unknown>)[k];
    const bv = (b as unknown as Record<string, unknown>)[k];
    if (sameEmptiness(av, bv)) continue;
    if (stableString(av) !== stableString(bv)) out.push({ field: k, mine: av, theirs: bv });
  }
  return out.sort((x, y) => x.field.localeCompare(y.field));
}

/**
 * Plan a merge of `remote` into `local`: union the non-clashing records and collect the
 * genuine conflicts. Pure — nothing is persisted, so the caller can show the conflicts
 * first and only then commit.
 */
export function planMerge(
  local: Record<string, Keyed[]>,
  remote: Record<string, Keyed[]>,
): MergePlan {
  const merged: Record<string, Keyed[]> = {};
  const conflicts: MergeConflict[] = [];
  const summary = { onlyHere: 0, onlyOther: 0, identical: 0, conflicts: 0, totalAfter: 0 };

  // Every collection either side knows about, so the PLAN never drops one.
  // Caveat, deliberately not solved here: if the other device runs a newer app version with a
  // collection this build has no store for, the storage layer skips it on write (see
  // `importAll` in the adapters) — the planner can't prevent that, and inventing stores for
  // unknown data would be worse. Pre-existing for the replace path too.
  for (const collection of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const mine = local[collection] ?? [];
    const theirs = remote[collection] ?? [];
    const theirsById = new Map(theirs.map((r) => [r.id, r]));
    const out: Keyed[] = [];

    // Local order first, so resolving a conflict never reshuffles the user's view.
    for (const a of mine) {
      const b = theirsById.get(a.id);
      if (!b) {
        out.push(a);
        summary.onlyHere++;
        continue;
      }
      theirsById.delete(a.id);
      const differences = differencesBetween(a, b);
      const aAt = updatedAt(a);
      const bAt = updatedAt(b);
      if (differences.length === 0) {
        // Same content. Either byte-identical, or differing ONLY in who/when wrote it —
        // asking the user to choose there is a question with no answer. Keep the newer copy
        // so the timestamps converge, otherwise ours.
        out.push(aAt && bAt && bAt > aAt ? b : a);
        summary.identical++;
        continue;
      }
      // Last-write-wins ONLY when both sides timestamp the record. A missing timestamp must
      // not read as "older", or every untimestamped record would default to the other device.
      const bothTimestamped = !!aAt && !!bAt;
      const suggestion: ConflictChoice = bothTimestamped && bAt > aAt ? "theirs" : "mine";
      conflicts.push({
        collection,
        id: a.id,
        mine: a,
        theirs: b,
        changedFields: differences.map((d) => d.field),
        differences,
        suggestion,
        suggestionFromTimestamps: bothTimestamped && aAt !== bAt,
        timestampsEqual: bothTimestamped && aAt === bAt,
      });
      out.push(suggestion === "mine" ? a : b);
      summary.conflicts++;
    }
    // Anything left existed only on the other device.
    for (const b of theirsById.values()) {
      out.push(b);
      summary.onlyOther++;
    }
    merged[collection] = out;
    summary.totalAfter += out.length;
  }

  return { merged, conflicts, summary };
}

/**
 * Apply the user's per-conflict choices on top of a plan's `merged` data. Choices are keyed
 * by `conflictKey(c)`; anything unspecified keeps the plan's suggestion.
 */
export function applyChoices(
  plan: MergePlan,
  choices: Record<string, ConflictChoice>,
): Record<string, Keyed[]> {
  // Only the conflicts whose chosen side differs from the suggestion need swapping.
  const swaps = new Map<string, Map<string, Keyed>>();
  for (const c of plan.conflicts) {
    const chosen = choices[conflictKey(c)] ?? c.suggestion;
    if (chosen === c.suggestion) continue;
    const byId = swaps.get(c.collection) ?? new Map<string, Keyed>();
    byId.set(c.id, chosen === "mine" ? c.mine : c.theirs);
    swaps.set(c.collection, byId);
  }
  if (swaps.size === 0) return plan.merged;

  const out: Record<string, Keyed[]> = {};
  for (const [collection, records] of Object.entries(plan.merged)) {
    const byId = swaps.get(collection);
    out[collection] = byId ? records.map((r) => byId.get(r.id) ?? r) : records;
  }
  return out;
}

/** Stable key for a conflict (collection + id) — how the UI tracks each choice. */
export function conflictKey(c: Pick<MergeConflict, "collection" | "id">): string {
  return `${c.collection}:${c.id}`;
}

/** `<fileId>@<version>` — identity of one exact remote snapshot, as recorded in
 *  `settings.seenSnapshots`. Keyed by FILE, not by version alone: two devices can mint the
 *  same version number, and "seen v5" must never be read as "seen everyone's v5". */
export const snapshotKey = (f: { id: string; version: number }): string => `${f.id}@${f.version}`;

/** Files that may still hold records this device has never incorporated.
 *
 *  Subsumption rules, each independently sound:
 *   - version STRICTLY below `watermark` — superseded by what we've synced;
 *   - key in `seen` — this device pulled or merged that exact file@version;
 *   - `deviceId` is ours — we wrote it, from this same database;
 *   - not its own device's top version — snapshots are FULL documents, so a device's newer
 *     file contains everything its older one did (same device ⇒ same database ⇒ later export).
 *
 *  Note the strictness: a file AT the watermark is a hazard unless it is ours or recorded as
 *  seen. Snapshot versions are only monotonic per device, so two devices pushing concurrently
 *  (Drive's read-after-write lag hides each from the other's pre-push listing) can mint the
 *  SAME number — and treating "some file at v5" as "the v5 I read" let a device publish
 *  straight over a sibling's unread rows, with no merge ever offered.
 *
 *  Ties within one device are deliberately NOT collapsed either: if a device somehow has two
 *  files at its top version, both stay candidates, because subsuming an unseen one under a
 *  seen sibling would claim to hold data we've never read. */
export function unincorporatedFiles<T extends { id: string; version: number; deviceId: string }>(
  others: readonly T[],
  watermark: number,
  seen: ReadonlySet<string>,
  /** This device's id AND the version its database has reached. The id alone isn't enough: a
   *  CLONED profile copies the id while its data diverges, and would then be excused forever. A
   *  file we really wrote cannot exceed our own version, so bounding by it keeps every legitimate
   *  case (a prior session's file, a crash before `markSynced`) and still flags a diverged twin. */
  own?: { deviceId: string; version: number },
): T[] {
  const topByDevice = new Map<string, number>();
  for (const f of others) {
    topByDevice.set(f.deviceId, Math.max(topByDevice.get(f.deviceId) ?? -Infinity, f.version));
  }
  return others.filter(
    (f) =>
      f.version === topByDevice.get(f.deviceId) &&
      f.version >= watermark &&
      !(own && f.deviceId === own.deviceId && f.version <= own.version) &&
      !seen.has(snapshotKey(f)),
  );
}

/** May a snapshot at the baseline floor be recorded as incorporated WITHOUT reading it?
 *
 *  A new baseline (the v1→v2 migration, a password reset) declares every version up to its floor
 *  superseded, so each file AT that floor must be accounted for or its rows are published over
 *  silently. Only two cases are free:
 *   - `own` — our own device wrote it, from this same database, so our export can't lack its rows;
 *   - `seen` — we already pulled or merged that exact file@version.
 *  Everything else must be DECODED and unioned in first; if that fails, it stays unclaimed and the
 *  ordinary push guard keeps protecting it. A blocked push beats a silent overwrite. */
export function baselineClaim(
  file: { id: string; version: number; deviceId: string },
  ctx: { own: { deviceId: string; version: number }; seen: ReadonlySet<string> },
): "own" | "seen" | "must-read" {
  // Same version bound as `unincorporatedFiles`: our id on a file BEYOND our own version means a
  // cloned profile, not us, so it must be read like any stranger's.
  if (file.deviceId === ctx.own.deviceId && file.version <= ctx.own.version) return "own";
  if (ctx.seen.has(snapshotKey(file))) return "seen";
  return "must-read";
}
