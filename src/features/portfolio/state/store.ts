// Central portfolio store — framework-agnostic (no React import) so it can be
// unit-tested. Holds the working set in memory (aggregates need the full set),
// persists every mutation to the StorageAdapter, derives the FX table, and
// tracks the snapshot version + dirty flag that drive sync. React subscribes
// via useSyncExternalStore (subscribe + getState).

import type { BatchOp, Entity, StorageAdapter } from "../../../lib/storage/types";
import type { CurrencyCode, FxTable } from "../../../lib/money/currency";
import { withOverrides } from "../../../lib/fx/fx-service";
import { newId } from "../../../lib/util/id";
import { todayIso } from "../../../lib/util/format";
import { Collections, SCHEMA } from "../model/schema";
import type {
  Account,
  AppSettings,
  Category,
  FxRateSnapshot,
  Holding,
  HoldingEvent,
  ImportBatch,
  Person,
  SnapshotDoc,
  Transaction,
} from "../model/types";
import { createPortfolioRepo, type PortfolioRepo } from "../repo/portfolio-repo";
import { netUnits } from "../domain/holdings";
import { AUTO_VALUATION_NOTE } from "../domain/prices";
import { desiredAutopayTransfers, isAutopayTransaction, planAutopayReconcile } from "../domain/autopay";
import { importEventIdPrefix, type ImportPlan } from "../domain/import-holdings";

export interface PortfolioState {
  ready: boolean;
  people: Person[];
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  holdings: Holding[];
  holdingEvents: HoldingEvent[];
  fxRates: FxRateSnapshot[];
  settings: AppSettings;
  /** USD-anchored table (latest cached rates + manual overrides). */
  fx: FxTable;
  version: number;
  dirty: boolean;
}

const USD_ONLY: FxTable = { base: "USD", rates: { USD: 1 } };

// Import-undo log retention — undo is a short-term convenience, so the local record is
// bounded by BOTH age and count and never kept forever.
const IMPORT_BATCH_TTL_DAYS = 30;
const IMPORT_BATCH_KEEP = 25;

function defaultSettings(): AppSettings {
  return {
    id: "app",
    displayCurrency: "USD",
    deviceId: newId(),
    author: "me",
    fxOverrides: {},
    lastSyncedVersion: 0,
    localVersion: 0,
  };
}

/** Re-point an imported event to `toHoldingId`, stamping createdAt. Identity when
 *  from === to (the common case); only the M1 re-match (a draft merged into a live
 *  holding a concurrent preview created) changes the holding, and then the event's
 *  `import:<fromId>:...` id must be rewritten to `import:<toId>:...` so it dedups
 *  against that holding's existing imported events instead of double-counting. */
function retargetImportEvent(e: HoldingEvent, fromHoldingId: string, toHoldingId: string, now: string): HoldingEvent {
  if (fromHoldingId === toHoldingId) return { ...e, createdAt: e.createdAt ?? now };
  const oldPrefix = importEventIdPrefix(fromHoldingId);
  const id = e.id.startsWith(oldPrefix) ? `${importEventIdPrefix(toHoldingId)}${e.id.slice(oldPrefix.length)}` : e.id;
  return { ...e, id, holdingId: toHoldingId, createdAt: e.createdAt ?? now };
}

