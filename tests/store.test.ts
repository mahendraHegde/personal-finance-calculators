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
  await store.saveCategory({ id: "food", name: "Food" });
  await store.saveCategory({ id: "groc", name: "Groceries", parentId: "food" });
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

section("[store] reconcileAutopay materialises a payoff, is idempotent, and cleans up when disabled");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "shared" });
  await store.saveAccount({
    id: "CC",
    name: "Card",
    type: "creditcard",
    currency: "USD",
    personId: "shared",
    autopay: { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" },
  });
  await store.saveTransaction({
    id: "c1",
    date: "2025-05-05",
    type: "expense",
    accountId: "CC",
    personId: "shared",
    amount: 1500,
    currency: "USD",
    updatedAt: "",
  });

  await store.reconcileAutopay("2025-06-30");
  const autopayTxns = () => store.getState().transactions.filter((t) => t.id.startsWith("autopay:"));
  eq(autopayTxns().length, 1, "a managed payoff transfer is created");
  eq(autopayTxns()[0].amount, 1500, "for the statement balance");
  const afterFirst = store.getState().version;

  await store.reconcileAutopay("2025-06-30");
  eq(store.getState().version, afterFirst, "second reconcile is a no-op (no version bump)");
  eq(autopayTxns().length, 1, "still exactly one payoff (idempotent, no duplicate)");

  // Turning auto-pay off removes the managed transfer on the next reconcile.
  await store.saveAccount({ id: "CC", name: "Card", type: "creditcard", currency: "USD", personId: "shared" });
  await store.reconcileAutopay("2025-06-30");
  eq(autopayTxns().length, 0, "disabling auto-pay deletes the managed payoff");
}

section("[store] reconcileAutopay doesn't materialise a closed-but-not-yet-due statement early");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "shared" });
  await store.saveAccount({
    id: "CC",
    name: "Card",
    type: "creditcard",
    currency: "USD",
    personId: "shared",
    autopay: { fromAccountId: "BANK", statementDay: 10, dueDay: 15, dueNextMonth: true, since: "2025-01-01" },
  });
  await store.saveTransaction({
    id: "c1", date: "2025-05-01", type: "expense", accountId: "CC", personId: "shared", amount: 800, currency: "USD", updatedAt: "",
  });
  const autopayTxns = () => store.getState().transactions.filter((t) => t.id.startsWith("autopay:"));
  // Statement closed 05-10, due 06-15. As of 05-20 it's closed but NOT due.
  await store.reconcileAutopay("2025-05-20");
  eq(autopayTxns().length, 0, "closed but not due → not created yet");
  // Once the due date passes, it's created.
  await store.reconcileAutopay("2025-06-20");
  eq(autopayTxns().length, 1, "created once due");
  eq(autopayTxns()[0].amount, 800, "for the statement balance");
}

section("[store] reconcileAutopay keeps a payoff a peer created, even when THIS clock is before its due date");
{
  // Simulates a multi-device timezone skew: device A generated the payoff (due
  // passed there); device B pulls it and reconciles with an earlier `asOf`. B must
  // NOT delete it (deletion is by structural desire, not the local clock) — that's
  // what prevents cross-device ping-pong.
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "shared" });
  await store.saveAccount({
    id: "CC", name: "Card", type: "creditcard", currency: "USD", personId: "shared",
    autopay: { fromAccountId: "BANK", statementDay: 10, dueDay: 15, dueNextMonth: true, since: "2025-01-01" },
  });
  await store.saveTransaction({
    id: "c1", date: "2025-05-01", type: "expense", accountId: "CC", personId: "shared", amount: 800, currency: "USD", updatedAt: "",
  });
  const autopayTxns = () => store.getState().transactions.filter((t) => t.id.startsWith("autopay:"));
  await store.reconcileAutopay("2025-06-20"); // "device A": due has passed → created
  eq(autopayTxns().length, 1, "created when due");
  await store.reconcileAutopay("2025-05-20"); // "device B": clock before the due date
  eq(autopayTxns().length, 1, "NOT deleted despite the earlier clock (no ping-pong)");
}

