// Tests for PortfolioStore invariants (runs against the in-memory adapter).

import { createMemoryStorage } from "../src/lib/storage/memory-adapter";
import { SCHEMA } from "../src/features/portfolio/model/schema";
import { createPortfolioStore } from "../src/features/portfolio/state/store";
import type { SnapshotDoc } from "../src/features/portfolio/model/types";
import { done, eq, ok, section } from "./_harness";

const emptyDoc = (version: number): SnapshotDoc => ({
  schemaVersion: 1,
  version,
  data: {
    people: [],
    accounts: [],
    categories: [],
    transactions: [],
    holdings: [],
    holdingEvents: [],
    fxRates: [],
  },
});

section("[store] blocks deleting an account that has transactions");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "shared" });
  await store.saveTransaction({
    id: "t1",
    date: "2024-01-01",
    type: "expense",
    accountId: "A1",
    personId: "shared",
    amount: 10,
    currency: "USD",
    updatedAt: "",
  });
  let threw = false;
  try {
    await store.deleteAccount("A1");
  } catch {
    threw = true;
  }
  ok(threw, "delete throws when the account has transactions");
  eq(store.getState().accounts.length, 1, "account is preserved");
}

section("[store] deleting an unused account succeeds");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "shared" });
  await store.deleteAccount("A1");
  eq(store.getState().accounts.length, 0, "unused account removed");
}

section("[store] rehydrates unsynced version + dirty after a reload");
{
  const adapter = createMemoryStorage(SCHEMA);
  const s1 = await createPortfolioStore(adapter);
  await s1.savePerson({ id: "p1", name: "A" }); // edit, not yet synced
  const v1 = s1.getState().version;
  ok(v1 >= 1 && s1.getState().dirty, "after edit: version advanced and dirty");
  // Simulate a tab reload before any push: new store over the same persisted data.
  const s2 = await createPortfolioStore(adapter);
  eq(s2.getState().version, v1, "working version rehydrated (not reset to synced)");
  ok(s2.getState().dirty, "still dirty after reload (edit not lost)");
}

section("[store] loading an older snapshot does not regress the working version");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" });
  await store.savePerson({ id: "p2", name: "B" });
  const advanced = store.getState().version;
  ok(advanced >= 2, "version advanced with edits");
  await store.applyDocument(emptyDoc(0)); // older snapshot
  ok(store.getState().version >= advanced, "version not regressed below prior working version");
}

section("[store] blocks deleting a person who owns an account");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" });
  await store.saveAccount({ id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "p1" });
  let threw = false;
  try {
    await store.deletePerson("p1");
  } catch {
    threw = true;
  }
  ok(threw, "delete throws when the person owns an account");
  eq(store.getState().people.length, 1, "person preserved");
}

section("[store] reconcileVersion lifts the version above the remote max");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" }); // version 1
  await store.reconcileVersion(10); // remote already at v10
  eq(store.getState().version, 11, "version lifted to remoteMax + 1");
  await store.reconcileVersion(5); // older remote
  eq(store.getState().version, 11, "no regress when already above remote");
}

section("[store] backup restore stays dirty so it can be republished");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" });
  await store.markSynced(store.getState().version); // simulate already-synced
  ok(!store.getState().dirty, "clean right after a sync");
  const v = store.getState().version;
  await store.applyDocument(emptyDoc(v), { dirty: true }); // a backup restore
  ok(store.getState().dirty, "restore leaves the store dirty");
  ok(store.getState().version > v, "version advances so the next push wins");
}

section("[store] Drive pull stays clean");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.applyDocument(emptyDoc(7)); // a pull (no dirty opt)
  ok(!store.getState().dirty, "pulled snapshot is clean");
  eq(store.getState().settings.lastSyncedVersion, 7, "lastSyncedVersion = pulled version");
}

section("[store] concurrent commit + settings write stay consistent (no lost version bump)");
{
  const adapter = createMemoryStorage(SCHEMA);
  const store = await createPortfolioStore(adapter);
  const v0 = store.getState().version;
  // Fire a data mutation and a settings change "at once" — the serialization
  // mutex must keep the persisted localVersion in step with the bump.
  await Promise.all([
    store.savePerson({ id: "p1", name: "A" }),
    store.saveSettings({ displayCurrency: "INR" }),
  ]);
  eq(store.getState().version, v0 + 1, "exactly one version bump");
  eq(store.getState().settings.displayCurrency, "INR", "settings change applied");
  eq(store.getState().settings.localVersion, store.getState().version, "persisted localVersion in step");
  const reloaded = await createPortfolioStore(adapter);
  eq(reloaded.getState().version, store.getState().version, "version survives reload (no lost update)");
  ok(reloaded.getState().dirty, "still dirty after reload (edit preserved)");
}

