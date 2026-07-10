// Portfolio domain entities. All UUID-keyed; all monetary values carry their
// own native currency (conversion to a base happens at read time via FxTable).

import type { CurrencyCode } from "../../../lib/money/currency";
import type { Entity } from "../../../lib/storage/types";
import type { Keyring } from "../../../lib/crypto/keyring";

export type ID = string;

/** Sentinel personId for assets/expenses shared by the whole family. */
export const SHARED = "shared";
export type Owner = ID | typeof SHARED;

export interface Person {
  id: ID;
  name: string;
  color?: string;
  archived?: boolean;
}

export type AccountType =
  | "bank"
  | "cash"
  | "creditcard"
  | "brokerage"
  | "crypto"
  | "fd"
  | "realestate"
  | "liability";

export interface Account {
  id: ID;
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  personId: Owner;
  archived?: boolean;
}

export type CategoryKind = "expense" | "income";

export interface Category {
  id: ID;
  name: string;
  kind: CategoryKind;
  /** Parent category id for a SUB-category; absent for a top-level category.
   *  A subcategory inherits its parent's `kind`. (Two levels only.) */
  parentId?: ID;
  /** Hidden from the Add/Edit pickers but kept for history (old transactions
   *  still resolve its name). Set when a referenced category can't be deleted. */
  archived?: boolean;
}

export type TxnType = "expense" | "income" | "transfer";

export interface Transaction {
  id: ID;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  type: TxnType;
  accountId: ID;
  personId: Owner;
  amount: number;
  currency: CurrencyCode;
  categoryId?: ID;
  note?: string;
  /** For transfers: the destination account. */
  transferToAccountId?: ID;
  /** Reporting-only: when true this transaction is EXCLUDED from account balances
   *  & net worth, but still counts in income/expense reports. For importing past
   *  expenses that are already reflected in your current balance — recording them
   *  shouldn't double-deduct from net worth. */
  excludeFromBalance?: boolean;
  /** ISO timestamp of last edit (for audit / future merge). */
  updatedAt: string;
  author?: string;
}

export type AssetClass =
  | "equity"
  | "debt"
  | "cash"
  | "crypto"
  | "gold"
  | "realestate"
  | "other";

/** accumulating: dividends embedded in NAV (skip entry). payout: real cashflows. */
export type IncomeMode = "accumulating" | "payout";

/** Where to fetch a live price for a holding.
 *  - googlefinance: equities/ETFs via the user's GOOGLEFINANCE Sheet (native ccy)
 *  - coingecko: crypto (quoted in USD)
 *  - mfapi: Indian mutual-fund NAV via mfapi.in (INR) */
export type PriceSource = "googlefinance" | "coingecko" | "mfapi";

/** Compounding of a fixed deposit. `simple` = no compounding (P·(1+r·t)); the
 *  rest compound n times/yr (12/4/2/1). `quarterly` is the common bank default. */
export type FdCompounding = "simple" | "monthly" | "quarterly" | "halfyearly" | "annually";

/** Fixed-deposit auto-accrual terms. When set on a holding, its value is COMPUTED
 *  by compound interest from the opening principal (or the latest manual valuation,
 *  which re-bases and thus overrides it) up to the current date, capped at maturity.
 *  The result is an ESTIMATE — banks round / use exact day-counts / deduct TDS — so
 *  a manual `valuation` event still wins for exact reconciliation. */
export interface FdTerms {
  /** Annual interest rate, percent (e.g. 7.1 for 7.1%). */
  ratePct: number;
  compounding: FdCompounding;
  /** ISO date; accrual stops here (value freezes at the matured amount). */
  maturityDate?: string;
}

export interface Holding {
  id: ID;
  name: string;
  personId: Owner;
  accountId?: ID;
  assetClass: AssetClass;
  currency: CurrencyCode;
  incomeMode: IncomeMode;
  /** Symbol for live pricing: a GOOGLEFINANCE ticker (e.g. "NSE:INFY", "VOO")
   *  or a CoinGecko id (e.g. "bitcoin"). Live value = units held × price, so it
   *  only applies to unit-tracked holdings priced in `currency`. */
  ticker?: string;
  priceSource?: PriceSource;
  /** Fixed-deposit terms — when present, the value auto-accrues (see FdTerms). */
  fd?: FdTerms;
  archived?: boolean;
}

