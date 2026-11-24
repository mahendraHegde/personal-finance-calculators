// Read-only bridge from the Portfolio tab to the retirement calculator.
//
// The Portfolio keeps its data in its own IndexedDB database and exposes no
// API outside its component tree, and it must not be modified.  So this
// module (1) opens that database strictly read-only (never creating or
// upgrading it, closing the connection immediately), and (2) values the
// holdings and account balances with the Portfolio's own pure functions (the
// same ones its Dashboard uses), grouping them into retirement buckets.
// Nothing here writes anywhere.

import { currentHoldingValue, dataQuality, withFdAccrual } from "../features/portfolio/domain/holdings";
import { accountBalances } from "../features/portfolio/domain/networth";
import { Collections, DB_NAME } from "../features/portfolio/model/schema";
import {
  SHARED,
  type Account,
  type AccountType,
  type AppSettings,
  type AssetClass,
  type FxRateSnapshot,
  type Holding,
  type HoldingEvent,
  type Person,
  type Transaction,
} from "../features/portfolio/model/types";
import { makeFxAt } from "../features/portfolio/ui/helpers";
import { withOverrides } from "../lib/fx/fx-service";
import { tryConvert, type FxTable } from "../lib/money/currency";
import { compoundValue, type Compounding } from "../lib/money/interest";
import { clampNum, finiteOr } from "./retirement";

export interface PortfolioSnapshot {
  holdings: Holding[];
  holdingEvents: HoldingEvent[];
  people: Person[];
  fxRates: FxRateSnapshot[];
  settings?: AppSettings;
  // Optional so older callers (and tests) without accounts still work.
  accounts?: Account[];
  transactions?: Transaction[];
}

// "bank": balances of bank, cash and brokerage-cash accounts, kept apart
// from invested holdings so an emergency fund is easy to leave out.
export type ImportGroupKey = AssetClass | "fd" | "bank";

// Which import group an account's positive balance belongs to.  Credit cards
// and loans are debts, not retirement money, so they're left out (null).
// Every account type is listed, so a new type in the Portfolio is a compile
// error here until someone decides where it goes.
const ACCOUNT_GROUP: Record<AccountType, ImportGroupKey | null> = {
  bank: "bank",
  cash: "bank",
  brokerage: "bank",
  fd: "fd",
  crypto: "crypto",
  realestate: "realestate",
  creditcard: null,
  liability: null,
};

export interface ImportGroup {
  key: ImportGroupKey;
  label: string;
  amount: number; // INR
  // Names of the holdings and accounts in the group.
  items: string[];
  // Suggested long-run return after tax and volatility for the bucket.
  suggestedReturn: number;
  suggestedVolatility: number;
  // Real estate is usually not money you draw on in retirement.
  includeByDefault: boolean;
}

export interface ImportPreview {
  groups: ImportGroup[];
  // Holdings and accounts that couldn't be valued (no current value, no FX
  // rate, or an account type this calculator doesn't know).
  skipped: { name: string; reason: string }[];
  // People to offer in the owner filter: everyone active, plus archived
  // people who still own something with a value or that was left out (their
  // money would otherwise be in no owner view), plus "Unknown" for an owner
  // id that isn't in the people list.
  people: { id: string; name: string; archived?: boolean }[];
}

// Owner filter: "all", "shared", or a person id.
export type OwnerFilter = string;

// Listed in the order the groups are shown.  `ret` is the suggested return
// (% a year); for FD and bank groups it is the rate assumed for anything
// without an interest rate in Portfolio, before tax.
const GROUP_INFO: Record<
  ImportGroupKey,
  { label: string; ret: number; vol: number; include: boolean }
> = {
  equity: { label: "Equity (shares & equity funds)", ret: 11, vol: 16, include: true },
  debt: { label: "Debt funds & bonds", ret: 6.5, vol: 3, include: true },
  fd: { label: "Fixed deposits", ret: 6, vol: 0, include: true },
  bank: { label: "Bank & cash accounts", ret: 3, vol: 0, include: true },
  cash: { label: "Cash-type holdings (liquid funds etc.)", ret: 3.5, vol: 0.5, include: true },
  gold: { label: "Gold", ret: 8, vol: 15, include: true },
  crypto: { label: "Crypto", ret: 12, vol: 60, include: true },
  other: { label: "Other investments", ret: 8, vol: 10, include: true },
  realestate: { label: "Real estate", ret: 6, vol: 10, include: false },
};