export class PortfolioStore {
  private readonly adapter: StorageAdapter;
  private readonly repo: PortfolioRepo;
  private state: PortfolioState;
  private listeners = new Set<() => void>();

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
    this.repo = createPortfolioRepo(adapter);
    this.state = {
      ready: false,
      people: [],
      accounts: [],
      categories: [],
      transactions: [],
      holdings: [],
      holdingEvents: [],
      fxRates: [],
      settings: defaultSettings(),
      fx: USD_ONLY,
      version: 0,
      dirty: false,
    };
  }

  // -- subscription (useSyncExternalStore) ---------------------------------
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getState = (): PortfolioState => this.state;

  private emit(next: Partial<PortfolioState>): void {
    this.state = { ...this.state, ...next };
    for (const cb of this.listeners) cb();
  }

  // Serialises every settings/version read-modify-write so they can't interleave
  // across `await` gaps. Without this, e.g. a `saveSettings` could persist the
  // settings row with a STALE localVersion right after a `commit` bumped it,
  // making a real edit look "already synced" (silent loss). Single-threaded JS +
  // this promise chain = no lost updates.
  private writeChain: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // -- lifecycle -----------------------------------------------------------
  async init(): Promise<void> {
    const [people, accounts, categories, transactions, holdings, holdingEvents, fxRates, settingsRows] =
      await Promise.all([
        this.repo.people.getAll(),
        this.repo.accounts.getAll(),
        this.repo.categories.getAll(),
        this.repo.transactions.getAll(),
        this.repo.holdings.getAll(),
        this.repo.holdingEvents.getAll(),
        this.repo.fxRates.getAll(),
        this.adapter.collection<AppSettings>(Collections.settings).getAll(),
      ]);

    let settings = settingsRows[0];
    if (!settings) {
      settings = defaultSettings();
      await this.adapter.collection<AppSettings>(Collections.settings).put(settings);
    }

    // Rehydrate the working version from persistence so unsynced edits made
    // before a reload aren't silently treated as already-synced.
    const version = Math.max(settings.localVersion, settings.lastSyncedVersion);
    this.emit({
      ready: true,
      people,
      accounts,
      categories,
      transactions,
      holdings,
      holdingEvents,
      fxRates,
      settings,
      fx: this.computeFx(fxRates, settings),
      version,
      dirty: version > settings.lastSyncedVersion,
    });
    // Sweep expired/over-cap import-undo records on open (device-local, best-effort).
    void this.pruneImportBatches();
  }

  private computeFx(fxRates: FxRateSnapshot[], settings: AppSettings): FxTable {
    const latest = [...fxRates].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const base: FxTable = latest ? { base: latest.base, rates: latest.rates } : USD_ONLY;
    return withOverrides(base, settings.fxOverrides);
  }

  // -- generic helpers -----------------------------------------------------
  /**
   * Persist a data change AND the version bump in a SINGLE atomic transaction,
   * then update in-memory state. This is the only mutation path: it guarantees
   * a crash can't leave the row written but the version/dirty bookkeeping not
   * (which would make the edit look "already synced" and silently lose it).
   * `localVersion` is persisted so the working version/dirty survives a reload.
   *
   * `build` is a THUNK evaluated INSIDE the serialization lock — so any read of
   * `this.state` (the in-memory patch, a cascade-delete's op list, a record's
   * author/createdAt) sees post-serialization state. Computing the patch eagerly
   * at call time would let two concurrent same-collection writes clobber each
   * other's in-memory change (the later `emit` merging a stale list), silently
   * showing wrong values until a reload — so callers MUST read `this.state`
   * inside the thunk, never close over a pre-read snapshot.
   */
  private commit(
    build: () => { ops: BatchOp[]; patch: Partial<PortfolioState> },
  ): Promise<void> {
    return this.exclusive(async () => {
      const { ops, patch } = build();
      // A build that resolves to NO data ops (e.g. a price refresh whose target
      // holdings were all deleted/closed during the fetch await-gap) must not bump
      // the version or mark the document dirty — there is nothing to persist or
      // sync. Every other caller always produces at least one op.
      if (ops.length === 0) return;
      const version = this.state.version + 1;
      const settings: AppSettings = { ...this.state.settings, localVersion: version, id: "app" };
      await this.adapter.batch([
        ...ops,
        { collection: Collections.settings, op: "put", value: settings },
      ]);
      this.emit({ ...patch, settings, version, dirty: true });
    });
  }

  private replace<T extends Entity>(list: T[], rec: T): T[] {
    const i = list.findIndex((x) => x.id === rec.id);
    if (i < 0) return [...list, rec];
    const copy = list.slice();
    copy[i] = rec;
    return copy;
  }

  // -- people --------------------------------------------------------------
  async savePerson(p: Person): Promise<void> {
    await this.commit(() => ({
      ops: [{ collection: Collections.people, op: "put", value: p }],
      patch: { people: this.replace(this.state.people, p) },
    }));
  }
  async deletePerson(id: string): Promise<void> {
    // Refuse to orphan owned rows (there's no ownership-reassign UI, so they'd
    // be stuck rendering as "Unknown"). The check runs INSIDE the commit thunk so
    // it reads post-serialization state — a row referencing this person added by a
    // concurrent commit is seen, so the guard can't be raced into orphaning.
    await this.commit(() => {
      const referenced =
        this.state.accounts.some((a) => a.personId === id) ||
        this.state.holdings.some((h) => h.personId === id) ||
        this.state.transactions.some((t) => t.personId === id);
      if (referenced) {
        throw new Error("This person owns accounts, holdings, or transactions — reassign or remove them first.");
      }
      return {
        ops: [{ collection: Collections.people, op: "delete", id }],
        patch: { people: this.state.people.filter((x) => x.id !== id) },
      };
    });
  }

  // -- accounts ------------------------------------------------------------
  async saveAccount(a: Account): Promise<void> {
    await this.commit(() => ({
      ops: [{ collection: Collections.accounts, op: "put", value: a }],
      patch: { accounts: this.replace(this.state.accounts, a) },
    }));
  }
  async deleteAccount(id: string): Promise<void> {
    // Refuse to orphan history: deleting an account with transactions/holdings
    // would drop its balance from net worth while the rows linger as "—". Checked
    // inside the commit thunk so a concurrently-added referencing row is seen.
    // MANAGED auto-pay transfers are exempt: they're derived, not hand-entered, so
    // they don't block deletion — instead they're cascade-deleted in the SAME
    // commit (otherwise a card/payer could never be deleted while auto-pay was on,
    // and "remove them first" would be a dead end since reconcile recreates them).
    await this.commit(() => {
      const references = (t: Transaction): boolean => t.accountId === id || t.transferToAccountId === id;
      const usedByTxn = this.state.transactions.some((t) => references(t) && !isAutopayTransaction(t));
      const usedByHolding = this.state.holdings.some((h) => h.accountId === id);
      if (usedByTxn || usedByHolding) {
        throw new Error("This account has transactions or holdings — remove or reassign them first.");
      }
      const managed = this.state.transactions.filter((t) => references(t) && isAutopayTransaction(t));
      const managedIds = new Set(managed.map((t) => t.id));
      // Any card that paid FROM this account now has a dangling payer — clear its
      // auto-pay config so it doesn't silently reference a deleted account.
      const orphanedCards = this.state.accounts.filter((a) => a.id !== id && a.autopay?.fromAccountId === id);
      const clearAutopay = (a: Account): Account => {
        const copy = { ...a };
        delete copy.autopay;
        return copy;
      };
      const orphanedIds = new Set(orphanedCards.map((a) => a.id));
      return {
        ops: [
          { collection: Collections.accounts, op: "delete", id },
          ...managed.map((t): BatchOp => ({ collection: Collections.transactions, op: "delete", id: t.id })),
          ...orphanedCards.map((a): BatchOp => ({ collection: Collections.accounts, op: "put", value: clearAutopay(a) })),
        ],
        patch: {
          accounts: this.state.accounts
            .filter((x) => x.id !== id)
            .map((a) => (orphanedIds.has(a.id) ? clearAutopay(a) : a)),
          transactions: this.state.transactions.filter((t) => !managedIds.has(t.id)),
        },
      };
    });
  }

  // -- categories ----------------------------------------------------------
  async saveCategory(c: Category): Promise<void> {
    await this.commit(() => ({
      ops: [{ collection: Collections.categories, op: "put", value: c }],
      patch: { categories: this.replace(this.state.categories, c) },
    }));
  }
  async deleteCategory(id: string): Promise<void> {
    // Checked inside the commit thunk (post-serialization state) so a concurrently
    // added referencing transaction / subcategory is seen and not orphaned.
    await this.commit(() => {
      // Refuse to orphan history: transactions referencing this category would
      // lose their label and collapse under "Unknown" in filters/rollups.
      if (this.state.transactions.some((t) => t.categoryId === id)) {
        throw new Error("This category is used by transactions — reassign or remove them first.");
      }
      // And don't orphan subcategories under a deleted parent.
      if (this.state.categories.some((c) => c.parentId === id)) {
        throw new Error("This category has subcategories — remove them first.");
      }
      return {
        ops: [{ collection: Collections.categories, op: "delete", id }],
        patch: { categories: this.state.categories.filter((x) => x.id !== id) },
      };
    });
  }

  // -- transactions --------------------------------------------------------
  async saveTransaction(t: Transaction): Promise<void> {
    await this.commit(() => {
      const rec = { ...t, updatedAt: new Date().toISOString(), author: this.state.settings.author };
      return {
        ops: [{ collection: Collections.transactions, op: "put", value: rec }],
        patch: { transactions: this.replace(this.state.transactions, rec) },
      };
    });
  }
  async deleteTransaction(id: string): Promise<void> {
    await this.commit(() => ({
      ops: [{ collection: Collections.transactions, op: "delete", id }],
      patch: { transactions: this.state.transactions.filter((x) => x.id !== id) },
    }));
  }

  /** Bring the managed credit-card auto-pay transfers in line with each card's
   *  config as of `asOf`: create newly-due payoffs, update ones whose statement
   *  amount changed, and delete any no longer wanted (auto-pay turned off, a cycle
   *  now fully credited, config narrowed). Deterministic ids make this idempotent —
   *  when nothing differs it produces ZERO ops, so `commit` is a true no-op (no
   *  version bump, no dirty flag, no sync churn). Safe to call on every state
   *  change; NOT called from inside another commit (that would deadlock the lock).
   */
  async reconcileAutopay(asOf: string): Promise<void> {
    await this.commit(() => {
      // The DECISION (create-gate, update-if-changed, delete-by-desire) is a pure
      // domain function so it's testable without the store; here we just stamp and
      // persist it.
      const desired = desiredAutopayTransfers(this.state.accounts, this.state.transactions, asOf, this.state.fx);
      const existing = this.state.transactions.filter(isAutopayTransaction);
      const { toPut, toDeleteIds } = planAutopayReconcile(existing, desired, asOf);
      // Nothing changed → true no-op (commit skips the version bump on empty ops).
      if (toPut.length === 0 && toDeleteIds.length === 0) return { ops: [], patch: {} };

      const now = new Date().toISOString();
      const author = this.state.settings.author;
      const puts = new Map<string, Transaction>(toPut.map((d) => [d.id, { ...d, updatedAt: now, author }]));
      const deletes = new Set(toDeleteIds);
      const ops: BatchOp[] = [
        ...[...puts.values()].map(
          (rec): BatchOp => ({ collection: Collections.transactions, op: "put", value: rec }),
        ),
        ...toDeleteIds.map((id): BatchOp => ({ collection: Collections.transactions, op: "delete", id })),
      ];
      // Rebuild the transactions list in ONE pass (O(T + changes)) rather than a
      // replace/filter per change (O(changes × T)) — matters on first-load catch-up.
      const next: Transaction[] = [];
      for (const t of this.state.transactions) {
        if (deletes.has(t.id)) continue;
        const updated = puts.get(t.id);
        if (updated) {
          next.push(updated);
          puts.delete(t.id); // consumed → the leftover puts are brand-new payoffs
        } else {
          next.push(t);
        }
      }
      for (const rec of puts.values()) next.push(rec);
      return { ops, patch: { transactions: next } };
    });
  }

  // -- holdings & events ---------------------------------------------------
  async saveHolding(h: Holding): Promise<void> {
    await this.commit(() => ({
      ops: [{ collection: Collections.holdings, op: "put", value: h }],
      patch: { holdings: this.replace(this.state.holdings, h) },
    }));
  }
  async deleteHolding(id: string): Promise<void> {
    // Delete the holding AND cascade-delete its events in ONE transaction. The
    // event list is read inside the thunk so a concurrently-added event to this
    // holding is still caught by the cascade.
    await this.commit(() => {
      const events = this.state.holdingEvents.filter((e) => e.holdingId === id);
      return {
        ops: [
          { collection: Collections.holdings, op: "delete", id },
          ...events.map(
            (e): BatchOp => ({ collection: Collections.holdingEvents, op: "delete", id: e.id }),
          ),
        ],
        patch: {
          holdings: this.state.holdings.filter((x) => x.id !== id),
          holdingEvents: this.state.holdingEvents.filter((e) => e.holdingId !== id),
        },
      };
    });
  }
  /** Settle (close out) a fixed deposit in ONE atomic commit. Two modes:
   *  - `withdraw`: record the matured/broken value as an income transaction on
   *    `toAccountId`, flagged `excludeFromReports` (so it RAISES the account balance
   *    — net worth is unchanged, the money merely moved from FD to bank — WITHOUT
   *    showing up as earned income; the interest already lived inside the FD's
   *    return), then archive the FD.
   *  - `renew`: just archive the FD. Per the chosen model no lineage is tracked —
   *    the user records the renewed deposit(s) as fresh holdings themselves (a broken
   *    FD may become two, or two may combine into one).
   *  Archiving is what removes the FD from net worth, portfolio value and the default
   *  Active view. Guarded: throws if the holding is missing, isn't an FD, or is
   *  already settled — and, for `withdraw`, if the account is missing or the amount
   *  isn't a positive finite number (the UI pre-fills the accrued value; the whole
   *  thing is one transaction, so a bad input aborts with no partial write). */
  async settleFd(
    holdingId: string,
    opts:
      | { mode: "withdraw"; toAccountId: string; amount: number; note?: string }
      | { mode: "renew" },
  ): Promise<void> {
    await this.commit(() => {
      const holding = this.state.holdings.find((h) => h.id === holdingId);
      if (!holding) throw new Error("Holding not found");
      if (!holding.fd) throw new Error("Only a fixed deposit can be settled");
      if (holding.archived) throw new Error("This fixed deposit is already settled");

      const archived: Holding = { ...holding, archived: true };
      const ops: BatchOp[] = [{ collection: Collections.holdings, op: "put", value: archived }];
      const patch: Partial<PortfolioState> = { holdings: this.replace(this.state.holdings, archived) };

      if (opts.mode === "withdraw") {
        const account = this.state.accounts.find((a) => a.id === opts.toAccountId);
        if (!account) throw new Error("Deposit account not found");
        if (!Number.isFinite(opts.amount) || opts.amount <= 0) {
          throw new Error("Deposit amount must be a positive number");
        }
        const txn: Transaction = {
          id: newId(),
          date: todayIso(),
          type: "income",
          accountId: account.id,
          personId: holding.personId, // the settled cash belongs to the FD's owner
          amount: opts.amount,
          // DERIVED from the account, never taken from the caller — a divergent currency
          // would post `amount` raw into an account of another currency and corrupt its
          // balance & net worth (the app's account-currency invariant).
          currency: account.currency,
          note: opts.note?.trim() || `FD settled: ${holding.name}`,
          excludeFromReports: true,
          updatedAt: new Date().toISOString(),
          author: this.state.settings.author,
        };
        ops.push({ collection: Collections.transactions, op: "put", value: txn });
        patch.transactions = this.replace(this.state.transactions, txn);
      }
      return { ops, patch };
    });
  }
  async saveHoldingEvent(e: HoldingEvent): Promise<void> {
    await this.commit(() => {
      // Stamp creation time (once) so same-date valuations have a tiebreak.
      const rec: HoldingEvent = { ...e, createdAt: e.createdAt ?? new Date().toISOString() };
      return {
        ops: [{ collection: Collections.holdingEvents, op: "put", value: rec }],
        patch: { holdingEvents: this.replace(this.state.holdingEvents, rec) },
      };
    });
  }
  async deleteHoldingEvent(id: string): Promise<void> {
    await this.commit(() => ({
      ops: [{ collection: Collections.holdingEvents, op: "delete", id }],
      patch: { holdingEvents: this.state.holdingEvents.filter((x) => x.id !== id) },
    }));
  }
  /** Append many events in ONE atomic commit (one version bump for the whole
   *  batch). Used by the live-price refresh to save auto-valuations together so
   *  a partial crash can't leave some priced and the version half-bumped. The
   *  recs (and the in-memory merge) are built inside the thunk so a refresh that
   *  finishes WHILE the user is editing doesn't clobber their concurrent edit. */
  async addValuations(events: HoldingEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    let persisted = 0;
    await this.commit(() => {
      // Re-validate against LIVE, post-serialization state inside the lock:
      //  (1) DROP a valuation whose holding was deleted during the price fetch's
      //      await-gap (or by a Drive pull) — otherwise it persists as an orphan
      //      event that nothing cleans up.
      //  (2) RECOMPUTE amount = CURRENT units × price for auto-valuations that
      //      carry a price, so a refresh that captured stale units (a concurrent
      //      edit / overlapping refresh) can't persist a wrong value — whatever
      //      commits last reflects the true current position.
      const holdingIds = new Set(this.state.holdings.map((h) => h.id));
      const recs: HoldingEvent[] = [];
      for (const e of events) {
        if (!holdingIds.has(e.holdingId)) continue; // holding gone → skip (no orphan)
        let rec: HoldingEvent = { ...e, createdAt: e.createdAt ?? new Date().toISOString() };
        if (rec.type === "valuation" && rec.price !== undefined) {
          const units = netUnits(this.state.holdingEvents.filter((ev) => ev.holdingId === e.holdingId));
          if (units === null || units <= 0) continue; // no longer held / untracked → don't write a stale value
          rec = { ...rec, amount: units * rec.price };
        }
        recs.push(rec);
      }
      persisted = recs.length;
      return {
        ops: recs.map((e): BatchOp => ({ collection: Collections.holdingEvents, op: "put", value: e })),
        patch: { holdingEvents: recs.reduce((list, e) => this.replace(list, e), this.state.holdingEvents) },
      };
    });
    return persisted;
  }
  /** Reconcile a holding to a known QUANTITY: replace its `opening` event(s) with
   *  a single units-bearing opening (so live pricing can value it as units ×
   *  price). Leaves buys/sells/dividends/valuations intact. One atomic commit. */
  async setOpeningPosition(
    holdingId: string,
    opts: { units: number; cost?: number; date: string },
  ): Promise<void> {
    await this.commit(() => {
      const rec: HoldingEvent = {
        id: newId(),
        holdingId,
        date: opts.date,
        type: "opening",
        units: opts.units,
        amount: opts.cost,
        createdAt: new Date().toISOString(),
      };
      const isOldOpening = (e: HoldingEvent): boolean => e.holdingId === holdingId && e.type === "opening";
      return {
        ops: [
          ...this.state.holdingEvents
            .filter(isOldOpening)
            .map((e): BatchOp => ({ collection: Collections.holdingEvents, op: "delete", id: e.id })),
          { collection: Collections.holdingEvents, op: "put", value: rec },
        ],
        patch: {
          holdingEvents: this.replace(this.state.holdingEvents.filter((e) => !isOldOpening(e)), rec),
        },
      };
    });
  }

  /** Apply a reviewed holdings-import plan in ONE atomic commit: create new
   *  holdings, delete the opening estimates the import supersedes, and insert the
   *  new events (deterministic ids → re-applying is a no-op). Re-validated against
   *  post-serialization state inside the lock: a planned merge INTO an existing
   *  holding that was deleted while the preview was open is skipped rather than
   *  writing orphan events. Returns how many holdings/events were actually written. */
  async applyImport(
    plan: ImportPlan,
    opts: { label?: string } = {},
  ): Promise<{ holdings: number; events: number; batch: ImportBatch | null }> {
    let written = { holdings: 0, events: 0 };
    let batch: ImportBatch | null = null;
    await this.commit(() => {
      const now = new Date().toISOString();
      const addedEventIds: string[] = []; // events this import inserts (for undo)
      const replacedOpenings: HoldingEvent[] = []; // full events it deletes (to restore on undo)
      const liveHoldingIds = new Set(this.state.holdings.map((h) => h.id));
      const liveAccountIds = new Set(this.state.accounts.map((a) => a.id));
      const livePersonIds = new Set(this.state.people.map((pp) => pp.id));
      // Every event id already in the DB — so a re-import (or a concurrent second
      // preview) never re-inserts or overwrites an existing event.
      const existingEventIds = new Set(this.state.holdingEvents.map((e) => e.id));
      // Live holdings indexed by (account, normalised ticker) so a NEW draft can be
      // re-matched to a holding that a concurrent tab/preview already created since the
      // plan was built — merging into it instead of creating a duplicate (M1). ONLY
      // holdings that did NOT exist when the plan was built are eligible: re-matching
      // into a holding the user SAW at plan time would silently defeat an explicit
      // "create new" choice (N1) or hijack an unrelated same-ticker holding (N4).
      const knownAtPlan = new Set(plan.knownHoldingIds);
      const norm = (s: string): string => s.trim().toLowerCase();
      const acctTickerKey = (accountId: string | undefined, ticker: string): string => `${accountId ?? ""}|${norm(ticker)}`;
      const liveByAcctTicker = new Map<string, string>(); // key -> holdingId (holdings created since the plan was built)
      for (const h of this.state.holdings) {
        if (h.archived || !h.ticker || knownAtPlan.has(h.id)) continue;
        const k = acctTickerKey(h.accountId, h.ticker);
        if (!liveByAcctTicker.has(k)) liveByAcctTicker.set(k, h.id);
      }
      const ops: BatchOp[] = [];
      const newHoldings: Holding[] = [];
      const putEvents = new Map<string, HoldingEvent>();
      const deleteIds = new Set<string>();
      for (const p of plan.holdings) {
        // Resolve which live holding this plan entry writes into (creating it if new).
        let targetHoldingId: string;
        let fromHoldingId: string; // the id the plan's events were built under
        if (p.draft) {
          if (liveHoldingIds.has(p.draft.id)) continue; // this exact draft already applied
          fromHoldingId = p.draft.id;
          // Account deleted while the preview was open → keep the holding but unassign it.
          const accountId = p.draft.accountId && liveAccountIds.has(p.draft.accountId) ? p.draft.accountId : undefined;
          // M1: a concurrent preview may have created this (account, ticker) already.
          // Skip the re-match if F6 changed the account (accountId !== the draft's
          // original), else the fallback key could hijack a bystander holding (N4).
          const matchId =
            p.draft.ticker && accountId === p.draft.accountId
              ? liveByAcctTicker.get(acctTickerKey(accountId, p.draft.ticker))
              : undefined;
          if (matchId) {
            targetHoldingId = matchId; // merge into the existing holding, don't duplicate
          } else {
            // Create it, dropping a dangling account (F6) and a deleted owner (M3).
            const draft: Holding = {
              ...p.draft,
              accountId,
              personId: livePersonIds.has(p.draft.personId) ? p.draft.personId : "shared",
            };
            newHoldings.push(draft);
            ops.push({ collection: Collections.holdings, op: "put", value: draft });
            liveHoldingIds.add(draft.id);
            if (draft.ticker) liveByAcctTicker.set(acctTickerKey(draft.accountId, draft.ticker), draft.id);
            targetHoldingId = draft.id;
          }
        } else if (p.existingHoldingId && liveHoldingIds.has(p.existingHoldingId)) {
          targetHoldingId = p.existingHoldingId;
          fromHoldingId = p.existingHoldingId;
        } else {
          continue; // merge target vanished during the preview → skip (no orphans)
        }

        for (const id of p.replacedOpeningIds) {
          if (deleteIds.has(id)) continue;
          const ev = this.state.holdingEvents.find((e) => e.id === id);
          if (!ev) continue; // already gone (stale re-apply) → don't emit a no-op delete
          replacedOpenings.push(ev); // capture the FULL event so undo can restore it
          deleteIds.add(id);
          ops.push({ collection: Collections.holdingEvents, op: "delete", id });
        }
        for (const e of p.newEvents) {
          // Retarget the event to the resolved holding (identity unless M1 re-matched a
          // draft into a different live holding), then skip it if that id already exists
          // (idempotent re-import / concurrent-preview race) or repeats within this plan.
          const rec = retargetImportEvent(e, fromHoldingId, targetHoldingId, now);
          if (existingEventIds.has(rec.id) || putEvents.has(rec.id) || deleteIds.has(rec.id)) continue;
          putEvents.set(rec.id, rec);
          addedEventIds.push(rec.id);
          ops.push({ collection: Collections.holdingEvents, op: "put", value: rec });
        }
      }
      if (ops.length === 0) return { ops, patch: {} };
      // Rebuild the events list in ONE pass (O(E + changes)), not replace/filter per
      // event (O(changes × E)) — an import can carry thousands of events.
      const holdingEvents: HoldingEvent[] = [];
      for (const e of this.state.holdingEvents) {
        if (deleteIds.has(e.id)) continue;
        const upd = putEvents.get(e.id);
        if (upd) {
          holdingEvents.push(upd);
          putEvents.delete(e.id);
        } else {
          holdingEvents.push(e);
        }
      }
      for (const rec of putEvents.values()) holdingEvents.push(rec);
      written = {
        holdings: newHoldings.length,
        events: ops.filter((o) => o.collection === Collections.holdingEvents && o.op === "put").length,
      };
      // Record an undo batch (device-local, stripped from backup/sync) IN THE SAME atomic
      // write, so the record can never desync from the data it describes.
      if (written.holdings + written.events > 0) {
        batch = {
          id: newId(),
          createdAt: now,
          label: opts.label?.trim() || "CSV import",
          createdHoldingIds: newHoldings.map((h) => h.id),
          addedEventIds,
          replacedOpenings,
          counts: { ...written },
        };
        ops.push({ collection: Collections.importBatches, op: "put", value: batch });
      }
      return { ops, patch: { holdings: [...this.state.holdings, ...newHoldings], holdingEvents } };
    });
    // Best-effort retention: keep the undo log small (local-only, no long-term value).
    if (batch) await this.pruneImportBatches();
    return { ...written, batch };
  }

  /** Recent, still-valid CSV imports, newest first (device-local; never synced/backed
   *  up). Expired ones (past the TTL) are filtered from the result and swept by
   *  pruneImportBatches on init / next import — undo is a short-term convenience. */
  async listImportBatches(): Promise<ImportBatch[]> {
    const cutoff = new Date(Date.now() - IMPORT_BATCH_TTL_DAYS * 86_400_000).toISOString();
    const all = await this.adapter.collection<ImportBatch>(Collections.importBatches).getAll();
    return all
      .filter((b) => b.createdAt >= cutoff)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, IMPORT_BATCH_KEEP);
  }

  /** Delete import-undo records that are expired (older than the TTL) OR beyond the keep
   *  cap, so the local log is both time- and count-bounded and never grows forever. Runs
   *  on init and after each import; writes DIRECTLY (not via commit) so sweeping this
   *  local-only, stripped collection never bumps the sync version. */
  private async pruneImportBatches(): Promise<void> {
    const cutoff = new Date(Date.now() - IMPORT_BATCH_TTL_DAYS * 86_400_000).toISOString();
    const all = (await this.adapter.collection<ImportBatch>(Collections.importBatches).getAll()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    ); // newest first
    const stale = all.filter((b, i) => b.createdAt < cutoff || i >= IMPORT_BATCH_KEEP);
    if (stale.length > 0) {
      await this.adapter.batch(stale.map((b) => ({ collection: Collections.importBatches, op: "delete", id: b.id })));
    }
  }

  /** Undo one import: remove the transactions it added, delete only the holdings it
   *  CREATED that have no other events left (a holding you've since added your own
   *  transactions to is kept — just its imported rows go), and restore any opening
   *  estimate it replaced. Atomic. Returns what was reverted, or null if the batch is gone. */
  async undoImportBatch(batchId: string): Promise<{ holdings: number; events: number } | null> {
    const batch = await this.adapter.collection<ImportBatch>(Collections.importBatches).get(batchId);
    if (!batch) return null;
    let reverted: { holdings: number; events: number } | null = null;
    await this.commit(() => {
      const addedSet = new Set(batch.addedEventIds);
      const existingEventIds = new Set(this.state.holdingEvents.map((e) => e.id));
      const liveHoldingIds = new Set(this.state.holdings.map((h) => h.id));
      // An auto price-refresh valuation isn't the user's own data — it's derived from the
      // (now-being-removed) position. It must NOT keep an import-created holding alive, and
      // it must be cleaned up WITH that holding (a user-edited valuation drops this note, so
      // it counts as real data and is preserved).
      const isAutoValuation = (e: HoldingEvent): boolean => e.type === "valuation" && e.note === AUTO_VALUATION_NOTE;
      // A created holding is deleted unless a GENUINE user event survives (not the import's
      // rows, not an auto valuation) — so a holding that only got auto-priced still reverts.
      const userRemaining = new Map<string, number>();
      for (const e of this.state.holdingEvents) {
        if (addedSet.has(e.id) || isAutoValuation(e)) continue;
        userRemaining.set(e.holdingId, (userRemaining.get(e.holdingId) ?? 0) + 1);
      }
      const holdingsToDelete = new Set(
        batch.createdHoldingIds.filter((hid) => liveHoldingIds.has(hid) && (userRemaining.get(hid) ?? 0) === 0),
      );
      // Remove the import's transactions AND every event of a holding being deleted
      // (including its auto-valuations) — otherwise those valuations orphan a dead holding.
      const delEventIds = new Set<string>();
      for (const id of batch.addedEventIds) if (existingEventIds.has(id)) delEventIds.add(id);
      for (const e of this.state.holdingEvents) if (holdingsToDelete.has(e.holdingId)) delEventIds.add(e.id);
      const removedImportEvents = batch.addedEventIds.filter((id) => existingEventIds.has(id)).length;
      const reinsert = batch.replacedOpenings.filter(
        (ev) => !existingEventIds.has(ev.id) && liveHoldingIds.has(ev.holdingId) && !holdingsToDelete.has(ev.holdingId),
      );

      // Nothing left to revert (already undone, e.g. a concurrent double-undo) → do a
      // true no-op: don't bump the sync version. The stale batch record is swept below
      // via a direct write (like prune), so it doesn't dirty the synced document.
      if (delEventIds.size === 0 && holdingsToDelete.size === 0 && reinsert.length === 0) {
        return { ops: [], patch: {} };
      }

      const ops: BatchOp[] = [];
      for (const id of delEventIds) ops.push({ collection: Collections.holdingEvents, op: "delete", id });
      for (const hid of holdingsToDelete) ops.push({ collection: Collections.holdings, op: "delete", id: hid });
      for (const ev of reinsert) ops.push({ collection: Collections.holdingEvents, op: "put", value: ev });
      ops.push({ collection: Collections.importBatches, op: "delete", id: batchId });

      const holdingEvents = this.state.holdingEvents.filter((e) => !delEventIds.has(e.id)).concat(reinsert);
      const holdings = this.state.holdings.filter((h) => !holdingsToDelete.has(h.id));
      reverted = { holdings: holdingsToDelete.size, events: removedImportEvents };
      return { ops, patch: { holdings, holdingEvents } };
    });
    // If there was nothing to revert, the batch record may still linger (e.g. it was
    // read before a concurrent undo consumed it) → sweep it locally without a version bump.
    if (reverted === null) {
      await this.adapter.batch([{ collection: Collections.importBatches, op: "delete", id: batchId }]);
    }
    return reverted;
  }

  // -- settings & FX -------------------------------------------------------
  // Settings are device-local and excluded from snapshots, so changing them
  // does NOT bump the sync version or mark the document dirty.
  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    return this.exclusive(async () => {
      const cur = this.state.settings;
      // Deep-merge the nested `drive` object so a partial update (e.g. just the
      // API key) doesn't drop sibling fields (the client id) — rapid paste of
      // both fields would otherwise clobber the first. To CLEAR `drive`, pass it
      // explicitly as undefined.
      const drive =
        "drive" in patch
          ? patch.drive === undefined
            ? undefined
            : { ...cur.drive, ...patch.drive }
          : cur.drive;
      const next: AppSettings = { ...cur, ...patch, drive, id: "app" };
      await this.adapter.collection<AppSettings>(Collections.settings).put(next);
      this.emit({ settings: next, fx: this.computeFx(this.state.fxRates, next) });
    });
  }

  /** Set or clear a single FX override, reading the LATEST persisted overrides
   *  (not a stale UI closure) so rapid edits to different currencies don't drop
   *  each other. `rate <= 0`/null clears the override (back to the live rate). */
  async setFxOverride(code: CurrencyCode, rate: number | null): Promise<void> {
    return this.exclusive(async () => {
      const fxOverrides = { ...this.state.settings.fxOverrides };
      if (rate === null || !Number.isFinite(rate) || rate <= 0) delete fxOverrides[code];
      else fxOverrides[code] = rate;
      const next: AppSettings = { ...this.state.settings, fxOverrides, id: "app" };
      await this.adapter.collection<AppSettings>(Collections.settings).put(next);
      this.emit({ settings: next, fx: this.computeFx(this.state.fxRates, next) });
    });
  }

  async cacheFxRates(table: FxTable): Promise<void> {
    return this.exclusive(async () => {
      const date = todayIso();
      // Deterministic per-day id → refreshing twice the same day overwrites the
      // row instead of leaving two snapshots with the same date.
      const snap: FxRateSnapshot = { id: `fx-${date}`, date, base: table.base, rates: table.rates };
      const fxRates = this.replace(
        this.state.fxRates.filter((r) => r.date !== snap.date),
        snap,
      );
      const settings = { ...this.state.settings, fxUpdatedAt: new Date().toISOString() };
      // Write the rate snapshot AND the settings touch in one atomic batch.
      await this.adapter.batch([
        { collection: Collections.fxRates, op: "put", value: snap },
        { collection: Collections.settings, op: "put", value: settings },
      ]);
      this.emit({ fxRates, settings, fx: this.computeFx(fxRates, settings) });
    });
  }

  // -- snapshot (backup / sync) -------------------------------------------
  // DEVICE-LOCAL collections excluded from snapshots: `settings` (deviceId,
  // Drive config, vault salt, display currency) and `fxRates` (a per-device
  // rate cache — syncing it would churn versions and upload differing bytes
  // under the same version). Both are preserved across an import.
  private stripLocal(data: Record<string, Entity[]>): Record<string, Entity[]> {
    const out = { ...data };
    delete out[Collections.settings];
    delete out[Collections.fxRates];
    delete out[Collections.importBatches]; // device-local undo log — never backed up or synced
    return out;
  }

  async exportDocument(): Promise<SnapshotDoc> {
    // Read the data AND stamp the version inside the serialization mutex, so a
    // concurrent commit can't bump the version between exportAll() (which spans
    // multiple IndexedDB transactions) and reading state.version — which would
    // produce a snapshot LABELLED vN+1 but MISSING that edit, then get marked
    // synced and silently drop the edit. (No caller runs inside `exclusive`, so
    // no re-entrancy.)
    return this.exclusive(async () => {
      const data = this.stripLocal(await this.adapter.exportAll());
      return { schemaVersion: SCHEMA.version, version: this.state.version, data };
    });
  }

  /** Replace local data with a snapshot. Device-local collections are preserved.
   *  The working version never regresses (loading an OLDER snapshot keeps the
   *  higher local version so the next push can't collide with Drive).
   *
   *  `opts.dirty`:
   *   - false/omitted (a Drive PULL): the snapshot already IS what's on Drive →
   *     mark it synced (lastSyncedVersion = doc.version), clean.
   *   - true (a BACKUP restore): the user wants this state PUBLISHED → keep it
   *     dirty (and strictly ahead of lastSyncedVersion) so `Sync now` uploads it
   *     instead of taking the "nothing to sync" path. */
  async applyDocument(doc: SnapshotDoc, opts: { dirty?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const priorVersion = this.state.version;
      const priorLastSynced = this.state.settings.lastSyncedVersion;
      // Compute the version bookkeeping BEFORE the write so it can be persisted
      // atomically WITH the data.
      let version = Math.max(doc.version, priorVersion);
      let lastSyncedVersion: number;
      if (opts.dirty) {
        lastSyncedVersion = priorLastSynced; // unchanged — we didn't pull from Drive
        if (version <= lastSyncedVersion) version = lastSyncedVersion + 1; // ensure publishable
      } else {
        lastSyncedVersion = doc.version;
      }
      const settings: AppSettings = {
        ...this.state.settings,
        lastSyncedVersion,
        localVersion: version,
        id: "app",
      };
      // ONE transaction: replace synced collections (clearing any the snapshot
      // omits) while PRESERVING device-local ones, AND write the version
      // bookkeeping (settings) — so a crash can't leave new data with stale
      // version info. `init()` then reloads the consistent state and derives the
      // same version/dirty (version = max(localVersion, lastSyncedVersion)).
      await this.adapter.importAll(this.stripLocal(doc.data), "replace", {
        preserve: [Collections.settings, Collections.fxRates, Collections.importBatches],
        alsoPut: [{ collection: Collections.settings, op: "put", value: settings }],
      });
      await this.init();
    });
  }

  /** Ensure the working version is strictly above what's already on the remote,
   *  so a push from a device that forked at the same version doesn't reuse an
   *  already-used version number (which latestSnapshot can't disambiguate). */
  async reconcileVersion(remoteMaxVersion: number): Promise<void> {
    return this.exclusive(async () => {
      if (this.state.version > remoteMaxVersion) return;
      const version = remoteMaxVersion + 1;
      const settings: AppSettings = { ...this.state.settings, localVersion: version, id: "app" };
      await this.adapter.collection<AppSettings>(Collections.settings).put(settings);
      this.emit({ version, dirty: true, settings });
    });
  }

  /** Force a fresh, PUBLISHABLE version strictly above `floor` (the folder's max
   *  snapshot version) WITHOUT a data change — used to publish a new-baseline
   *  snapshot after an encryption change (v1→v2 migration, or a fresh-DEK password
   *  reset). Also sets `lastSyncedVersion = floor` so the pull-before-push guard
   *  treats everything up to `floor` as superseded and lets this baseline publish.
   *
   *  SAFETY: this deliberately marks unseen remote snapshots as superseded, so it
   *  must ONLY be called when we are intentionally establishing a new baseline from
   *  local data — either a current device (migration: nothing unseen is dropped) or
   *  a deliberate forgotten-password reset (old-key snapshots are unrecoverable
   *  anyway). It is NOT a normal sync path. */
  async bumpVersionAbove(floor: number): Promise<void> {
    return this.exclusive(async () => {
      const version = Math.max(this.state.version, floor) + 1;
      const settings: AppSettings = {
        ...this.state.settings,
        localVersion: version,
        lastSyncedVersion: floor,
        id: "app",
      };
      await this.adapter.collection<AppSettings>(Collections.settings).put(settings);
      this.emit({ version, dirty: true, settings });
    });
  }

  /** Record that `pushedVersion` was uploaded. We do NOT regress the working
   *  version, and we only clear `dirty` if no edit raced ahead during the push
   *  — otherwise autosave reschedules and the latest edit still gets pushed. */
  async markSynced(pushedVersion: number): Promise<void> {
    return this.exclusive(async () => {
      const settings: AppSettings = {
        ...this.state.settings,
        lastSyncedVersion: pushedVersion,
        id: "app",
      };
      await this.adapter.collection<AppSettings>(Collections.settings).put(settings);
      this.emit({ settings, dirty: this.state.version !== pushedVersion });
    });
  }
}

export async function createPortfolioStore(adapter: StorageAdapter): Promise<PortfolioStore> {
  const store = new PortfolioStore(adapter);
  await store.init();
  return store;
}