section("[store] deleting a payer cascade-removes managed auto-pay transfers + clears the dangling config");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "shared" });
  await store.saveAccount({
    id: "CC", name: "Card", type: "creditcard", currency: "USD", personId: "shared",
    autopay: { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" },
  });
  await store.saveTransaction({
    id: "c1", date: "2025-05-05", type: "expense", accountId: "CC", personId: "shared", amount: 500, currency: "USD", updatedAt: "",
  });
  await store.reconcileAutopay("2025-06-30");
  ok(store.getState().transactions.some((t) => t.id.startsWith("autopay:")), "a managed payoff exists (BANK → CC)");
  // A card with real charges can't be deleted (its history blocks it) — that's
  // correct, not a trap. But the PAYER's only reference is the managed transfer, so
  // deleting it should succeed, cascade-delete the transfer, and clear CC's now-
  // dangling auto-pay config (rather than throw the dead-end error).
  let threw = false;
  try {
    await store.deleteAccount("CC");
  } catch {
    threw = true;
  }
  ok(threw, "card with real charges is still protected (blocked by its charge history)");
  await store.deleteAccount("BANK");
  eq(store.getState().accounts.some((a) => a.id === "BANK"), false, "payer deleted");
  eq(store.getState().transactions.filter((t) => t.id.startsWith("autopay:")).length, 0, "managed transfers cascade-deleted");
  eq(store.getState().accounts.find((a) => a.id === "CC")?.autopay, undefined, "CC's dangling auto-pay config cleared");
}

const rejects = async (fn: () => Promise<unknown>, msg: string): Promise<void> => {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  ok(threw, msg);
};

section("[store] settleFd withdraw: deposits (excludeFromReports) + archives the FD");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "BANK", name: "SBI", type: "bank", currency: "INR", personId: "p1" });
  await store.saveHolding({
    id: "FD1",
    name: "SBI FD",
    personId: "p1",
    accountId: "BANK",
    assetClass: "debt",
    currency: "INR",
    incomeMode: "accumulating",
    fd: { ratePct: 7, compounding: "quarterly", maturityDate: "2026-01-01" },
  });
  await store.settleFd("FD1", { mode: "withdraw", toAccountId: "BANK", amount: 108000 });
  ok(store.getState().holdings.find((x) => x.id === "FD1")?.archived === true, "FD archived after withdraw");
  const txns = store.getState().transactions;
  eq(txns.length, 1, "one deposit transaction created");
  const t = txns[0]!;
  eq(t.type, "income", "deposit is an income transaction");
  eq(t.accountId, "BANK", "deposited into the chosen account");
  eq(t.amount, 108000, "amount is the settled value");
  eq(t.currency, "INR", "currency DERIVED from the account (not the caller)");
  eq(t.personId, "p1", "attributed to the FD owner");
  ok(t.excludeFromReports === true, "flagged out of income/expense reports");
  ok((t.note ?? "").includes("SBI FD"), "note references the FD");
  // Persisted, not just in memory.
  const exported = (await store.exportDocument()).data;
  ok((exported.holdings ?? []).find((h) => h.id === "FD1")?.archived === true, "archive persisted");
  eq((exported.transactions ?? []).length, 1, "deposit persisted");
}

section("[store] settleFd withdraw: deposit currency is the ACCOUNT's, not the FD's");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "USDACC", name: "Schwab", type: "brokerage", currency: "USD", personId: "p1" });
  await store.saveHolding({
    id: "FD1",
    name: "INR FD",
    personId: "p1",
    assetClass: "debt",
    currency: "INR",
    incomeMode: "accumulating",
    fd: { ratePct: 7, compounding: "quarterly" },
  });
  // The UI converts the amount; the store records it verbatim but must stamp the
  // ACCOUNT's currency (a divergent currency would corrupt the account balance).
  await store.settleFd("FD1", { mode: "withdraw", toAccountId: "USDACC", amount: 1300 });
  const t = store.getState().transactions[0]!;
  eq(t.currency, "USD", "deposit currency = the target account's (USD), not the FD's (INR)");
  eq(t.accountId, "USDACC", "deposited into the USD account");
}

section("[store] settleFd renew: archives with NO transaction");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveHolding({
    id: "FD1",
    name: "HDFC FD",
    personId: "p1",
    assetClass: "debt",
    currency: "INR",
    incomeMode: "accumulating",
    fd: { ratePct: 6, compounding: "quarterly" },
  });
  await store.settleFd("FD1", { mode: "renew" });
  ok(store.getState().holdings.find((x) => x.id === "FD1")?.archived === true, "FD archived on renew");
  eq(store.getState().transactions.length, 0, "renew creates no transaction");
}