section("[store] concurrent same-collection writes all survive in memory (no clobber)");
{
  const adapter = createMemoryStorage(SCHEMA);
  const store = await createPortfolioStore(adapter);
  await store.saveHolding({
    id: "H1",
    name: "X",
    personId: "shared",
    assetClass: "equity",
    currency: "USD",
    incomeMode: "accumulating",
  });
  // The P1: a slow price refresh (addValuations) finishing WHILE the user saves
  // a manual buy. Both touch `holdingEvents`; the bug was the later emit merging
  // a STALE holdingEvents snapshot computed at call time, silently dropping one.
  await Promise.all([
    store.addValuations([
      { id: "v1", holdingId: "H1", date: "2026-06-28", type: "valuation", amount: 100 },
      { id: "v2", holdingId: "H1", date: "2026-06-28", type: "valuation", amount: 200 },
    ]),
    store.saveHoldingEvent({ id: "b1", holdingId: "H1", date: "2026-06-28", type: "buy", units: 1, price: 50 }),
  ]);
  const mem = store.getState().holdingEvents.map((e) => e.id).sort();
  eq(mem.join(","), "b1,v1,v2", "all 3 events present in memory (none clobbered)");
  const exported = ((await store.exportDocument()).data.holdingEvents ?? []).map((e) => e.id).sort();
  eq(exported.join(","), "b1,v1,v2", "in-memory state matches what's persisted on disk");
}

section("[store] setOpeningPosition replaces the opening and tracks units");
{
  const adapter = createMemoryStorage(SCHEMA);
  const store = await createPortfolioStore(adapter);
  await store.saveHolding({
    id: "H1",
    name: "BTC",
    personId: "shared",
    assetClass: "crypto",
    currency: "USD",
    incomeMode: "accumulating",
  });
  // Onboarded amount-only (no units) — the bug case.
  await store.saveHoldingEvent({ id: "o1", holdingId: "H1", date: "2025-01-01", type: "opening", amount: 5000 });
  // Reconcile to a known quantity.
  await store.setOpeningPosition("H1", { units: 0.085, cost: 5000, date: "2025-01-01" });
  const openings = store.getState().holdingEvents.filter((e) => e.holdingId === "H1" && e.type === "opening");
  eq(openings.length, 1, "exactly one opening (old one replaced, not duplicated)");
  eq(openings[0].units, 0.085, "opening now carries units");
  const exported = ((await store.exportDocument()).data.holdingEvents ?? []).filter(
    (e) => (e as { type: string }).type === "opening",
  );
  eq(exported.length, 1, "single opening persisted on disk too");
}

section("[store] saveSettings deep-merges `drive` (no sibling-field drop)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveSettings({ drive: { clientId: "cid" } });
  await store.saveSettings({ drive: { apiKey: "key" } });
  eq(store.getState().settings.drive?.clientId, "cid", "clientId preserved");
  eq(store.getState().settings.drive?.apiKey, "key", "apiKey added");
}

section("[store] setFxOverride sets then clears a single rate");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.setFxOverride("INR", 83);
  await store.setFxOverride("CLP", 950);
  eq(store.getState().settings.fxOverrides.INR, 83, "INR set");
  eq(store.getState().settings.fxOverrides.CLP, 950, "CLP set (other not dropped)");
  await store.setFxOverride("INR", null); // clear
  ok(!("INR" in store.getState().settings.fxOverrides), "INR cleared");
  eq(store.getState().settings.fxOverrides.CLP, 950, "CLP still present after clearing INR");
}

section("[store] blocks deleting a category with subcategories or used by a transaction");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveCategory({ id: "food", name: "Food", kind: "expense" });
  await store.saveCategory({ id: "groc", name: "Groceries", kind: "expense", parentId: "food" });
  let threwParent = false;
  try {
    await store.deleteCategory("food");
  } catch {
    threwParent = true;
  }
  ok(threwParent, "can't delete a parent that has subcategories");

  await store.saveAccount({ id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "shared" });
  await store.saveTransaction({
    id: "t1",
    date: "2024-01-01",
    type: "expense",
    accountId: "A1",
    personId: "shared",
    amount: 10,
    currency: "USD",
    categoryId: "groc",
    updatedAt: "",
  });
  let threwChild = false;
  try {
    await store.deleteCategory("groc");
  } catch {
    threwChild = true;
  }
  ok(threwChild, "can't delete a category used by a transaction");
}

