// Multi-currency conversion. Pure and dependency-free.
//
// An FxTable expresses rates as "units of CCY per 1 unit of base" (so
// base→CCY is multiplication). The base itself has an implicit rate of 1.

export type CurrencyCode = string; // ISO-4217-ish: "USD", "INR", "CLP", …

export interface Money {
  amount: number;
  currency: CurrencyCode;
}

export interface FxTable {
  base: CurrencyCode;
  /** units of <code> per 1 <base>. The base may be omitted (implicitly 1). */
  rates: Record<CurrencyCode, number>;
}

function rateOf(code: CurrencyCode, fx: FxTable): number | undefined {
  if (code === fx.base) return 1;
  const r = fx.rates[code];
  return r && Number.isFinite(r) && r > 0 ? r : undefined;
}

/** Convert `m` into `to`. Throws if either currency is missing from the table. */
export function convert(m: Money, to: CurrencyCode, fx: FxTable): number {
  if (m.currency === to) return m.amount;
  const from = rateOf(m.currency, fx);
  const target = rateOf(to, fx);
  if (from === undefined) throw new Error(`no FX rate for ${m.currency}`);
  if (target === undefined) throw new Error(`no FX rate for ${to}`);
  const inBase = m.amount / from;
  return inBase * target;
}

/** Like convert, but returns null instead of throwing when a rate is missing —
 *  so one unknown currency can't blow up a whole aggregation. */
export function tryConvert(m: Money, to: CurrencyCode, fx: FxTable): number | null {
  try {
    return convert(m, to, fx);
  } catch {
    return null;
  }
}

/** Convenience: convert into the table's base currency. */
export function toBase(m: Money, fx: FxTable): number {
  return convert(m, fx.base, fx);
}

/** Sum mixed-currency amounts into a single base-currency total. */
export function sumInBase(items: Money[], fx: FxTable): number {
  let total = 0;
  for (const m of items) total += toBase(m, fx);
  return total;
}

/** Re-express a table in a different base currency (rates scaled accordingly).
 *  Lets us keep one canonical USD-anchored table but present in any currency. */
export function rebase(fx: FxTable, newBase: CurrencyCode): FxTable {
  if (newBase === fx.base) return fx;
  const anchor = rateOf(newBase, fx);
  if (anchor === undefined) throw new Error(`no FX rate for ${newBase}`);
  const rates: Record<CurrencyCode, number> = {};
  // Every currency known in the old table, re-expressed per 1 newBase.
  rates[fx.base] = 1 / anchor;
  for (const [code, r] of Object.entries(fx.rates)) {
    if (code === newBase) continue;
    rates[code] = r / anchor;
  }
  return { base: newBase, rates };
}
