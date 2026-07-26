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
  Owner,
  Person,
  SnapshotDoc,
  Transaction,
} from "../model/types";
import { createPortfolioRepo, type PortfolioRepo } from "../repo/portfolio-repo";
import { netUnits } from "../domain/holdings";
import { AUTO_VALUATION_NOTE } from "../domain/prices";
import { desiredAutopayTransfers, isAutopayTransaction, planAutopayReconcile } from "../domain/autopay";
import { importEventIdPrefix, type ImportPlan } from "../domain/import/holdings";
import { importTxnIdPrefix, type TxnImportPlan } from "../domain/import/transactions";
import { SHARED } from "../model/types";

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

/** The PERSISTED version bookkeeping — the only fingerprint that a second tab's writes are
 *  visible in (tabs share the database, not in-memory state). Used for compare-and-apply. */
export interface VersionFingerprint {
  localVersion: number;
  lastSyncedVersion: number;
  /** Bumped on every write to SYNCED data, so the fingerprint moves even when the version
   *  numbers legitimately don't (merging a file numbered below ours). Version numbers alone let a
   *  committed merge stay invisible to a plan captured before it. Device-local writes are
   *  excluded: a merge preserves those collections, so a plan can't lose them — and counting
   *  them meant an unattended FX refresh discarded an open merge. */
  dataSeq: number;
}

/** What an undo reverted. `holdings`/`events` are always present (0 for a transaction
 *  import) so existing callers keep working; the rest are set by a transaction undo. */
export interface UndoResult {
  holdings: number;
  events: number;
  transactions?: number;
  accounts?: number;
  categories?: number;
  people?: number;
}

// Import-undo log retention — undo is a short-term convenience, so the local record is
// bounded by BOTH age and count and never kept forever.
const IMPORT_BATCH_TTL_DAYS = 30;
const IMPORT_BATCH_KEEP = 25;

/** Keep the seen-snapshot log small and truthful: drop what the watermark strictly supersedes,
 *  add the newly incorporated file, and cap it so a long-lived device can't grow it without
 *  bound. Entries AT the watermark are KEPT — a concurrent push from another device can sit at
 *  exactly that number, and only the key proves which of the two we actually read. */
const SEEN_SNAPSHOT_KEEP = 200;
/** `add` may be several keys (a new baseline supersedes every file it validated). `present`, when
 *  given, is the set of keys the folder still holds — dropping the rest is what bounds the log by
 *  the FOLDER rather than by age. Age-capping alone re-created the very deadlock this log exists
 *  to remove: past the cap the oldest acknowledgement was discarded, so with more distinct
 *  writers than the cap the guard could never clear. */
export function pruneSeen(
  seen: string[] | undefined,
  watermark: number,
  add?: string | readonly string[],
  present?: ReadonlySet<string>,
): string[] {
  const version = (k: string): number => Number(k.slice(k.lastIndexOf("@") + 1));
  const fileId = (k: string): string => k.slice(0, k.lastIndexOf("@"));
  const relevant = (k: string): boolean => Number.isFinite(version(k)) && version(k) >= watermark;
  const kept = [...new Set(seen ?? [])].filter((k) => relevant(k) && (!present || present.has(k)));
  const added = (typeof add === "string" ? [add] : (add ?? [])).filter(relevant);
  // One key per FILE, highest version. A peer's session file is updated IN PLACE, so a
  // long-lived peer tab mints unboundedly many keys for a single file — and since a file's newer
  // version subsumes its older one (the same rule `unincorporatedFiles` relies on), those are
  // dead weight. Left in, they filled the cap and evicted the key that was actually load-bearing,
  // making a file we had merged look unread again and re-arming the guard.
  const top = new Map<string, string>();
  for (const k of [...kept, ...added]) {
    const cur = top.get(fileId(k));
    if (!cur || version(k) > version(cur)) top.set(fileId(k), k);
  }
  return [...top.values()].slice(-SEEN_SNAPSHOT_KEEP);
}

/** Web Locks name — one writer at a time across every tab of this origin. */
const STORE_WRITE_LOCK = "portfolio-store-write";

/** Serialise a write against OTHER TABS as well as this one.
 *
 *  `writeChain` only orders writes made through this store instance. Tabs share the database
 *  but not the chain, so two read-modify-write cycles could interleave and both persist the
 *  same `dataSeq` — leaving the fingerprint non-injective and letting one tab's replace-write
 *  drop the other's rows. The Web Locks API gives real cross-tab exclusion; where it isn't
 *  available (older browsers, Node tests) we fall back to the in-process chain, which is the
 *  behaviour we had. */