section("[store] addValuations recomputes amount from CURRENT units (not the stale captured units)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveHolding({
    id: "H1", name: "VOO", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating",
  });
  // 10 units held now.
  await store.saveHoldingEvent({ id: "o1", holdingId: "H1", date: "2024-01-01", type: "opening", units: 10, amount: 1000 });
  // A refresh that started when only 2 units were held would carry amount = 2×50 = 100,
  // but it also carries the per-unit price; the store must re-derive 10×50 = 500.
  await store.addValuations([
    { id: "auto-H1-2024-06-01", holdingId: "H1", date: "2024-06-01", type: "valuation", amount: 100, price: 50, note: "auto: live price" },
  ]);
  const val = store.getState().holdingEvents.find((e) => e.id === "auto-H1-2024-06-01");
  eq(val?.amount, 500, "amount recomputed as current units (10) × price (50), not the stale 100");
}

section("[store] addValuations for a DELETED holding writes no orphan + does not bump version");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  const v0 = store.getState().version;
  await store.addValuations([
    { id: "auto-GONE-2024-06-01", holdingId: "GONE", date: "2024-06-01", type: "valuation", amount: 123, price: 5, note: "auto: live price" },
  ]);
  eq(store.getState().holdingEvents.length, 0, "no orphan valuation event written for a missing holding");
  eq(store.getState().version, v0, "version NOT bumped (nothing to persist or sync)");
}

// --- version bookkeeping used by the envelope-encryption baseline/re-key paths ---
// A regression in any of these silently loses edits or makes a restored/re-keyed
// baseline fail to publish, so they are unit-pinned here (pure, in-memory).

section("[store] bumpVersionAbove lifts a publishable version above the floor");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" }); // version now 1, lastSynced 0
  await store.markSynced(1); // clean at v1
  // A migration/reset publishes a baseline floored at the folder's max (say 7).
  await store.bumpVersionAbove(7);
  const s = store.getState();
  eq(s.version, 8, "version = max(state, floor) + 1 = 8");
  eq(s.settings.lastSyncedVersion, 7, "lastSyncedVersion set to the floor (everything up to it superseded)");
  ok(s.dirty, "dirty so the baseline actually publishes");
}

section("[store] bumpVersionAbove uses the local version when it already exceeds the floor");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" });
  await store.savePerson({ id: "p2", name: "B" }); // version now 2
  await store.bumpVersionAbove(0); // floor below local
  eq(store.getState().version, 3, "version = max(2, 0) + 1 = 3 (local version wins)");
  eq(store.getState().settings.lastSyncedVersion, 0, "lastSyncedVersion = floor (0)");
}

section("[store] applyDocument (pull) marks synced + clean; never regresses the version");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" }); // local version 1, dirty
  // Pull a HIGHER remote version → adopt it, mark synced, clean.
  await store.applyDocument(emptyDoc(5));
  let s = store.getState();
  eq(s.version, 5, "version adopts the pulled doc version");
  eq(s.settings.lastSyncedVersion, 5, "lastSyncedVersion = pulled version");
  ok(!s.dirty, "clean after a pull (this IS what's on the remote)");
  eq(s.people.length, 0, "pulled (empty) data replaced local");
  // Pull an OLDER version → working version must not regress below the local one.
  await store.savePerson({ id: "p2", name: "B" }); // version 6, dirty
  await store.applyDocument(emptyDoc(3));
  s = store.getState();
  ok(s.version >= 6, "loading an older snapshot does not regress the working version");
}

section("[store] applyDocument(dirty) keeps a restore publishable (strictly above lastSynced)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" });
  await store.markSynced(1); // synced at v1
  // Restore a backup whose version (1) is NOT above lastSynced → must be lifted so
  // "Sync now" uploads it instead of taking the "nothing to sync" path.
  await store.applyDocument(emptyDoc(1), { dirty: true });
  const s = store.getState();
  ok(s.dirty, "restore stays dirty");
  ok(s.version > s.settings.lastSyncedVersion, "version lifted strictly above lastSyncedVersion so it publishes");
  eq(s.settings.lastSyncedVersion, 1, "lastSyncedVersion unchanged by a dirty restore (we didn't pull)");
}

section("[store] markSynced clears dirty only when nothing raced ahead");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "A" }); // version 1
  await store.markSynced(1);
  ok(!store.getState().dirty, "clean when the synced version matches the working version");
  await store.savePerson({ id: "p2", name: "B" }); // version 2, dirty
  await store.markSynced(1); // an older push confirmed while v2 is pending
  ok(store.getState().dirty, "still dirty because v2 hasn't been synced (no lost edit)");
}

done();