export type HoldingEventType =
  | "opening" // legacy onboarding: cost basis at an (approx) start date
  | "buy"
  | "sell"
  | "dividend" // payout only
  | "valuation" // current market value marker (not a cashflow)
  | "adjustment"; // reconciliation plug (signed)

export interface HoldingEvent {
  id: ID;
  holdingId: ID;
  date: string;
  type: HoldingEventType;
  units?: number;
  price?: number;
  /** Direct money amount when units/price aren't used (opening/dividend/valuation/adjustment). */
  amount?: number;
  fee?: number;
  note?: string;
  /** ISO timestamp the event was recorded — breaks same-`date` ties so a later
   *  correction (e.g. a re-entered valuation for today) wins over the stale one. */
  createdAt?: string;
}

export interface FxRateSnapshot {
  id: ID;
  /** ISO date this rate set applies to. */
  date: string;
  base: CurrencyCode;
  rates: Record<CurrencyCode, number>;
}

/** Confidence in a holding's computed return. `needs-valuation` = an open
 *  position with no current/fresh value, so value and return can't be shown. */
export type DataQuality = "complete" | "cost-estimate" | "value-only" | "needs-valuation";

/** Single app-settings record (id is always "app"). */
export interface AppSettings {
  id: "app";
  /** Currency the dashboard presents totals in. */
  displayCurrency: CurrencyCode;
  /** Stable per-device id, used in snapshot metadata. */
  deviceId: string;
  /** This member's display name, stamped on snapshots. */
  author: string;
  /** Manual FX overrides (units of CCY per 1 USD). */
  fxOverrides: Record<CurrencyCode, number>;
  /** Cached copy of the folder's keyring (envelope encryption): the DEK wrapped
   *  by the passphrase-derived KEK, plus its version/dekId/kdf. Non-secret, and
   *  device-local (stripped from snapshots). Survives lock so the UI can tell
   *  "configured but locked" from "no vault", enables offline passphrase check
   *  (unwrap the DEK), and lets a device re-upload the keyring if Drive's copy is
   *  deleted. See docs/MIGRATION_HISTORY.md. */
  vaultKeyring?: Keyring;
  /** LEGACY (pre-envelope) shared KDF salt: the passphrase-derived key encrypted
   *  files DIRECTLY. Kept only to detect + migrate a v1 vault to the keyring, and
   *  to read old `pfdb-v1` snapshots. New vaults set `vaultKeyring` instead. */
  vaultKdf?: { salt: string; iterations: number };
  /** LEGACY sentinel for offline v1 passphrase check. v2 verifies by unwrapping
   *  the keyring instead. Retained for v1 devices that haven't migrated yet. */
  vaultCheck?: { iv: string; ciphertext: string };
  /** ISO timestamp rates were last refreshed. */
  fxUpdatedAt?: string;
  /** Spreadsheet id of the auto-created GOOGLEFINANCE price oracle (device-local
   *  scratch sheet; not synced). */
  priceSheetId?: string;
  /** Google config (client id / api key / chosen shared folder). */
  drive?: {
    clientId?: string;
    apiKey?: string;
    folderId?: string;
    folderName?: string;
  };
  /** Highest snapshot version this device has loaded/written. */
  lastSyncedVersion: number;
  /** Working version counter, PERSISTED on every edit so a reload before a push
   *  rehydrates the unsynced version/dirty state instead of resetting to synced. */
  localVersion: number;
}

/** The full document serialised into a snapshot/backup file. */
export interface SnapshotDoc {
  schemaVersion: number;
  version: number;
  /** Every collection's records (StorageAdapter.exportAll() shape). */
  data: Record<string, Entity[]>;
}
