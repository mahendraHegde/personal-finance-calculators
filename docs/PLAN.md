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
| **Storage** | IndexedDB, **on-disk cursor pagination** (never load everything). No SQLite. |
| **Pluggable** | Domain depends only on a generic `StorageAdapter` interface → swap IndexedDB for SQLite/etc. later with zero domain changes |
| **IDs** | UUIDs on every record (stable across devices/merges) |
| **Sync** | Google Drive API, OAuth **client ID only — never a secret** (PKCE/token flow), scope **`drive.file` + Picker** (pick the shared folder once; avoids restricted-scope verification) |
| **Sync model** | Immutable per-session snapshots in one shared folder ("the folder is the database") |
| **File creation** | Created **on first edit**, not on app open. View-only sessions write nothing. |
| **Within a session** | Auto-save (debounced) **updates that one session file**; past sessions' files are never touched (immutable across sessions) |
| **Filenames** | Neutral, time-sortable: `pf-<sessionStartUTC>.pfdb`. Author/version live in Drive `appProperties`, not the name |
| **"Latest"** | `max(appProperties.version)` — a monotonic counter, **not** wall-clock (device clocks drift) |
| **Load flow** | List folder (metadata only) → pick highest version → download just that one → **diff vs local** → prompt **[Load] / [Keep local]** |
| **Concurrency** | Deferred. Last-writer-wins on active state; immutability means the other side's file is never destroyed (recoverable) |
| **Secrets** | Nothing sensitive at rest. Passphrase → **non-extractable `CryptoKey`** in IndexedDB (usable, not exportable). OAuth token in memory, silently re-acquired |
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
- **Account** `{ id, name, type(bank|cash|brokerage|crypto|fd|realestate|liability), currency, personId|"shared", archived? }`
- **Category** `{ id, name, kind(expense|income) }`
- **Transaction** `{ id, date, type(expense|income|transfer), accountId, personId|"shared", amount, currency, categoryId?, note?, transferToAccountId?, updatedAt, author? }`
- **Holding** `{ id, name, personId|"shared", accountId?, assetClass, currency, incomeMode(accumulating|payout), archived? }`
- **HoldingEvent** `{ id, holdingId, date, type(opening|buy|sell|dividend|valuation|adjustment), units?, price?, amount?, fee?, note? }`
- **FxRateSnapshot** `{ id, date, base, rates }` (cached; historical figures use period-appropriate rates)

**Indexes** (for on-disk paginated/filtered reads): `transactions[date]`, `[personId,date]`,
`[accountId,date]`, `[categoryId,date]`; `holdingEvents[holdingId,date]`; `accounts[personId]`;
`holdings[personId]`; `categories[kind]`; `fxRates[date]`.

**XIRR rule**: cashflows are derived from events (opening/buy = outflow, sell/dividend/adjustment =
inflow) + current value as a final inflow at `asOf`; each converted to base at its own date's FX.

---

## Build phases

1. **(this phase)** data model + `StorageAdapter` (IndexedDB + in-memory) + pure domain
   (xirr, currency, holding/net-worth compute) + keyed diff + tests. **No UI.**
2. Expenses UI (add/list/filter/**paginate**, categories, multi-currency)
3. Investments UI (holdings + events + XIRR + data-quality badges + opening-position onboarding)
4. Dashboard (net worth, per-person, **family view**, allocation, trends, FX)
5. File backup/restore (export/import; durability baseline) + encryption (non-extractable key)
6. Drive sync (auth + Picker + session snapshots + load-latest + version-compare + diff modal)
7. PWA + persistent-storage request
8. *(optional)* feed holdings → FIRE calculator corpus buckets
