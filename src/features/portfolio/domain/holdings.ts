// Pure holding analytics: current value, data-quality classification, the
// cashflow vector, and XIRR. All derived from the event log — so adding missing
// events later (a back-dated dividend, an imported CAS) just recomputes; no
// rework. XIRR here is in the holding's native currency; base-currency XIRR
// (per-date FX) is a later enhancement.

import type { Cashflow } from "../../../lib/money/xirr";
import { xirr } from "../../../lib/money/xirr";
import { tryConvert } from "../../../lib/money/currency";
import type { CurrencyCode, FxTable } from "../../../lib/money/currency";
import type { DataQuality, FdTerms, Holding, HoldingEvent } from "../model/types";

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

// --- Fixed-deposit auto-accrual -------------------------------------------
// An FD's value is DETERMINISTIC (principal + rate + compounding + time), so
// instead of manual valuations we compute it. Modelled as a synthetic `valuation`
// event at `asOf` injected via withFdAccrual(), so the whole value/pnl/xirr
// pipeline (which keys off valuation events) works unchanged. A manual valuation
// RE-BASES the accrual (compounding continues from the reconciled amount/date), so
// it naturally overrides the estimate.

const FD_PERIODS: Record<Exclude<FdTerms["compounding"], "simple">, number> = {
  monthly: 12,
  quarterly: 4,
  halfyearly: 2,
  annually: 1,
};

const MS_PER_YEAR = 365 * 86_400_000; // actual/365, matching xirr's day count

/** Accrued value of a fixed deposit: `principal` grown from `startDate` to `asOf`
 *  (capped at `maturityDate`) at annual `ratePct`, with the given compounding.
 *  Never accrues before the start (t ≤ 0 → principal). Both dates are ISO
 *  `YYYY-MM-DD`, parsed as UTC so the day-diff is timezone-independent. */
