// Tests for two-sided sync reconciliation (lib/sync/merge): the union of both devices,
// which records count as conflicts, and that a merge NEVER loses a record.

import { applyChoices, baselineClaim, conflictKey, planMerge, snapshotKey, unincorporatedFiles, type ConflictChoice } from "../src/lib/sync/merge";
import type { Keyed } from "../src/lib/sync/diff";
import { done, eq, ok, section } from "./_harness";

const txn = (id: string, over: Record<string, unknown> = {}): Keyed =>
  ({ id, date: "2026-01-01", type: "expense", accountId: "A", personId: "p1", amount: 100, currency: "INR", updatedAt: "2026-01-01T00:00:00.000Z", ...over }) as unknown as Keyed;
const named = (id: string, name: string, over: Record<string, unknown> = {}): Keyed =>
  ({ id, name, ...over }) as unknown as Keyed;
const ids = (recs: Keyed[] | undefined): string => (recs ?? []).map((r) => r.id).sort().join(",");

// ---------------------------------------------------------------------------
section("[merge] additions on BOTH devices all survive (the core promise)");
{
  const local = { transactions: [txn("a"), txn("b")], accounts: [named("A1", "HDFC")] };
  const remote = { transactions: [txn("b"), txn("c")], accounts: [named("A1", "HDFC"), named("A2", "Axis")] };
  const plan = planMerge(local, remote);
  eq(ids(plan.merged.transactions), "a,b,c", "a local-only, a shared and a remote-only txn are all kept");
  eq(ids(plan.merged.accounts), "A1,A2", "the other device's new account is adopted");
  eq(plan.conflicts.length, 0, "identical shared records are not conflicts");
  eq(plan.summary.onlyHere, 1, "1 record existed ONLY here (txn a)");
  eq(plan.summary.onlyOther, 2, "2 came only from the other device (txn c + account A2)");
  eq(plan.summary.identical, 2, "…and 2 were byte-identical on both sides (txn b + account A1)");
  eq(plan.summary.totalAfter, 5, "5 records survive in total — the number the UI headlines");
}

section("[merge] nothing is ever dropped: output ⊇ both inputs, for every collection");
{
  const local = { transactions: [txn("a"), txn("b", { amount: 5 })], categories: [named("c1", "Food")] };
  const remote = { transactions: [txn("b", { amount: 9 }), txn("z")], people: [named("p9", "Meera")] };
  const plan = planMerge(local, remote);
  const all = new Set(Object.values(plan.merged).flat().map((r) => r.id));
  for (const r of [...Object.values(local).flat(), ...Object.values(remote).flat()]) {
    ok(all.has(r.id), `record ${r.id} survives the merge`);
  }
  ok("people" in plan.merged, "a collection only the OTHER device had is not dropped");
  ok("categories" in plan.merged, "…nor one only this device had");
}

section("[merge] a record changed on both sides is a CONFLICT, never silently resolved");
{
  const local = { transactions: [txn("a", { amount: 250, note: "Coffee" })] };
  const remote = { transactions: [txn("a", { amount: 300, note: "Coffee" })] };
  const plan = planMerge(local, remote);
  eq(plan.conflicts.length, 1, "one conflict reported");
  const c = plan.conflicts[0]!;
  eq(c.collection, "transactions", "carries its collection");
  eq(c.changedFields.join(","), "amount", "reports exactly which fields differ (id excluded)");
  eq(plan.summary.conflicts, 1, "counted in the summary");
}

section("[merge] last-write-wins ONLY when both sides are timestamped");
{
  const older = "2026-01-01T00:00:00.000Z";
  const newer = "2026-02-01T00:00:00.000Z";
  // Remote edited later → suggest theirs.
  let plan = planMerge(
    { transactions: [txn("a", { amount: 1, updatedAt: older })] },
    { transactions: [txn("a", { amount: 2, updatedAt: newer })] },
  );
  eq(plan.conflicts[0]!.suggestion, "theirs", "the newer copy is suggested");
  ok(plan.conflicts[0]!.suggestionFromTimestamps, "…and it's flagged as timestamp-based");
  eq((plan.merged.transactions[0] as unknown as { amount: number }).amount, 2, "the suggestion is pre-applied");
  // Local edited later → suggest mine.
  plan = planMerge(
    { transactions: [txn("a", { amount: 1, updatedAt: newer })] },
    { transactions: [txn("a", { amount: 2, updatedAt: older })] },
  );
  eq(plan.conflicts[0]!.suggestion, "mine", "this device's newer copy is suggested");
  // No timestamps at all → default to MINE, and don't pretend it was a timestamp decision.
  plan = planMerge({ categories: [named("c", "Food")] }, { categories: [named("c", "Groceries")] });
  eq(plan.conflicts[0]!.suggestion, "mine", "untimestamped records default to this device");
  eq(plan.conflicts[0]!.suggestionFromTimestamps, false, "…and that is NOT presented as a timestamp decision");
  // A missing timestamp on one side must not read as "older" and hand it to the remote.
  plan = planMerge(
    { transactions: [txn("a", { amount: 1, updatedAt: "" })] },
    { transactions: [txn("a", { amount: 2, updatedAt: newer })] },
  );
  eq(plan.conflicts[0]!.suggestion, "mine", "a blank local timestamp does not lose to a remote one");
}

section("[merge] applyChoices honours the user's per-item decisions");
{
  const local = { transactions: [txn("a", { amount: 1 }), txn("b", { amount: 10 })] };
  const remote = { transactions: [txn("a", { amount: 2 }), txn("b", { amount: 20 })] };
  const plan = planMerge(local, remote);
  eq(plan.conflicts.length, 2, "two conflicts");
  const amountOf = (data: Record<string, Keyed[]>, id: string): number =>
    (data.transactions.find((r) => r.id === id) as unknown as { amount: number }).amount;
  // No choices → suggestions stand (both "mine", since timestamps are equal).
  eq(amountOf(applyChoices(plan, {}), "a"), 1, "unspecified conflicts keep the suggestion");
  // Flip one to theirs.
  const oneFlipped = applyChoices(plan, { [conflictKey(plan.conflicts[0]!)]: "theirs" });
  eq(amountOf(oneFlipped, "a"), 2, "the flipped conflict takes the other device's copy");
  eq(amountOf(oneFlipped, "b"), 10, "…and the other conflict is untouched");
  // Bulk "all theirs".
  const allTheirs: Record<string, ConflictChoice> = Object.fromEntries(
    plan.conflicts.map((c) => [conflictKey(c), "theirs" as ConflictChoice]),
  );
  const bulk = applyChoices(plan, allTheirs);
  eq(amountOf(bulk, "a"), 2, "all-theirs applies to every conflict (a)");
  eq(amountOf(bulk, "b"), 20, "all-theirs applies to every conflict (b)");
  // Record COUNT never changes with a choice — only which version is kept.
  eq(bulk.transactions.length, plan.merged.transactions.length, "resolving conflicts never adds or drops records");
}

section("[merge] local order is preserved so resolving a conflict doesn't reshuffle the view");
{
  const local = { transactions: [txn("x"), txn("y"), txn("z")] };
  const remote = { transactions: [txn("z"), txn("w")] };
  const plan = planMerge(local, remote);
  eq(plan.merged.transactions.map((r) => r.id).join(","), "x,y,z,w", "local order first, remote-only appended");
}

section("[merge] field ORDER never looks like a difference");
{
  const a = { transactions: [{ id: "a", amount: 1, note: "x" } as unknown as Keyed] };
  const b = { transactions: [{ id: "a", note: "x", amount: 1 } as unknown as Keyed] };
  eq(planMerge(a, b).conflicts.length, 0, "same content in a different key order is not a conflict");
}

section("[merge] empty / one-sided datasets behave");
{
  eq(planMerge({}, {}).conflicts.length, 0, "two empty datasets merge to nothing");
  const fromNothing = planMerge({}, { transactions: [txn("a")] });
  eq(ids(fromNothing.merged.transactions), "a", "a fresh device adopts everything");
  eq(fromNothing.summary.onlyOther, 1, "…counted as adopted");
  const toNothing = planMerge({ transactions: [txn("a")] }, {});
  eq(ids(toNothing.merged.transactions), "a", "an empty remote takes nothing away");
  eq(toNothing.summary.onlyHere, 1, "…and the local record is counted as kept");
}

section("[merge] deletions are NOT propagated (documented, safe direction)");
{
  // The other device still has a record this device deleted. Without tombstones we cannot
  // tell "deleted" from "not seen yet", so the record comes BACK rather than risking
  // deleting something real.
  const plan = planMerge({ transactions: [] }, { transactions: [txn("gone")] });
  eq(ids(plan.merged.transactions), "gone", "a record deleted here returns instead of being lost");
  eq(plan.summary.onlyOther, 1, "…and it's reported as adopted, not hidden");
}

// ---------------------------------------------------------------------------
// Controller-level: the merge must actually be PUBLISHABLE and must never write a
// stale plan. Both of these were real defects the pure-planner tests could not see.
// ---------------------------------------------------------------------------

import { createMemoryStorage } from "../src/lib/storage/memory-adapter";
import { SCHEMA } from "../src/features/portfolio/model/schema";
import { createPortfolioStore, pruneSeen } from "../src/features/portfolio/state/store";
import { SyncController } from "../src/features/portfolio/state/sync-controller";
import type { SnapshotDoc, Transaction } from "../src/features/portfolio/model/types";
import type { SnapshotMeta } from "../src/lib/sync/types";
import { readLastCheck, humanError, syncSituation, refundsCheckSlot, SYNC_TONE_COLOR } from "../src/features/portfolio/ui/sync-readings";
import { SignInRequiredError } from "../src/lib/google/drive-auth";

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-01-01", type: "expense", accountId: "A1", personId: "p1",
  amount: 100, currency: "INR", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});

