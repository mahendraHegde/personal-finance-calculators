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

done();
