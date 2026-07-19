// Pure net-worth & rollup compute. Converts every native-currency balance and
// holding value into the base currency, then aggregates: total, assets vs
// liabilities, per-person, and asset-class allocation. Anything contributing a
// negative base value counts as a liability — so the liability sign convention
// doesn't matter.

import type { CurrencyCode, FxTable } from "../../../lib/money/currency";
import { tryConvert } from "../../../lib/money/currency";
import { accruedInterest, type BalanceDelta } from "../../../lib/money/interest";
import { xirr, type Cashflow } from "../../../lib/money/xirr";
import { holdingReturnFlows } from "./holdings";
import type { Account, AccountType, AssetClass, Holding, HoldingEvent, ID, Owner, Transaction } from "../model/types";

/** How a cash ACCOUNT's positive balance maps into the asset-class allocation
 *  (holdings bring their own `assetClass`). `bank`/`cash`/`brokerage` are liquid
 *  cash; an `fd` account is fixed-income (debt). `creditcard`/`liability` are
 *  omitted — their balance is a liability, not an asset slice. */
const ACCOUNT_ASSET_CLASS: Partial<Record<AccountType, AssetClass>> = {
  bank: "cash",
  cash: "cash",
  brokerage: "cash",
  fd: "debt",
  crypto: "crypto",
  realestate: "realestate",
};

/** Amount credited to a transfer's DESTINATION account, in that account's own
 *  currency (converts when the transfer currency differs). `null` when a
 *  cross-currency transfer has no FX rate — callers then skip the whole transfer
 *  rather than credit a mis-scaled amount. Centralised so the conversion rule lives
 *  in one place (the balance rollup and `accountTxnDelta`). */
function transferCredit(t: Transaction, dest: Account, fx?: FxTable): number | null {
  if (fx && dest.currency !== t.currency) {
    return tryConvert({ amount: t.amount, currency: t.currency }, dest.currency, fx);
  }
  return t.amount;
}

/** Signed effect of transaction `t` on `account`'s own-currency balance: income
 *  into it → +amount, expense on it → −amount, a transfer's source leg → −amount
 *  and its destination leg → +credit (converted). 0 when `t` doesn't touch the
 *  account or is `excludeFromBalance`. This is the TOTAL effect on the account
 *  (both legs if a transfer somehow targets it twice); the sign rules live here so
 *  the balance rollup and the autopay statement-balance share them. */
export function accountTxnDelta(t: Transaction, account: Account, fx?: FxTable): number {
  if (t.excludeFromBalance) return 0;
  if (t.type === "income") return t.accountId === account.id ? t.amount : 0;
  if (t.type === "expense") return t.accountId === account.id ? -t.amount : 0;
  let d = 0;
  if (t.accountId === account.id) d -= t.amount;
  if (t.transferToAccountId === account.id) {
    // An unconvertible cross-currency credit contributes 0 rather than a mis-scaled
    // raw amount (mirrors the balance rollup skipping such a transfer).
    const credit = transferCredit(t, account, fx);
    if (credit !== null) d += credit;
  }
  return d;
}

/** FX for cross-currency transfer credits: either a fixed table, or a per-date
 *  resolver `(date) => FxTable`. Pass the resolver to credit a cross-currency
 *  transfer at ITS OWN date's rate (a stable historical figure) instead of
 *  re-deriving it from the source amount at today's rate on every read (which makes
 *  a transfer-funded foreign balance "breathe" with the current rate). A fixed
 *  table keeps the old behaviour and is fine for same-currency data. */
export type FxSource = FxTable | ((date: string) => FxTable);

const fxFor = (fx: FxSource | undefined, date: string): FxTable | undefined =>
  typeof fx === "function" ? fx(date) : fx;

/** Running balance per account, in that account's own currency (opening balance +
 *  transactions, plus read-time interest when `asOf` is given). A convenience over
 *  `accountBalancesByPerson`; see it for the transfer/currency/attribution rules. */
export function accountBalances(
  accounts: Account[],
  transactions: Transaction[],
  fx?: FxSource,
  asOf?: string,
): Map<ID, number> {
  // Derive the per-account total by summing the per-person breakdown, so the two
  // can never diverge (the per-person rollup must add up to the account total).
  return sumAccountBalances(accountBalancesByPerson(accounts, transactions, fx, asOf));
}

/** Collapse a per-account per-person breakdown to per-account totals. Exposed so a
 *  caller that already built the byPerson map (e.g. the dashboard, which needs
 *  both) can derive the totals without a SECOND transaction scan + interest pass. */