// Derived, so a group can't be added to GROUP_INFO and then never shown.
const GROUP_ORDER = Object.keys(GROUP_INFO) as ImportGroupKey[];

// Groups whose suggested return is the interest they earn, after tax.
const INTEREST_GROUPS: ReadonlySet<ImportGroupKey> = new Set<ImportGroupKey>(["fd", "bank"]);

// Rates assumed for accounts with no interest rate in Portfolio, by type
// (the Portfolio can't store a 0% rate).  Cash in hand and brokerage cash
// earn nothing; other bank and FD accounts fall back to their group's rate.
const UNRATED_ACCOUNT_RATE: Partial<Record<AccountType, number>> = { cash: 0, brokerage: 0 };

// The assumed rates (% a year, before tax), for the help text.
export const ASSUMED_INTEREST = {
  bank: GROUP_INFO.bank.ret,
  fd: GROUP_INFO.fd.ret,
  cash: UNRATED_ACCOUNT_RATE.cash ?? GROUP_INFO.bank.ret,
  brokerage: UNRATED_ACCOUNT_RATE.brokerage ?? GROUP_INFO.bank.ret,
};

// The tax rate (%) actually applied to interest: 0 to 100, anything that
// isn't a number counts as 0.
export const clampTaxRate = (pct: number): number => clampNum(finiteOr(pct, 0), 0, 100);

// The yearly growth a nominal interest rate gives once compounding is
// counted (7% compounded quarterly grows 7.19% a year), using the
// Portfolio's own interest maths over one 365-day year.  The calculator's
// returns are yearly growth rates, so this is what it needs.  A non-number
// rate gives undefined (treated as unknown).
const effectiveAnnualPct = (ratePct: number, compounding: Compounding): number | undefined =>
  Number.isFinite(ratePct)
    ? (compoundValue(1, ratePct, compounding, "2001-01-01", "2002-01-01") - 1) * 100
    : undefined;

// The Portfolio's FX table: newest cached snapshot + the user's manual
// overrides (same rule as its store).
const portfolioFx = (snapshot: PortfolioSnapshot): FxTable => {
  const latest = [...snapshot.fxRates].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const base: FxTable = latest
    ? { base: latest.base, rates: latest.rates }
    : { base: "USD", rates: { USD: 1 } };
  return withOverrides(base, snapshot.settings?.fxOverrides ?? {});
};

const QUALITY_REASON: Record<string, string> = {
  "needs-valuation": "no up-to-date value in Portfolio (refresh prices or add a valuation)",
};