function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: { request?: (name: string, cb: () => Promise<T>) => Promise<T> } } })
    .navigator?.locks;
  if (!locks?.request) return fn();
  return locks.request(STORE_WRITE_LOCK, fn);
}

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
  /** Newest import-batch timestamp written//seen this session. Undo records are ordered
   *  (and pruned) by `createdAt` alone, so two batches landing in the SAME millisecond
   *  would be unorderable — the keep-cap could then drop the newest instead of the
   *  oldest, silently losing the undo for the import just made. `nextBatchAt` keeps the
   *  stamps strictly increasing so the ordering is always total. */
  private lastBatchAt = "";

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
    const guarded = (): Promise<T> => withCrossTabLock(fn);
    const run = this.writeChain.then(guarded, guarded);
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
    build: () =>
      | { ops: BatchOp[]; patch: Partial<PortfolioState> }
      | Promise<{ ops: BatchOp[]; patch: Partial<PortfolioState> }>,
  ): Promise<void> {
    return this.exclusive(async () => {
      // `await` so a thunk MAY read storage inside the lock. Sync thunks (all the small writes)
      // are unaffected; the import's validation needs it, because checking against this tab's
      // memory let a sibling tab's delete or re-denomination slip past.
      const { ops, patch } = await build();
      // A build that resolves to NO data ops (e.g. a price refresh whose target
      // holdings were all deleted/closed during the fetch await-gap) must not bump
      // the version or mark the document dirty — there is nothing to persist or
      // sync. Every other caller always produces at least one op.
      if (ops.length === 0) return;
      // One read of the settings row for the whole write (floor + next row), not two.
      const stored = await this.settingsRow();
      const version = this.versionFloorFrom(stored) + 1;
      const settings = await this.nextSettings({ localVersion: version }, { dataWrite: true, stored });
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
  /** Fold `sourceId` INTO `targetId` in one atomic commit: re-point every transaction
   *  tagged with the source to the target, re-parent the source's subcategories under
   *  the target, then delete the source. Guarded so it can't orphan data or exceed the
   *  two-level hierarchy (all checks read post-serialization state). */
  async mergeCategories(sourceId: string, targetId: string): Promise<void> {
    await this.commit(() => {
      if (sourceId === targetId) throw new Error("Cannot merge a category into itself");
      const source = this.state.categories.find((c) => c.id === sourceId);
      const target = this.state.categories.find((c) => c.id === targetId);
      if (!source) throw new Error("Source category not found");
      if (!target) throw new Error("Target category not found");
      // Can't merge a parent into its own subcategory (would orphan/cycle the rest).
      if (target.parentId === sourceId) {
        throw new Error("Cannot merge a category into its own subcategory");
      }
      const children = this.state.categories.filter((c) => c.parentId === sourceId);
      // If the source has subcategories they move under the target, so the target must
      // be top-level (else those children would nest three levels deep).
      if (children.length > 0 && target.parentId) {
        throw new Error("Pick a top-level target — it will receive the subcategories");
      }

      const now = new Date().toISOString();
      const author = this.state.settings.author;
      const movedTxns = this.state.transactions
        .filter((t) => t.categoryId === sourceId)
        .map((t): Transaction => ({ ...t, categoryId: targetId, updatedAt: now, author }));
      const reparented = children.map((c): Category => ({ ...c, parentId: targetId }));

      // Nothing actually changes? (no txns, no children) — still delete the source.
      const movedIds = new Set(movedTxns.map((t) => t.id));
      const reparentedIds = new Set(reparented.map((c) => c.id));
      const ops: BatchOp[] = [
        ...movedTxns.map((t): BatchOp => ({ collection: Collections.transactions, op: "put", value: t })),
        ...reparented.map((c): BatchOp => ({ collection: Collections.categories, op: "put", value: c })),
        { collection: Collections.categories, op: "delete", id: sourceId },
      ];
      const txnById = new Map(movedTxns.map((t) => [t.id, t]));
      const catById = new Map(reparented.map((c) => [c.id, c]));
      return {
        ops,
        patch: {
          transactions: this.state.transactions.map((t) => (movedIds.has(t.id) ? txnById.get(t.id)! : t)),
          categories: this.state.categories
            .filter((c) => c.id !== sourceId)
            .map((c) => (reparentedIds.has(c.id) ? catById.get(c.id)! : c)),
        },
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
          createdAt: this.nextBatchAt(),
          label: opts.label?.trim() || "CSV import",
          kind: "holdings",
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

  /** Apply a reviewed TRANSACTION-import plan in ONE atomic commit: create the accounts /
   *  categories / people the plan invented for unknown banks, categories and owners, then
   *  insert the transactions (deterministic ids → re-applying the same file is a no-op).
   *  Re-validated against post-serialization state inside the lock: a row whose account
   *  was deleted while the preview was open is skipped rather than orphaned, and a
   *  transaction id that already exists is never overwritten. Returns what was written
   *  plus the undo batch. */
  async applyTransactionImport(
    plan: TxnImportPlan,
    opts: { label?: string } = {},
  ): Promise<{
    transactions: number;
    accounts: number;
    categories: number;
    people: number;
    /** Reasons for rows the review accepted but the write could not apply (the world
     *  changed meanwhile) — surfaced so the count is never silently short. */
    dropped: string[];
    batch: ImportBatch | null;
  }> {
    let written = { transactions: 0, accounts: 0, categories: 0, people: 0 };
    let batch: ImportBatch | null = null;
    let dropped: string[] = [];
    await this.commit(async () => {
      const now = new Date().toISOString();
      const author = this.state.settings.author;
      const ops: BatchOp[] = [];
      // VALIDATE against storage, not this tab's memory. Tabs share the database and get no
      // cross-tab refresh, so a sibling tab can delete the target account or re-denominate it
      // while the review sits open — and validating from memory then wrote a transaction pointing
      // at an account that no longer exists, or an INR amount into a now-USD account, instead of
      // dropping the row as this method promises. (The in-memory patch below is still built from
      // `this.state`: it is this tab's VIEW, which may lag until a reload. The DATA written, and
      // every decision about what to write, comes from storage.)
      const [storedAccounts, storedPeople, storedCategories, storedTxns] = await Promise.all([
        this.repo.accounts.getAll(),
        this.repo.people.getAll(),
        this.repo.categories.getAll(),
        this.repo.transactions.getAll(),
      ]);

      // --- entities the plan creates (skip any a concurrent tab already created) ---
      // Convergence identity for an account is name + CURRENCY + OWNER, not the name alone.
      // Same display names are legal and normal here — each person can have an "IBKR" — so a
      // name-only match let a row planned for Meera's new account be posted into Ravi's existing
      // one whenever a concurrent tab had created that name first. The ids are then re-keyed to
      // that account, so a later re-import dedups against the wrong one and never repairs it.
      // A person, by contrast, IS identified by name, so that map stays as it was.
      const accountKey = (a: { name: string; currency: string; personId: string }): string =>
        `${a.name.trim().toLowerCase()}\u0000${a.currency}\u0000${a.personId}`;
      const liveAccountsByKey = new Map<string, Account>();
      for (const a of storedAccounts) {
        if (!liveAccountsByKey.has(accountKey(a))) liveAccountsByKey.set(accountKey(a), a); // first wins
      }
      const livePeopleByName = new Map<string, Person>();
      for (const p of storedPeople) {
        const k = p.name.trim().toLowerCase();
        if (!livePeopleByName.has(k)) livePeopleByName.set(k, p); // first wins, as the planner does
      }
      const liveCategoryIds = new Set(storedCategories.map((c) => c.id));
      /** planned id -> the id actually used (an existing same-named entity wins). */
      const accountIdMap = new Map<string, string>();
      const personIdMap = new Map<string, string>();
      const newAccounts: Account[] = [];
      const newPeople: Person[] = [];
      const newCategories: Category[] = [];

      // PEOPLE FIRST: a created account can be owned by a person this same import creates,
      // so that person must already be resolvable when the account is validated below
      // (checking only `state.people` downgraded every such account to SHARED).
      for (const p of plan.newPeople) {
        const existing = livePeopleByName.get(p.name.trim().toLowerCase());
        if (existing) {
          personIdMap.set(p.id, existing.id);
          continue;
        }
        newPeople.push(p);
        livePeopleByName.set(p.name.trim().toLowerCase(), p);
        ops.push({ collection: Collections.people, op: "put", value: p });
      }
      /** Owners that will exist after this commit: already-stored + created here. */
      const ownerExists = (id: Owner): boolean =>
        id === SHARED || storedPeople.some((p) => p.id === id) || newPeople.some((p) => p.id === id);
      for (const a of plan.newAccounts) {
        // Resolve the owner FIRST: convergence must compare the account's real owner (a
        // same-named person created by a concurrent tab is the SAME owner), or an account would
        // look different from an identical one purely because the person row is new.
        const owner = personIdMap.get(a.personId) ?? a.personId;
        const existing = liveAccountsByKey.get(accountKey({ ...a, personId: owner }));
        if (existing) {
          accountIdMap.set(a.id, existing.id); // converge on the account that already exists
          continue;
        }
        // Fall back to SHARED only if that owner genuinely won't exist after this commit.
        const rec: Account = { ...a, personId: ownerExists(owner) ? owner : SHARED };
        newAccounts.push(rec);
        // Keyed the same way, and first-wins, so two planned accounts differing only by owner both
        // get created instead of the second silently folding into the first.
        if (!liveAccountsByKey.has(accountKey(rec))) liveAccountsByKey.set(accountKey(rec), rec);
        ops.push({ collection: Collections.accounts, op: "put", value: rec });
      }
      // Categories: keep the plan's ids (they're referenced by the transactions) but drop a
      // subcategory whose parent vanished mid-preview to top-level rather than orphaning it.
      const plannedCategoryIds = new Set(plan.newCategories.map((c) => c.id));
      for (const c of plan.newCategories) {
        if (liveCategoryIds.has(c.id)) continue; // already applied
        const parentOk = !c.parentId || liveCategoryIds.has(c.parentId) || plannedCategoryIds.has(c.parentId);
        const rec: Category = parentOk ? c : { ...c, parentId: undefined };
        newCategories.push(rec);
        ops.push({ collection: Collections.categories, op: "put", value: rec });
      }

      // --- transactions ---
      const liveAccountIds = new Set([...storedAccounts.map((a) => a.id), ...newAccounts.map((a) => a.id)]);
      const livePersonIds = new Set([...storedPeople.map((p) => p.id), ...newPeople.map((p) => p.id)]);
      const validCategoryIds = new Set([...liveCategoryIds, ...newCategories.map((c) => c.id)]);
      const existingTxnIds = new Set(storedTxns.map((t) => t.id));
      // Every account the rows can land in, by id — the currency check below runs per ROW, and a
      // linear scan there made a large import quadratic inside the write lock.
      const accountsForWrite = new Map<string, Account>();
      for (const a of storedAccounts) accountsForWrite.set(a.id, a);
      for (const a of newAccounts) accountsForWrite.set(a.id, a);
      const addedTransactionIds: string[] = [];
      const records: Transaction[] = [];
      // Rows the PLAN accepted but this commit cannot write (the world changed while the
      // preview was open). Counted and returned so the UI can report them instead of
      // silently writing fewer transactions than the review promised.
      const droppedAtWrite: string[] = [];
      for (const t of plan.transactions) {
        // Re-point to the converged account/person (an existing same-named entity).
        const accountId = accountIdMap.get(t.accountId) ?? t.accountId;
        if (!liveAccountIds.has(accountId)) {
          droppedAtWrite.push(`${t.date}: its account was deleted while the import was open`);
          continue; // don't orphan the row onto a dead account
        }
        const account = accountsForWrite.get(accountId);
        // A transaction posts in its ACCOUNT's currency. If convergence landed this row in
        // an account of a DIFFERENT currency than the plan assumed, the amount is no longer
        // meaningful (INR 50,000 must never be written as USD 50,000) — skip it, exactly as
        // the plan's own currency guard would have.
        if (account && account.currency !== t.currency) {
          droppedAtWrite.push(
            `${t.date}: "${account.name}" is ${account.currency}, but the row is ${t.currency}`,
          );
          continue;
        }
        const personId = personIdMap.get(t.personId) ?? t.personId;
        // The id encodes the ORIGINAL account; re-point it too so dedup keys off the
        // account the row actually lands in (matching importTxnIdPrefix).
        const id =
          accountId === t.accountId
            ? t.id
            : t.id.replace(importTxnIdPrefix(t.accountId), importTxnIdPrefix(accountId));
        if (existingTxnIds.has(id)) continue; // idempotent: a previous import already wrote this row
        existingTxnIds.add(id);
        const rec: Transaction = {
          ...t,
          id,
          accountId,
          personId: personId === SHARED || livePersonIds.has(personId) ? personId : SHARED,
          currency: account?.currency ?? t.currency,
          categoryId: t.categoryId && validCategoryIds.has(t.categoryId) ? t.categoryId : undefined,
          updatedAt: now,
          author,
        };
        records.push(rec);
        addedTransactionIds.push(rec.id);
        ops.push({ collection: Collections.transactions, op: "put", value: rec });
      }
      dropped = droppedAtWrite;

      // No transaction survived (everything was already imported, or dropped above)? Then
      // the accounts/categories/people existed only to host those rows — writing them would
      // leave empty records behind while the UI truthfully reports "nothing new". Make the
      // whole thing a real no-op instead: no writes, no batch, no version bump.
      if (records.length === 0) {
        dropped = droppedAtWrite;
        return { ops: [], patch: {} };
      }
      written = {
        transactions: records.length,
        accounts: newAccounts.length,
        categories: newCategories.length,
        people: newPeople.length,
      };
      // Record the undo batch in the SAME atomic write, so it can never desync from the
      // data it describes. Device-local: stripped from backup/sync.
      batch = {
        id: newId(),
        createdAt: this.nextBatchAt(),
        label: opts.label?.trim() || "CSV import",
        kind: "transactions",
        createdHoldingIds: [],
        addedEventIds: [],
        replacedOpenings: [],
        addedTransactionIds,
        createdAccountIds: newAccounts.map((a) => a.id),
        createdCategoryIds: newCategories.map((c) => c.id),
        createdPersonIds: newPeople.map((p) => p.id),
        counts: {
          holdings: 0,
          events: 0,
          transactions: written.transactions,
          accounts: written.accounts,
          categories: written.categories,
          people: written.people,
        },
      };
      ops.push({ collection: Collections.importBatches, op: "put", value: batch });

      return {
        ops,
        patch: {
          accounts: [...this.state.accounts, ...newAccounts],
          people: [...this.state.people, ...newPeople],
          categories: [...this.state.categories, ...newCategories],
          transactions: [...this.state.transactions, ...records],
        },
      };
    });
    if (batch) await this.pruneImportBatches();
    return { ...written, dropped, batch };
  }

  /** A strictly-increasing `createdAt` for a new import batch: real time, unless a batch
   *  already exists at that millisecond (or later), in which case the previous stamp + 1ms.
   *  Undo records are ordered and keep-capped by `createdAt` alone, so equal stamps would
   *  make "newest" arbitrary — and prune could then delete the newest batch instead of the
   *  oldest, silently dropping the undo for the import just made. */
  private nextBatchAt(): string {
    const now = new Date().toISOString();
    let at = now;
    if (now <= this.lastBatchAt) {
      // Bump by 1ms. A corrupted/non-ISO stored stamp would make Date() NaN and throw on
      // toISOString(), which would take BOTH importers down — fall back to real time.
      const prev = new Date(this.lastBatchAt).getTime();
      at = Number.isFinite(prev) ? new Date(prev + 1).toISOString() : now;
    }
    this.lastBatchAt = at;
    return at;
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
    // Seed the monotonic stamp from persistence (this runs on init) so a batch created
    // right after a reload still sorts after the ones already stored.
    if (all[0] && all[0].createdAt > this.lastBatchAt) this.lastBatchAt = all[0].createdAt;
    const stale = all.filter((b, i) => b.createdAt < cutoff || i >= IMPORT_BATCH_KEEP);
    if (stale.length > 0) {
      await this.adapter.batch(stale.map((b) => ({ collection: Collections.importBatches, op: "delete", id: b.id })));
    }
  }

  /** Undo one import: remove the transactions it added, delete only the holdings it
   *  CREATED that have no other events left (a holding you've since added your own
   *  transactions to is kept — just its imported rows go), and restore any opening
   *  estimate it replaced. Atomic. Returns what was reverted, or null if the batch is gone. */
  async undoImportBatch(batchId: string): Promise<UndoResult | null> {
    const batch = await this.adapter.collection<ImportBatch>(Collections.importBatches).get(batchId);
    if (!batch) return null;
    // A transaction import reverts different collections — same contract (null = nothing
    // left to revert), same atomicity, so it gets its own focused path.
    if (batch.kind === "transactions") return this.undoTransactionBatch(batch);
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

  /** Undo one TRANSACTION import: remove the transactions it added, then delete the
   *  accounts / categories / people it created — but ONLY those nothing else references
   *  any more (an account you've since recorded your own transactions in, or a category
   *  you've reused, is KEPT; just the imported rows go). Atomic; returns null when
   *  there's nothing left to revert (e.g. a concurrent double-undo). */
  private async undoTransactionBatch(batch: ImportBatch): Promise<UndoResult | null> {
    let reverted: UndoResult | null = null;
    await this.commit(() => {
      const addedIds = new Set(batch.addedTransactionIds ?? []);
      const liveTxnIds = new Set(this.state.transactions.map((t) => t.id));
      const removeTxnIds = new Set([...addedIds].filter((id) => liveTxnIds.has(id)));
      // What SURVIVES the undo decides whether a created entity can go.
      const remaining = this.state.transactions.filter((t) => !removeTxnIds.has(t.id));

      // Reference sets built in ONE pass over the survivors, not one scan per created id: an
      // import that creates 20 accounts against 50k transactions was ~1M comparisons inside the
      // write lock, all of it re-deriving the same answer.
      const referencedAccountIds = new Set<string>();
      const referencedPersonIds = new Set<string>();
      const referencedCategoryIds = new Set<string>();
      for (const t of remaining) {
        referencedAccountIds.add(t.accountId);
        if (t.transferToAccountId) referencedAccountIds.add(t.transferToAccountId);
        referencedPersonIds.add(t.personId);
        if (t.categoryId) referencedCategoryIds.add(t.categoryId);
      }
      for (const h of this.state.holdings) {
        if (h.accountId) referencedAccountIds.add(h.accountId);
        referencedPersonIds.add(h.personId);
      }
      for (const a of this.state.accounts) {
        if (a.autopay?.fromAccountId) referencedAccountIds.add(a.autopay.fromAccountId);
      }
      const liveAccountIdSet = new Set(this.state.accounts.map((a) => a.id));
      const accountsToDelete = new Set(
        (batch.createdAccountIds ?? []).filter(
          (id) => liveAccountIdSet.has(id) && !referencedAccountIds.has(id),
        ),
      );
      // A created category goes only if NOTHING surviving needs it:
      //  (a) no surviving transaction is tagged with it, and
      //  (b) no child of it survives — otherwise that child would be left with a dangling
      //      parentId (it happens when another import's rows use a SUBcategory of a parent
      //      this batch created: the sub is referenced, the parent isn't, but the parent
      //      must stay). Resolved to a fixpoint so a whole surviving branch is protected.
      const liveCategoryIdSet = new Set(this.state.categories.map((c) => c.id));
      const createdCats = (batch.createdCategoryIds ?? []).filter((id) => liveCategoryIdSet.has(id));
      const categoriesToDelete = new Set(createdCats.filter((id) => !referencedCategoryIds.has(id)));
      const childrenByParent = new Map<string, string[]>();
      for (const c of this.state.categories) {
        if (!c.parentId) continue;
        const kids = childrenByParent.get(c.parentId);
        if (kids) kids.push(c.id);
        else childrenByParent.set(c.parentId, [c.id]);
      }
      for (let changed = true; changed; ) {
        changed = false;
        for (const id of [...categoriesToDelete]) {
          const survivingChild = (childrenByParent.get(id) ?? []).some((kid) => !categoriesToDelete.has(kid));
          if (survivingChild) {
            categoriesToDelete.delete(id); // keep the parent so its child never dangles
            changed = true;
          }
        }
      }
      // Owners of accounts that SURVIVE this undo still count as referenced (an owner of an
      // account we're about to delete does not) — so this one narrowing needs the delete set.
      for (const a of this.state.accounts) {
        if (!accountsToDelete.has(a.id)) referencedPersonIds.add(a.personId);
      }
      const livePersonIdSet = new Set(this.state.people.map((p) => p.id));
      const peopleToDelete = new Set(
        (batch.createdPersonIds ?? []).filter(
          (id) => livePersonIdSet.has(id) && !referencedPersonIds.has(id),
        ),
      );

      // Nothing left to revert → true no-op (no version bump). The stale batch record is
      // swept by the caller with a direct write, so it doesn't dirty the synced document.
      if (
        removeTxnIds.size === 0 &&
        accountsToDelete.size === 0 &&
        categoriesToDelete.size === 0 &&
        peopleToDelete.size === 0
      ) {
        return { ops: [], patch: {} };
      }

      const ops: BatchOp[] = [];
      for (const id of removeTxnIds) ops.push({ collection: Collections.transactions, op: "delete", id });
      for (const id of accountsToDelete) ops.push({ collection: Collections.accounts, op: "delete", id });
      for (const id of categoriesToDelete) ops.push({ collection: Collections.categories, op: "delete", id });
      for (const id of peopleToDelete) ops.push({ collection: Collections.people, op: "delete", id });
      ops.push({ collection: Collections.importBatches, op: "delete", id: batch.id });

      reverted = {
        holdings: 0,
        events: 0,
        transactions: removeTxnIds.size,
        accounts: accountsToDelete.size,
        categories: categoriesToDelete.size,
        people: peopleToDelete.size,
      };
      return {
        ops,
        patch: {
          transactions: remaining,
          accounts: this.state.accounts.filter((a) => !accountsToDelete.has(a.id)),
          categories: this.state.categories.filter((c) => !categoriesToDelete.has(c.id)),
          people: this.state.people.filter((p) => !peopleToDelete.has(p.id)),
        },
      };
    });
    if (reverted === null) {
      await this.adapter.batch([{ collection: Collections.importBatches, op: "delete", id: batch.id }]);
    }
    return reverted;
  }

  // -- settings & FX -------------------------------------------------------
  // Settings are device-local and excluded from snapshots, so changing them
  // does NOT bump the sync version or mark the document dirty.
  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    return this.exclusive(async () => {
      // Deep-merge the nested `drive` object so a partial update (e.g. just the API key)
      // doesn't drop sibling fields (the client id) — rapid paste of both fields would
      // otherwise clobber the first. To CLEAR `drive`, pass it explicitly as undefined.
      //
      // Merged onto the STORED row, and OMITTED from the patch when the caller didn't mention
      // it. Rebuilding it from `this.state.settings` re-asserted a stale copy on every
      // unrelated settings change, so a second tab's folder pick was silently reverted — or
      // the whole Drive config erased, leaving the device quietly local-only after a reload.
      const stored = await this.settingsRow();
      const base = stored ?? this.state.settings;
      const drivePatch: Partial<AppSettings> =
        "drive" in patch
          ? { drive: patch.drive === undefined ? undefined : { ...base.drive, ...patch.drive } }
          : {};
      // `importAliases` accumulates across imports, so a patch MERGES into the stored map rather
      // than replacing it (same reasoning as `drive` above).
      const aliasPatch: Partial<AppSettings> =
        "importAliases" in patch
          ? { importAliases: { ...base.importAliases, ...patch.importAliases } }
          : {};
      const next = await this.nextSettings({ ...patch, ...drivePatch, ...aliasPatch }, { stored });
      await this.adapter.collection<AppSettings>(Collections.settings).put(next);
      this.emit({ settings: next, fx: this.computeFx(this.state.fxRates, next) });
    });
  }

  /** Set or clear a single FX override, reading the LATEST persisted overrides
   *  (not a stale UI closure) so rapid edits to different currencies don't drop
   *  each other. `rate <= 0`/null clears the override (back to the live rate). */
  async setFxOverride(code: CurrencyCode, rate: number | null): Promise<void> {
    return this.exclusive(async () => {
      const stored = await this.settingsRow();
      const fxOverrides = { ...(stored?.fxOverrides ?? this.state.settings.fxOverrides) };
      if (rate === null || !Number.isFinite(rate) || rate <= 0) delete fxOverrides[code];
      else fxOverrides[code] = rate;
      const next = await this.nextSettings({ fxOverrides }, { stored });
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
      const settings = await this.nextSettings({ fxUpdatedAt: new Date().toISOString() });
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
      // Version from STORAGE, not just memory: a second tab may have written since, and a
      // snapshot labelled below the database's version could collide on the next push.
      return { schemaVersion: SCHEMA.version, version: await this.versionFloor(), data };
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
   *     instead of taking the "nothing to sync" path.
   *
   *  `opts.seenRemoteVersion` (a MERGE): the state is a combination of local data and a
   *  remote snapshot, so it must be BOTH dirty (nobody has it yet) AND recorded as having
   *  SEEN the remote up to that version. Without the second half, the push path's
   *  data-loss guard (`remoteMax > lastSyncedVersion`) keeps refusing forever: the merged
   *  document could never be published and autosave would stay wedged in "error". Pass the
   *  remote version actually reconciled — never a higher one, or an unmerged sibling file
   *  at that version would be silently treated as seen. */
  async applyDocument(
    doc: SnapshotDoc,
    opts: {
      dirty?: boolean;
      seenRemoteVersion?: number;
      /** `<fileId>@<version>` of the snapshot this merge incorporated. Recorded even when the
       *  watermark can't move, which is what makes successive merges converge instead of
       *  deadlocking. Safe to record whether or not that file still exists remotely — it
       *  states what OUR data now contains, not what the folder looks like. */
      seenSnapshotKey?: string;
      /** PULL only: other snapshots are still unincorporated, so the watermark must NOT move.
       *
       *  `lastSyncedVersion = doc.version` is another device's counter and says nothing about what
       *  we hold. Because a file is subsumed at `version >= watermark`, jumping to a higher
       *  version silently un-flagged every LOWER foreign file — and the pull deliberately targets
       *  the newest unincorporated one, so this was reachable by an ordinary "Pull latest →
       *  replace" on a clean device with two other devices in play. The seen-KEY still records
       *  the file we loaded, which is what clears that file (and only that file). */
      holdWatermark?: boolean;
      /** COMPARE-AND-APPLY. When given, the write is abandoned unless the PERSISTED version
       *  bookkeeping still matches — checked here, inside the same lock as the write, and
       *  read from storage rather than memory.
       *
       *  Both halves matter for a merge: this is a full `replace`, so anything written since
       *  the merge was planned would be deleted. An in-memory check performed by the caller
       *  can't see (a) writes that land during this method's own multi-transaction export, or
       *  (b) ANY write from a second tab, which shares the database but not this tab's state. */
      expect?: VersionFingerprint;
    } = {},
  ): Promise<void> {
    return this.exclusive(async () => {
      const storedRow = await this.settingsRow();
      if (opts.expect) {
        // Compare PERSISTED-to-PERSISTED. The in-memory `state.version` is derived and can
        // legitimately differ from the stored row (e.g. `saveSettings` moves the synced
        // watermark without bumping it), so mixing the two would false-positive.
        const live = this.fingerprintFrom(storedRow);
        if (
          live.localVersion !== opts.expect.localVersion ||
          live.lastSyncedVersion !== opts.expect.lastSyncedVersion ||
          live.dataSeq !== opts.expect.dataSeq
        ) {
          throw new Error(
            "Your data changed while you were reviewing — nothing was written. Tap Pull latest again to redo it with the current data.",
          );
        }
      }
      // The floor is read from STORAGE, so a stale tab can't write a version BELOW what the
      // database already holds (which would let a later write reproduce an earlier
      // fingerprint — see versionFloor).
      const priorVersion = this.versionFloorFrom(storedRow);
      // From the ROW, not memory: a second tab may have advanced the watermark or recorded a
      // merge since this tab loaded, and rewriting either from a stale copy loses it.
      const priorLastSynced = storedRow?.lastSyncedVersion ?? this.state.settings.lastSyncedVersion;
      // Compute the version bookkeeping BEFORE the write so it can be persisted
      // atomically WITH the data.
      let version = Math.max(doc.version, priorVersion);
      let lastSyncedVersion: number;
      if (opts.dirty) {
        // A merge additionally acknowledges the remote it reconciled; a plain restore
        // acknowledges nothing. Never regress an already-higher watermark.
        lastSyncedVersion = Math.max(priorLastSynced, opts.seenRemoteVersion ?? 0);
        // This is a data change, so the working version must MOVE — merging a file numbered
        // below our own left it untouched, and then a plan captured before this merge still
        // matched and deleted everything the merge had adopted.
        version = Math.max(version, priorVersion + 1);
        if (version <= lastSyncedVersion) version = lastSyncedVersion + 1; // ensure publishable
      } else {
        // Never regress, and never leap over a file we haven't read (see holdWatermark).
        lastSyncedVersion = opts.holdWatermark ? priorLastSynced : Math.max(priorLastSynced, doc.version);
      }
      const settings = await this.nextSettings(
        {
          lastSyncedVersion,
          localVersion: version,
          // Remember the exact file this snapshot came from, so several merges in a row can add
          // up to "nothing outstanding" even when no single one clears the high-water mark.
          //
          // A REPLACE (the non-dirty pull path) makes our data exactly this snapshot, which
          // FALSIFIES every earlier acknowledgement — those rows are gone. Keeping the ones above
          // the new watermark let "Replace with snapshot" on an older file leave a merged sibling
          // still marked seen, and the next push then went over it with no merge ever offered.
          seenSnapshots: opts.dirty
            ? pruneSeen(storedRow?.seenSnapshots, lastSyncedVersion, opts.seenSnapshotKey)
            : opts.seenSnapshotKey
              ? [opts.seenSnapshotKey]
              : [],
        },
        { dataWrite: true, stored: storedRow },
      );
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

  /** A snapshot AND the version fingerprint that describes it, taken in ONE lock.
   *
   *  Anything that plans a write from exported data must use this: taking the fingerprint
   *  separately (before or after) leaves a window in which a write is both absent from the
   *  plan and invisible to the compare-and-apply check, so committing the plan deletes it
   *  silently. Atomic capture makes the pair provably consistent. */
  async exportWithFingerprint(): Promise<{ doc: SnapshotDoc; fingerprint: VersionFingerprint }> {
    return this.exclusive(async () => {
      const data = this.stripLocal(await this.adapter.exportAll());
      const row = await this.settingsRow();
      return {
        doc: { schemaVersion: SCHEMA.version, version: this.versionFloorFrom(row), data },
        fingerprint: this.fingerprintFrom(row),
      };
    });
  }

  /** The settings row AS STORED. Tabs share this row but each keeps its own in-memory copy,
   *  so anything that persists settings must start from here. */
  private async settingsRow(): Promise<AppSettings | undefined> {
    return (await this.adapter.collection<AppSettings>(Collections.settings).getAll())[0];
  }

  /** The next settings row to persist: the STORED row plus this call's patch, with the write
   *  counter bumped.
   *
   *  Every settings write must go through here. Spreading `this.state.settings` instead — which
   *  is what `saveSettings`, `setFxOverride`, `cacheFxRates` and `markSynced` all used to do —
   *  writes back a second tab's fields from a stale snapshot: it rolled `localVersion` and
   *  `lastSyncedVersion` BACKWARDS (so a merge's compare-and-apply saw its old fingerprint
   *  again and silently deleted the other tab's rows), marked never-pushed edits as already
   *  synced, and erased `seenSnapshots`. The FX refresh runs hourly and unattended, so this
   *  needed no user action at all. */
  private async nextSettings(
    patch: Partial<AppSettings> = {},
    opts: { dataWrite?: boolean; stored?: AppSettings } = {},
  ): Promise<AppSettings> {
    const stored = opts.stored ?? (await this.settingsRow());
    const base = stored ?? this.state.settings;
    if (opts.dataWrite) {
      return { ...base, ...patch, dataSeq: (base.dataSeq ?? 0) + 1, id: "app" };
    }
    return { ...base, ...patch, id: "app" };
  }

  /** The lowest version a NEW write may take, read from STORAGE.
   *
   *  Every version bump goes through here, and that is what makes `localVersion` strictly
   *  increasing per DATABASE rather than per tab. It has to be: the compare-and-apply
   *  fingerprint is `(localVersion, lastSyncedVersion)`, so if a second tab — same database,
   *  its own in-memory state, no cross-tab notification anywhere in the app — derived its
   *  next version from its own stale `state.version`, its writes would walk back up to the
   *  value a merge recorded and the K-th one would REPRODUCE it exactly. The check would then
   *  pass and the merge's full-replace write would delete that tab's rows silently.
   *  Monotonic-per-database means any write from any tab always moves the fingerprint. */
  private async versionFloor(): Promise<number> {
    return this.versionFloorFrom(await this.settingsRow());
  }

  /** Same rule, from a row the caller has already read — settings reads are on the write path of
   *  every edit, so each lock body reads the row ONCE and threads it through. */
  private versionFloorFrom(row: AppSettings | undefined): number {
    return Math.max(this.state.version, row?.localVersion ?? 0, row?.lastSyncedVersion ?? 0);
  }

  /** ALL the sync bookkeeping as STORED: both version halves, the acknowledgement log and the
   *  device id.
   *
   *  Every rule that decides "could this file hold records I've never read" must read this rather
   *  than `state.settings`. Tabs share the row but not memory, so after a sibling tab merges or
   *  pulls a snapshot the database holds that data and the row records its key — while this tab
   *  still has the old log and watermark. Judging from memory then re-flags an already
   *  incorporated file, the push guard refuses, and because that path returns without scheduling a
   *  retry (autosave is gated on `phase === "ready"`) the tab silently stops syncing until a
   *  reload. */
  async persistedSyncState(): Promise<{
    localVersion: number;
    lastSyncedVersion: number;
    seenSnapshots: string[];
    deviceId: string;
  }> {
    const row = await this.settingsRow();
    const mem = this.state.settings;
    return {
      localVersion: row?.localVersion ?? mem.localVersion,
      lastSyncedVersion: row?.lastSyncedVersion ?? mem.lastSyncedVersion,
      seenSnapshots: row?.seenSnapshots ?? mem.seenSnapshots ?? [],
      deviceId: row?.deviceId ?? mem.deviceId,
    };
  }

  /** The version bookkeeping as STORED (not as held in memory). Reading it from the database
   *  is what lets a caller detect a write made by another tab, which shares the database but
   *  has its own in-memory state. Falls back to memory only if the row is somehow absent. */
  async versionFingerprint(): Promise<VersionFingerprint> {
    return this.fingerprintFrom(await this.settingsRow());
  }

  private fingerprintFrom(row: AppSettings | undefined): VersionFingerprint {
    return {
      localVersion: row?.localVersion ?? this.state.settings.localVersion,
      lastSyncedVersion: row?.lastSyncedVersion ?? this.state.settings.lastSyncedVersion,
      dataSeq: row?.dataSeq ?? this.state.settings.dataSeq ?? 0,
    };
  }

  /** Ensure the working version is strictly above what's already on the remote,
   *  so a push from a device that forked at the same version doesn't reuse an
   *  already-used version number (which latestSnapshot can't disambiguate). */
  async reconcileVersion(remoteMaxVersion: number): Promise<void> {
    return this.exclusive(async () => {
      const stored = await this.settingsRow();
      if (this.versionFloorFrom(stored) > remoteMaxVersion) return;
      const version = remoteMaxVersion + 1;
      const settings = await this.nextSettings({ localVersion: version }, { stored });
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
  async bumpVersionAbove(floor: number, supersededKeys: readonly string[] = []): Promise<void> {
    return this.exclusive(async () => {
      const stored = await this.settingsRow();
      const version = Math.max(this.versionFloorFrom(stored), floor) + 1;
      // Record the files this baseline supersedes. Setting only the watermark isn't enough any
      // more: a file AT the watermark is a hazard unless it's ours or recorded, so a migrated
      // device could never publish its baseline while the folder's newest file belonged to
      // another device — and the offered recovery (Pull latest) can't decode a v1 file, so the
      // user had no action at all.
      const settings = await this.nextSettings(
        { localVersion: version, lastSyncedVersion: floor, seenSnapshots: pruneSeen(stored?.seenSnapshots, floor, supersededKeys) },
        { stored },
      );
      await this.adapter.collection<AppSettings>(Collections.settings).put(settings);
      this.emit({ version, dirty: true, settings });
    });
  }

  /** Record that `pushedVersion` was uploaded. We do NOT regress the working
   *  version, and we only clear `dirty` if no edit raced ahead during the push
   *  — otherwise autosave reschedules and the latest edit still gets pushed. */
  async markSynced(pushedVersion: number, presentKeys?: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      const stored = await this.settingsRow();
      const settings = await this.nextSettings({
        lastSyncedVersion: pushedVersion,
        // Everything BELOW the version we just published is subsumed by it. Entries AT it are
        // kept: a colliding file from another device sits at that number and is not ours.
        seenSnapshots: pruneSeen(
          stored?.seenSnapshots,
          pushedVersion,
          undefined,
          presentKeys ? new Set(presentKeys) : undefined,
        ),
      }, { stored });
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