export function sumAccountBalances(byPerson: Map<ID, Map<Owner, number>>): Map<ID, number> {
  const bal = new Map<ID, number>();
  for (const [id, persons] of byPerson) {
    let sum = 0;
    for (const v of persons.values()) sum += v;
    bal.set(id, sum);
  }
  return bal;
}

/**
 * Per-account, per-person native-currency balance. Each transaction's effect is
 * attributed to its OWN `personId` (NOT the account's owner) — so a personal
 * expense/income booked on a SHARED account counts toward that person, not
 * "shared". Summing the persons of an account gives its total balance. Skips
 * `excludeFromBalance` (historical) transactions entirely.
 *
 * An account's `openingBalance` (money it already held) is seeded to the ACCOUNT
 * OWNER — not a transaction, so it never appears in income reports. When `asOf` is
 * supplied, any account with `interest` config also accrues READ-TIME interest on
 * its daily balance up to `asOf` (added to the owner) — an estimate; omit `asOf`
 * to get the plain balance with no interest.
 */
export function accountBalancesByPerson(
  accounts: Account[],
  transactions: Transaction[],
  fx?: FxSource,
  asOf?: string,
): Map<ID, Map<Owner, number>> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<ID, Map<Owner, number>>();
  for (const a of accounts) out.set(a.id, new Map());
  const bump = (accId: ID, who: Owner, delta: number): void => {
    const m = out.get(accId);
    if (m) m.set(who, (m.get(who) ?? 0) + delta);
  };

  // Seed opening balances (attributed to the account owner — not a transaction, so
  // it stays out of income/expense reports).
  for (const a of accounts) if (a.openingBalance) bump(a.id, a.personId, a.openingBalance);

  // For interest-bearing accounts (only when we know the as-of date) collect the
  // dated balance changes so we can accrue interest on the fluctuating balance.
  const interestAccts = asOf
    ? new Set(accounts.filter((a) => a.interest && a.interest.ratePct > 0).map((a) => a.id))
    : new Set<ID>();
  const deltas = new Map<ID, BalanceDelta[]>();
  const track = (accId: ID, date: string, amount: number): void => {
    if (!interestAccts.has(accId)) return;
    const arr = deltas.get(accId);
    if (arr) arr.push({ date, amount });
    else deltas.set(accId, [{ date, amount }]);
  };

  for (const t of transactions) {
    if (t.excludeFromBalance) continue; // historical / reporting-only → not in balances
    if (t.type === "transfer") {
      // All-or-nothing on endpoint presence: a transfer nets to zero, so if EITHER
      // account is missing (an incomplete import / cross-device snapshot whose
      // Account rows didn't all land) skip the WHOLE transfer rather than applying
      // one leg — half-applying silently loses money from net worth (missing dest)
      // or fabricates it (missing source). Same for an unconvertible cross-currency
      // transfer (transferCredit → null).
      const toId = t.transferToAccountId;
      if (!toId || !byId.has(t.accountId)) continue;
      const dest = byId.get(toId);
      if (!dest) continue;
      // Credit at the transfer's OWN date when a resolver is supplied — so the
      // dest-currency amount is locked to the transfer-date rate, not re-derived at
      // today's rate on every read.
      const credit = transferCredit(t, dest, fxFor(fx, t.date));
      if (credit === null) continue;
      // Both legs carry the transaction's personId (SHARED for transfers), so a
      // transfer nets out within that person and doesn't shift attribution.
      bump(t.accountId, t.personId, -t.amount); // source leg, in t.currency
      bump(toId, t.personId, credit); // dest leg (both endpoints confirmed present)
      track(t.accountId, t.date, -t.amount);
      track(toId, t.date, credit);
      continue;
    }
    // income / expense — a single leg on t.accountId (no-op if that account is gone).
    // fx is irrelevant here (no transfer leg), but resolve it to a table for the type.
    const acct = byId.get(t.accountId);
    if (!acct) continue;
    const delta = accountTxnDelta(t, acct, fxFor(fx, t.date));
    bump(t.accountId, t.personId, delta);
    track(t.accountId, t.date, delta);
  }

  // Read-time interest on the accrued daily balance (added to the account owner).
  if (asOf) {
    for (const a of accounts) {
      if (!interestAccts.has(a.id) || !a.interest) continue;
      const interest = accruedInterest(
        a.openingBalance ?? 0,
        a.openingBalanceDate,
        deltas.get(a.id) ?? [],
        a.interest.ratePct,
        a.interest.frequency,
        asOf,
      );
      if (interest) bump(a.id, a.personId, interest);
    }
  }
  return out;
}

