// Pure transaction queries & rollups for the ledger and dashboard. Filtering is
// in-memory (the store keeps the working set loaded); the repo's cursor
// pagination remains available for very large sets.

import type { CurrencyCode, FxTable } from "../../../lib/money/currency";
import { tryConvert } from "../../../lib/money/currency";
import { monthKey } from "../../../lib/util/format";
import type { Account, Category, Owner, Transaction, TxnType } from "../model/types";
import { SHARED } from "../model/types";

export interface TxnFilter {
  /** Whose transaction it is (the transaction's own `personId`). */
  personId?: Owner;
  /** Whose NAME the account is in (`Account.personId`), which can differ from the
   *  transaction's owner. A transfer matches if EITHER of its accounts is held by them,
   *  since the money moved through that person's account. Needs `accounts`. */
  accountHolderId?: Owner;
  accountId?: string;
  categoryId?: string;
  /** Match any of these category ids — used by the ledger's category filter, where
   *  selecting a PARENT category matches the parent AND its subcategories. */
  categoryIds?: string[];
  type?: TxnType;
  currency?: CurrencyCode;
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
  /** Month-of-year "01".."12" — keeps only txns in that calendar month. Composes with
   *  from/to (e.g. year bounds + month = that month of that year; no bounds + month =
   *  that month across all years). */
  month?: string;
  /** Case-insensitive substring match on the note. */
  text?: string;
}

export function filterTransactions(
  txns: Transaction[],
  f: TxnFilter,
  accounts: readonly Pick<Account, "id" | "personId">[] = [],
): Transaction[] {
  const text = f.text?.trim().toLowerCase();
  const holderOf = f.accountHolderId ? new Map(accounts.map((a) => [a.id, a.personId])) : null;
  return txns.filter((t) => {
    if (f.personId && t.personId !== f.personId) return false;
    if (holderOf) {
      const held = (id: string | undefined): boolean => id !== undefined && holderOf.get(id) === f.accountHolderId;
      if (!held(t.accountId) && !(t.type === "transfer" && held(t.transferToAccountId))) return false;
    }
    if (f.accountId && t.accountId !== f.accountId) return false;
    if (f.categoryId && t.categoryId !== f.categoryId) return false;
    if (f.categoryIds && (t.categoryId === undefined || !f.categoryIds.includes(t.categoryId))) return false;
    if (f.type && t.type !== f.type) return false;
    if (f.currency && t.currency !== f.currency) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.month && t.date.slice(5, 7) !== f.month) return false;
    if (text && !(t.note ?? "").toLowerCase().includes(text)) return false;
    return true;
  });
}

/** Year-select value in the ledger toolbar meaning "custom From/To range" (never a real year). */
export const LEDGER_CUSTOM = "custom";

/** What the ledger toolbar has selected, before it is checked against the current data. */
export interface LedgerSelection {
  /** Type, text, owner, account holder and currency as picked. */
  filter: TxnFilter;
  /** "" = all years, "YYYY", or LEDGER_CUSTOM. */
  year: string;
  /** "01".."12" or "". Ignored for a custom range. */
  month: string;
  /** Inclusive ISO bounds for a custom range; "" = open on that side. */
  rangeFrom: string;
  rangeTo: string;
  /** Category and subcategory picks, already checked to exist ("" = none). */
  categoryId: string;
  subcategoryId: string;
}

/** The data a selection is checked against. */
export interface LedgerContext {
  /** Currencies present in the ledger; the currency select hides when there is only one. */
  currencies: readonly string[];
  people: readonly { id: string }[];
  categories: readonly Pick<Category, "id" | "parentId">[];
  /** The account-holder select only exists when there are accounts. */
  hasAccounts: boolean;
}

/** The filter the ledger actually applies, rows AND totals alike.
 *
 *  Drops any pick that no longer resolves or whose control is hidden, so the list and the
 *  Income/Expense/Net figures can never stay SILENTLY scoped to something the toolbar no longer
 *  shows: a currency once only one remains, a hard-deleted person (an ARCHIVED one still
 *  resolves and stays selectable), an account holder when there are no accounts. A category
 *  becomes its id set: a subcategory alone, or a parent plus all its subcategories. The period
 *  becomes inclusive bounds; a custom range ignores the month. */
export function ledgerFilter(sel: LedgerSelection, ctx: LedgerContext): TxnFilter {
  const resolves = (id: string | undefined): boolean =>
    id === SHARED || ctx.people.some((p) => p.id === id);
  let f: TxnFilter = { ...sel.filter, categoryIds: undefined, from: undefined, to: undefined, month: undefined };
  if (f.currency && (ctx.currencies.length < 2 || !ctx.currencies.includes(f.currency))) f = { ...f, currency: undefined };
  if (f.personId && !resolves(f.personId)) f = { ...f, personId: undefined };
  if (f.accountHolderId && (!ctx.hasAccounts || !resolves(f.accountHolderId))) f = { ...f, accountHolderId: undefined };
  if (sel.subcategoryId) f = { ...f, categoryIds: [sel.subcategoryId] };
  else if (sel.categoryId) {
    const kids = ctx.categories.filter((c) => c.parentId === sel.categoryId).map((c) => c.id);
    f = { ...f, categoryIds: [sel.categoryId, ...kids] };
  }
  if (sel.year === LEDGER_CUSTOM) return { ...f, from: sel.rangeFrom || undefined, to: sel.rangeTo || undefined };
  if (sel.year) f = { ...f, from: `${sel.year}-01-01`, to: `${sel.year}-12-31` };
  return sel.month ? { ...f, month: sel.month } : f;
}

/** How many of the ledger's SECONDARY filters (the ones behind its Filters button) a filter from
 *  `ledgerFilter` applies. Counted from the effective filter, so a dropped pick can't leave a
 *  phantom count with nothing visible to clear. */
export function secondaryFilterCount(f: TxnFilter): number {
  return [f.categoryIds, f.personId, f.accountHolderId, f.currency].filter((v) => v !== undefined).length;
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
    if (t.excludeFromReports) continue; // internal asset move (e.g. FD settlement) — not earnings/spend
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
    if (t.excludeFromReports) continue; // internal asset move (e.g. FD settlement) — not earnings/spend
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
    if (t.excludeFromReports) continue; // internal asset move (e.g. FD settlement) — not earnings/spend
    if (t.type === "income") income += inBase(t, base, fx);
    else if (t.type === "expense") expense += inBase(t, base, fx);
  }
  return { income, expense, net: income - expense };
}