/** A store with one account and the given transactions, plus a synced watermark. */
async function deviceWith(txns: Transaction[], lastSynced: number) {
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "Ravi" });
  await store.saveAccount({ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" });
  for (const t of txns) await store.saveTransaction(t);
  await store.saveSettings({ lastSyncedVersion: lastSynced });
  return store;
}

section("[merge/controller] the merged result is PUBLISHABLE — the push guard must stop refusing");
{
  // The push guard refuses while `remoteMax > lastSyncedVersion`. A merge that leaves the
  // watermark behind can NEVER be published: the merged data (which neither device has)
  // would be stranded here forever and autosave would stay wedged in "error".
  const store = await deviceWith([tx("local-1")], 5);
  const controller = new SyncController(store);
  const remoteVersion = 7;
  const remoteDoc: SnapshotDoc = {
    schemaVersion: SCHEMA.version,
    version: remoteVersion,
    data: {
      people: [{ id: "p1", name: "Ravi" }],
      accounts: [{ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" }],
      transactions: [tx("remote-1")],
    } as never,
  };
  const preview = await controller.previewMerge(remoteDoc);
  // No engine in this harness → the version can't be acknowledged from a listing, so feed
  // the value the real pull would supply (doc is the unique folder max).
  await controller.commitMerge({ ...preview, seenRemoteVersion: remoteVersion }, {});

  const after = store.getState();
  const ids = after.transactions.map((t) => t.id).sort().join(",");
  eq(ids, "local-1,remote-1", "both devices' transactions survive the merge");
  eq(after.settings.lastSyncedVersion, remoteVersion, "the reconciled remote version is recorded as SEEN");
  ok(after.version > remoteVersion, "…and the working version is strictly ahead, so there IS something to push");
  ok(after.dirty, "…and it's dirty, so Sync now will actually upload it");
  // The exact guard the sync engine applies before pushing.
  ok(
    !(remoteVersion > after.settings.lastSyncedVersion),
    "the data-loss guard (remoteMax > lastSynced) no longer refuses — the deadlock is broken",
  );
}

section("[merge/controller] an unacknowledgeable remote keeps the guard armed (no silent supersede)");
{
  // When another unmerged file shares the folder's max version, `seenRemoteVersion` is null:
  // claiming to have seen that version would silently supersede the sibling we did NOT merge.
  const store = await deviceWith([tx("local-1")], 5);
  const controller = new SyncController(store);
  const remoteDoc: SnapshotDoc = {
    schemaVersion: SCHEMA.version,
    version: 7,
    data: { transactions: [tx("remote-1")] } as never,
  };
  const preview = await controller.previewMerge(remoteDoc);
  eq(preview.seenRemoteVersion, null, "with no legible folder listing, nothing is acknowledged");
  await controller.commitMerge(preview, {});
  const after = store.getState();
  eq(after.settings.lastSyncedVersion, 5, "the watermark is NOT advanced");
  ok(after.dirty, "the merge is still held locally, dirty");
  ok(7 > after.settings.lastSyncedVersion, "…and the guard stays armed so the sibling must be merged too");
}

section("[merge/controller] a plan is never committed against changed local data");
{
  // The plan is reviewed in a modal for an unbounded time, and the write is a full replace.
  // If local data changed meanwhile, committing the stale plan would DELETE it.
  const store = await deviceWith([tx("local-1")], 5);
  const controller = new SyncController(store);
  const remoteDoc: SnapshotDoc = {
    schemaVersion: SCHEMA.version,
    version: 7,
    data: { transactions: [tx("remote-1")] } as never,
  };
  const preview = await controller.previewMerge(remoteDoc);
  // …the hourly FX refresh / autopay reconcile / a second tab writes a row here.
  await store.saveTransaction(tx("typed-during-review", { amount: 999 }));

  let threw = false;
  try {
    await controller.commitMerge(preview, {});
  } catch {
    threw = true;
  }
  ok(threw, "committing a stale plan is REFUSED rather than silently dropping the new row");
  ok(
    store.getState().transactions.some((t) => t.id === "typed-during-review"),
    "the row written during the review window survives",
  );
  // Re-previewing picks it up and then commits cleanly.
  const fresh = await controller.previewMerge(remoteDoc);
  await controller.commitMerge(fresh, {});
  const ids = store.getState().transactions.map((t) => t.id).sort().join(",");
  eq(ids, "local-1,remote-1,typed-during-review", "a fresh preview merges all three rows");
}

section("[merge] timestamps are compared as INSTANTS, not text");
{
  // A non-UTC offset sorts wrongly as a string: "2026-01-02T04:00:00+05:30" (= 22:30 UTC on
  // the 1st) is textually GREATER than "2026-01-01T23:00:00.000Z" but is actually older.
  const plan = planMerge(
    { transactions: [txn("a", { amount: 1, updatedAt: "2026-01-01T23:00:00.000Z" })] },
    { transactions: [txn("a", { amount: 2, updatedAt: "2026-01-02T04:00:00+05:30" })] },
  );
  eq(plan.conflicts[0]!.suggestion, "mine", "the genuinely newer local copy is suggested despite the text order");
  // Unparseable text counts as NO timestamp, never as a winner.
  const junk = planMerge(
    { transactions: [txn("a", { amount: 1, updatedAt: "not-a-date" })] },
    { transactions: [txn("a", { amount: 2, updatedAt: "2026-02-01T00:00:00.000Z" })] },
  );
  eq(junk.conflicts[0]!.suggestion, "mine", "a junk local timestamp does not hand the record to the remote");
  eq(junk.conflicts[0]!.suggestionFromTimestamps, false, "…and it isn't presented as a timestamp decision");
}

section("[merge] a difference of only who/when wrote the record is NOT a conflict");
{
  // Two devices independently materialise the same auto-pay transfer (deterministic id) with
  // their own updatedAt/author. Asking the user to choose there is a question with no answer,
  // and it manufactured dozens of identical-looking choices.
  const plan = planMerge(
    { transactions: [txn("autopay:card:2026-01", { updatedAt: "2026-01-01T00:00:00.000Z", author: "phone" })] },
    { transactions: [txn("autopay:card:2026-01", { updatedAt: "2026-01-02T00:00:00.000Z", author: "laptop" })] },
  );
  eq(plan.conflicts.length, 0, "bookkeeping-only differences are not conflicts");
  eq(plan.summary.identical, 1, "…they count as identical");
  eq(plan.summary.conflicts, 0, "…so nothing is asked of the user");
  // A real content difference alongside them IS still a conflict, and the bookkeeping fields
  // are not offered as things to choose between.
  const real = planMerge(
    { transactions: [txn("t", { amount: 100, updatedAt: "2026-01-01T00:00:00.000Z", author: "phone" })] },
    { transactions: [txn("t", { amount: 200, updatedAt: "2026-01-02T00:00:00.000Z", author: "laptop" })] },
  );
  eq(real.conflicts.length, 1, "a genuine content difference is still a conflict");
  eq(real.conflicts[0]!.changedFields.join(","), "amount", "only the real field is listed");
  eq(real.conflicts[0]!.differences.length, 1, "…and only it is offered as a choice");
  eq(real.conflicts[0]!.differences[0]!.mine, 100, "with THIS device's value");
  eq(real.conflicts[0]!.differences[0]!.theirs, 200, "…and the other device's, so the two options differ visibly");
}

section("[merge/controller] device-local collections survive a merge");
{
  // settings / fxRates / importBatches are device-local and stripped from snapshots. A merge
  // must not wipe them (the merged `data` comes from an already-stripped export).
  const store = await deviceWith([tx("local-1")], 5);
  await store.cacheFxRates({ base: "USD", rates: { USD: 1, INR: 83 } });
  await store.saveSettings({ displayCurrency: "INR" });
  const controller = new SyncController(store);
  const preview = await controller.previewMerge({
    schemaVersion: SCHEMA.version,
    version: 7,
    data: { transactions: [tx("remote-1")] } as never,
  });
  await controller.commitMerge({ ...preview, seenRemoteVersion: 7 }, {});
  const after = store.getState();
  eq(after.settings.displayCurrency, "INR", "device-local settings are preserved");
  ok(after.fxRates.length > 0, "cached FX rates are preserved");
}



// ---------------------------------------------------------------------------
// Display naming: a conflict is only decidable if BOTH options read as something the user
// recognises. These guard the two ways that broke.
// ---------------------------------------------------------------------------

import { describe, humanField, makeNameResolver, showValue } from "../src/features/portfolio/ui/merge-labels";

section("[store] exportWithFingerprint captures data and its version stamp atomically");
{
  // Taken separately, a write between the two is missing from the plan AND invisible to the
  // commit-time check — so committing the plan deletes it silently. This is the guard.
  const store = await deviceWith([tx("a")], 5);
  const first = await store.exportWithFingerprint();
  eq((first.doc.data.transactions ?? []).length, 1, "the snapshot holds the row");
  // A write now must change the fingerprint, so a plan built from `first` can no longer commit.
  await store.saveTransaction(tx("b"));
  const second = await store.exportWithFingerprint();
  ok(
    second.fingerprint.localVersion !== first.fingerprint.localVersion,
    "a write moves the persisted fingerprint",
  );
  let threw = false;
  try {
    await store.applyDocument(first.doc, { dirty: true, expect: first.fingerprint });
  } catch {
    threw = true;
  }
  ok(threw, "applying the stale snapshot is refused by compare-and-apply");
  ok(store.getState().transactions.some((t) => t.id === "b"), "…and the newer row survives");
}

section("[merge/controller] a superseded snapshot from the same device does not block publishing");
{
  // Snapshots are FULL documents: a device that pushed v4 then v5 has everything from v4 inside
  // v5. Counting the stale v4 as unmerged made the merge permanently unpublishable, with the
  // destructive replace as the only escape.
  const store = await deviceWith([tx("local-1")], 3);
  const controller = new SyncController(store);
  // Two files from ONE other device, plus our own older file.
  const files = [
    { id: "f1", name: "a", version: 4, author: "me", deviceId: "phone", savedAt: "2026-01-01T00:00:00Z", schemaVersion: SCHEMA.version },
    { id: "f2", name: "b", version: 5, author: "me", deviceId: "phone", savedAt: "2026-01-02T00:00:00Z", schemaVersion: SCHEMA.version },
  ];
  // Minimal engine stand-in: previewMerge only needs list() + getSessionFileId().
  (controller as unknown as { engine: unknown }).engine = {
    list: async () => files,
    getSessionFileId: () => null,
  };
  const remoteDoc: SnapshotDoc = {
    schemaVersion: SCHEMA.version,
    version: 5,
    data: { transactions: [tx("phone-1")] } as never,
  };
  const preview = await controller.previewMerge(remoteDoc, "f2");
  eq(preview.outstandingOthers, 0, "the device's older snapshot is subsumed by its newest, not outstanding");
  eq(preview.seenRemoteVersion, 5, "so the merged version IS acknowledged");
  eq(preview.ackBlocked, null, "…with no blocking reason");
  await controller.commitMerge(preview, {});
  const after = store.getState();
  eq(after.settings.lastSyncedVersion, 5, "the watermark advances, so the push guard stops refusing");
  ok(after.dirty, "…and the merge is still publishable");
  eq(after.transactions.map((t) => t.id).sort().join(","), "local-1,phone-1", "both devices' rows survive");
}

section("[merge/controller] a genuinely unmerged OTHER device keeps the guard armed, and says why");
{
  const store = await deviceWith([tx("local-1")], 3);
  const controller = new SyncController(store);
  const files = [
    { id: "f2", name: "b", version: 5, author: "me", deviceId: "phone", savedAt: "2026-01-02T00:00:00Z", schemaVersion: SCHEMA.version },
    { id: "f3", name: "c", version: 6, author: "me", deviceId: "tablet", savedAt: "2026-01-03T00:00:00Z", schemaVersion: SCHEMA.version },
  ];
  (controller as unknown as { engine: unknown }).engine = {
    list: async () => files,
    getSessionFileId: () => null,
  };
  const preview = await controller.previewMerge(
    { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("phone-1")] } as never },
    "f2",
  );
  eq(preview.outstandingOthers, 1, "the tablet's newer snapshot is still outstanding");
  eq(preview.seenRemoteVersion, null, "so nothing is acknowledged — its rows would be superseded");
  eq(preview.ackBlocked, "outstanding", "…and the reason is reported as 'outstanding', not a listing failure");
}

section("[merge/labels] the SHARED owner sentinel is named, not reported missing");
{
  const records = new Map<string, Keyed[]>([
    ["people", [{ id: "p1", name: "Ravi" } as unknown as Keyed]],
    ["accounts", [{ id: "A1", name: "IBKR", currency: "USD", personId: "shared" } as unknown as Keyed]],
  ]);
  const record = (c: string, id: string): Keyed | undefined => (records.get(c) ?? []).find((r) => r.id === id);
  const name = makeNameResolver(record);
  const ctx = { record, name };
  // "shared" is a VALUE, not a people row. Rendering "(no longer exists)" was false and pushed
  // the user to adopt the other side, silently re-owning a shared item.
  eq(name("people", "shared"), "Shared", "the shared sentinel resolves to 'Shared'");
  eq(showValue("personId", "shared", {} as Keyed, ctx), "Shared", "…and renders as 'Shared' in a conflict card");
  eq(showValue("personId", "p1", {} as Keyed, ctx), "Ravi", "a real person still resolves to their name");
  eq(showValue("personId", "gone", {} as Keyed, ctx), "(no longer exists)", "a genuinely missing person still says so");
}

section("[merge/labels] same-named accounts stay distinguishable (owner + currency)");
{
  const records = new Map<string, Keyed[]>([
    ["people", [
      { id: "p1", name: "Ravi" } as unknown as Keyed,
      { id: "p2", name: "Meera" } as unknown as Keyed,
    ]],
    ["accounts", [
      { id: "A1", name: "IBKR", currency: "USD", personId: "p1" } as unknown as Keyed,
      { id: "A2", name: "IBKR", currency: "USD", personId: "p2" } as unknown as Keyed,
    ]],
  ]);
  const record = (c: string, id: string): Keyed | undefined => (records.get(c) ?? []).find((r) => r.id === id);
  const ctx = { record, name: makeNameResolver(record) };
  const a = showValue("accountId", "A1", {} as Keyed, ctx);
  const b = showValue("accountId", "A2", {} as Keyed, ctx);
  ok(a !== b, `two same-named accounts render differently (${a} vs ${b})`);
  ok(a.includes("Ravi") && b.includes("Meera"), "…by naming the owner, as the app does everywhere else");
}

section("[merge/labels] a category shows its parent, and a transfer's received amount uses the DESTINATION currency");
{
  const records = new Map<string, Keyed[]>([
    ["categories", [
      { id: "food", name: "Food" } as unknown as Keyed,
      { id: "dining", name: "Dining", parentId: "food" } as unknown as Keyed,
    ]],
    ["accounts", [{ id: "usd", name: "Schwab", currency: "USD", personId: "p1" } as unknown as Keyed]],
  ]);
  const record = (c: string, id: string): Keyed | undefined => (records.get(c) ?? []).find((r) => r.id === id);
  const ctx = { record, name: makeNameResolver(record) };
  eq(showValue("categoryId", "dining", {} as Keyed, ctx), "Food › Dining", "a subcategory shows its parent path");
  // transferToAmount is in the DESTINATION account's currency — formatting it with the source's
  // states a false amount (₹600 for a US$600 credit).
  const transfer = { id: "t", currency: "INR", transferToAccountId: "usd" } as unknown as Keyed;
  const shown = showValue("transferToAmount", 600, transfer, ctx);
  ok(shown.includes("600") && !shown.includes("₹"), `received amount uses the destination currency (${shown})`);
}

section("[merge/labels] nested settings render as words, with one-sided keys still shown");
{
  const record = (): Keyed | undefined => undefined;
  const ctx = { record, name: makeNameResolver(record) };
  const mine = { ratePct: 7.1, compounding: "quarterly", maturityDate: "2027-03-31" };
  const theirs = { ratePct: 7.5, compounding: "quarterly" };
  const shownMine = showValue("fd", mine, {} as Keyed, ctx, theirs);
  ok(!shownMine.includes("{"), "no raw JSON reaches the user");
  ok(shownMine.includes("rate pct 7.1"), "values render as words");
  // A sub-field only one side has must not silently vanish from the comparison.
  const shownTheirs = showValue("autopay", { statementDay: 10 }, {} as Keyed, ctx, { statementDay: 10, dueNextMonth: true });
  ok(shownTheirs.includes("due next month no"), `a one-sided boolean shows as "no" rather than disappearing (${shownTheirs})`);
}

// ---------------------------------------------------------------------------
// Round-4 findings. Each of these was a CONFIRMED defect, so each keeps a test.
// ---------------------------------------------------------------------------

section("[store] a SECOND TAB's write is detected — the version is monotonic per DATABASE");
{
  // The blocker: `commit` derived the next version from its OWN in-memory state, so a tab K
  // versions behind wrote values that walked back up to the number a merge had recorded, and
  // the K-th write REPRODUCED it. The compare-and-apply then passed and the merge's
  // full-replace write deleted that tab's rows silently. Nothing in the app propagates writes
  // between tabs, so the database is the only shared truth.
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  await tab1.savePerson({ id: "p1", name: "Ravi" });
  await tab1.saveAccount({ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" });
  await tab1.saveTransaction(tx("local-1"));
  const tab2 = await createPortfolioStore(adapter); // second tab: same DB, its own state
  for (let i = 0; i < 4; i++) await tab1.saveTransaction(tx(`t1-${i}`)); // tab2 is now 4 behind

  const captured = await tab1.exportWithFingerprint();
  // Every subsequent tab2 write must move the PERSISTED fingerprint — not one of them may
  // reproduce the captured pair.
  for (let i = 0; i < 6; i++) {
    await tab2.saveTransaction(tx(`t2-${i}`));
    const live = await tab1.versionFingerprint();
    ok(
      live.localVersion !== captured.fingerprint.localVersion ||
        live.lastSyncedVersion !== captured.fingerprint.lastSyncedVersion,
      `after the second tab's write #${i + 1} the fingerprint still differs from the captured one`,
    );
  }
  let refused = false;
  try {
    await tab1.applyDocument(captured.doc, { dirty: true, expect: captured.fingerprint });
  } catch {
    refused = true;
  }
  ok(refused, "committing the plan captured before those writes is refused");
  const survived = await adapter.exportAll();
  const rows = (survived.transactions ?? []).map((r) => r.id);
  for (let i = 0; i < 6; i++) ok(rows.includes(`t2-${i}`), `the second tab's row t2-${i} survives`);
}

section("[merge] unincorporatedFiles: which snapshots may still hold data we've never read");
{
  const f = (id: string, version: number, deviceId: string) => ({ id, name: id, version, deviceId, author: "me", savedAt: "2026-01-01T00:00:00Z", schemaVersion: SCHEMA.version });
  const none = new Set<string>();
  const own = { deviceId: "mine", version: 99 }; // this database is well past every file below

  // At the watermark is NOT a free pass — a concurrent push from another device sits at exactly
  // that number (see the collision section below). Only our own file, or a recorded key, clears it.
  eq(unincorporatedFiles([f("a", 4, "d1")], 4, none, own).length, 1, "another device's file AT the watermark is still a hazard");
  eq(unincorporatedFiles([f("a", 4, "mine")], 4, none, own).length, 0, "…but our own file there is not");
  eq(unincorporatedFiles([f("a", 3, "d1")], 4, none, own).length, 0, "a strictly older file is superseded");
  eq(unincorporatedFiles([f("a", 5, "d1")], 4, none).length, 1, "one above it is not incorporated");
  // Full documents: a device's newer snapshot contains everything its older one did.
  eq(
    unincorporatedFiles([f("a", 4, "d1"), f("b", 5, "d1")], 3, new Set([snapshotKey({ id: "b", version: 5 })])).length,
    0,
    "merging a device's newest subsumes its own superseded file",
  );
  // …but NOT another device's file at a lower version.
  const twoDevices = unincorporatedFiles(
    [f("a", 4, "d1"), f("b", 5, "d2")], 3, new Set([snapshotKey({ id: "b", version: 5 })]),
  );
  eq(twoDevices.map((x) => x.id).join(","), "a", "another device's older file is NOT subsumed — versions are only per-device monotonic");
  // A tie inside one device must not let a seen file swallow an unseen sibling.
  const tie = unincorporatedFiles(
    [f("a", 5, "d1"), f("b", 5, "d1")], 3, new Set([snapshotKey({ id: "b", version: 5 })]),
  );
  eq(tie.map((x) => x.id).join(","), "a", "at equal versions the unseen file stays outstanding");
  // Keyed by FILE, so a sibling's same-numbered version is never mistaken for the one we read.
  eq(
    unincorporatedFiles([f("a", 5, "d1")], 3, new Set([snapshotKey({ id: "other", version: 5 })])).length,
    1,
    "'seen v5' from a different file does not cover this v5",
  );
}

section("[store] pruneSeen keeps the seen-log small and truthful");
{
  eq(pruneSeen(["f1@3", "f2@5"], 4).join(","), "f2@5", "entries strictly below the watermark are subsumed and dropped");
  eq(pruneSeen(["f1@4"], 3, "f2@5").join(","), "f1@4,f2@5", "the newly merged file is added");
  eq(pruneSeen(undefined, 0, "f1@1").join(","), "f1@1", "works from empty");
  eq(pruneSeen(["f1@2", "f1@2"], 1, "f1@2").join(","), "f1@2", "no duplicates");
  const many = Array.from({ length: 300 }, (_, i) => `f${i}@${i + 10}`);
  eq(pruneSeen(many, 0).length, 200, "capped, so a long-lived device can't grow it without bound");
  // The cap alone re-created the old deadlock (past it, the oldest acknowledgement was dropped and
  // the guard could never clear), so the real bound is the FOLDER's contents.
  eq(
    pruneSeen(["gone@5", "here@6"], 0, undefined, new Set(["here@6"])).join(","),
    "here@6",
    "keys for files the folder no longer holds are dropped",
  );
  eq(
    pruneSeen(["here@6"], 0, "fresh@7", new Set(["here@6"])).join(","),
    "here@6,fresh@7",
    "…while a key recorded right now survives a stale listing",
  );
  eq(pruneSeen(undefined, 0, ["a@1", "b@2"]).join(","), "a@1,b@2", "several keys can be recorded at once (a baseline)");
}

section("[merge/controller] THREE devices converge: successive merges add up to publishable");
{
  // The HIGH: with A@4 and B@5 both above our watermark, merging the folder max could never
  // move a scalar watermark past A@4 — the merge was unpublishable FOREVER and the only exit
  // was the destructive replace. Snapshot versions are monotonic per device, not globally.
  const store = await deviceWith([tx("local-1")], 3);
  const controller = new SyncController(store);
  const meta = (id: string, version: number, deviceId: string) => ({ id, name: id, version, deviceId, author: "me", savedAt: `2026-01-0${version}T00:00:00Z`, schemaVersion: SCHEMA.version });
  const files = [meta("fileA", 4, "phone"), meta("fileB", 5, "tablet")];
  const docs: Record<string, SnapshotDoc> = {
    fileA: { schemaVersion: SCHEMA.version, version: 4, data: { transactions: [tx("phone-1")] } as never },
    fileB: { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("tablet-1")] } as never },
  };
  // commitMerge calls refreshPhase(), which rebuilds the engine from settings (none here) —
  // so the stub is re-attached before each use rather than assigned once.
  const attach = (): void => {
    (controller as unknown as { engine: unknown }).engine = {
      list: async () => files,
      getSessionFileId: () => null,
      loadFile: async (m: { id: string }) => ({ doc: docs[m.id], meta: files.find((f) => f.id === m.id) }),
    };
  };
  attach();

  // Round 1 — the pull picks the newest file that still needs reconciling.
  let check = await controller.checkRemote();
  eq(check?.fileId, "fileB", "the first pull targets the newest unreconciled snapshot");
  let preview = await controller.previewMerge(check!.doc, check!.fileId);
  eq(preview.outstandingOthers, 1, "the other device's file is still outstanding");
  eq(preview.ackBlocked, "outstanding", "…and that is the reported reason");
  let res = await controller.commitMerge(preview, {});
  eq(res.publishable, false, "so the UI must not promise 'tap Sync now' yet");
  eq(store.getState().settings.seenSnapshots?.join(","), "fileB@5", "but the merged file IS recorded");

  // Round 2 — now the pull can REACH the older file (this is what deadlocked before).
  attach();
  check = await controller.checkRemote();
  eq(check?.fileId, "fileA", "the second pull targets the file below the folder max");
  preview = await controller.previewMerge(check!.doc, check!.fileId);
  eq(preview.outstandingOthers, 0, "nothing is left unincorporated");
  eq(preview.ackBlocked, null, "…so there is no blocking reason");
  res = await controller.commitMerge(preview, {});
  eq(res.publishable, true, "the merge is publishable");
  const st = store.getState();
  eq(st.transactions.map((t) => t.id).sort().join(","), "local-1,phone-1,tablet-1", "all three devices' rows survive");
  ok(st.dirty, "and the combined document is dirty, so Sync now sends it");
  eq(st.settings.lastSyncedVersion, 5, "the watermark advanced to the folder max");
  eq(st.settings.seenSnapshots?.join(","), "fileB@5", "…which prunes the seen-log down to the key at that version");
  // The push guard itself must now agree.
  eq(
    unincorporatedFiles(files, st.settings.lastSyncedVersion, new Set(st.settings.seenSnapshots ?? []), {
      deviceId: st.settings.deviceId,
      version: st.version,
    }).length,
    0,
    "the push guard finds nothing unincorporated — it will no longer refuse",
  );
}

section("[merge/controller] a version COLLISION acknowledges only the file actually merged");
{
  // loadLatest picks by version then savedAt and does NOT skip our own file, so a device is
  // sometimes handed ITS OWN snapshot. Recording a VERSION would have covered a sibling's
  // unmerged rows at that same number; recording the FILE cannot.
  const store = await deviceWith([tx("local-1")], 3);
  const controller = new SyncController(store);
  const meta = (id: string, version: number, deviceId: string) => ({ id, name: id, version, deviceId, author: "me", savedAt: "2026-01-04T00:00:00Z", schemaVersion: SCHEMA.version });
  const files = [meta("mine", 4, "this-device"), meta("sibling", 4, "other-device")];
  (controller as unknown as { engine: unknown }).engine = {
    list: async () => files,
    getSessionFileId: () => "mine",
    loadFile: async () => ({ doc: { schemaVersion: SCHEMA.version, version: 4, data: {} as never }, meta: files[0] }),
  };
  const preview = await controller.previewMerge(
    { schemaVersion: SCHEMA.version, version: 4, data: { transactions: [tx("local-1")] } as never },
    "mine",
  );
  eq(preview.outstandingOthers, 1, "the sibling at the SAME version is still outstanding");
  eq(preview.ackBlocked, "outstanding", "so the guard stays armed");
  const res = await controller.commitMerge(preview, {});
  eq(res.publishable, false, "…and the UI says so");
  eq(store.getState().settings.lastSyncedVersion, 3, "the watermark did NOT jump over the sibling");
}

section("[merge/labels] money in a conflict card is EXACT, not display-rounded");
{
  const records = new Map<string, Keyed[]>([
    ["accounts", [{ id: "A2", name: "Wise", currency: "USD", personId: "p1" } as unknown as Keyed]],
  ]);
  const record = (c: string, id: string): Keyed | undefined => (records.get(c) ?? []).find((r) => r.id === id);
  const ctx = { record, name: makeNameResolver(record) };
  const rec = { id: "t1", currency: "USD", transferToAccountId: "A2" } as unknown as Keyed;
  // formatMoney drops the cents above 1000, so two different amounts rendered identically —
  // the card said "differs in the amount" over two identical values.
  const mine = showValue("amount", 1240.2, rec, ctx);
  const theirs = showValue("amount", 1240.4, rec, ctx);
  ok(mine !== theirs, `cents above 1000 stay distinguishable (${mine} vs ${theirs})`);
  ok(mine.includes("1,240.20"), `and the exact figure is shown (${mine})`);
  eq(showValue("amount", 1240, rec, ctx).includes("."), false, "a whole amount gains no noise digits");
  const t1 = showValue("transferToAmount", 100000.25, rec, ctx);
  const t2 = showValue("transferToAmount", 100000.75, rec, ctx);
  ok(t1 !== t2, `a received amount keeps its cents too (${t1} vs ${t2})`);
}

section("[merge/labels] the conflict's own identity line separates same-named records");
{
  const records = new Map<string, Keyed[]>([
    ["people", [
      { id: "p1", name: "Ravi" } as unknown as Keyed,
      { id: "p2", name: "Meera" } as unknown as Keyed,
    ]],
    ["categories", [
      { id: "food", name: "Food" } as unknown as Keyed,
      { id: "travel", name: "Travel" } as unknown as Keyed,
    ]],
  ]);
  const record = (c: string, id: string): Keyed | undefined => (records.get(c) ?? []).find((r) => r.id === id);
  const name = makeNameResolver(record);
  // Two accounts the app itself lets you name identically — the row HEADING must differ, not
  // only the values under it.
  const ctx = { record, name };
  const a1 = describe("accounts", { id: "A1", name: "IBKR", currency: "USD", personId: "p1" } as unknown as Keyed, ctx);
  const a2 = describe("accounts", { id: "A2", name: "IBKR", currency: "USD", personId: "p2" } as unknown as Keyed, ctx);
  ok(a1 !== a2, `two same-named accounts describe differently (${a1} vs ${a2})`);
  ok(a1.includes("Ravi") && a2.includes("Meera"), "…by naming the owner");
  eq(
    describe("accounts", { id: "A3", name: "Joint", currency: "INR", personId: "shared" } as unknown as Keyed, ctx).includes("Shared"),
    true,
    "the shared sentinel is named here too, never '(no longer exists)'",
  );
  // Two "Misc" categories under different parents.
  const c1 = describe("categories", { id: "m1", name: "Misc", parentId: "food" } as unknown as Keyed, ctx);
  const c2 = describe("categories", { id: "m2", name: "Misc", parentId: "travel" } as unknown as Keyed, ctx);
  eq(c1, "Food › Misc", "a subcategory shows its parent path");
  ok(c1 !== c2, `so two same-named subcategories are distinguishable (${c1} vs ${c2})`);
  // Two identically-named deposits owned by different people.
  const h1 = describe("holdings", { id: "h1", name: "HDFC Fixed Deposit", personId: "p1" } as unknown as Keyed, ctx);
  const h2 = describe("holdings", { id: "h2", name: "HDFC Fixed Deposit", personId: "p2" } as unknown as Keyed, ctx);
  ok(h1 !== h2, `two same-named investments describe differently (${h1} vs ${h2})`);
}

section("[merge/labels] a one-sided NESTED field is visible whatever its type");
{
  const record = (): Keyed | undefined => undefined;
  const ctx = { record, name: makeNameResolver(record) };
  // Clearing an FD's maturity date changes how it accrues. Filtering absent keys out reduced
  // that to a phrase quietly missing from one card.
  const mine = showValue("fd", { compounding: "quarterly", maturityDate: "2027-03-31" }, {} as Keyed, ctx, { compounding: "monthly" });
  const theirs = showValue("fd", { compounding: "monthly" }, {} as Keyed, ctx, { compounding: "quarterly", maturityDate: "2027-03-31" });
  ok(mine.includes("2027-03-31"), `the side that has the date shows it (${mine})`);
  ok(theirs.includes("maturity date"), `the side that lacks it still names the field (${theirs})`);
  ok(theirs.includes("none"), `…and marks it absent rather than omitting it (${theirs})`);
}

section("[merge/labels] machine values are humanised: timestamps and field names");
{
  const record = (): Keyed | undefined => undefined;
  const ctx = { record, name: makeNameResolver(record) };
  const shown = showValue("updatedAt", "2026-07-17T08:00:00.000Z", {} as Keyed, ctx);
  ok(!shown.includes("T08:00:00"), `a timestamp is not shown as raw ISO (${shown})`);
  ok(/2026/.test(shown), `…but still names the moment (${shown})`);
  // Field labels must be NOUN phrases: a verb phrase turned "differs in the amount and counts
  // in reports but not balances" into a false claim about the record, then read as its own
  // negation next to a "no".
  for (const f of ["excludeFromBalance", "excludeFromReports", "archived", "dueNextMonth"]) {
    const l = humanField(f);
    ok(!/^(counts|hidden)\b/.test(l), `"${f}" reads as a noun phrase, not a verb phrase (${l})`);
  }
}

// ---------------------------------------------------------------------------
// Round-5 findings.
// ---------------------------------------------------------------------------

section("[store] an ordinary settings write cannot roll back another tab's bookkeeping");
{
  // The blocker, second door: every settings writer persisted the whole row spread from its own
  // in-memory copy, so tab1's hourly FX refresh (unattended!) rewrote localVersion /
  // lastSyncedVersion / seenSnapshots from a stale snapshot — restoring the fingerprint a merge
  // had captured, so the compare-and-apply passed and deleted tab2's rows.
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  await tab1.savePerson({ id: "p1", name: "Ravi" });
  await tab1.saveAccount({ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" });
  await tab1.saveTransaction(tx("local-1"));
  const tab2 = await createPortfolioStore(adapter);

  const captured = await tab1.exportWithFingerprint();
  await tab2.saveTransaction(tx("tab2-1")); // the edit that must survive
  const moved = await tab1.versionFingerprint();

  // Each of tab1's stale-memory writers, in turn.
  await tab1.cacheFxRates({ base: "USD", rates: { USD: 1, INR: 83 } });
  await tab1.saveSettings({ displayCurrency: "INR" });
  await tab1.setFxOverride("INR", 84);
  await tab1.markSynced(2);
  const after = await tab1.versionFingerprint();
  ok(
    after.localVersion >= moved.localVersion,
    `settings writes never regress the version (was ${moved.localVersion}, now ${after.localVersion})`,
  );
  eq(
    after.dataSeq,
    moved.dataSeq,
    "…and NONE of them touches the data counter — a merge preserves device-local collections, so " +
      "counting them made an unattended hourly FX refresh throw away an open merge review",
  );
  let refused = false;
  try {
    await tab1.applyDocument(captured.doc, { dirty: true, expect: captured.fingerprint });
  } catch {
    refused = true;
  }
  ok(refused, "so the merge plan captured before tab2's edit is still refused");
  ok(
    (await adapter.exportAll()).transactions?.some((t) => t.id === "tab2-1"),
    "and tab2's row survives",
  );
}

section("[store] a settings write preserves what another tab recorded");
{
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  const tab2 = await createPortfolioStore(adapter);
  // tab2 acknowledges a merged snapshot…
  await tab2.applyDocument(
    { schemaVersion: SCHEMA.version, version: 9, data: {} as never },
    { dirty: true, seenRemoteVersion: 9, seenSnapshotKey: "fileX@9" },
  );
  // …and tab1, which has never heard of it, changes an unrelated setting.
  await tab1.saveSettings({ displayCurrency: "USD" });
  const row = await tab1.versionFingerprint();
  eq(row.lastSyncedVersion, 9, "the watermark another tab set is not rolled back");
  const stored = (await adapter.exportAll()).settings?.[0] as unknown as { seenSnapshots?: string[] };
  eq(stored.seenSnapshots?.join(","), "fileX@9", "…nor the seen-log it recorded");
}

section("[store] a committed merge always moves the fingerprint, so an older plan can't apply");
{
  // Merging a file numbered BELOW our own localVersion left (localVersion, lastSyncedVersion)
  // untouched — the guard's normal state, since the user keeps editing while it refuses. A plan
  // captured before that merge then still validated and deleted everything it had adopted.
  const store = await deviceWith([tx("local-1")], 3);
  for (let i = 0; i < 15; i++) await store.saveTransaction(tx(`edit-${i}`)); // localVersion ≫ 5
  const captured = await store.exportWithFingerprint();
  ok(captured.fingerprint.localVersion > 5, "our version is far above the remote file's");
  // A merge of the low-numbered remote file, adopting one row.
  await store.applyDocument(
    { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("adopted")] } as never },
    { dirty: true, seenSnapshotKey: "fileB@5" },
  );
  const live = await store.versionFingerprint();
  ok(
    live.localVersion !== captured.fingerprint.localVersion || live.writeSeq !== captured.fingerprint.writeSeq,
    "the merge moved the persisted fingerprint",
  );
  let refused = false;
  try {
    await store.applyDocument(captured.doc, { dirty: true, expect: captured.fingerprint });
  } catch {
    refused = true;
  }
  ok(refused, "so the earlier plan is refused");
  ok(store.getState().transactions.some((t) => t.id === "adopted"), "and the merged-in record survives");
}

section("[merge] a colliding file AT the watermark is not mistaken for the one we read");
{
  const f = (id: string, version: number, deviceId: string) => ({ id, name: id, version, deviceId, author: "me", savedAt: "2026-01-01T00:00:00Z", schemaVersion: SCHEMA.version });
  const seen = new Set([snapshotKey({ id: "read-it", version: 5 })]);
  // Two devices concurrently minted v5; we pulled ONE of them.
  const files = [f("read-it", 5, "phone"), f("sibling", 5, "tablet")];
  const hazards = unincorporatedFiles(files, 5, seen, { deviceId: "mine", version: 99 });
  eq(hazards.map((x) => x.id).join(","), "sibling", "the file we never read is still a hazard");
  // Our OWN file at the watermark must NOT be flagged (that would refuse every push).
  eq(
    unincorporatedFiles([f("ours", 5, "mine")], 5, new Set(), { deviceId: "mine", version: 5 }).length,
    0,
    "our own file at the watermark is fine",
  );
  // …but our id on a file BEYOND our own version is a cloned profile, not us.
  eq(
    unincorporatedFiles([f("twin", 9, "mine")], 5, new Set(), { deviceId: "mine", version: 5 }).length,
    1,
    "a diverged twin sharing our deviceId is still a hazard",
  );
  // And a file we pulled is cleared by its key, not by the number.
  eq(unincorporatedFiles([f("read-it", 5, "phone")], 5, seen, { deviceId: "mine", version: 99 }).length, 0, "the file we did read is cleared");
  eq(unincorporatedFiles([f("older", 4, "phone")], 5, new Set(), { deviceId: "mine", version: 99 }).length, 0, "a strictly older file stays superseded");
}

section("[store] pruneSeen keeps entries AT the watermark (they're the colliding ones)");
{
  eq(pruneSeen(["f1@4", "f2@5"], 5).join(","), "f2@5", "below the watermark is dropped, at it is kept");
  eq(pruneSeen([], 5, "f2@5").join(","), "f2@5", "a key recorded by a pull that sets the watermark survives");
}

section("[merge/labels] an investment transaction's money is in its HOLDING's currency");
{
  const records = new Map<string, Keyed[]>([
    ["holdings", [{ id: "h1", name: "HDFC Fixed Deposit", currency: "INR", personId: "p1" } as unknown as Keyed]],
  ]);
  const record = (c: string, id: string): Keyed | undefined => (records.get(c) ?? []).find((r) => r.id === id);
  const ctx = { record, name: makeNameResolver(record) };
  // A HoldingEvent has no `currency` of its own — defaulting to USD overstated an INR deposit
  // ~87× on both option cards of a conflict AND on every pull's diff.
  const ev = { id: "e1", holdingId: "h1", date: "2026-06-30", type: "valuation", amount: 505000.5 } as unknown as Keyed;
  const shown = showValue("amount", 505000.5, ev, ctx);
  ok(!shown.includes("US$") && !shown.includes("$5"), `not dollars (${shown})`);
  ok(shown.includes("₹"), `the holding's currency is used (${shown})`);
  // The identity line above the card must agree with it, not print a bare number.
  const line = describe("holdingEvents", ev, ctx);
  ok(line.includes("₹"), `the header formats the same way (${line})`);
  ok(!line.includes("505000.5"), `…and not as a raw number (${line})`);
  // With nothing to resolve, claim no currency at all rather than a false one.
  const orphan = { id: "e2", holdingId: "gone", amount: 1234.5 } as unknown as Keyed;
  const bare = showValue("amount", 1234.5, orphan, ctx);
  ok(!bare.includes("$") && !bare.includes("₹"), `an unresolvable currency is shown plainly (${bare})`);
  ok(bare.includes("1,234.5"), `…but still readable (${bare})`);
}

section("[store] an unrelated settings change can't erase another tab's Drive config");
{
  // `drive` was rebuilt from this tab's stale memory on EVERY saveSettings, so a second tab's
  // folder pick was silently reverted — or the whole config erased, leaving the device quietly
  // local-only ("no-folder") after the next reload, with no records lost but no syncing either.
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  const tab2 = await createPortfolioStore(adapter);
  await tab2.saveSettings({ drive: { clientId: "cid", apiKey: "akey", folderId: "F1", folderName: "Family" } });
  await tab1.saveSettings({ displayCurrency: "INR" }); // knows nothing about the folder
  const stored = (await adapter.exportAll()).settings?.[0] as unknown as {
    drive?: { folderId?: string; apiKey?: string };
    displayCurrency?: string;
  };
  eq(stored.drive?.folderId, "F1", "the folder another tab picked survives");
  eq(stored.drive?.apiKey, "akey", "…with its sibling fields");
  eq(stored.displayCurrency, "INR", "and this tab's actual change is applied");
  // A partial drive patch still deep-merges — onto the STORED value.
  await tab1.saveSettings({ drive: { folderName: "Home" } });
  const after = (await adapter.exportAll()).settings?.[0] as unknown as { drive?: Record<string, string> };
  eq(after.drive?.folderId, "F1", "a partial drive patch keeps the stored siblings");
  eq(after.drive?.folderName, "Home", "…and applies the new value");
  // Clearing is still explicit.
  await tab1.saveSettings({ drive: undefined });
  eq(((await adapter.exportAll()).settings?.[0] as unknown as { drive?: unknown }).drive, undefined, "passing drive: undefined still clears it");
}

section("[store] a new baseline records the files it supersedes, so it can be published");
{
  // `bumpVersionAbove` set only the watermark. Once a file AT the watermark counts as a hazard,
  // that left a migrated device unable to publish its baseline whenever the folder's newest file
  // belonged to another device — and Pull latest can't decode a v1 file, so there was no way out.
  const store = await deviceWith([tx("local-1")], 3);
  await store.bumpVersionAbove(5, ["fileA@5"]);
  const st = store.getState().settings;
  eq(st.lastSyncedVersion, 5, "the baseline supersedes everything up to the floor");
  ok((st.seenSnapshots ?? []).includes("fileA@5"), "…and records the file sitting AT it");
  ok(store.getState().version > 5, "the baseline's own version is above the folder");
  const foreign = [{ id: "fileA", name: "a", version: 5, deviceId: "phone", author: "me", savedAt: "2026-01-01T00:00:00Z", schemaVersion: SCHEMA.version }];
  eq(
    unincorporatedFiles(foreign, st.lastSyncedVersion, new Set(st.seenSnapshots ?? []), {
      deviceId: st.deviceId,
      version: store.getState().version,
    }).length,
    0,
    "so the push guard lets the baseline out",
  );
}

section("[merge] the plan reports HOW each default was chosen, so the UI can't over-claim");
{
  // Only `Transaction` carries updatedAt. For every other collection the suggestion is the
  // fallback "mine" — the merge dialog must not announce "the more recently edited copy is
  // selected" over records whose edit times were never compared (there are none to compare).
  const older = "2026-01-01T00:00:00.000Z";
  const newer = "2026-02-01T00:00:00.000Z";
  const plan = planMerge(
    {
      transactions: [txn("t-recency", { amount: 1, updatedAt: older }), txn("t-tie", { amount: 1, updatedAt: older })],
      categories: [named("c1", "Food")],
      people: [named("p1", "Ravi", { color: "#111" })],
    },
    {
      transactions: [txn("t-recency", { amount: 2, updatedAt: newer }), txn("t-tie", { amount: 2, updatedAt: older })],
      categories: [named("c1", "Groceries")],
      people: [named("p1", "Ravi", { color: "#222" })],
    },
  );
  eq(plan.conflicts.length, 4, "four conflicts: two timestamped, two untimestamped");
  const byRecency = plan.conflicts.filter((c) => c.suggestionFromTimestamps);
  eq(byRecency.length, 1, "exactly ONE was decided by recency");
  eq(byRecency[0]!.id, "t-recency", "…the transaction with differing timestamps");
  for (const c of plan.conflicts.filter((x) => !x.suggestionFromTimestamps)) {
    eq(c.suggestion, "mine", `${c.collection}/${c.id} falls back to this device's copy`);
  }
  const tie = plan.conflicts.find((c) => c.id === "t-tie")!;
  ok(tie.timestampsEqual, "an equal-timestamp conflict is flagged as a tie, not as a recency pick");
  ok(!tie.suggestionFromTimestamps, "…and is NOT counted as decided by recency");
}

section("[store] the seen-log keeps ONE key per file — the highest version");
{
  // A peer's session file is updated IN PLACE, so a long-lived peer tab mints unboundedly many
  // keys for a single file. Keeping them filled the cap and evicted the key that mattered,
  // making a file we HAD merged look unread again and re-arming the push guard.
  const churn = Array.from({ length: 251 }, (_, i) => `peerQ@${i + 200}`);
  const kept = pruneSeen([...churn, "fileP@100"], 100);
  eq(kept.length, 2, "251 versions of one file collapse to one key, alongside the other file");
  ok(kept.includes("fileP@100"), "the load-bearing key is NOT evicted");
  ok(kept.includes("peerQ@450"), "…and the peer file is recorded at its highest version");
  ok(!kept.includes("peerQ@200"), "…with its superseded versions dropped");
  // Collapsing must never lose a DISTINCT file.
  const many = pruneSeen(Array.from({ length: 300 }, (_, i) => `f${i}@${i + 10}`), 0);
  eq(many.length, 200, "distinct files are still capped as a backstop");
}

section("[merge] ties are distinguishable from untimestamped conflicts (the UI words them apart)");
{
  // A tie DID carry edit times — it just doesn't establish a newer copy. Telling the user it has
  // "no edit time", or warning that the other side "may be newer", both contradict the row's own
  // note ("edited at the same moment — neither is newer").
  const stamp = "2026-03-01T00:00:00.000Z";
  const plan = planMerge(
    { transactions: [txn("tie", { amount: 1, updatedAt: stamp })], categories: [named("c1", "Food")] },
    { transactions: [txn("tie", { amount: 2, updatedAt: stamp })], categories: [named("c1", "Groceries")] },
  );
  const tie = plan.conflicts.find((c) => c.id === "tie")!;
  const untimed = plan.conflicts.find((c) => c.collection === "categories")!;
  ok(tie.timestampsEqual, "the tie is flagged as a tie");
  ok(!tie.suggestionFromTimestamps, "…and not as decided by recency");
  ok(!untimed.timestampsEqual, "an untimestamped conflict is NOT a tie");
  ok(!untimed.suggestionFromTimestamps, "…and also not decided by recency");
  eq(tie.suggestion, "mine", "both fall back to this device's copy");
  eq(untimed.suggestion, "mine", "both fall back to this device's copy");
  // The three buckets the summary counts must partition the conflicts exactly, and each must be
  // separately countable — the UI gives each its own clause, because a tie has an edit time (so
  // it can't be told it has none) and has no newer copy (so it must not carry that warning).
  const byRecency = plan.conflicts.filter((c) => c.suggestionFromTimestamps).length;
  const ties = plan.conflicts.filter((c) => c.timestampsEqual).length;
  const rest = plan.conflicts.length - byRecency - ties;
  eq(byRecency + ties + rest, plan.conflicts.length, "recency + ties + untimed accounts for every conflict");
  eq(ties, 1, "one tie");
  eq(rest, 1, "one untimestamped");
  ok(byRecency === 0, "…and neither of those is counted as decided by recency");
  // A tie is never BOTH — the buckets must not overlap, or a count would double-report.
  for (const c of plan.conflicts) {
    ok(!(c.suggestionFromTimestamps && c.timestampsEqual), `${c.id} is in exactly one bucket`);
  }
}

section("[merge] a new baseline may only claim files it wrote or has already read");
{
  // A baseline declares every version up to its floor superseded. Claiming the folder's LATEST
  // file unconditionally was silent data loss: when the adopt step was skipped — we weren't
  // behind (a peer's concurrent push landing after our TOCTOU re-list), or the file was in a
  // format we can't decode — the baseline published straight over rows never read, and the claim
  // defeated the hazard rule meant to catch exactly that.
  const seen = new Set(["read-it@5"]);
  const ctx = { own: { deviceId: "mine", version: 9 }, seen };
  eq(baselineClaim({ id: "f1", version: 5, deviceId: "mine" }, ctx), "own", "our own file needs no read");
  eq(baselineClaim({ id: "read-it", version: 5, deviceId: "phone" }, ctx), "seen", "a file we already read is claimable");
  eq(baselineClaim({ id: "unread", version: 5, deviceId: "phone" }, ctx), "must-read", "a peer's unread file must be read first");
  // Keyed by file AND version: the same id at a different version is a different snapshot.
  eq(baselineClaim({ id: "read-it", version: 6, deviceId: "phone" }, ctx), "must-read", "a newer version of a read file must be read again");
  eq(
    baselineClaim({ id: "twin", version: 99, deviceId: "mine" }, ctx),
    "must-read",
    "our own id beyond our own version is a cloned profile — read it like a stranger's",
  );
}

section("[store] an unattended FX refresh does NOT discard an open merge review");
{
  // The hourly refreshFxIfStale tick (PortfolioProvider) writes fxRates + a settings touch. Those
  // collections are PRESERVED by a merge, so nothing of theirs can be lost — but while the
  // fingerprint counted every write, a tick during the review rejected the whole merge with
  // "Your data changed while you were reviewing", blaming the user's own data.
  const store = await deviceWith([tx("local-1")], 0);
  const captured = await store.exportWithFingerprint();
  await store.cacheFxRates({ base: "USD", rates: { USD: 1, INR: 83 } });
  await store.saveSettings({ displayCurrency: "INR" });
  await store.setFxOverride("INR", 84);
  const live = await store.versionFingerprint();
  eq(live.dataSeq, captured.fingerprint.dataSeq, "device-local writes leave the data counter alone");
  await store.applyDocument(
    { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("remote-1")] } as never },
    { dirty: true, expect: captured.fingerprint },
  );
  const after = store.getState();
  ok(after.transactions.some((t) => t.id === "remote-1"), "so the merge commits");
  eq(after.settings.displayCurrency, "INR", "…and the settings change made during the review survives");
  eq(after.fxRates.length, 1, "…as does the cached rate snapshot");
  // A real DATA write still invalidates the plan.
  const second = await store.exportWithFingerprint();
  await store.saveTransaction(tx("raced"));
  let refused = false;
  try {
    await store.applyDocument(second.doc, { dirty: true, expect: second.fingerprint });
  } catch {
    refused = true;
  }
  ok(refused, "a write to SYNCED data still refuses the stale plan");
  ok(store.getState().transactions.some((t) => t.id === "raced"), "…and the raced row survives");
}

