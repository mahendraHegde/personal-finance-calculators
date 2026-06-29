// Pure transaction queries & rollups for the ledger and dashboard. Filtering is
// in-memory (the store keeps the working set loaded); the repo's cursor
// pagination remains available for very large sets.

import type { CurrencyCode, FxTable } from "../../../lib/money/currency";
import { tryConvert } from "../../../lib/money/currency";
import { monthKey } from "../../../lib/util/format";
import type { Category, Owner, Transaction, TxnType } from "../model/types";

export interface TxnFilter {
  personId?: Owner;
  accountId?: string;
  categoryId?: string;
  type?: TxnType;
  currency?: CurrencyCode;
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
  /** Case-insensitive substring match on the note. */
  text?: string;
}

export function filterTransactions(txns: Transaction[], f: TxnFilter): Transaction[] {
  const text = f.text?.trim().toLowerCase();
  return txns.filter((t) => {
    if (f.personId && t.personId !== f.personId) return false;
    if (f.accountId && t.accountId !== f.accountId) return false;
    if (f.categoryId && t.categoryId !== f.categoryId) return false;
    if (f.type && t.type !== f.type) return false;
    if (f.currency && t.currency !== f.currency) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (text && !(t.note ?? "").toLowerCase().includes(text)) return false;
    return true;
  });
}

/** Newest-first by date, stable on id. */
export function sortByDateDesc(txns: Transaction[]): Transaction[] {
  return [...txns].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
}

function inBase(t: Transaction, base: CurrencyCode, fx: FxTable): number {
  // Unknown currency → 0 rather than throwing mid-aggregation.
  return tryConvert({ amount: t.amount, currency: t.currency }, base, fx) ?? 0;
}

export interface MonthlyPoint {
  month: string; // YYYY-MM
  income: number;
  expense: number;
}

/** Income & expense totals per month, in `base`, ascending by month. Takes a
 *  per-DATE FX resolver (`fxAt`) so each transaction is converted with the rate
 *  for its own date — refreshing rates today must not retroactively re-price
 *  last January's bar. */
export function monthlyTotals(
  txns: Transaction[],
  base: CurrencyCode,
  fxAt: (date: string) => FxTable,
): MonthlyPoint[] {
  const map = new Map<string, MonthlyPoint>();
  for (const t of txns) {
    if (t.type === "transfer") continue;
    const fx = fxAt(t.date);
    const m = monthKey(t.date);
    const point = map.get(m) ?? { month: m, income: 0, expense: 0 };
    if (t.type === "income") point.income += inBase(t, base, fx);
    else point.expense += inBase(t, base, fx);
    map.set(m, point);
  }
  return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

export interface CategoryTotal {
  categoryId: string;
  name: string;
  total: number;
}

/** Spend (or income) grouped by category, in `base`, largest first. */
export function categoryTotals(
  txns: Transaction[],
  categories: Category[],
  type: "expense" | "income",
  base: CurrencyCode,
  fx: FxTable,
): CategoryTotal[] {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const map = new Map<string, number>();
  for (const t of txns) {
    if (t.type !== type) continue;
    const key = t.categoryId ?? "uncategorized";
    map.set(key, (map.get(key) ?? 0) + inBase(t, base, fx));
  }
  return [...map.entries()]
    .map(([categoryId, total]) => ({
      categoryId,
      name: categoryId === "uncategorized" ? "Uncategorized" : (names.get(categoryId) ?? "Unknown"),
      total,
    }))
    .sort((a, b) => b.total - a.total);
}

export interface FlowSummary {
  income: number;
  expense: number;
  net: number;
}

export function flowSummary(txns: Transaction[], base: CurrencyCode, fx: FxTable): FlowSummary {
  let income = 0;
  let expense = 0;
  for (const t of txns) {
    if (t.type === "income") income += inBase(t, base, fx);
    else if (t.type === "expense") expense += inBase(t, base, fx);
  }
  return { income, expense, net: income - expense };
}