// Pure: value every active holding and every account with money (owned by
// `owner`) in INR and group them.  Each holding and account counts in full
// for its owner as set in the Portfolio.  Interest earned by FDs and bank
// accounts is taxed every year at your income-tax rate, so their suggested
// return is the yearly interest (compounding included) after
// `interestTaxRate` (%), matching the after-tax returns the calculator asks
// for.
export function buildImportPreview(
  snapshot: PortfolioSnapshot,
  owner: OwnerFilter,
  asOf: string,
  interestTaxRate = 0,
): ImportPreview {
  const afterTax = 1 - clampTaxRate(interestTaxRate) / 100;
  const fx = portfolioFx(snapshot);
  const eventsByHolding = new Map<string, HoldingEvent[]>();
  for (const e of snapshot.holdingEvents) {
    const list = eventsByHolding.get(e.holdingId);
    if (list) list.push(e);
    else eventsByHolding.set(e.holdingId, [e]);
  }
  // "Name · Owner" (two people's "HDFC" accounts would otherwise read
  // "HDFC, HDFC").  Same wording as the Portfolio's `ownerLabel`, which needs
  // its whole store state rather than a snapshot.
  const ownerName = (id: string) =>
    id === SHARED ? "Shared" : (snapshot.people.find((p) => p.id === id)?.name ?? "Unknown");
  const label = (name: string, ownerId: string) => `${name} · ${ownerName(ownerId)}`;
  // Everyone who owns something that has a value or was left out, whatever
  // `owner` is: the owner list is built from this.  Everything is valued for
  // every owner, and only then filtered, so this can't drift from what each
  // owner's view shows.
  const owners = new Set<string>();
  const mine = (ownerId: string) => {
    owners.add(ownerId);
    return owner === "all" || ownerId === owner;
  };
  const groups = new Map<ImportGroupKey, ImportGroup & { rateWeight: number; ratedAmount: number }>();
  const skipped: ImportPreview["skipped"] = [];
  // Add `inr` to a group; `ratePct` (FD or savings interest) feeds the
  // value-weighted suggested return for FD and bank groups.
  const addTo = (key: ImportGroupKey, name: string, inr: number, ratePct?: number) => {
    const info = GROUP_INFO[key];
    const g =
      groups.get(key) ??
      {
        key,
        label: info.label,
        amount: 0,
        items: [],
        suggestedReturn: info.ret,
        suggestedVolatility: info.vol,
        includeByDefault: info.include,
        rateWeight: 0,
        ratedAmount: 0,
      };
    g.amount += inr;
    g.items.push(name);
    if (ratePct !== undefined && Number.isFinite(ratePct)) {
      g.rateWeight += inr * ratePct;
      g.ratedAmount += inr;
    }
    groups.set(key, g);
  };
  for (const h of snapshot.holdings) {
    if (h.archived) continue;
    const events = withFdAccrual(h, eventsByHolding.get(h.id) ?? [], asOf);
    const native = currentHoldingValue(events);
    if (native === null) {
      const q = dataQuality(events);
      // A closed position (everything sold) simply isn't held any more.
      if (q === "needs-valuation" && mine(h.personId)) {
        skipped.push({ name: label(h.name, h.personId), reason: QUALITY_REASON[q] });
      }
      continue;
    }
    // Nothing to import (checked before the exchange rate, so a worthless
    // holding is never reported as left out).
    if (!(native > 0) || !Number.isFinite(native)) continue;
    const inr = tryConvert({ amount: native, currency: h.currency }, "INR", fx);
    if (inr === null) {
      if (mine(h.personId)) {
        skipped.push({ name: label(h.name, h.personId), reason: `no ${h.currency}→INR exchange rate in Portfolio yet` });
      }
      continue;
    }
    if (!(inr > 0) || !Number.isFinite(inr)) continue;
    if (!mine(h.personId)) continue;
    // An asset class this version doesn't know yet goes to "Other" rather
    // than being dropped.
    const key: ImportGroupKey = h.fd
      ? "fd"
      : Object.prototype.hasOwnProperty.call(GROUP_INFO, h.assetClass)
        ? h.assetClass
        : "other";
    // FDs: suggest the value-weighted interest rate they actually earn.  An
    // FD that pays its interest out doesn't compound.
    const fdRate = h.fd
      ? effectiveAnnualPct(h.fd.ratePct, h.incomeMode === "payout" ? "simple" : h.fd.compounding)
      : undefined;
    addTo(key, label(h.name, h.personId), inr, fdRate);
  }

  // Account balances, computed exactly as the Portfolio's Dashboard does
  // (opening balance + transactions + read-time savings interest).  Each
  // account counts in full for its owner, like holdings.  (Splitting by who
  // made each transaction doesn't work for this: the Portfolio files every
  // transfer as "shared", so a person's own transfers would be stranded
  // under "shared".)  Archived accounts that still hold money are included,
  // as the Portfolio's Dashboard includes them.
  const accounts = snapshot.accounts ?? [];
  if (accounts.length > 0) {
    const fxAt = makeFxAt(snapshot.fxRates, fx.base, fx);
    const balances = accountBalances(accounts, snapshot.transactions ?? [], fxAt, asOf);
    for (const a of accounts) {
      const key: ImportGroupKey | null | undefined = ACCOUNT_GROUP[a.type];
      if (key === null) continue; // credit card or loan
      const native = balances.get(a.id) ?? 0;
      if (!(native > 0) || !Number.isFinite(native)) continue;
      if (key === undefined) {
        // A type from a newer Portfolio version: say so rather than drop it.
        if (mine(a.personId)) {
          skipped.push({
            name: label(a.name, a.personId),
            reason: `account type "${a.type}" isn't supported by this calculator yet`,
          });
        }
        continue;
      }
      const inr = tryConvert({ amount: native, currency: a.currency }, "INR", fx);
      if (inr === null) {
        if (mine(a.personId)) {
          skipped.push({ name: label(a.name, a.personId), reason: `no ${a.currency}→INR exchange rate in Portfolio yet` });
        }
        continue;
      }
      if (!mine(a.personId)) continue;
      const ratePct = INTEREST_GROUPS.has(key)
        ? a.interest
          ? effectiveAnnualPct(a.interest.ratePct, a.interest.frequency)
          : UNRATED_ACCOUNT_RATE[a.type]
        : undefined;
      addTo(key, label(a.name, a.personId), inr, ratePct);
    }
  }
  const out: ImportGroup[] = [];
  for (const key of GROUP_ORDER) {
    const g = groups.get(key);
    if (!g) continue;
    const { rateWeight, ratedAmount, ...group } = g;
    // Interest-bearing groups suggest the value-weighted rate actually
    // earned (anything without a known rate counts at the group default),
    // after income tax on the interest.
    if (INTEREST_GROUPS.has(key)) {
      const blended = (rateWeight + (g.amount - ratedAmount) * GROUP_INFO[key].ret) / g.amount;
      // An absurd stored rate can overflow; fall back to the group default.
      const rate = Number.isFinite(blended) ? blended : GROUP_INFO[key].ret;
      group.suggestedReturn = Math.round(rate * afterTax * 10) / 10;
    }
    out.push(group);
  }
  const known = new Set(snapshot.people.map((p) => p.id));
  return {
    groups: out,
    skipped,
    people: [
      ...snapshot.people
        .filter((p) => !p.archived || owners.has(p.id))
        .map((p) => ({ id: p.id, name: p.name, ...(p.archived ? { archived: true } : {}) })),
      // An owner id missing from the people list (shouldn't happen: the
      // Portfolio won't delete a person who still owns things), so that
      // money still has an owner view.
      ...[...owners]
        .filter((id) => id !== SHARED && !known.has(id))
        .map((id) => ({ id, name: ownerName(id) })),
    ],
  };
}