section("[store] a REPLACE invalidates every earlier acknowledgement");
{
  // seenSnapshots asserts "our data contains that file's rows". A full replace makes our data
  // exactly the loaded snapshot, so any other entry is now false. Keeping the ones above the new
  // watermark let "Replace with snapshot" on an OLDER file (which the pull deliberately targets
  // when it is the unreconciled one) leave a merged sibling still marked seen — and the next push
  // then went straight over that sibling's rows with no merge ever offered.
  const store = await deviceWith([tx("local-1")], 3);
  await store.applyDocument(
    { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("from-B")] } as never },
    { dirty: true, seenRemoteVersion: 5, seenSnapshotKey: "fileB@5" },
  );
  eq(store.getState().settings.seenSnapshots?.join(","), "fileB@5", "the merge is recorded");
  // Now REPLACE with an older file.
  await store.applyDocument(
    { schemaVersion: SCHEMA.version, version: 4, data: { transactions: [tx("from-A")] } as never },
    { seenSnapshotKey: "fileA@4" },
  );
  const st = store.getState();
  eq(st.settings.seenSnapshots?.join(","), "fileA@4", "only the file we just loaded remains acknowledged");
  ok(!st.transactions.some((t) => t.id === "from-B"), "…which is honest: B's row is gone from our data");
  // …so the guard protects B again.
  const files = [
    { id: "fileB", name: "b", version: 5, deviceId: "tablet", author: "me", savedAt: "2026-01-05T00:00:00Z", schemaVersion: SCHEMA.version },
  ];
  eq(
    unincorporatedFiles(files, st.settings.lastSyncedVersion, new Set(st.settings.seenSnapshots ?? []), {
      deviceId: st.settings.deviceId,
      version: st.version,
    }).length,
    1,
    "B is a hazard again, so the next push is refused instead of overwriting it",
  );
}