export function fdValue(principal: number, terms: FdTerms, startDate: string, asOf: string): number {
  const startMs = Date.parse(startDate);
  let endMs = Date.parse(asOf);
  if (terms.maturityDate) {
    const matMs = Date.parse(terms.maturityDate);
    if (Number.isFinite(matMs)) endMs = Math.min(endMs, matMs);
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return principal;
  const years = (endMs - startMs) / MS_PER_YEAR;
  if (years <= 0 || !(terms.ratePct > 0)) return principal;
  const r = terms.ratePct / 100;
  const n = FD_PERIODS[terms.compounding === "simple" ? "annually" : terms.compounding];
  const v = terms.compounding === "simple" ? principal * (1 + r * years) : principal * Math.pow(1 + r / n, n * years);
  // A pathological rate (e.g. a typo of 1e6 %) can overflow to Infinity; never let a
  // non-finite value flow into net worth — fall back to the principal.
  return Number.isFinite(v) ? v : principal;
}

/** For an FD holding, a synthetic `valuation` at `asOf` equal to its accrued value.
 *  Base = the latest MANUAL valuation `{date, amount}` if one exists (so a
 *  reconcile re-bases the accrual), else the opening principal `{date, amount}`.
 *  Null when the holding isn't an FD or has no known principal to accrue from. */
export function fdAccrualValuation(
  holding: Holding,
  events: HoldingEvent[],
  asOf: string,
): HoldingEvent | null {
  if (!holding.fd) return null;
  // Auto-accrual models a CUMULATIVE FD: interest reinvested (compounding), principal
  // untouched. A PAYOUT FD (interest paid out) doesn't compound, and any
  // withdrawal/payout would be double-counted — accrued on the gross principal AND
  // counted as income — overstating value/gain/XIRR. So don't auto-accrue when the
  // holding pays income out, or has any sell/dividend event; the value then falls back
  // to a manual valuation (or "needs valuation"), which is honest rather than silently
  // wrong. (Payout FDs are a deferred feature; a clean cumulative FD has none of these.)
  if (holding.incomeMode !== "accumulating") return null;
  if (events.some((e) => e.type === "sell" || e.type === "dividend")) return null;
  const manual = latestValuation(events);
  let amount: number;
  if (manual && manual.amount !== undefined) {
    // Re-base from the reconciled figure (this is how a manual valuation overrides).
    amount = fdValue(manual.amount, holding.fd, manual.date, asOf);
  } else {
    // Accrue each deposit from ITS OWN date, then sum — correct for a laddered /
    // topped-up FD (a single lump sum is just one term).
    let sum = 0;
    let any = false;
    for (const e of events) {
      if (e.type === "opening" || e.type === "buy") {
        sum += fdValue(grossAmount(e), holding.fd, e.date, asOf);
        any = true;
      }
    }
    if (!any) return null; // no principal to accrue from
    amount = sum;
  }
  if (!Number.isFinite(amount)) return null; // absurd principal(s) summed to Infinity → fall back
  return {
    id: `fd-accrual:${holding.id}`,
    holdingId: holding.id,
    date: asOf,
    type: "valuation",
    amount,
    // Late-in-day createdAt so this (freshest, computed-now) value wins the same-day
    // tiebreak and a same-date deposit doesn't flag it stale — otherwise a
    // just-created FD (deposit dated today) would read as "—" until the next day.
    createdAt: `${asOf}T23:59:59.999Z`,
  };
}

/** Events augmented with the FD's accrued valuation at `asOf` (a no-op for a
 *  non-FD holding). Pass the result to currentHoldingValue / holdingPnl /
 *  holdingXirr so an FD auto-accrues at read time. */
export function withFdAccrual(holding: Holding, events: HoldingEvent[], asOf: string): HoldingEvent[] {
  const synth = fdAccrualValuation(holding, events, asOf);
  return synth ? [...events, synth] : events;
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

export interface PortfolioReturn {
  /** Money-weighted (XIRR) annualized return across ALL holdings combined, in the
   *  base currency; null when it can't be computed honestly. Includes dividends and
   *  FX moves; EXCLUDES cash/salary (only holdings contribute). */
  xirr: number | null;
  invested: number; // base
  value: number; // base — current market value of open positions
  absoluteGain: number | null; // base — incl. dividends + realized
  included: number; // holdings that contributed to the return
  total: number; // holdings with any events
}

/**
 * Portfolio-level money-weighted return: concatenate every eligible holding's
 * dated cashflows (opening/buy = outflow, sell/dividend = inflow, current value a
 * final inflow at `asOf`), each converted to `base` at ITS date's FX, then run one
 * XIRR. Only holdings with a computable per-holding return (real cost basis + a
 * fresh value or fully closed) contribute — a value-only / stale holding has no
 * honest return and is excluded (reported via `included`/`total`). A holding whose
 * currency lacks a rate at some cashflow date is skipped rather than folded in with
 * dropped flows (which would corrupt its contribution).
 */
export function portfolioReturn(
  holdings: Holding[],
  eventsByHolding: Map<string, HoldingEvent[]>,
  base: CurrencyCode,
  fxAt: (date: string) => FxTable,
  asOf: string,
): PortfolioReturn {
  const flows: Cashflow[] = [];
  const nowFx = fxAt(asOf);
  let invested = 0;
  let value = 0;
  let gain = 0;
  let gainKnown = false;
  let included = 0;
  let total = 0;

  for (const h of holdings) {
    const raw = eventsByHolding.get(h.id) ?? [];
    if (raw.length === 0) continue;
    // Accrue an FD to `asOf` so it contributes its computed value + return.
    const events = withFdAccrual(h, raw, asOf);
    total++;

    // Include a holding with a real cost basis AND a known end state (a fresh current
    // value, or fully closed). We deliberately DON'T gate on the standalone
    // per-holding XIRR being solvable: a holding bought today at today's price has a
    // 0-day span (its own IRR is null), yet it's valid and its money + flows belong
    // in the portfolio — the single xirr() below solves once ANY flow in the combined
    // series has a nonzero span. `invested > 0` excludes value-only holdings; the
    // value-or-closed check excludes stale open positions.
    const pnl = holdingPnl(events);
    if (!(pnl.invested > 0 && (currentHoldingValue(events) !== null || isClosed(events)))) continue;

    // Convert every flow at its own date; skip the WHOLE holding if any date lacks a
    // rate (partial flows would corrupt the IRR).
    const holdingFlows: Cashflow[] = [];
    let convertible = true;
    for (const cf of holdingCashflows(events, { asOf })) {
      const b = tryConvert({ amount: cf.amount, currency: h.currency }, base, fxAt(String(cf.date)));
      if (b === null || !Number.isFinite(b)) {
        convertible = false;
        break;
      }
      holdingFlows.push({ date: cf.date, amount: b });
    }
    if (!convertible) continue;

    included++;
    flows.push(...holdingFlows);
    // Display aggregates cover the SAME set (in base, current rate), so
    // "invested / value / gain" stays coherent.
    const toBaseNow = (amt: number): number =>
      tryConvert({ amount: amt, currency: h.currency }, base, nowFx) ?? 0;
    invested += toBaseNow(pnl.invested);
    if (pnl.value !== null) value += toBaseNow(pnl.value);
    if (pnl.absoluteGain !== null) {
      gain += toBaseNow(pnl.absoluteGain);
      gainKnown = true;
    }
  }

  return {
    xirr: flows.length >= 2 ? xirr(flows) : null,
    invested,
    value,
    absoluteGain: gainKnown ? gain : null,
    included,
    total,
  };
}
