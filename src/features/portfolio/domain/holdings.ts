// Pure holding analytics: current value, data-quality classification, the
// cashflow vector, and XIRR. All derived from the event log — so adding missing
// events later (a back-dated dividend, an imported CAS) just recomputes; no
// rework. XIRR here is in the holding's native currency; base-currency XIRR
// (per-date FX) is a later enhancement.

import type { Cashflow } from "../../../lib/money/xirr";
import { xirr } from "../../../lib/money/xirr";
import type { DataQuality, HoldingEvent } from "../model/types";

function byDate(a: HoldingEvent, b: HoldingEvent): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/** Money amount for a buy/sell/opening event (units×price preferred). */
function grossAmount(e: HoldingEvent): number {
  if (e.units !== undefined && e.price !== undefined) return e.units * e.price;
  return e.amount ?? 0;
}

/** Pick the governing valuation: latest by `date`, and for the same date the
 *  most-recently-recorded one (by `createdAt`, then `id`) — so re-entering
 *  today's value corrects it instead of the first entry sticking forever. */
/** True if event `a` was recorded AFTER `b`: later `date`, then (same date)
 *  later `createdAt`, then higher `id`. The createdAt tiebreak is what makes
 *  SAME-DAY ordering correct — e.g. a sell entered at 11:00 is "after" a
 *  valuation entered at 10:00 on the same calendar date. */
function isAfter(a: HoldingEvent, b: HoldingEvent): boolean {
  if (a.date !== b.date) return a.date > b.date;
  const ac = a.createdAt ?? "";
  const bc = b.createdAt ?? "";
  if (ac !== bc) return ac > bc;
  return a.id > b.id;
}

function latestValuation(events: HoldingEvent[]): HoldingEvent | undefined {
  let latest: HoldingEvent | undefined;
  for (const e of events) {
    if (e.type !== "valuation") continue;
    if (!latest || isAfter(e, latest)) latest = e;
  }
  return latest;
}

/**
 * Current market value = the latest `valuation` amount — but only if it isn't
 * stale. If any buy/sell/dividend/adjustment was recorded AFTER the latest
 * valuation (including LATER THE SAME DAY, via createdAt), that valuation no
 * longer reflects the position (you sold out, or a payout dropped the value),
 * so we return null rather than a misleading figure.
 */
export function currentHoldingValue(events: HoldingEvent[]): number | null {
  // A fully-closed position (units netted to 0 after a sell) holds NOTHING, so its
  // current value is null regardless of any stray valuation dated after the
  // sell-out — otherwise that figure would double-count (a phantom liquidation on
  // top of the realized sale) and inflate net worth. The realized return still
  // comes from holdingPnl's closed branch.
  if (isClosed(events)) return null;
  const v = latestValuation(events);
  if (!v || v.amount === undefined) return null;
  if (events.some((e) => e.type !== "valuation" && invalidatesValuation(e, v))) return null;
  return v.amount;
}

/**
 * Does activity event `a` make valuation `v` stale? Later `date`, or same date
 * with a later `createdAt`. On a same-date tie where we CAN'T establish order
 * (either side missing `createdAt`, e.g. legacy/imported data), we bias toward
 * stale — failing to an honest "—" rather than coin-flipping on random UUIDs
 * and possibly showing a fresh value for an already-sold position. (We don't use
 * `isAfter` here because its UUID tiebreak is fine for picking a winning
 * valuation but wrong for this safety decision.)
 */
function invalidatesValuation(a: HoldingEvent, v: HoldingEvent): boolean {
  if (a.date !== v.date) return a.date > v.date;
  if (a.createdAt !== undefined && v.createdAt !== undefined) return a.createdAt > v.createdAt;
  return true; // same date, can't order → conservatively stale
}

/** Net units held; null when units aren't tracked (amount-only events). An
 *  `opening` with units counts as an initial position (so onboarding a holding
 *  by quantity, or the "set quantity" reconciliation, makes it live-priceable);
 *  amount-only openings carry no units and stay untracked. */
export function netUnits(events: HoldingEvent[]): number | null {
  let units = 0;
  let tracked = false;
  for (const e of events) {
    if (e.units === undefined) continue;
    if (e.type === "buy" || e.type === "opening") {
      units += e.units;
      tracked = true;
    } else if (e.type === "sell") {
      units -= e.units;
      tracked = true;
    }
  }
  if (!tracked) return null;
  // Snap float residue (e.g. 0.1 + 0.2 − 0.3 = 5.5e-17) to 0 so a fully-sold
  // FRACTIONAL position reads as closed — not a phantom dust holding that breaks
  // isClosed/XIRR and emits a near-zero auto-valuation. 1e-9 is far below any real
  // unit count (a BTC satoshi is 1e-8), so genuine tiny holdings are unaffected.
  return Math.abs(units) < 1e-9 ? 0 : units;
}