section("[store] a full replace refuses when the PERSISTED row shows unsynced work");
{
  // The migration's adopt step refused on in-memory `dirty`. The app stays editable while locked
  // and nothing propagates between tabs, so a second tab could be recording expenses while this
  // one sat on the unlock screen: in-memory dirty was false, the refusal never fired, and the
  // replace deleted that tab's rows. The persisted fingerprint is the only cross-tab truth.
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  await tab1.savePerson({ id: "p1", name: "Ravi" });
  await tab1.saveAccount({ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" });
  await tab1.markSynced(tab1.getState().version); // tab1 is clean and knows it
  const tab2 = await createPortfolioStore(adapter);
  await tab2.saveTransaction(tx("typed-in-other-tab"));

  eq(tab1.getState().dirty, false, "tab1's in-memory dirty flag still says clean…");
  const fp = await tab1.versionFingerprint();
  ok(fp.localVersion > fp.lastSyncedVersion, "…while the PERSISTED row shows unsynced work");
  // And the compare-and-apply refuses the replace even if the caller missed that.
  const captured = await tab1.exportWithFingerprint();
  await tab2.saveTransaction(tx("second-row"));
  let refused = false;
  try {
    await tab1.applyDocument(
      { schemaVersion: SCHEMA.version, version: 9, data: { transactions: [tx("from-folder")] } as never },
      { expect: captured.fingerprint },
    );
  } catch {
    refused = true;
  }
  ok(refused, "a replace planned before the other tab's write is refused");
  const rows = (await adapter.exportAll()).transactions?.map((t) => t.id) ?? [];
  ok(rows.includes("typed-in-other-tab") && rows.includes("second-row"), "both of the other tab's rows survive");
}

section("[store] a pull does NOT jump the watermark over files it hasn't read");
{
  // The pull set `lastSyncedVersion = doc.version` unconditionally. Since a file is subsumed at
  // `version >= watermark`, that leapt over every strictly-LOWER foreign file, which then stopped
  // being a hazard forever — and the pull deliberately targets the newest unincorporated file, so
  // an ordinary "Pull latest → replace" on a clean device published over a third device's rows
  // with no merge ever offered.
  const store = await deviceWith([tx("local-1")], 3);
  await store.applyDocument(
    { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("from-B")] } as never },
    { seenSnapshotKey: "fileB@5", holdWatermark: true },
  );
  const st = store.getState();
  eq(st.settings.lastSyncedVersion, 3, "the watermark stays put while another file is unread");
  eq(st.settings.seenSnapshots?.join(","), "fileB@5", "…and only the file we loaded is acknowledged");
  const files = [
    { id: "fileA", name: "a", version: 4, deviceId: "phone", author: "me", savedAt: "2026-01-04T00:00:00Z", schemaVersion: SCHEMA.version },
    { id: "fileB", name: "b", version: 5, deviceId: "tablet", author: "me", savedAt: "2026-01-05T00:00:00Z", schemaVersion: SCHEMA.version },
  ];
  const hazards = unincorporatedFiles(files, st.settings.lastSyncedVersion, new Set(st.settings.seenSnapshots ?? []), {
    deviceId: st.settings.deviceId,
    version: st.version,
  });
  eq(hazards.map((h) => h.id).join(","), "fileA", "the lower-versioned file is STILL a hazard");
  // With nothing else outstanding the watermark does advance, as before.
  const solo = await deviceWith([tx("local-1")], 3);
  await solo.applyDocument(
    { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("from-B")] } as never },
    { seenSnapshotKey: "fileB@5" },
  );
  eq(solo.getState().settings.lastSyncedVersion, 5, "a pull that leaves nothing unread still advances it");
  ok(!solo.getState().dirty, "…and leaves the device clean");
}

section("[merge] our own file is judged by the PERSISTED version, not a stale in-memory one");
{
  // `runSync` passed this tab's in-memory version as `own.version`. A second tab's push advances
  // the database while memory lags, so our OWN file looked like a diverged clone: the guard
  // refused, and since that path returns without scheduling a retry (and autosave is gated on
  // phase === "ready"), the tab silently stopped autosaving.
  const f = (id: string, version: number, deviceId: string) => ({ id, name: id, version, deviceId, author: "me", savedAt: "2026-01-01T00:00:00Z", schemaVersion: SCHEMA.version });
  const ourFile = [f("ours", 5, "device-1")];
  eq(
    unincorporatedFiles(ourFile, 3, new Set(), { deviceId: "device-1", version: 4 }).length,
    1,
    "with a STALE version our own file looks foreign (the bug)",
  );
  eq(
    unincorporatedFiles(ourFile, 3, new Set(), { deviceId: "device-1", version: 5 }).length,
    0,
    "with the persisted version it is correctly excused",
  );
  eq(
    unincorporatedFiles([f("twin", 9, "device-1")], 3, new Set(), { deviceId: "device-1", version: 5 }).length,
    1,
    "…while a clone genuinely AHEAD of us stays a hazard",
  );
}

section("[store] the pull-replace path carries a fingerprint, so a sibling tab's rows survive");
{
  // The ordinary Pull latest → Replace was the last full replace without compare-and-apply. The
  // UI's own staleness check reads THIS tab's in-memory version, which cannot see a sibling tab, so
  // a second tab's never-pushed rows were deleted silently — the same defect the merge path fixed.
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  await tab1.savePerson({ id: "p1", name: "Ravi" });
  await tab1.saveAccount({ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" });
  await tab1.markSynced(tab1.getState().version);
  const tab2 = await createPortfolioStore(adapter);

  // tab1 opens the dialog: this is what checkRemote captures.
  const captured = await tab1.exportWithFingerprint();
  eq(captured.fingerprint.localVersion, captured.fingerprint.lastSyncedVersion, "tab1 is genuinely clean");
  // tab2 types an expense during the confirm window.
  await tab2.saveTransaction(tx("typed-in-tab2"));
  eq(tab1.getState().dirty, false, "tab1's in-memory flag can't see it (hence the UI guard failed)");

  let refused = false;
  try {
    await tab1.applyDocument(
      { schemaVersion: SCHEMA.version, version: 9, data: { transactions: [tx("from-folder")] } as never },
      { seenSnapshotKey: "fileB@9", expect: captured.fingerprint },
    );
  } catch {
    refused = true;
  }
  ok(refused, "the replace is refused");
  ok(
    (await adapter.exportAll()).transactions?.some((t) => t.id === "typed-in-tab2"),
    "…and the sibling tab's unpushed row survives",
  );
  // Without a competing write it still applies, so the guard isn't over-tight.
  const fresh = await tab1.exportWithFingerprint();
  await tab1.applyDocument(
    { schemaVersion: SCHEMA.version, version: 9, data: { transactions: [tx("from-folder")] } as never },
    { seenSnapshotKey: "fileB@9", expect: fresh.fingerprint },
  );
  ok(tab1.getState().transactions.some((t) => t.id === "from-folder"), "an uncontested replace still applies");
}

// ---------------------------------------------------------------------------
// The startup gate: what a just-opened device does before the user can touch anything.
// ---------------------------------------------------------------------------

/** Controller with a stub engine/provider over `files`, serving `docs` by file id. */
function withFolder(store: Awaited<ReturnType<typeof deviceWith>>, files: SnapshotMeta[], docs: Record<string, SnapshotDoc>, opts: { locked?: boolean } = {}) {
  const controller = new SyncController(store);
  const engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async (m: { id: string }) => ({ doc: docs[m.id], meta: files.find((f) => f.id === m.id) }),
  };
  const inject = (): void => {
    const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
    c.engine = opts.locked ? null : engine;
    c.provider = { list: async () => files };
    c.codec = opts.locked ? null : {};
  };
  inject();
  return { controller, inject };
}
/** The three readings the UI derives from `status.lastCheck`, for assertions. */
const seen = (c: SyncController): { behind: number | undefined; unreachable: boolean; at: string | undefined } => {
  const lc = c.getStatus().lastCheck;
  return {
    behind: lc && "behind" in lc ? lc.behind : undefined,
    unreachable: !!lc && "unreachable" in lc,
    at: lc?.at,
  };
};
const meta = (id: string, version: number, deviceId: string): SnapshotMeta =>
  ({ id, name: id, version, deviceId, author: "me", savedAt: `2026-01-0${Math.min(version, 9)}T00:00:00Z`, schemaVersion: SCHEMA.version });
/** A snapshot built FROM this device's own export, so shared rows are byte-identical — which is
 *  what a real peer snapshot looks like (the store stamps `updatedAt`/`author` on write, so a
 *  hand-built row would differ on every field and read as "modified"). */
async function peerDoc(
  store: Awaited<ReturnType<typeof deviceWith>>,
  version: number,
  edit: (txns: Transaction[]) => Transaction[],
): Promise<SnapshotDoc> {
  const local = await store.exportDocument();
  return {
    schemaVersion: SCHEMA.version,
    version,
    data: { ...local.data, transactions: edit((local.data.transactions ?? []) as Transaction[]) } as never,
  };
}

section("[startup] a pure addition on a clean device is loaded automatically");
{
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version); // clean: nothing of ours is unpushed
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const files = [meta("fileB", 9, "tablet")];
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const { controller } = withFolder(store, files, { fileB: doc });
  const res = await controller.startupCheck();
  eq(res.kind, "applied", "it applied without asking");
  ok(store.getState().transactions.some((t) => t.id === "from-B"), "the other device's row is here");
  ok(store.getState().transactions.some((t) => t.id === "local-1"), "…and ours is untouched");
  eq(seen(controller).behind, 0, "the pill can now honestly say synced");
  ok(!!seen(controller).at, "…with a checked-at stamp");
}