const request = <T,>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// Browser-only, strictly read-only.  Resolves null when the Portfolio has no
// data on this device.  Never creates or upgrades the database: it is opened
// without a version (so an existing one is used as-is), an open that would
// create it is aborted, and the connection is closed straight after one
// read-only transaction (and earlier if the Portfolio needs to upgrade).
export async function readPortfolioSnapshot(): Promise<PortfolioSnapshot | null> {
  if (typeof indexedDB === "undefined") return null;
  if (typeof indexedDB.databases === "function") {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === DB_NAME)) return null;
  }
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      // Only fires when the database doesn't exist yet: don't create it.
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      if (req.error?.name === "AbortError") resolve(null);
      else reject(req.error);
    };
  });
  if (!db) return null;
  db.onversionchange = () => db.close();
  try {
    const wanted = [
      Collections.holdings,
      Collections.holdingEvents,
      Collections.people,
      Collections.fxRates,
      Collections.settings,
      Collections.accounts,
      Collections.transactions,
    ];
    if (!db.objectStoreNames.contains(Collections.holdings) && !db.objectStoreNames.contains(Collections.accounts)) {
      return null;
    }
    const present = wanted.filter((n) => db.objectStoreNames.contains(n));
    const tx = db.transaction(present, "readonly");
    const all = <T,>(name: string): Promise<T[]> =>
      present.includes(name as (typeof wanted)[number])
        ? request(tx.objectStore(name).getAll() as IDBRequest<T[]>)
        : Promise.resolve([]);
    const [holdings, holdingEvents, people, fxRates, settingsRows, accounts, transactions] =
      await Promise.all([
        all<Holding>(Collections.holdings),
        all<HoldingEvent>(Collections.holdingEvents),
        all<Person>(Collections.people),
        all<FxRateSnapshot>(Collections.fxRates),
        all<AppSettings>(Collections.settings),
        all<Account>(Collections.accounts),
        all<Transaction>(Collections.transactions),
      ]);
    return { holdings, holdingEvents, people, fxRates, settings: settingsRows[0], accounts, transactions };
  } finally {
    db.close();
  }
}
