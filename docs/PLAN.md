# Portfolio & Expenses — Design Plan

A privacy-first, local-first personal finance tracker that lives **inside this repo**
alongside the retirement/FIRE calculator. Tracks expenses, investments (with XIRR),
net worth, multi-currency, **per family member + a consolidated family view**.

This is a lifetime-maintained tool, so the architecture is layered, modular, and the
storage + sync layers are **app-agnostic and reusable** by the FIRE calculator or any
future calculator we add.

---

## Decisions (locked)

| Area | Decision |
|---|---|
| **Home** | New module in `financial-calculators`; reuses Vite/Tailwind/React + GitHub Pages auto-deploy |
| **Storage** | IndexedDB. The adapter supports keyset pagination, but the app currently **loads each collection fully into memory** and filters/sorts/aggregates there — a family's data is tiny (even decades is a few thousand rows). On-disk pagination + secondary indexes are a **deferred** optimization (see *Divergences* below). No SQLite. |
| **Pluggable** | Domain depends only on a generic `StorageAdapter` interface → swap IndexedDB for SQLite/etc. later with zero domain changes |
| **IDs** | UUIDs on every record (stable across devices/merges) |
| **Sync** | Google Drive API, OAuth **client ID only — never a secret** (PKCE/token flow), scope **`drive.file` + Picker** (pick the shared folder once; avoids restricted-scope verification) |
| **Sync model** | Immutable per-session snapshots in one shared folder ("the folder is the database") |
| **File creation** | Created **on first edit**, not on app open. View-only sessions write nothing. |
| **Within a session** | Auto-save (debounced) **updates that one session file**; past sessions' files are never touched (immutable across sessions) |
| **Filenames** | Neutral, time-sortable: `pf-<sessionStartUTC>.pfdb`. Author/version live in Drive `appProperties`, not the name |
| **"Latest"** | `max(appProperties.version)` — a monotonic counter, **not** wall-clock (device clocks drift) |
| **Load flow** | List folder (metadata only) → pick highest version → download just that one → **diff vs local** → prompt **[Load] / [Keep local]** |
| **Concurrency** | No auto-merge (last-writer-wins on *apply*), but conflict is **detected and user-mediated**: pull-before-push guard + post-push TOCTOU re-check + a diff/review modal before applying a remote snapshot. Guards are **session-scoped** (by session file, not device) so two tabs on one profile also conflict-check. Immutable files ⇒ neither side's snapshot is destroyed (recoverable). |
| **Secrets** | Passphrase → **non-extractable `CryptoKey`** in IndexedDB (usable, not exportable). OAuth access token **persisted to `localStorage`** (the user's own ~1h Drive token) so a refresh reuses it — the GIS token flow is popup-based, so the background **never** opens a consent popup; a fresh token is fetched only on an explicit Connect/Reconnect click. |
| **Encryption** | Drive snapshot encrypted (AES-GCM); salt/IV/KDF in cleartext header, only ciphertext is secret |
| **Mobile** | Responsive (Tailwind mobile-first) + installable PWA + `navigator.storage.persist()`; **file backup is the durability backbone** |
| **Hosting** | Plain `github.io` for now (origin isolation + Public Suffix List already prevent cross-site reads); custom domain later, no code change |
| **Security** | Primary control = no XSS (strict CSP, React escaping, no `dangerouslySetInnerHTML`, minimal deps). Key storage is secondary defense-in-depth |

## Legacy data / data-quality (locked)

- Existing holdings onboarded via an **`opening`** event (cost basis + approx start date) plus a
  **`valuation`** event (current value) → **estimated since-inception XIRR**, badged.
- XIRR **degrades gracefully**: no cost basis ⇒ no fake %, show value + a `value-only` badge.
- Default `incomeMode: "accumulating"` ⇒ **dividends embedded in NAV, never entered**.
- For `payout` holdings, reconcile later via an **`adjustment`** plug or bulk import — no rework,
  because XIRR is **derived from events**, events are **append-only + back-datable**.
- Per-holding badge: `complete` (real buys) / `cost-estimate` (opening) / `value-only`.

---

## Architecture (layers, each independently testable)

```
src/
  lib/                       APP-AGNOSTIC, REUSABLE across calculators
    util/      id (uuid)
    storage/   StorageAdapter interface + IndexedDB & in-memory adapters   ← pluggable
    money/     xirr(), currency convert — pure, no React, no DOM
    sync/      diff (keyed) + SyncProvider/Codec interfaces                 ← reusable engine seam
  features/
    portfolio/                 THE NEW APP
      model/   entity types + storage schema (collections + indexes)
      repo/    typed repositories built ON the StorageAdapter interface
      domain/  pure compute: holding XIRR/cashflows, net worth, allocation, rollups
      ui/      React components + hooks (thin; call domain)   [later phase]
  features/retirement/  existing calc (can later adopt lib/sync for its own backup)
```

**Reusability seams**
- `StorageAdapter` / `Collection<T>` — generic CRUD + range queries + keyset pagination + bulk
  export/import. IndexedDB and in-memory implementations ship now; SQLite/other can be added.
- `SyncProvider` (transport) + `Codec<TDoc>` (encrypt/serialize) + `diffDatasets()` — the sync
  engine is generic over the document type, so the FIRE calculator could back up its own config
  to the same Drive folder model with a trivial diff.

---

## Data model (UUID-keyed)

- **Person** `{ id, name, color?, archived? }`
- **Account** `{ id, name, type(bank|cash|creditcard|brokerage|crypto|fd|realestate|liability), currency, personId|"shared", archived? }`
- **Category** `{ id, name, kind(expense|income), parentId?, archived? }` (two levels: parent + sub)
- **Transaction** `{ id, date, type(expense|income|transfer), accountId, personId|"shared", amount, currency, categoryId?, note?, transferToAccountId?, excludeFromBalance?, updatedAt, author? }` — `excludeFromBalance` = reporting-only (historical import; counts in reports, not in balances)
- **Holding** `{ id, name, personId|"shared", accountId?, assetClass, currency, incomeMode(accumulating|payout), ticker?, priceSource?(googlefinance|coingecko|mfapi), archived? }`
- **HoldingEvent** `{ id, holdingId, date, type(opening|buy|sell|dividend|valuation|adjustment), units?, price?, amount?, fee?, note?, createdAt? }`
- **FxRateSnapshot** `{ id, date, base, rates }` (cached; historical figures use period-appropriate rates)

**Live pricing** (optional, per holding via `ticker` + `priceSource`): equities/ETFs and Indian
mutual funds via **GOOGLEFINANCE** (driven through the user's own Google Sheet — same Drive OAuth),
crypto via **CoinGecko**, MF NAV via **mfapi.in**. Value = units × latest price; a refresh writes a
`valuation` event. Same-ticker holdings across brokers share one fetch. A quote with no reported
currency (e.g. mutual funds) is assumed to be in the holding's own currency.

**Indexes**: none currently. Secondary indexes were removed (schema v2) — the store loads each
collection fully into memory and filters/sorts/aggregates there, so they were pure write-overhead.
The adapter's index + keyset-pagination machinery remains, ready to re-introduce (with the specific
indexes: `transactions[date]`/`[personId,date]`/`[accountId,date]`/`[categoryId,date]`,
`holdingEvents[holdingId,date]`, etc.) if the dataset ever outgrows memory.

**XIRR rule**: cashflows are derived from events (opening/buy = outflow, sell/dividend/adjustment =
inflow) + current value as a final inflow at `asOf`; each converted to base at its own date's FX.

---

## Build phases

1. ✅ Data model + `StorageAdapter` (IndexedDB + in-memory) + pure domain (xirr, currency,
   holding/net-worth compute) + keyed diff + tests. No UI.
2. ✅ Expenses UI (add/list/filter, categories, multi-currency; year filter + totals)
3. ✅ Investments UI (holdings + events + XIRR + data-quality badges + opening-position onboarding)
4. ✅ Dashboard (net worth, per-person + **family view**, allocation, trend, FX)
5. ✅ File backup/restore (export/import) + encryption (non-extractable key)
6. ✅ Drive sync (auth + Picker + session snapshots + load-latest + version-compare + diff modal)
7. ✅ PWA + persistent-storage request
8. *(optional, not done)* feed holdings → FIRE calculator corpus buckets

## Shipped beyond the original plan

- **Live pricing** (GOOGLEFINANCE sheet oracle / CoinGecko / mfapi) + auto-revalue a holding on edit.
- **Multi-broker holdings** (same security across Schwab/IBKR/etc.) + per-account/broker **exposure**
  (concentration) view.
- **Historical import** without denting net worth (`excludeFromBalance` reporting-only txns);
  **by-person rollup** attributed by transaction owner; **yearly** income/expense totals;
  **spending & income by category**.
- **INR Lakh/Crore** localized numbering.
- **Archive-instead-of-delete** for referenced people/accounts/categories (hard-delete only when
  unreferenced; archived stays in history + totals, hidden from pickers).
- **Dashboard is hidden-by-default & lazy** (sections compute only when opened; eye for figures,
  chevron for charts) with hover tooltips on the donut + a legend/month-labels on the bar chart.
- **Dialog UX**: autofocus first field; Enter submits the primary action (never Delete); wider forms.

## Divergences from the original plan

- **Load-all-in-memory, no indexes.** The plan assumed on-disk cursor pagination + secondary
  indexes from day one. In practice a family's dataset is tiny, so the store loads everything and
  computes in memory; indexes were removed (schema v2) as pure write-overhead. Pagination + indexes
  are a **deferred** optimization (the adapter still supports them). If the dataset ever outgrows
  memory (tens of thousands of rows over decades), the intended approach is materialized aggregates
  (running per-account/-person/-month totals) + a reconcile-from-scratch check, keyset-paginated
  ledger reads, and per-year-partitioned sync snapshots.
- **OAuth token is persisted** (localStorage), not memory-only + silently re-acquired. The GIS token
  flow is popup-based, so silent background re-acquisition popped a consent dialog on every refresh /
  sync cycle (and failed under Cross-Origin-Opener-Policy on Windows Chrome). Now the background
  reuses the stored token or fails gracefully; popups happen only on an explicit Connect/Reconnect.
- **Concurrency is guarded, not just deferred** (see the Concurrency decision above).