section("[startup] a snapshot that would REMOVE our rows is never applied automatically");
{
  // The case that makes silent catch-up unsafe: another device restored an old backup and
  // published it. It looks like "just newer" but drops rows, so it must reach a human.
  const store = await deviceWith([tx("local-1"), tx("local-2")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => t.filter((x) => x.id !== "local-2"));
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], { fileB: doc });
  const res = await controller.startupCheck();
  eq(res.kind, "review", "it stops for review");
  eq(store.getState().transactions.length, 2, "and nothing was written — both our rows remain");
}

section("[startup] a snapshot that MODIFIES a record is not applied automatically either");
{
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => t.map((x) => (x.id === "local-1" ? { ...x, amount: 999 } : x)));
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], { fileB: doc });
  eq((await controller.startupCheck()).kind, "review", "a rewrite of an existing row needs a human");
  eq(store.getState().transactions[0]!.amount, 100, "our value is untouched");
}

section("[startup] unsynced local work always goes to review, even for a pure addition");
{
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  await store.saveTransaction(tx("typed-here")); // now dirty
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], { fileB: doc });
  eq((await controller.startupCheck()).kind, "review", "a dirty device is never auto-replaced");
  ok(store.getState().transactions.some((t) => t.id === "typed-here"), "our unsynced row survives");
}

section("[startup] a locked vault reports being behind without decoding anything");
{
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], {}, { locked: true });
  const res = await controller.startupCheck();
  eq(res.kind, "locked-behind", "listing works while locked — metadata isn't encrypted");
  eq(seen(controller).behind, 1, "…and the count it published says how many are waiting");
}

section("[startup] nothing to check when no folder is configured");
{
  const store = await deviceWith([tx("local-1")], 3);
  let listed = false;
  const controller = new SyncController(store);
  (controller as unknown as { provider: unknown }).provider = {
    list: async () => {
      listed = true;
      return [];
    },
  };
  // Not "up-to-date": nothing was looked at, and the shell must be able to tell the difference —
  // it spends its one check per app start on this answer.
  eq((await controller.startupCheck()).kind, "no-folder", "a local-only user sees nothing");
  eq(listed, false, "…and the folder is never listed");
}

section("[startup] an unreachable folder lets the user work locally");
{
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.provider = { list: async () => { throw new Error("offline"); } };
  c.engine = { list: async () => { throw new Error("offline"); }, getSessionFileId: () => null };
  c.codec = {};
  const res = await controller.startupCheck();
  eq(res.kind, "unavailable", "it reports unavailable rather than blocking");
  eq(store.getState().transactions.length, 1, "local data is untouched");
}

section("[startup] the behind count stops claiming work that has been done");
{
  // The pill and the standing notice read `behind`. It was only ever set by the startup check, so
  // after the user actually loaded or merged, the app kept telling them they were behind.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], { fileB: doc });
  eq((await controller.startupCheck()).kind, "applied", "the pure addition is applied");
  eq(seen(controller).behind, 0, "…and nothing is reported as still waiting");

  // A pull of one file while ANOTHER remains unread must leave the count at that other file.
  const store2 = await deviceWith([tx("local-1")], 3);
  await store2.markSynced(store2.getState().version);
  await store2.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const docB = await peerDoc(store2, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet"), meta("fileC", 8, "phone")];
  const { controller: c2 } = withFolder(store2, files, { fileB: docB, fileC: docB });
  const remote = await c2.checkRemote();
  eq(remote?.fileId, "fileB", "the newest unreconciled file is targeted");
  eq(remote?.outstandingOthers, 1, "one other file is still unreconciled");
  await c2.applyRemote(remote!.doc, remote!.fileId, remote!.outstandingOthers, remote!.base);
  eq(seen(c2).behind, 1, "the count reflects the file still waiting, not zero");
}

section("[startup] a failed check must not wedge autosave for the session");
{
  // `phase` gates autosave (`phase !== "ready"` → return). A read-only check that set "error"
  // stopped every later edit from ever being scheduled, with no retry — before the user had done
  // anything. The check reports unreachability without touching the phase.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.provider = { list: async () => { throw new Error("offline"); } };
  c.engine = { list: async () => { throw new Error("offline"); }, getSessionFileId: () => null };
  c.codec = {};
  const before = controller.getStatus().phase;
  eq((await controller.startupCheck()).kind, "unavailable", "it reports unavailable");
  eq(controller.getStatus().phase, before, "…without changing the phase that gates autosave");
  eq(seen(controller).unreachable, true, "…flagging unreachable for the UI instead");
}

section("[startup] a refused apply reports what is really left, not zero");
{
  // `behind` was published BEFORE the write it described, so a refusal (a sibling tab got there
  // first) left the pill saying "Synced" while a peer file was genuinely unread.
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  await tab1.savePerson({ id: "p1", name: "Ravi" });
  await tab1.saveAccount({ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" });
  await tab1.saveTransaction(tx("local-1"));
  await tab1.markSynced(tab1.getState().version);
  await tab1.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  // A MODIFYING snapshot, so the gate routes to review and publishes a real count instead of
  // applying — without that prior value, "behind is not 0" would pass vacuously.
  const doc = await peerDoc(tab1, 9, (t) => t.map((x) => ({ ...x, amount: 555 })));
  const { controller, inject } = withFolder(tab1, [meta("fileB", 9, "tablet")], { fileB: doc });
  eq((await controller.startupCheck()).kind, "review", "the gate stops for review");
  eq(seen(controller).behind, 1, "…and publishes one file waiting");

  inject(); // refreshPhase() rebuilt the engine from (absent) real config
  const remote = await controller.checkRemote();
  // A sibling tab writes during the confirm window → the compare-and-apply must refuse.
  const tab2 = await createPortfolioStore(adapter);
  await tab2.saveTransaction(tx("typed-in-tab2"));
  let refused = false;
  try {
    await controller.applyRemote(remote!.doc, remote!.fileId, remote!.outstandingOthers, remote!.base);
  } catch {
    refused = true;
  }
  ok(refused, "the apply is refused");
  eq(seen(controller).behind, 1, "…and the count still says one file is unread, not 0");
  ok(
    (await adapter.exportAll()).transactions?.some((t) => t.id === "typed-in-tab2"),
    "the sibling tab's row survives",
  );
  eq(tab1.getState().transactions.find((t) => t.id === "local-1")?.amount, 100, "…and ours is unchanged");
}

section("[startup] a snapshot from a NEWER build is never applied automatically");
{
  // `importAll` skips collections this build has no store for, so an automatic apply would drop
  // the peer's rows while recording the file as incorporated — and the next push would publish
  // without them. The merge path handles it; the silent lane must not.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const future = { ...doc, schemaVersion: SCHEMA.version + 1 };
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], { fileB: future });
  eq((await controller.startupCheck()).kind, "review", "a future schema goes to review");
  ok(!store.getState().transactions.some((t) => t.id === "from-B"), "nothing was applied");
}

section("[startup] the timeout stops the work, not just the answer");
{
  // `Promise.race` can't cancel. The losing run used to keep going and apply a snapshot after
  // "unavailable" had been reported and the blocking overlay taken down.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const slow = async <T,>(v: T): Promise<T> => {
    await new Promise((r) => setTimeout(r, 60));
    return v;
  };
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    list: async () => slow(files),
    getSessionFileId: () => null,
    loadFile: async () => slow({ doc, meta: files[0] }),
  };
  c.provider = { list: async () => slow(files) };
  c.codec = {};
  eq((await controller.startupCheck(20)).kind, "unavailable", "it gives up on time");
  await new Promise((r) => setTimeout(r, 300)); // let the abandoned run finish
  ok(
    !store.getState().transactions.some((t) => t.id === "from-B"),
    "and the abandoned run did NOT write after we stopped waiting",
  );
  ok(seen(controller).unreachable, "the user is told why the wait ended");
}

section("[startup] a write that lands AFTER the timeout is announced, not silent");
{
  // Nothing can cancel an in-flight apply, so if the race times out mid-write the data still
  // changes. The one unacceptable outcome is saying nothing: the dashboard totals would move with
  // no explanation. `appliedVersion` is live status, so the acknowledgement survives the gate
  // having already resolved to "unavailable".
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  let listCalls = 0;
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    // Calls 1 (the gate's own count) and 2 (checkRemote's) are fast, so the apply decision is
    // reached and passes. Call 3 is applyRemote's internal re-listing — slow, so the race times
    // out while the write is already in flight. That is the only window where an apply can land
    // after the caller has been told "unavailable".
    list: async () => {
      listCalls += 1;
      if (listCalls > 2) await new Promise((r) => setTimeout(r, 120));
      return files;
    },
    getSessionFileId: () => null,
    loadFile: async () => ({ doc, meta: files[0] }),
  };
  c.provider = { list: async () => files };
  c.codec = {};
  eq((await controller.startupCheck(40)).kind, "unavailable", "the caller stopped waiting");
  await new Promise((r) => setTimeout(r, 400));
  ok(store.getState().transactions.some((t) => t.id === "from-B"), "the write did land (uncancellable)");
  eq(controller.getStatus().appliedVersion, 9, "…and it is announced, so the UI can say so");
}

section("[startup] a STRICT-SUPERSET snapshot still goes to review when local work is unsynced");
{
  // The existing dirty-device test passes for the wrong reason: its unsynced row reads as
  // `removed`, so `pureAddition` is already false and `removed === 0` alone forces review —
  // deleting the `!hasLocalChanges` condition would not fail it. This is the load-bearing case:
  // the peer's snapshot is a strict SUPERSET of ours (nothing removed, nothing modified) while we
  // still hold unpushed work, so only `hasLocalChanges` can stop the automatic lane.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  // Build the peer doc from our CURRENT rows plus one, then make ourselves dirty in a way the
  // snapshot already contains — a re-save of an existing row (what an autopay reconcile does).
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  // `localVersion > lastSyncedVersion` with the DATA untouched: unpushed work by the store's own
  // definition, while the peer's snapshot remains a strict superset of ours.
  await store.saveSettings({ lastSyncedVersion: store.getState().settings.localVersion - 1 });
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], { fileB: doc });
  const remote = await controller.checkRemote();
  eq(remote?.diff.summary.removed, 0, "nothing would be removed");
  eq(remote?.diff.summary.modified, 0, "…and nothing modified — a strict superset");
  ok(remote?.hasLocalChanges, "…yet this device has unsynced work");
  eq((await controller.startupCheck()).kind, "review", "so the automatic lane must refuse");
  ok(!store.getState().transactions.some((t) => t.id === "from-B"), "nothing was applied");
}

section("[startup] an unknown COLLECTION is refused even at our own schema version");
{
  // The schema guard is `schemaVersion <= ours && every collection known`. The existing test bumps
  // the version, which short-circuits the && — so the collection clause was never evaluated.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const base = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  // Same schemaVersion as us, but carrying a store this build doesn't have: `importAll` would skip
  // it while we recorded the file as incorporated, so its rows would be silently dropped.
  const withUnknown = {
    ...base,
    data: { ...base.data, budgets: [{ id: "b1", name: "Groceries" }] } as never,
  };
  const { controller } = withFolder(store, [meta("fileB", 9, "tablet")], { fileB: withUnknown });
  eq((await controller.startupCheck()).kind, "review", "an unknown collection goes to review");
  ok(!store.getState().transactions.some((t) => t.id === "from-B"), "nothing was applied");

  // And it is not over-tight: a snapshot that simply OMITS our empty collections still auto-applies.
  const store2 = await deviceWith([tx("local-1")], 3);
  await store2.markSynced(store2.getState().version);
  await store2.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const full = await peerDoc(store2, 9, (t) => [...t, tx("from-B")]);
  const trimmed = { ...full, data: { ...full.data } as Record<string, unknown> };
  delete trimmed.data.holdings;
  delete trimmed.data.holdingEvents;
  const { controller: c2 } = withFolder(store2, [meta("fileB", 9, "tablet")], { fileB: trimmed as never });
  eq((await c2.startupCheck()).kind, "applied", "omitting empty collections is fine");
}

section("[startup] a dead run's timer can never speak over a later success");
{
  // `clearTimeout` used to sit after the await inside the try, so a REJECTING run skipped it and
  // the orphan timer fired seconds later, setting `unreachable: true` over whatever had happened
  // since — including a successful apply. The pill flipped to "Not connected" with no way back.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  // Run 1 REJECTS (offline).
  c.provider = { list: async () => { throw new Error("offline"); } };
  c.engine = { list: async () => { throw new Error("offline"); }, getSessionFileId: () => null };
  c.codec = {};
  eq((await controller.startupCheck(30)).kind, "unavailable", "the offline launch reports unavailable");
  eq(seen(controller).unreachable, true, "…and says so");
  // Run 2 succeeds, as it would after the user reconnects or unlocks.
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet")];
  c.provider = { list: async () => files };
  c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => ({ doc, meta: files[0] }) };
  eq((await controller.startupCheck()).kind, "applied", "the second run applies");
  eq(seen(controller).unreachable, false, "…and clears the offline flag");
  // Well past run 1's 30ms deadline: the orphan must stay silent.
  await new Promise((r) => setTimeout(r, 200));
  eq(seen(controller).unreachable, false, "the dead run's timer did not re-flag us offline");
}

section("[startup] a successful listing clears the offline flag, even with nothing to send");
{
  // The notice tells the user their changes are local-only; both recoveries it points at (Sync now,
  // Pull latest) list the folder successfully, so neither may leave the flag set.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.provider = { list: async () => { throw new Error("offline"); } };
  c.engine = { list: async () => { throw new Error("offline"); }, getSessionFileId: () => null };
  c.codec = {};
  await controller.startupCheck(30);
  eq(seen(controller).unreachable, true, "offline launch sets the flag");
  // Now reachable, and there is genuinely nothing to reconcile.
  const doc = await peerDoc(store, 9, (t) => t);
  const files = [meta("fileB", 9, "tablet")];
  c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => ({ doc, meta: files[0] }) };
  c.provider = { list: async () => files };
  await controller.checkRemote();
  eq(seen(controller).unreachable, false, "a successful Pull latest clears it");
}

section("[startup] a successful apply never leaves a 'you are behind' claim standing");
{
  // `remaining` used to be derived from a listing taken BEFORE the write and published after it.
  // When that listing threw, the gate's pre-apply count survived — so a SUCCESSFUL automatic apply
  // still said "Behind — 1", which also outranked (and hid) the acknowledgement.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  let calls = 0;
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    // Calls 1-2 succeed (the gate's count, then checkRemote); call 3 — applyRemote's own
    // re-listing — fails, as a rate-limit or a drop mid-write would.
    list: async () => {
      calls += 1;
      if (calls > 2) throw new Error("rate limited");
      return files;
    },
    getSessionFileId: () => null,
    loadFile: async () => ({ doc, meta: files[0] }),
  };
  c.provider = { list: async () => files };
  c.codec = {};
  eq((await controller.startupCheck()).kind, "applied", "the apply succeeds");
  ok(store.getState().transactions.some((t) => t.id === "from-B"), "the data is here");
  eq(seen(controller).behind, 0, "and the count says nothing is waiting — not a stale 1, not 'unknown'");
  eq(controller.getStatus().appliedVersion, 9, "…so the acknowledgement is what the user sees");
}

section("[startup] the count after a merge excludes the file just merged");
{
  // `commitMerge` gated the count on `ackBlocked === null`, which by definition means "nothing
  // outstanding" — so the only value it could publish was 0, while the case carrying a real number
  // ("outstanding", a SUCCESSFUL listing) was skipped and the pre-merge count stood. The user was
  // then nagged about the very file they had just merged.
  const store = await deviceWith([tx("local-1")], 3);
  const files = [meta("fileA", 4, "phone"), meta("fileB", 5, "tablet")];
  const docs: Record<string, SnapshotDoc> = {
    fileA: { schemaVersion: SCHEMA.version, version: 4, data: { transactions: [tx("from-A")] } as never },
    fileB: { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("from-B")] } as never },
  };
  const controller = new SyncController(store);
  const inject = (): void => {
    (controller as unknown as { engine: unknown }).engine = {
      list: async () => files,
      getSessionFileId: () => null,
      loadFile: async (m: { id: string }) => ({ doc: docs[m.id], meta: files.find((f) => f.id === m.id) }),
    };
  };
  inject();
  const preview = await controller.previewMerge(docs.fileB!, "fileB");
  eq(preview.ackBlocked, "outstanding", "one other file is still unreconciled");
  eq(preview.outstandingOthers, 1, "…exactly one");
  await controller.commitMerge(preview, {});
  eq(seen(controller).behind, 1, "the count is what remains AFTER the merge, not before");
  ok(store.getState().transactions.some((t) => t.id === "from-B"), "the merged rows are here");
}