section("[store] settleFd guards are atomic (non-FD, missing account, bad amount, double-settle)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "p1" });
  await store.saveHolding({ id: "EQ", name: "AAPL", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" });
  await rejects(() => store.settleFd("EQ", { mode: "renew" }), "settling a non-FD throws");
  ok(store.getState().holdings.find((x) => x.id === "EQ")?.archived !== true, "non-FD left unarchived");

  await rejects(() => store.settleFd("MISSING", { mode: "renew" }), "settling a missing holding throws");

  await store.saveHolding({ id: "FD", name: "FD", personId: "p1", assetClass: "debt", currency: "USD", incomeMode: "accumulating", fd: { ratePct: 5, compounding: "annually" } });
  await rejects(
    () => store.settleFd("FD", { mode: "withdraw", toAccountId: "NOPE", amount: 100 }),
    "withdraw to a missing account throws",
  );
  ok(store.getState().holdings.find((x) => x.id === "FD")?.archived !== true, "FD NOT archived after failed withdraw (atomic — no partial write)");
  eq(store.getState().transactions.length, 0, "no deposit written on failure");

  await rejects(
    () => store.settleFd("FD", { mode: "withdraw", toAccountId: "BANK", amount: 0 }),
    "non-positive amount throws",
  );
  await rejects(
    () => store.settleFd("FD", { mode: "withdraw", toAccountId: "BANK", amount: Number.NaN }),
    "NaN amount throws",
  );
  await rejects(
    () => store.settleFd("FD", { mode: "withdraw", toAccountId: "BANK", amount: Number.POSITIVE_INFINITY }),
    "infinite amount throws",
  );
  ok(store.getState().holdings.find((x) => x.id === "FD")?.archived !== true, "FD NOT archived after a bad amount");

  await store.settleFd("FD", { mode: "renew" });
  await rejects(() => store.settleFd("FD", { mode: "renew" }), "settling an already-settled FD throws");
}

section("[store] mergeCategories: re-points transactions, re-parents subcategories, deletes the source");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount({ id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "p1" });
  await store.saveCategory({ id: "food", name: "Food" }); // source: top-level, has a child
  await store.saveCategory({ id: "snacks", name: "Snacks", parentId: "food" });
  await store.saveCategory({ id: "grocery", name: "Grocery" }); // target: top-level
  const tx = (id: string, categoryId: string): Promise<void> =>
    store.saveTransaction({
      id, date: "2026-01-01", type: "expense", accountId: "A1", personId: "p1", amount: 5, currency: "USD", categoryId, updatedAt: "",
    });
  await tx("t1", "food");
  await tx("t2", "food");
  await tx("t3", "snacks"); // on the CHILD — must not move (child survives, re-parented)
  await store.mergeCategories("food", "grocery");
  const cats = store.getState().categories;
  const txns = store.getState().transactions;
  ok(!cats.some((c) => c.id === "food"), "source category deleted");
  eq(cats.find((c) => c.id === "snacks")?.parentId, "grocery", "source's subcategory re-parented under target");
  eq(txns.find((t) => t.id === "t1")?.categoryId, "grocery", "source txn re-pointed to target");
  eq(txns.find((t) => t.id === "t2")?.categoryId, "grocery", "source txn re-pointed to target");
  eq(txns.find((t) => t.id === "t3")?.categoryId, "snacks", "child's txn left unchanged");
}

section("[store] mergeCategories guards are atomic (self, missing, into-own-subcategory, subcats→non-top target)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveCategory({ id: "a", name: "A" });
  await store.saveCategory({ id: "asub", name: "A-sub", parentId: "a" });
  await store.saveCategory({ id: "b", name: "B" });
  await store.saveCategory({ id: "bsub", name: "B-sub", parentId: "b" });
  await rejects(() => store.mergeCategories("a", "a"), "merge into itself throws");
  await rejects(() => store.mergeCategories("a", "nope"), "merge into a missing target throws");
  await rejects(() => store.mergeCategories("nope", "b"), "merge from a missing source throws");
  await rejects(() => store.mergeCategories("a", "asub"), "merge a parent into its own subcategory throws");
  // 'a' has a subcategory, so a non-top-level target ('bsub') would nest 3 levels → block.
  await rejects(() => store.mergeCategories("a", "bsub"), "merge (source has subcats) into a subcategory target throws");
  eq(store.getState().categories.length, 4, "no category added/removed by failed merges");
  eq(store.getState().categories.find((c) => c.id === "asub")?.parentId, "a", "asub still under 'a' (atomic — no partial write)");
}

done();