/** A position is "closed" (fully realized) when units net to zero after a sell —
 *  its return is knowable from realized cashflows without a current value. */
function isClosed(events: HoldingEvent[]): boolean {
  return netUnits(events) === 0 && events.some((e) => e.type === "sell");
}

export function dataQuality(events: HoldingEvent[]): DataQuality {
  if (events.length === 0) return "value-only";
  // Open position with no current/fresh value → can't show value or return.
  if (currentHoldingValue(events) === null && !isClosed(events)) return "needs-valuation";
  // Real buy history dominates a legacy opening estimate.
  if (events.some((e) => e.type === "buy")) return "complete";
  if (events.some((e) => e.type === "opening")) return "cost-estimate";
  return "value-only";
}

/**
 * Build the dated cashflow vector for a holding.
 *   opening/buy  → outflow (negative)
 *   sell/dividend→ inflow  (positive)
 *   adjustment   → signed inflow (its amount sign)
 *   valuation    → not a flow; the latest one seeds the closing value
 * A final inflow equal to current value is appended at `asOf` (defaults to the
 * latest valuation date) to represent liquidation — that's what makes XIRR a
 * since-inception return.
 */
export function holdingCashflows(
  events: HoldingEvent[],
  opts: { asOf?: string | number | Date } = {},
): Cashflow[] {
  const sorted = [...events].sort(byDate);
  const flows: Cashflow[] = [];

  for (const e of sorted) {
    switch (e.type) {
      case "opening":
        flows.push({ date: e.date, amount: -(grossAmount(e) + (e.fee ?? 0)) });
        break;
      case "buy":
        flows.push({ date: e.date, amount: -(grossAmount(e) + (e.fee ?? 0)) });
        break;
      case "sell":
        flows.push({ date: e.date, amount: grossAmount(e) - (e.fee ?? 0) });
        break;
      case "dividend":
        flows.push({ date: e.date, amount: e.amount ?? 0 });
        break;
      case "adjustment":
        flows.push({ date: e.date, amount: e.amount ?? 0 });
        break;
      case "valuation":
        break; // closing value handled below
    }
  }

  const value = currentHoldingValue(sorted);
  if (value !== null) {
    let asOf = opts.asOf;
    if (asOf === undefined) {
      const lastVal = [...sorted].reverse().find((e) => e.type === "valuation");
      asOf = lastVal?.date ?? sorted[sorted.length - 1]?.date;
    }
    if (asOf !== undefined) flows.push({ date: asOf, amount: value });
  }
  return flows;
}

/**
 * Since-inception XIRR (native currency), or null when it can't be computed
 * HONESTLY. We only return a number when there's a real basis for one:
 *   - a current/fresh valuation exists (it becomes the closing inflow), OR
 *   - the position is fully closed (realized return from buy/sell cashflows).
 * For an open position with a STALE/missing valuation, or just an
 * opening+adjustment with no value, we return null instead of a confident wrong
 * number — matching how currentHoldingValue / holdingPnl already show "—".
 */
export function holdingXirr(
  events: HoldingEvent[],
  opts: { asOf?: string | number | Date } = {},
): number | null {
  if (currentHoldingValue(events) === null && !isClosed(events)) return null;
  return xirr(holdingCashflows(events, opts));
}

/** Total invested (sum of outflows) and absolute gain vs current value. */
export function holdingPnl(events: HoldingEvent[]): {
  invested: number;
  value: number | null;
  income: number;
  absoluteGain: number | null;
} {
  let invested = 0;
  let income = 0;
  for (const e of events) {
    if (e.type === "opening" || e.type === "buy") invested += grossAmount(e) + (e.fee ?? 0);
    else if (e.type === "sell") income += grossAmount(e) - (e.fee ?? 0);
    else if (e.type === "dividend") income += e.amount ?? 0;
    else if (e.type === "adjustment") income += e.amount ?? 0;
  }
  const value = currentHoldingValue(events);
  const closed = netUnits(events) === 0 && events.some((e) => e.type === "sell");
  // `invested === 0` means NO cost basis was recorded (e.g. a quantity set without
  // a cost) — the basis is UNKNOWN, not zero/free. Gain is then unknowable, so
  // report null rather than crediting the whole value/proceeds as "gain" — for an
  // OPEN position AND for a closed one (a sale of an unknown-basis lot can't have
  // a meaningful realized gain).
  const costKnown = invested > 0;
  let absoluteGain: number | null;
  if (value !== null) absoluteGain = costKnown ? value + income - invested : null;
  else if (closed) absoluteGain = costKnown ? income - invested : null;
  else absoluteGain = null;
  return { invested, value, income, absoluteGain };
}