section("[sync] a raw error never reaches the banner, only the tooltip");
{
  // The diff promotes `status.message` to an app-wide banner, where "TypeError: Failed to fetch"
  // is not something a person can act on. The sentence and the diagnostic are now separate fields.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.provider = { list: async () => files0 };
  const files0: SnapshotMeta[] = [];
  c.engine = { list: async () => { throw new TypeError("Failed to fetch"); }, getSessionFileId: () => null };
  c.codec = {};
  await controller.syncNow().catch(() => {});
  const st = controller.getStatus();
  ok(!/TypeError/.test(st.message ?? ""), `the banner sentence is human: ${st.message}`);
  ok(/Failed to fetch/.test(st.detail ?? ""), "…and the raw text is kept as detail");
}

section("[startup] an automatic apply still reports the OTHER files left to load");
{
  // The auto-apply lane was only ever tested with a single peer file, so a bug that dropped the
  // remaining count went unnoticed: with the post-write listing failing, `behind` became
  // "unknown", which renders as NO notice at all — hiding a file the push guard would then refuse
  // and turning a free fast-forward into a merge.
  const build = async () => {
    const store = await deviceWith([tx("local-1")], 3);
    await store.markSynced(store.getState().version);
    await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
    const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
    // fileB is a pure addition (auto-appliable); fileC is a different device's file we've never read.
    const files = [meta("fileB", 9, "tablet"), meta("fileC", 8, "phone")];
    return { store, doc, files };
  };

  // (a) everything reachable: the count must be the OTHER file.
  {
    const { store, doc, files } = await build();
    const { controller } = withFolder(store, files, { fileB: doc, fileC: doc });
    eq((await controller.startupCheck()).kind, "applied", "the pure addition is applied");
    eq(seen(controller).behind, 1, "…and the untouched peer file is still reported");
  }

  // (b) the post-write listing fails: it must fall back to the known-good figure, never to unknown.
  {
    const { store, doc, files } = await build();
    const controller = new SyncController(store);
    let calls = 0;
    const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
    c.engine = {
      list: async () => {
        calls += 1;
        if (calls > 2) throw new Error("rate limited"); // applyRemote's own re-listing
        return files;
      },
      getSessionFileId: () => null,
      loadFile: async (m: { id: string }) => ({ doc, meta: files.find((f) => f.id === m.id) }),
    };
    c.provider = { list: async () => files };
    c.codec = {};
    eq((await controller.startupCheck()).kind, "applied", "the apply still succeeds");
    eq(seen(controller).behind, 1, "…and the outstanding file is NOT hidden");
    ok(!seen(controller).unreachable, "…nor is a successful download called unreachable");
  }
}

section("[sync] a successful push clears the offline flag");
{
  // The other half of what the "clears the offline flag" test claims to cover: `runSync`'s own
  // paths. Reverting those clears used to leave the whole suite green.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.provider = { list: async () => { throw new Error("offline"); } };
  c.engine = { list: async () => { throw new Error("offline"); }, getSessionFileId: () => null };
  c.codec = {};
  await controller.startupCheck(30);
  eq(seen(controller).unreachable, true, "the offline launch sets the flag");
  // Now reachable and nothing to send (a clean device): runSync's "nothing to sync" path.
  await store.markSynced(store.getState().version);
  c.engine = { list: async () => [meta("fileB", 2, "tablet")], getSessionFileId: () => null };
  c.provider = { list: async () => [meta("fileB", 2, "tablet")] };
  await controller.syncNow().catch(() => {});
  eq(seen(controller).unreachable, false, "a successful listing clears it, even with nothing to send");
}

section("[startup] the count is recomputed AFTER the write, not carried over from before it");
{
  // The mutation audit's headline gap: nothing distinguished a post-write recount from the
  // caller's pre-write figure, so the whole mechanism could have been deleted silently. A replace
  // RESETS the seen-log, which resurrects a previously acknowledged file — so any number measured
  // before the write can report 0 while a file sits unread.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  // fileC was merged earlier: it is in the seen-log, so a PRE-write count excludes it.
  await store.applyDocument(
    { schemaVersion: SCHEMA.version, version: 5, data: {} as never },
    { dirty: true, seenSnapshotKey: "fileC@5" },
  );
  await store.markSynced(store.getState().version);
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet"), meta("fileC", 5, "phone")];
  const controller = new SyncController(store);
  let calls = 0;
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    // checkRemote's listing succeeds; applyRemote's own re-listing fails, which forces the
    // watermark to be HELD — the only state where the resurrected file still counts (otherwise
    // the advanced watermark legitimately supersedes it).
    list: async () => {
      calls += 1;
      if (calls > 1) throw new Error("rate limited");
      return files;
    },
    getSessionFileId: () => null,
    loadFile: async () => ({ doc, meta: files[0] }),
  };
  c.provider = { list: async () => files };
  c.codec = {};
  const remote = await controller.checkRemote();
  eq(remote?.outstandingOthers, 0, "before the write, fileC is excluded — it is in the seen-log");
  await controller.applyRemote(remote!.doc, remote!.fileId, remote!.outstandingOthers, remote!.base, {
    listing: remote!.listing,
  });
  // The replace reset the log to [fileB@9] and held the watermark, so fileC is unincorporated
  // again — and must be counted.
  eq(store.getState().settings.seenSnapshots?.join(","), "fileB@9", "the replace reset the log");
  eq(seen(controller).behind, 1, "the published count reflects POST-write state, not the pre-write 0");
}

section("[startup] a decode failure is not reported as an unreachable folder");
{
  // Restoring the pre-fix `unreachable: true` here used to leave the suite green.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async () => { throw new Error("decrypt failed: bad MAC"); },
  };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  eq((await controller.startupCheck()).kind, "review", "an unreadable snapshot needs a human");
  eq(seen(controller).unreachable, false, "the folder listed fine — this is not a network fault");
  eq(seen(controller).behind, 1, "…and the count from that listing stands");
  // Reported through `problem`, not `message`: the check leaves `phase` alone, and the shell's
  // error branch is keyed on `phase === "error"` — so a sentence in `message` reached a tooltip
  // and nowhere else.
  ok(/Couldn't read the newest snapshot/.test(controller.getStatus().problem?.text ?? ""), "the sentence names the real problem");
}

section("[sync] a successful push records what the folder held afterwards");
{
  // Deleting the post-push observation used to leave the suite green.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  await store.saveTransaction(tx("to-push")); // dirty, so runSync actually pushes
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown; sessionVerified: boolean; keyringEnsured: boolean };
  let pushed = 0;
  c.engine = {
    list: async () => [],
    getSessionFileId: () => null,
    setSessionFileId: () => {},
    push: async () => {
      pushed += 1;
      return meta("mine", store.getState().version + 1, store.getState().settings.deviceId);
    },
    prune: async () => 0,
  };
  c.provider = { list: async () => [] };
  c.codec = {};
  c.sessionVerified = true; // skip the DEK backstop, which needs a real provider
  c.keyringEnsured = true;
  await controller.syncNow().catch(() => {});
  eq(pushed, 1, "it pushed");
  eq(seen(controller).behind, 0, "…and recorded the post-push listing as the observation");
  ok(!!seen(controller).at, "…with the moment it was taken");
}

section("[startup] a merge is stamped with the moment its listing was taken, not the moment OK was clicked");
{
  // The review modal can sit open for minutes. Publishing the count under `new Date()` claimed a
  // freshness no check had: "checked just now" against a folder last looked at before lunch.
  const store = await deviceWith([tx("local-1")], 3);
  const files = [meta("fileA", 4, "phone"), meta("fileB", 5, "tablet")];
  const docs: Record<string, SnapshotDoc> = {
    fileA: { schemaVersion: SCHEMA.version, version: 4, data: { transactions: [tx("from-A")] } as never },
    fileB: { schemaVersion: SCHEMA.version, version: 5, data: { transactions: [tx("from-B")] } as never },
  };
  const stamped = new SyncController(store);
  (stamped as unknown as { engine: unknown }).engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async (m: { id: string }) => ({ doc: docs[m.id], meta: files.find((f) => f.id === m.id) }),
  };
  const preview = await stamped.previewMerge(docs.fileB!, "fileB");
  ok(!!preview.listing?.at, "the preview carries the moment it looked");
  await new Promise((r) => setTimeout(r, 5)); // the user reads the diff
  await stamped.commitMerge(preview, {});
  eq(seen(stamped).at, preview.listing?.at, "the observation keeps the LISTING's timestamp");
}

section("[sync] a push that loses the race still records what the other device published");
{
  // The TOCTOU branch reported the conflict and said nothing about the listing that proved it, so
  // the shell kept whatever count it had — often 0 — while a file it had never read sat there.
  // (In the WINNING lane every other file is below the new watermark by construction, so the only
  // post-push listing that can carry a real number is this one.)
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  await store.saveTransaction(tx("to-push")); // dirty, so runSync actually pushes
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown; sessionVerified: boolean; keyringEnsured: boolean };
  let listed = 0;
  let pushedVersion = 0;
  c.engine = {
    // Empty before the push; a rival's file at our own version after it — the race we lost.
    list: async () => (++listed === 1 ? [] : [meta("fileRival", pushedVersion, "tablet")]),
    getSessionFileId: () => null,
    setSessionFileId: () => {},
    push: async () => {
      pushedVersion = store.getState().version + 1;
      return meta("mine", pushedVersion, store.getState().settings.deviceId);
    },
    prune: async () => 0,
  };
  c.provider = { list: async () => [] };
  c.codec = {};
  c.sessionVerified = true;
  c.keyringEnsured = true;
  await controller.syncNow().catch(() => {});
  ok(listed >= 2, "it re-listed after pushing");
  ok(/Sync conflict/.test(controller.getStatus().message ?? ""), "the conflict is reported");
  eq(seen(controller).behind, 1, "…and so is the rival file we have never read");
}

section("[sync] a successful push dates the pill from the listing taken AFTER it");
{
  // The count itself can't move here — the push guard only lets us publish when nothing is
  // outstanding, and everything else is below the new watermark — so what the post-push
  // observation carries is FRESHNESS. Without it "checked at" is stamped from the pre-push
  // listing, which is older than the folder we just wrote to.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  await store.saveTransaction(tx("to-push"));
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown; sessionVerified: boolean; keyringEnsured: boolean };
  let pushedAt = "";
  c.engine = {
    list: async () => [],
    getSessionFileId: () => null,
    setSessionFileId: () => {},
    push: async () => {
      await new Promise((r) => setTimeout(r, 5)); // uploads take time; the pre-push look is now old
      pushedAt = new Date().toISOString();
      return meta("mine", store.getState().version + 1, store.getState().settings.deviceId);
    },
    prune: async () => 0,
  };
  c.provider = { list: async () => [] };
  c.codec = {};
  c.sessionVerified = true;
  c.keyringEnsured = true;
  await controller.syncNow().catch(() => {});
  eq(controller.getStatus().phase, "ready", "the push went through");
  eq(seen(controller).behind, 0, "…with nothing left outstanding");
  ok((seen(controller).at ?? "") >= pushedAt, "…and dated from after the upload, not before it");
}

section("[startup] a dropped download and an unreadable snapshot get different sentences");
{
  // Both are read failures with a good listing, but only one is the user's connection. Collapsing
  // them told an offline user their peer's file was corrupt.
  const build = async () => {
    const store = await deviceWith([tx("local-1")], 3);
    await store.markSynced(store.getState().version);
    await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
    return store;
  };
  const files = [meta("fileB", 9, "tablet")];
  const run = async (thrown: unknown): Promise<string> => {
    const controller = new SyncController(await build());
    const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
    c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => { throw thrown; } };
    c.provider = { list: async () => files, download: async () => new Uint8Array() };
    c.codec = {};
    eq((await controller.startupCheck()).kind, "review", "either way a human decides");
    return controller.getStatus().problem?.text ?? "";
  };
  ok(/check your connection/.test(await run(new TypeError("Failed to fetch"))), "a dropped download blames the connection");
  ok(/still be uploading/.test(await run(new Error("decrypt failed"))), "an unreadable snapshot does not");
}

section("[startup] an apply is never started once the run has been abandoned");
{
  // `Promise.race` cannot cancel: without the flag the losing run reached the auto-apply lane and
  // replaced the user's data after the overlay had already gone away.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]); // a pure addition: auto-appliable
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    // The read outlives the deadline, so the decision below happens on an abandoned run.
    loadFile: async () => { await new Promise((r) => setTimeout(r, 30)); return { doc, meta: files[0] }; },
  };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  const res = await controller.startupCheck(10);
  eq(res.kind, "unavailable", "the caller was told we timed out");
  await new Promise((r) => setTimeout(r, 60)); // let the losing run finish
  ok(!store.getState().transactions.some((t) => t.id === "from-B"), "nothing was applied behind the user's back");
}

section("[ui] the shell's readings of lastCheck");
{
  // Rendered by the shell and covered by nothing until these: every mutation of them survived.
  eq(readLastCheck(undefined).behind, 0, "never looked → nothing to report");
  eq(readLastCheck(undefined).unreachable, false, "…and not a failure either");
  eq(readLastCheck(undefined).checkedAt, null, "…and no 'checked at' to show");
  const good = readLastCheck({ at: "2026-01-01T00:00:00.000Z", behind: 2 });
  eq(good.behind, 2, "a successful look reports its count");
  eq(good.unreachable, false, "…is not a failure");
  eq(good.checkedAt, "2026-01-01T00:00:00.000Z", "…and licenses a 'checked at'");
  const bad = readLastCheck({ at: "2026-01-01T00:00:00.000Z", unreachable: true });
  eq(bad.unreachable, true, "a failed look is a failure");
  eq(bad.behind, 0, "…claims no count");
  eq(bad.checkedAt, null, "…and must NOT render as 'Synced · 00:00' — we never saw the folder");
}

section("[ui] every failure reaches the user as a sentence");
{
  const offlineText = humanError(new TypeError("Failed to fetch"));
  ok(/check your connection/.test(offlineText), "offline is named as offline");
  // This funnel also carries FX refreshes and backup restores, so it must not blame one service.
  ok(!/Drive|Google/.test(offlineText), `…without blaming a service that may not be involved: ${offlineText}`);
  ok(/sign-in expired/.test(humanError(new SignInRequiredError("nope"))), "an expired session says so");
  eq(humanError(new RangeError("Version 4 is older than 5")), "Version 4 is older than 5", "our own errors are already sentences, subclass or not");
  eq(humanError("plain string"), "plain string", "a non-Error still says something");
}

section("[startup] a listing that SUCCEEDED is not retracted by a slow download");
{
  // The count and "the folder is unreachable" came from two different moments: `note()` published
  // a true count from a listing that worked, then the deadline overwrote it with `unreachable`,
  // which reads as behind:0. The overlay drops on that same tick, so the user starts editing with
  // the "1 snapshot to load" warning gone and a false "you're offline" in its place — the exact
  // outcome the gate exists to prevent.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    list: async () => files, // the folder answers immediately…
    getSessionFileId: () => null,
    loadFile: async () => { await new Promise((r) => setTimeout(r, 40)); return null; }, // …the download does not
  };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  eq((await controller.startupCheck(10)).kind, "unavailable", "the caller is told we gave up waiting");
  eq(seen(controller).unreachable, false, "but we DID see the folder — saying otherwise is a falsehood");
  eq(seen(controller).behind, 1, "…and the warning the user needs still stands");
}

section("[startup] a sign-in that expires mid-download doesn't erase the count either");
{
  // Worse than the timeout: nothing repairs this one. The shell's gate is spent, so an erased
  // count stays erased for the whole session.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async () => { throw new SignInRequiredError("token expired"); },
  };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  eq((await controller.startupCheck()).kind, "unavailable", "sign-in is a transport failure");
  eq(controller.getStatus().needsAuth, true, "…and the user is told what to fix");
  eq(seen(controller).unreachable, false, "the listing still happened");
  eq(seen(controller).behind, 1, "…so what is at stake is still on screen");
}

section("[startup] a folder we never reached IS reported as unreachable");
{
  // The other side of the same rule — the guard must not swallow a real offline case.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = { list: async () => { throw new TypeError("Failed to fetch"); }, getSessionFileId: () => null };
  c.provider = { list: async () => { throw new TypeError("Failed to fetch"); } };
  c.codec = {};
  eq((await controller.startupCheck()).kind, "unavailable", "we could not look");
  eq(seen(controller).unreachable, true, "…and we say so");
}

section("[startup] a dead run cannot republish its count over what the user has since done");
{
  // `note()` guards the run's own writes, but `checkRemote` published from INSIDE the download —
  // so the run that lost the race came back minutes later and reinstated its pre-download count
  // over a folder the user had meanwhile reconciled by hand: a permanent false "1 to load", and a
  // Review button that re-opens a file already applied.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  let release: (() => void) | null = null;
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async () => {
      await new Promise<void>((r) => { release = r; }); // held open past the deadline
      return { doc, meta: files[0] };
    },
  };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  eq((await controller.startupCheck(10)).kind, "unavailable", "the caller moved on");
  // The user reconciles by hand; THIS is the current truth.
  (controller as unknown as { set: (p: object) => void }).set({ lastCheck: { at: "TRUTH", behind: 0 } });
  release!();
  await new Promise((r) => setTimeout(r, 30)); // let the dead run finish
  eq(seen(controller).behind, 0, "the dead run did not overwrite it");
  eq(seen(controller).at, "TRUTH", "…the standing observation is still the live one");
}