export interface NetWorthInput {
  accounts: Account[];
  /** account.id → native-currency balance (from accountBalances). */
  balances: Map<ID, number>;
  /** account.id → (personId → native-currency balance) from
   *  accountBalancesByPerson. When supplied, the per-person rollup attributes
   *  each transaction to ITS person (a personal expense on a shared account
   *  counts against that person). When omitted, falls back to the account owner. */
  balancesByPerson?: Map<ID, Map<Owner, number>>;
  holdings: Holding[];
  /** holding.id → native-currency current value. */
  holdingValues: Map<ID, number | null>;
  fx: FxTable;
}

export interface NetWorthResult {
  base: CurrencyCode;
  total: number;
  assets: number;
  liabilities: number;
  byPerson: Record<Owner, number>;
  byAssetClass: Partial<Record<AssetClass, number>>;
}

export function netWorth(input: NetWorthInput): NetWorthResult {
  const { fx } = input;
  const byPerson: Record<string, number> = {};
  const byAssetClass: Partial<Record<AssetClass, number>> = {};
  let assets = 0;
  let liabilities = 0;

  const addPerson = (who: Owner, v: number): void => {
    byPerson[who] = (byPerson[who] ?? 0) + v;
  };
  const classify = (v: number): void => {
    if (v >= 0) assets += v;
    else liabilities += -v;
  };

  // A currency missing from the FX table is skipped (not fatal) — a single bad
  // code can't take down the whole net-worth computation. total/assets/liabilities
  // come from each account's TOTAL balance; the per-person rollup is attributed by
  // transaction owner when `balancesByPerson` is supplied (else by account owner).
  // Both are gated by the SAME per-account decision (one loop), so the per-person
  // rollup can never diverge from the total — if an account's total is skipped
  // (non-finite / unconvertible), none of its per-person parts are counted either.
  for (const a of input.accounts) {
    const native = input.balances.get(a.id) ?? 0;
    if (!Number.isFinite(native)) continue; // a NaN balance would poison the total
    const v = tryConvert({ amount: native, currency: a.currency }, fx.base, fx);
    if (v === null || !Number.isFinite(v)) continue;
    classify(v);
    // Fold the account's cash into the asset-class allocation (positive balances
    // only — a negative balance is a liability, already counted in `liabilities`,
    // not an asset slice). This is what makes idle cash / deposits show up in the
    // allocation alongside holdings, instead of the donut being investments-only.
    if (v > 0) {
      const cls = ACCOUNT_ASSET_CLASS[a.type];
      if (cls) byAssetClass[cls] = (byAssetClass[cls] ?? 0) + v;
    }
    const persons = input.balancesByPerson?.get(a.id);
    if (!persons) {
      addPerson(a.personId, v); // fallback / no breakdown: attribute to the owner
      continue;
    }
    // Distribute the account's value across the people who transacted on it. Sums
    // to `v` because convert() is linear and the sub-balances sum to the total.
    for (const [who, sub] of persons) {
      if (!Number.isFinite(sub)) continue;
      const pv = tryConvert({ amount: sub, currency: a.currency }, fx.base, fx);
      if (pv === null || !Number.isFinite(pv)) continue;
      addPerson(who, pv);
    }
  }

  for (const h of input.holdings) {
    if (h.archived) continue; // settled/redeemed — no longer an asset (its cash moved to an account)
    const native = input.holdingValues.get(h.id);
    if (native === null || native === undefined || !Number.isFinite(native)) continue;
    const v = tryConvert({ amount: native, currency: h.currency }, fx.base, fx);
    if (v === null || !Number.isFinite(v)) continue;
    classify(v);
    addPerson(h.personId, v);
    byAssetClass[h.assetClass] = (byAssetClass[h.assetClass] ?? 0) + v;
  }

  return {
    base: fx.base,
    total: assets - liabilities,
    assets,
    liabilities,
    byPerson,
    byAssetClass,
  };
}

export interface TotalReturn {
  /** Money-weighted (XIRR) return across holdings + all asset accounts (ex
   *  credit-card / liability), base currency; null when not computable. Idle cash
   *  is included, so it DRAGS the figure — this is a personal rate of return on
   *  total assets, not just investments (that's `portfolioReturn`). */
  xirr: number | null;
  /** Base-currency value of the included assets (net worth excluding liabilities). */
  value: number;
  /** Holdings + accounts that contributed cashflows. */
  included: number;
}

