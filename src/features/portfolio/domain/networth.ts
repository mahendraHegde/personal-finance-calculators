// Pure net-worth & rollup compute. Converts every native-currency balance and
// holding value into the base currency, then aggregates: total, assets vs
// liabilities, per-person, and asset-class allocation. Anything contributing a
// negative base value counts as a liability — so the liability sign convention
// doesn't matter.

import type { CurrencyCode, FxTable } from "../../../lib/money/currency";
import { tryConvert } from "../../../lib/money/currency";
import type { Account, AssetClass, Holding, ID, Owner, Transaction } from "../model/types";

/** Running balance per account, in that account's own currency. When an `fx`
 *  table is supplied, a transfer whose destination account uses a different
 *  currency is converted for the destination leg — so a cross-currency transfer
 *  (e.g. from an import or another device) doesn't corrupt balances/net worth.
 *  The form already restricts manual transfers to same-currency; this hardens
 *  the calc layer against data that didn't go through it. */
export function accountBalances(
  accounts: Account[],
  transactions: Transaction[],
  fx?: FxTable,
): Map<ID, number> {
  // Derive the per-account total by summing the per-person breakdown, so the two
  // can never diverge (the per-person rollup must add up to the account total).
  const byPerson = accountBalancesByPerson(accounts, transactions, fx);
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
 */
export function accountBalancesByPerson(
  accounts: Account[],
  transactions: Transaction[],
  fx?: FxTable,
): Map<ID, Map<Owner, number>> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<ID, Map<Owner, number>>();
  for (const a of accounts) out.set(a.id, new Map());
  const bump = (accId: ID, who: Owner, delta: number): void => {
    const m = out.get(accId);
    if (m) m.set(who, (m.get(who) ?? 0) + delta);
  };
  for (const t of transactions) {
    if (t.excludeFromBalance) continue; // historical / reporting-only → not in balances
    switch (t.type) {
      case "income":
        bump(t.accountId, t.personId, t.amount);
        break;
      case "expense":
        bump(t.accountId, t.personId, -t.amount);
        break;
      case "transfer": {
        // All-or-nothing on endpoint presence: a transfer nets to zero, so if
        // EITHER account is missing (an incomplete import / cross-device snapshot
        // whose Account rows didn't all land) skip the WHOLE transfer rather than
        // applying one leg — half-applying silently loses money from net worth
        // (missing dest) or fabricates it (missing source). Mirrors the
        // unconvertible-cross-currency skip just below.
        const toId = t.transferToAccountId;
        if (!toId || !byId.has(t.accountId)) break;
        const dest = byId.get(toId);
        if (!dest) break;
        let credit = t.amount;
        if (fx && dest.currency !== t.currency) {
          const converted = tryConvert({ amount: t.amount, currency: t.currency }, dest.currency, fx);
          // Unconvertible cross-currency transfer (no FX rate): skip the WHOLE
          // transfer rather than crediting a mis-scaled raw amount — that would
          // silently corrupt the balance. A transfer nets to zero anyway.
          if (converted === null) break;
          credit = converted;
        }
        // Both legs carry the transaction's personId (SHARED for transfers), so a
        // transfer nets out within that person and doesn't shift attribution.
        bump(t.accountId, t.personId, -t.amount); // source leg, in t.currency
        bump(toId, t.personId, credit); // dest leg (both endpoints confirmed present)
        break;
      }
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