section("[startup] a problem carries its own diagnostic, and both retire together");
{
  // The raw text used to live in the shared `detail`, which nothing cleared when the problem was
  // resolved — so "decrypt failed: bad MAC" re-attached itself to whatever notice showed next.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  let broken = true;
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async () => {
      if (broken) throw new Error("decrypt failed: bad MAC");
      return { doc, meta: files[0] };
    },
  };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  await controller.startupCheck();
  ok(/bad MAC/.test(controller.getStatus().problem?.detail ?? ""), "the diagnostic travels WITH the sentence");
  eq(controller.getStatus().detail, undefined, "…not in the shared field, where it would outlive it");
  broken = false;
  await controller.startupCheck();
  eq(controller.getStatus().problem, undefined, "a check that worked retires the problem");
}

section("[sync] a diagnostic never outlives the message it explains");
{
  // `detail` is the raw text behind the CURRENT sentence. Left standing, it gets read as the
  // explanation of a later, unrelated one.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  await store.saveTransaction(tx("to-push"));
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown; sessionVerified: boolean; keyringEnsured: boolean };
  let offline = true;
  c.engine = {
    list: async () => { if (offline) throw new TypeError("Failed to fetch"); return []; },
    getSessionFileId: () => null,
    setSessionFileId: () => {},
    push: async () => meta("mine", store.getState().version + 1, store.getState().settings.deviceId),
    prune: async () => 0,
  };
  c.provider = { list: async () => [] };
  c.codec = {};
  c.sessionVerified = true;
  c.keyringEnsured = true;
  await controller.syncNow().catch(() => {});
  ok(/Failed to fetch/.test(controller.getStatus().detail ?? ""), "the failure left a diagnostic");
  offline = false;
  await controller.syncNow().catch(() => {});
  eq(controller.getStatus().phase, "ready", "the retry worked");
  eq(controller.getStatus().detail, undefined, "…and took the old diagnostic with it");
}

section("[ui] one problem, one next step — never the same thing twice");
{
  // Both of these pairs fired in the running app: the push guard sets `phase:error` only when it
  // has ALREADY recorded a listing with behind >= 1, and a startup `problem` is only ever set
  // inside the behind > 0 branch. Two amber banners, two buttons, one situation.
  const base = { phase: "ready" as const };
  const guardRefused = syncSituation({
    ...base,
    phase: "error",
    message: "Remote has newer changes — Pull latest and review before syncing.",
    lastCheck: { at: "T", behind: 2 },
  });
  eq(guardRefused.notices.length, 1, "the refusal and the count are ONE banner");
  ok(/2 snapshots still to load/.test(guardRefused.notices[0]!.text), "…and the count survives the fold");
  eq(guardRefused.notices[0]!.action.kind, "review", "…under the action that actually resolves it");

  const readFailed = syncSituation({
    ...base,
    problem: { text: "Couldn't read the newest snapshot from your other device.", detail: "bad MAC" },
    lastCheck: { at: "T", behind: 1 },
  });
  eq(readFailed.notices.length, 1, "a failed read plus its count is one banner too");
  eq(readFailed.notices[0]!.title, "bad MAC", "…with its own diagnostic on hover");
  eq(readFailed.pill.title, "Couldn't read the newest snapshot from your other device.",
     "the pill explains itself from the SAME fact, not from a stale message");

  const stillBoth = syncSituation({
    ...base,
    phase: "error",
    message: "Sync conflict — another device synced at the same time. Pull latest to reconcile.",
    needsAuth: true,
  });
  eq(stillBoth.notices.length, 1, "an expired sign-in under an error banner is not a second banner");

  const applied = syncSituation({ ...base, appliedVersion: 9, lastCheck: { at: "T", behind: 1 } });
  eq(applied.notices.length, 2, "but 'we loaded your data' is a DIFFERENT fact and still shows");
  eq(applied.notices[0]!.key, "applied", "…first, because it explains what just changed");
  eq(syncSituation({ ...base, appliedVersion: 9 }, { dismissedApplied: 9 }).notices.length, 0, "…and it dismisses");
}

section("[ui] a locked vault is never offered a review it cannot run");
{
  // Keyed on the frozen startup RESULT, re-locking after the check left "Review now" as the only
  // offer — and it dead-ends in `new Error("sync not ready")`, shown to the user verbatim.
  const locked = syncSituation({ phase: "locked", lastCheck: { at: "T", behind: 1 } });
  eq(locked.notices.length, 1, "one next step");
  eq(locked.notices[0]!.action.label, "Unlock", "…and it is the one that can actually be done");
  const ready = syncSituation({ phase: "ready", lastCheck: { at: "T", behind: 1 } });
  eq(ready.notices[0]!.action.label, "Review now", "an unlocked device still goes to review");
}

section("[ui] the pill only claims 'synced' about a look that happened");
{
  const never = syncSituation({ phase: "ready" });
  eq(never.pill.label, "Not checked yet", "a device that never looked says so");
  const looked = syncSituation({ phase: "ready", lastCheck: { at: "2026-01-01T09:30:00.000Z", behind: 0 } },
    { formatTime: () => "09:30" });
  eq(looked.pill.label, "Synced · 09:30", "…and one that did is dated from the look");
  const failed = syncSituation({ phase: "ready", lastCheck: { at: "2026-01-01T09:30:00.000Z", unreachable: true } });
  eq(failed.pill.label, "Offline", "a look that FAILED is not a sync time");
}

section("[pull] a listing the caller has been holding keeps the caller's timestamp");
{
  // The confirm dialog can sit open for half an hour. Republishing its listing under `new Date()`
  // put a green "Synced · 14:30" over a folder last looked at 14:05 — with a file published at
  // 14:20 unread and unmentioned, because the old listing has never heard of it.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const old = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; codec: unknown };
  c.engine = {
    list: async () => { throw new TypeError("Failed to fetch"); }, // the in-apply re-listing blips
    getSessionFileId: () => null,
    loadFile: async () => ({ doc, meta: old[0] }),
  };
  c.codec = {};
  const takenAt = "2026-01-01T14:05:00.000Z";
  await controller.applyRemote(doc, "fileB", 0, undefined, { listing: { files: old, seq: 1, at: takenAt } });
  eq(seen(controller).at, takenAt, "the observation is dated from when the folder was SEEN");
  ok(store.getState().transactions.some((t) => t.id === "from-B"), "…and the pull still applied");
}

section("[startup] a session that starts with no folder still gets a check for the one it picks");
{
  // The gate runs once per app start. Spending that on "there is no folder" meant the folder the
  // user connected a minute later was never checked at all — the moment it is MOST likely to hold
  // family data this device has never seen.
  const store = await deviceWith([tx("local-1")], 3);
  const controller = new SyncController(store);
  eq((await controller.startupCheck()).kind, "no-folder", "nothing to look at yet");
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const files = [meta("fileB", 9, "tablet")];
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  eq((await controller.startupCheck()).kind, "review", "…and once there is, it is checked");
  eq(seen(controller).behind, 1, "…with the count published");
}

section("[merge] our OWN deviceId is excused only up to the version this database reached");
{
  // The bound exists for cloned profiles: a copied IndexedDB keeps the deviceId while the data
  // diverges, so a twin that edited and pushed past us must still be reviewed. Exercised through
  // the controller, so it pins `ownBound` itself — the direct `unincorporatedFiles` tests build
  // `own` by hand and would pass with the bound removed entirely.
  const build = async (peerVersion: number) => {
    const store = await deviceWith([tx("local-1")], 3);
    await store.markSynced(store.getState().version);
    await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
    const mine = store.getState().settings.deviceId;
    const files = [meta("twin", peerVersion, mine)]; // same deviceId, different database
    const controller = new SyncController(store);
    const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
    c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
    c.provider = { list: async () => files, download: async () => new Uint8Array() };
    c.codec = {};
    await controller.startupCheck();
    return seen(controller).behind;
  };
  const at = (await deviceWith([tx("local-1")], 3)).getState().version;
  eq(await build(at), 0, "our own file at a version we have reached is ours — nothing to review");
  eq(await build(at + 5), 1, "a file with our id ABOVE our version is a TWIN's, and must be read");
}

section("[ui] the sentences the user actually reads");
{
  // No DOM harness, so nothing asserted a full sentence — and a refactor shipped "1 snapshot
  // hasn't from your other devices been loaded here yet" to every stale device.
  const one = syncSituation({ phase: "ready", lastCheck: { at: "T", behind: 1 } }).notices[0]!;
  eq(one.text,
     "1 snapshot from your other devices hasn't been loaded here yet. Editing before loading it means merging later.",
     "singular reads as English");
  const many = syncSituation({ phase: "ready", lastCheck: { at: "T", behind: 3 } }).notices[0]!;
  eq(many.text,
     "3 snapshots from your other devices haven't been loaded here yet. Editing before loading them means merging later.",
     "…and so does the plural");
  const lockedOne = syncSituation({ phase: "locked", lastCheck: { at: "T", behind: 1 } }).notices[0]!;
  eq(lockedOne.text,
     "1 snapshot from your other devices is waiting. Unlock to load it — editing before that means merging later.",
     "the locked sentence too");
  const lockedMany = syncSituation({ phase: "locked", lastCheck: { at: "T", behind: 2 } }).notices[0]!;
  ok(lockedMany.text.startsWith("2 snapshots from your other devices are waiting."), "…in both numbers");
  const auth = syncSituation({ phase: "ready", needsAuth: true }).notices[0]!;
  ok(/Google sign-in expired/.test(auth.text), "a proper noun keeps its capital letter");
}

section("[ui] a transport failure keeps the button its own sentence names");
{
  // Folding took the OTHER notice's action, so "click Reconnect to resume sync" arrived under a
  // button labelled "Review now" — a control the sentence never mentions, and one that cannot run
  // until the session is restored.
  const authError = syncSituation({
    phase: "error",
    needsAuth: true,
    message: "Google sign-in expired — click Reconnect to resume sync.",
    lastCheck: { at: "T", behind: 1 },
  });
  eq(authError.notices.length, 1, "still one banner");
  eq(authError.notices[0]!.action.label, "Reconnect", "…and it offers what the sentence promises");
  ok(/1 snapshot still to load/.test(authError.notices[0]!.text),
     "…and still says what is at stake: the button it can't offer is not a reason to hide the count");

  // The offline next-step is dropped next to an error banner, and nothing is invented in its place.
  const offline = syncSituation({
    phase: "error",
    message: "Sync conflict — another device synced at the same time. Pull latest to reconcile.",
    lastCheck: { at: "T", unreachable: true },
  });
  eq(offline.notices.length, 1, "an unreachable folder is not a second banner");
  ok(!/0 snapshots/.test(offline.notices[0]!.text), "…and no count is folded in when there is none");
}

section("[ui] a device that cannot see the folder is told so, on its own");
{
  const offline = syncSituation({ phase: "ready", lastCheck: { at: "T", unreachable: true } });
  eq(offline.notices.length, 1, "one notice");
  eq(offline.notices[0]!.tone, "slate", "…quieter than a problem: nothing is wrong with the data");
  ok(/saved on this device/.test(offline.notices[0]!.text), "…and it says the work is safe");
  eq(offline.pill.label, "Offline", "the pill agrees with it");
  eq(offline.pill.tone, "idle", "…in the same quiet voice as its banner, not a louder one");
}

section("[ui] a locked device is never told to Reconnect");
{
  // Settings shows no Reconnect control while locked — that row needs ready/syncing/error — so
  // naming it sends the user to a screen that cannot do it.
  const locked = syncSituation({ phase: "locked", needsAuth: true });
  eq(locked.notices[0]!.action.label, "Unlock", "locked: unlock first");
  ok(/locked/.test(locked.notices[0]!.text), "…and the sentence says why");
  const ready = syncSituation({ phase: "ready", needsAuth: true });
  eq(ready.notices[0]!.action.label, "Reconnect", "unlocked: reconnect");
}

section("[ui] a locked device is not offered a retry it cannot run either");
{
  // Same rule as the two branches above, applied to the problem banner: "Try again" reaches
  // `checkRemote`, which throws a developer string while the vault is locked.
  const locked = syncSituation({
    phase: "locked",
    problem: { text: "Couldn't read the newest snapshot from your other device.", detail: "bad MAC" },
  });
  eq(locked.notices[0]!.action.label, "Unlock", "…so it asks for the unlock instead");
}

section("[startup] a failure BEFORE we look is not blamed on the folder");
{
  // The first thing the run does is read local bookkeeping. When THAT throws, the folder has not
  // been asked anything — telling the user "couldn't reach the shared folder" sends them to check
  // a connection that is fine, over a problem that isn't theirs.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown; store: { persistedSyncState: () => Promise<unknown> } };
  c.engine = { list: async () => [], getSessionFileId: () => null };
  c.provider = { list: async () => [] };
  c.codec = {};
  const real = c.store.persistedSyncState.bind(c.store);
  c.store.persistedSyncState = async () => { throw new Error("IndexedDB: UnknownError"); };
  eq((await controller.startupCheck()).kind, "unavailable", "the check could not run");
  eq(controller.getStatus().lastCheck, undefined, "…and it makes NO claim about the folder");
  c.store.persistedSyncState = real;
}

section("[startup] a deadline reached before we even look claims nothing either");
{
  // Same rule on the timeout path: the run stalled on local bookkeeping, so the folder was never
  // asked. "Couldn't reach the shared folder" would be a guess dressed as an observation.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown; store: { persistedSyncState: () => Promise<unknown> } };
  c.engine = { list: async () => [], getSessionFileId: () => null };
  c.provider = { list: async () => [] };
  c.codec = {};
  const real = c.store.persistedSyncState.bind(c.store);
  c.store.persistedSyncState = () => new Promise(() => {}); // never settles
  eq((await controller.startupCheck(10)).kind, "unavailable", "we gave up waiting");
  eq(controller.getStatus().lastCheck, undefined, "…having looked at nothing, we say nothing");
  c.store.persistedSyncState = real;
}

section("[startup] the auto-applied write is refused if the user has typed since");
{
  // The design deliberately lets this write land AFTER the deadline — nothing can cancel it. The
  // only thing standing between "the overlay dropped, so I started typing" and losing that row is
  // the `expect` fingerprint handed to `applyRemote`. Removing it left the suite green while a
  // probe watched a typed row disappear under a green "Loaded the latest changes (v9)".
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]); // a pure addition: auto-appliable
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  let release: (() => void) | null = null;
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async () => ({ doc, meta: files[0] }),
  };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  // Hold the WRITE open past the deadline: the decision was made while the gate still owned the
  // screen, the write lands after the user got it back.
  const realApply = store.applyDocument.bind(store);
  store.applyDocument = async (...args: Parameters<typeof store.applyDocument>) => {
    await new Promise<void>((r) => { release = r; });
    return realApply(...args);
  };
  const res = controller.startupCheck(10);
  eq((await res).kind, "unavailable", "the caller gave up waiting");
  await store.saveTransaction(tx("typed-after-overlay")); // the user has the app back
  release!();
  await new Promise((r) => setTimeout(r, 30));
  store.applyDocument = realApply;
  ok(store.getState().transactions.some((t) => t.id === "typed-after-overlay"), "what they typed is still here");
  eq(controller.getStatus().appliedVersion, undefined, "…and nothing claims to have loaded over it");
}

section("[ui] which outcomes give the check slot back");
{
  // One check per app start — but two outcomes checked NOTHING and must not spend it.
  eq(refundsCheckSlot("no-folder", "full"), true, "no folder: the one the user picks next still needs a check");
  eq(refundsCheckSlot("unavailable", "locked"), true, "a locked run that failed: the unlock still owes us one");
  eq(refundsCheckSlot("unavailable", "full"), false,
     "a failed FULL run keeps it: an offline device flips syncing→error constantly, and re-arming put the app behind the overlay every few seconds");
  eq(refundsCheckSlot("review", "full"), false, "a real answer spends it");
  eq(refundsCheckSlot("applied", "full"), false, "…as does a successful apply");
  eq(refundsCheckSlot("up-to-date", "full"), false, "…and finding nothing new");
}

section("[ui] an expired sign-in is never silent, however far behind we are");
{
  // `behind` outranked `needsAuth`, so a device that was BOTH behind and disconnected was offered
  // "Review now" — which re-throws the same sign-in error — and never told why it failed.
  const both = syncSituation({ phase: "ready", needsAuth: true, lastCheck: { at: "T", behind: 2 } });
  eq(both.notices.length, 1, "one notice");
  ok(/Google sign-in expired/.test(both.notices[0]!.text), "…it names the disconnection");
  ok(/2 snapshots/.test(both.notices[0]!.text), "…and what is waiting behind it");
  eq(both.notices[0]!.action.label, "Reconnect", "…and offers the step that unblocks both");
}

section("[pull] the post-write count comes from OUR listing, not the one the caller was holding");
{
  // The caller's listing is a fallback for when our own re-listing fails — not a preference. It
  // predates the write, so a file that arrived while the diff sat open is missing from it, and a
  // file the write incorporated is still in it.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const fileB = meta("fileB", 9, "tablet");
  const stale = { files: [fileB, meta("fileC", 12, "phone")], at: "2026-01-01T14:05:00.000Z" };
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; codec: unknown };
  c.engine = {
    list: async () => [fileB], // fileC was pruned away in the meantime
    getSessionFileId: () => null,
    loadFile: async () => ({ doc, meta: fileB }),
  };
  c.codec = {};
  await controller.applyRemote(doc, "fileB", 0, undefined, { listing: stale });
  eq(seen(controller).behind, 0, "the count is what the folder holds NOW");
  ok(seen(controller).at !== stale.at, "…dated from our own look, not the caller's older one");
}