/**
 * Personal money-weighted rate of return on ALL assets (ex-liabilities): the
 * holding cashflows (reused from `holdingReturnFlows`) PLUS each non-liability
 * account's cashflows — money added (income / opening balance / transfer-in) is a
 * contribution (outflow), money removed (expense / transfer-out) a distribution
 * (inflow), and the current balance (incl. read-time interest) a final inflow at
 * `asOf`. One XIRR over the whole series.
 *
 * The account cashflow at each event is the NEGATIVE of its balance effect
 * (`accountTxnDelta`), so a savings account's series collapses to
 * (contributions − withdrawals + interest): its contribution to the return is
 * exactly its interest, a 0% cash account contributes 0 (a drag), and an internal
 * transfer between two included accounts cancels. An account whose currency lacks a
 * rate at some cashflow date is skipped whole (like a holding), never folded in
 * with dropped flows.
 */
export function totalReturn(
  holdings: Holding[],
  eventsByHolding: Map<string, HoldingEvent[]>,
  accounts: Account[],
  transactions: Transaction[],
  base: CurrencyCode,
  fxAt: (date: string) => FxTable,
  asOf: string,
  /** The per-account terminal balances the caller already computed with the SAME
   *  `fxAt`/`asOf` (e.g. the dashboard's `balances`). Passing it avoids a second
   *  full transaction scan + interest pass. Recomputed when omitted. */
  balances?: Map<ID, number>,
): TotalReturn {
  const h = holdingReturnFlows(holdings, eventsByHolding, base, fxAt, asOf);
  const flows: Cashflow[] = [...h.flows];
  let value = h.value;
  let included = h.included;

  // Terminal native balances (incl. read-time interest) for every account, crediting
  // cross-currency transfers at their own date's rate (fxAt) — matching the per-flow
  // conversion below, so terminal and flows agree. Reuse the caller's map when given.
  const balNow = balances ?? accountBalances(accounts, transactions, fxAt, asOf);
  const byId = new Map(accounts.map((x) => [x.id, x]));
  // Group each transaction under every account it touches (source + destination,
  // deduped so a self-transfer isn't counted twice).
  const touching = new Map<ID, Transaction[]>();
  const add = (accId: ID, t: Transaction): void => {
    const arr = touching.get(accId);
    if (arr) arr.push(t);
    else touching.set(accId, [t]);
  };
  for (const t of transactions) {
    add(t.accountId, t);
    if (t.transferToAccountId && t.transferToAccountId !== t.accountId) add(t.transferToAccountId, t);
  }

  for (const a of accounts) {
    if (a.type === "creditcard" || a.type === "liability") continue; // ex-liabilities
    const txns = touching.get(a.id) ?? [];
    const terminal = balNow.get(a.id) ?? 0;
    if (terminal === 0 && txns.length === 0 && !a.openingBalance) continue; // empty account

    // Native cashflows: cashflow = −(balance effect). Opening balance + contributions
    // negative; withdrawals positive; terminal value positive.
    let earliest: string | undefined;
    for (const t of txns) if (earliest === undefined || t.date < earliest) earliest = t.date;
    const openDate = a.openingBalanceDate ?? earliest ?? asOf;
    const native: Cashflow[] = [];
    if (a.openingBalance) native.push({ date: openDate, amount: -a.openingBalance });
    for (const t of txns) {
      // Mirror accountBalances' all-or-nothing transfer skip so the flows agree with
      // the terminal: a transfer with a missing endpoint (or an unconvertible
      // cross-currency leg) isn't in the balance, so it must not create a phantom
      // cashflow here (which would otherwise poison the whole XIRR).
      if (t.type === "transfer") {
        const toId = t.transferToAccountId;
        if (!toId || !byId.has(t.accountId)) continue;
        const dest = byId.get(toId);
        if (!dest || transferCredit(t, dest, fxAt(t.date)) === null) continue;
      }
      const delta = accountTxnDelta(t, a, fxAt(t.date));
      if (delta !== 0) native.push({ date: t.date, amount: -delta });
    }
    native.push({ date: asOf, amount: terminal });
    // Contributes nothing (empty / excluded-only / washed to zero) → skip so it
    // neither adds a stray zero flow nor inflates `included`.
    if (native.every((cf) => cf.amount === 0)) continue;

    // Convert each to base at its date; skip the WHOLE account if any is unconvertible.
    const accFlows: Cashflow[] = [];
    let convertible = true;
    for (const cf of native) {
      const b = tryConvert({ amount: cf.amount, currency: a.currency }, base, fxAt(String(cf.date)));
      if (b === null || !Number.isFinite(b)) {
        convertible = false;
        break;
      }
      accFlows.push({ date: cf.date, amount: b });
    }
    if (!convertible) continue;

    flows.push(...accFlows);
    const termBase = tryConvert({ amount: terminal, currency: a.currency }, base, fxAt(asOf));
    if (termBase !== null && Number.isFinite(termBase)) value += termBase;
    included++;
  }

  return { xirr: flows.length >= 2 ? xirr(flows) : null, value, included };
}
