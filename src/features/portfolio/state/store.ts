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
  Person,
  SnapshotDoc,
  Transaction,
} from "../model/types";
import { createPortfolioRepo, type PortfolioRepo } from "../repo/portfolio-repo";
import { netUnits } from "../domain/holdings";

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
    await this.commit(() => {
      const usedByTxn = this.state.transactions.some(
        (t) => t.accountId === id || t.transferToAccountId === id,
      );
      const usedByHolding = this.state.holdings.some((h) => h.accountId === id);
      if (usedByTxn || usedByHolding) {
        throw new Error("This account has transactions or holdings — remove or reassign them first.");
      }
      return {
        ops: [{ collection: Collections.accounts, op: "delete", id }],
        patch: { accounts: this.state.accounts.filter((x) => x.id !== id) },
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
        preserve: [Collections.settings, Collections.fxRates],
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