section("[pull] a listing is dated when the folder answers, not when the download finishes");
{
  // Stamping after the download overstates freshness by however long the transfer took — on a bad
  // link, minutes — and that stamp is what a later write publishes as "checked at".
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; codec: unknown };
  let downloadStarted = "";
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async () => {
      downloadStarted = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 25)); // a slow link
      return { doc, meta: files[0] };
    },
  };
  c.codec = {};
  const remote = await controller.checkRemote();
  ok(!!remote, "there was something to check");
  ok(/^\d{4}-\d{2}-\d{2}T/.test(remote!.listing?.at ?? ""), "the listing carries a real timestamp");
  ok((remote!.listing?.at ?? "") <= downloadStarted, "…dated from before the download, not after it");
}

section("[pull] the newest FILES are recounted against the newest STATE");
{
  // Two half-truths used to fight over one field. The caller's listing predates the dialog, so it
  // has never heard of anything published since — recounting it alone retired a real "2 to load"
  // warning. But the standing count predates the WRITE, so keeping it nagged the user about the
  // very file they had just merged. Neither is the answer: the newest file set, recounted against
  // the state we now have.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  await store.saveTransaction(tx("mine-unsynced")); // dirty, so the gate reviews rather than auto-applies
  const fileB = meta("fileB", 9, "tablet");
  const fileC = meta("fileC", 12, "phone"); // published while the dialog sat open
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; provider: unknown; codec: unknown };
  let listing = [fileB, fileC];
  c.engine = {
    list: async () => { if (listing.length === 0) throw new TypeError("Failed to fetch"); return listing; },
    getSessionFileId: () => null,
    loadFile: async () => ({ doc, meta: fileB }),
  };
  c.provider = { list: async () => listing, download: async () => new Uint8Array() };
  c.codec = {};
  await controller.startupCheck(); // a real look: two files outstanding
  eq(seen(controller).behind, 2, "both are waiting");
  listing = []; // …and now our own re-listing blips, so the write falls back to the caller's set
  await controller.applyRemote(doc, "fileB", 0, undefined, {
    listing: { files: [fileB], seq: 1, at: "2026-01-01T14:05:00.000Z" }, // the pre-dialog set, without fileC
  });
  ok(store.getState().transactions.some((t) => t.id === "from-B"), "the pull applied");
  eq(seen(controller).behind, 1,
     "the merged file drops out (new state) and the one published since is still counted (newest files)");
}

section("[pull] the PUBLISHED timestamp is the listing's, not the download's");
{
  // Two stamps for one look: `listing.at` was taken when the folder answered, but what reached
  // `lastCheck` was `observed()`'s default — computed after `loadFile` returned.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 9, (t) => [...t, tx("from-B")]);
  const files = [meta("fileB", 9, "tablet")];
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; codec: unknown };
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async () => { await new Promise((r) => setTimeout(r, 25)); return { doc, meta: files[0] }; },
  };
  c.codec = {};
  const remote = await controller.checkRemote();
  eq(seen(controller).at, remote!.listing?.at, "one look, one timestamp — the folder's own");
}

section("[ui] the pill's colour is part of what it says");
{
  // `tone` is what the header text and the Settings badge are painted from. Nothing asserted it,
  // so a green "Behind — 2 to load" beside an amber banner passed the suite.
  eq(syncSituation({ phase: "ready", lastCheck: { at: "T", behind: 2 } }).pill.tone, "warn",
     "being behind is a warning, whatever else is true");
  eq(syncSituation({ phase: "error", message: "x" }).pill.tone, "bad", "an error is worse");
  eq(syncSituation({ phase: "ready", lastCheck: { at: "T", behind: 0 } }).pill.tone, "ok", "level is fine");
  eq(syncSituation({ phase: "ready" }).pill.tone, "idle", "never looked is neither");
  eq(syncSituation({ phase: "syncing", lastCheck: { at: "T", behind: 0 } }).pill.tone, "ok", "a plain push is fine");
  // A push in progress must not out-shout anything that is actually wrong.
  const busyAuth = syncSituation({ phase: "syncing", needsAuth: true });
  eq(busyAuth.pill.tone, "warn", "…but not while the session is expired");
  eq(busyAuth.pill.label, "Not connected", "…and the pill says which problem");
  const busyProblem = syncSituation({ phase: "syncing", problem: { text: "Couldn't read it.", detail: "x" } });
  eq(busyProblem.pill.tone, "warn", "…nor while a check failed");
  eq(busyProblem.pill.title, "Couldn't read it.", "…keeping the explanation on hover");
  // The colour NAME for each meaning is one decision, shared by the header and the badge.
  eq(SYNC_TONE_COLOR.warn, "amber", "warn is amber, everywhere");
  eq(SYNC_TONE_COLOR.bad, "red", "bad is red");
  eq(SYNC_TONE_COLOR.ok, "green", "ok is green");
  eq(SYNC_TONE_COLOR.idle, "slate", "idle is slate");
  const busyBehind = syncSituation({ phase: "syncing", lastCheck: { at: "T", behind: 2 } }).pill;
  eq(busyBehind.tone, "warn", "…but a push does not settle what is still unread");
  ok(/2 to load/.test(busyBehind.label), "…and the label says so too");
  // The same label is the Settings badge, so "no sync" states must say WHICH.
  eq(syncSituation({ phase: "locked" }).pill.label, "Locked", "a locked vault says so");
  eq(syncSituation({ phase: "no-vault" }).pill.label, "No password", "…and an unencrypted one says that");
  eq(syncSituation({ phase: "no-folder" }).pill.label, "Local only", "…and a folderless device that");
}

section("[sync] a merge is not followed by a nag about the file it just merged");
{
  // The other half of the same rule. A push landing between the preview and the commit publishes a
  // count taken BEFORE the merge; keeping it (because it is newer in time) told the user the file
  // they had just merged was still waiting.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const files = [meta("fileB", 9, "tablet")];
  const docs: Record<string, SnapshotDoc> = {
    fileB: { schemaVersion: SCHEMA.version, version: 9, data: { transactions: [tx("from-B")] } as never },
  };
  const controller = new SyncController(store);
  const c = controller as unknown as { engine: unknown; codec: unknown };
  c.engine = {
    list: async () => files,
    getSessionFileId: () => null,
    loadFile: async (m: { id: string }) => ({ doc: docs[m.id], meta: files.find((f) => f.id === m.id) }),
  };
  c.codec = {};
  const preview = await controller.previewMerge(docs.fileB!, "fileB");
  // …a push attempt lists the folder again while the dialog is open, publishing a count taken
  // before the merge — and stamped LATER than the preview's listing.
  await controller.syncNow().catch(() => {});
  eq(seen(controller).behind, 1, "one file is waiting, correctly: nothing has been merged yet");
  await controller.commitMerge(preview, {});
  eq(seen(controller).behind, 0, "after the merge it is retired — not re-reported by the newer stamp");
  ok(store.getState().transactions.some((t) => t.id === "from-B"), "…and the rows are here");
}

section("[sync] the diagnostic never outlives its sentence, at ANY error site");
{
  // Three of the four `phase: "error"` writers cleared `detail` by hand and the fourth didn't, so
  // "TypeError: Failed to fetch" from a previous failure ended up as the tooltip on a vault
  // mismatch. Enforced in the one funnel every status write goes through.
  const store = await deviceWith([tx("local-1")], 3);
  const controller = new SyncController(store);
  const set = (p: object): void => (controller as unknown as { set: (p: object) => void }).set(p);
  set({ phase: "error", message: "first failure", detail: "TypeError: Failed to fetch" });
  eq(controller.getStatus().detail, "TypeError: Failed to fetch", "the diagnostic is kept with its sentence");
  set({ phase: "error", message: "a different failure entirely" });
  eq(controller.getStatus().detail, undefined, "…and does not survive into the next one");
  set({ phase: "error", message: "explained", detail: "the real reason" });
  eq(controller.getStatus().detail, "the real reason", "…while a message that brings its own keeps it");
}

section("[sync] a folder change is NOTICED, whoever makes it");
{
  // The old folder's count and "checked at" kept driving the UI. Hung off the phase refresh so it
  // covers a sibling tab's pick arriving through the settings row, not just this tab's picker.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "OLD", folderName: "Old" } });
  const controller = new SyncController(store);
  const c = controller as unknown as {
    engine: unknown; provider: unknown; codec: unknown; engineFolderId: string | null; refreshPhase: () => void;
  };
  const files = [meta("fileB", 9, "tablet")];
  c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  c.engineFolderId = "OLD"; // what `rebuildEngine` records: the folder this engine talks to
  await controller.startupCheck();
  eq(seen(controller).behind, 1, "one file waiting in the old folder");
  await store.saveSettings({ drive: { folderId: "NEW", folderName: "New" } });
  c.refreshPhase();
  eq(controller.getStatus().lastCheck, undefined, "nothing is claimed about a folder we haven't looked at");
}

section("[sync] a folder switch can't be walked past by a look taken mid-switch");
{
  // `connectFolder` writes the settings row and THEN awaits network work before repointing the
  // engine. A debounced autosave landing in that window lists the OLD folder — and if the label
  // came from the settings row, that listing got filed under the NEW folder, after which the
  // guard, having already advanced, never fired again: the old folder's count kept driving the UI
  // for the rest of the session.
  const store = await deviceWith([tx("local-1")], 3);
  await store.saveSettings({ drive: { folderId: "OLD", folderName: "Old" } });
  const controller = new SyncController(store);
  const c = controller as unknown as {
    engine: unknown; provider: unknown; codec: unknown; engineFolderId: string | null; refreshPhase: () => void;
  };
  const files = [meta("fileB", 9, "tablet")];
  c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  c.engineFolderId = "OLD";
  await controller.startupCheck();
  eq(seen(controller).behind, 1, "one file waiting in the old folder");
  // The picker has written the new folder, but the engine still talks to the old one.
  await store.saveSettings({ drive: { folderId: "NEW", folderName: "New" } });
  await controller.startupCheck(); // an autosave-shaped look, still through the OLD engine
  eq(seen(controller).behind, 1, "…and this look is still about the OLD folder");
  // Now the switch completes.
  c.engineFolderId = "NEW";
  c.engine = { list: async () => [], getSessionFileId: () => null };
  c.provider = { list: async () => [] };
  (controller as unknown as { forgetOtherFolder: () => void }).forgetOtherFolder();
  eq(controller.getStatus().lastCheck, undefined, "the switch is noticed, not swallowed by the mid-switch look");
}

section("[sync] a wrong clock cannot change which listing wins");
{
  // Ordering is by SEQUENCE — which listing this device saw later — so the clock has no vote.
  // Ordering by timestamp cost four consecutive review rounds: a stamp is written by the same
  // clock that says what "now" is, so while the clock is wrong the two agree and nothing looks
  // amiss; the impossibility only appears after a correction, by which point the bad stamp is
  // stored and out-ranks every later look. The gate then reported "up-to-date" over an unread
  // snapshot — no overlay, no banner, straight into editing.
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const controller = new SyncController(store);
  const c = controller as unknown as {
    engine: unknown; provider: unknown; codec: unknown; engineFolderId: string | null;
    nowIso: () => string; newListing: (f: SnapshotMeta[]) => { files: SnapshotMeta[]; seq: number; at: string };
  };
  let files: SnapshotMeta[] = [];
  c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  c.codec = {};
  c.engineFolderId = "F1";
  const realNow = c.nowIso.bind(controller);
  c.nowIso = () => new Date(Date.parse(realNow()) + 60 * 60 * 1000).toISOString(); // an hour fast
  eq((await controller.startupCheck()).kind, "up-to-date", "the folder really is empty right now");
  c.nowIso = realNow; // NTP corrects it

  // The gate's own path: a later look wins.
  files = [meta("fileB", 99, "phone")];
  eq((await controller.startupCheck()).kind, "review", "a later look wins, whatever the clock did");
  eq(seen(controller).behind, 1, "…and the arrival is counted");

  // And the caller-stamped path — a listing handed over after a write, minted later than the one
  // recorded under the wrong clock. (This is the shape the gate's own path never exercises.)
  const doc = await peerDoc(store, 4, (t) => t);
  c.engine = { list: async () => { throw new TypeError("blip"); }, getSessionFileId: () => null };
  await controller.applyRemote(doc, "self", 0, undefined, { listing: c.newListing([]) });
  eq(seen(controller).behind, 0, "the newer listing retires the count");

  // And when the winner IS the one recorded under the wrong clock, its stamp is still not rendered
  // as a time that hasn't happened — the ordering ignores the clock, the display just refuses to
  // lie about it.
  c.nowIso = () => new Date(Date.parse(realNow()) + 60 * 60 * 1000).toISOString();
  files = [meta("fileC", 100, "tablet")];
  c.engine = { list: async () => files, getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  c.provider = { list: async () => files, download: async () => new Uint8Array() };
  await controller.startupCheck(); // minted under the fast clock, so it is the newest listing
  c.nowIso = realNow;
  c.engine = { list: async () => { throw new TypeError("blip"); }, getSessionFileId: () => null };
  await controller.applyRemote(doc, "self", 0, undefined, {
    listing: { files: [], seq: 1, at: "2026-01-01T00:00:00.000Z" }, // older: the fast one still wins
  });
  eq(seen(controller).behind, 1, "the newest listing still decides the count");
  ok((seen(controller).at ?? "") <= new Date().toISOString(), "…but the stamp shown is never in the future");
}

section("[sync] the WINNER is what gets remembered, and an unminted sequence cannot claim to lead");
{
  // Two rules that only bite on the second observation, which is why neither was pinned:
  //  - remembering the loser would let a caller's old file set become the baseline for the next
  //    comparison, quietly discarding what the newest look had seen;
  //  - `applyRemote({ listing })` is public and `Listing` is exported, so a sequence this
  //    controller never minted can arrive. A too-high one would out-rank every real look FOREVER
  //    (the old timestamp scheme at least healed once wall time caught up).
  const store = await deviceWith([tx("local-1")], 3);
  await store.markSynced(store.getState().version);
  await store.saveSettings({ drive: { folderId: "F1", folderName: "Family" } });
  const doc = await peerDoc(store, 4, (t) => t);
  const fileA = meta("fileA", 90, "tablet");
  const fileB = meta("fileB", 91, "phone");
  const controller = new SyncController(store);
  const c = controller as unknown as {
    engine: unknown; provider: unknown; codec: unknown; engineFolderId: string | null;
    newListing: (f: SnapshotMeta[]) => { files: SnapshotMeta[]; seq: number; at: string };
  };
  c.engine = { list: async () => [fileA, fileB], getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  c.provider = { list: async () => [fileA, fileB], download: async () => new Uint8Array() };
  c.codec = {};
  c.engineFolderId = "F1";
  // Two looks, so the remembered listing is demonstrably LATER than the ones handed over below.
  // (A failed download consumes a sequence without recording it — only relative order matters.)
  await controller.startupCheck();
  // A listing minted the way production mints them, held while a LATER look happens.
  const source = [fileA];
  const held = c.newListing(source);
  source.push(fileB); // the caller's array keeps moving; the listing is a snapshot, not a view
  eq(held.files.length, 1, "a listing is a copy of what the folder held, not a live reference");
  await controller.startupCheck();
  eq(seen(controller).behind, 2, "two files waiting");
  // From here every listing handed over is an older, partial one, and our own re-listing fails.
  c.engine = { list: async () => { throw new TypeError("blip"); }, getSessionFileId: () => null };
  await controller.applyRemote(doc, "self", 0, undefined, { listing: held });
  eq(seen(controller).behind, 2, "the newest look still decides, not the listing the caller was holding");
  await controller.applyRemote(doc, "self", 0, undefined, { listing: { files: [fileA], seq: 2, at: "2026-01-01T00:00:01.000Z" } });
  eq(seen(controller).behind, 2, "…and it is still the remembered one, not the last caller's");
  // A sequence from nowhere must not take over.
  await controller.applyRemote(doc, "self", 0, undefined, { listing: { files: [], seq: 1e9, at: "2026-01-01T00:00:02.000Z" } });
  eq(seen(controller).behind, 2, "an unminted sequence does not out-rank a real look");

  // …and it must not be able to BECOME the baseline either. With nothing remembered yet there is
  // nothing for it to lose to, so demoting it — rather than refusing it — is what stops it
  // refusing every real look afterwards.
  const fresh = new SyncController(store);
  const f = fresh as unknown as { engine: unknown; provider: unknown; codec: unknown; engineFolderId: string | null };
  f.engine = { list: async () => [fileA, fileB], getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  f.provider = { list: async () => [fileA, fileB], download: async () => new Uint8Array() };
  f.codec = {};
  f.engineFolderId = "F1";
  await fresh.applyRemote(doc, "self", 0, undefined, { listing: { files: [], seq: 1e9, at: "2026-01-01T00:00:03.000Z" } });
  await fresh.startupCheck();
  eq(seen(fresh).behind, 2, "a real look still lands on a controller that was handed a bogus sequence first");
  // …and a genuinely newer look still wins, so the clamp hasn't wedged anything.
  c.engine = { list: async () => [fileA], getSessionFileId: () => null, loadFile: async () => { throw new Error("x"); } };
  c.provider = { list: async () => [fileA], download: async () => new Uint8Array() };
  await controller.startupCheck();
  eq(seen(controller).behind, 1, "the folder moved on, and we can still see it");
}

done();
