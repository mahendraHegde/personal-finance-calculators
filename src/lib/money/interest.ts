// Shared interest math for the money layer. Two shapes, both computed READ-TIME
// (never persisted as interest transactions), so adding activity later just
// recomputes:
//   - compoundValue():  a FIXED principal grown to a date — a fixed deposit.
//     Closed-form, capped at maturity.
//   - accruedInterest(): interest on a FLUCTUATING balance — a savings account you
//     spend from — via the daily-balance method, compounded at a crediting
//     frequency.
// Both are ESTIMATES (banks round, use exact day-counts, deduct TDS); a manual
// figure (an FD `valuation`, or a recorded interest-income transaction) always
// wins. Pure; dates are ISO YYYY-MM-DD parsed as UTC so day-diffs are
// timezone-independent. Types are local (structural) so this stays a leaf of the
// money layer — it imports nothing from features.

import { addMonthsIso } from "../util/date";

/** Fixed-deposit compounding. `simple` = no compounding; the rest compound
 *  n×/yr (12/4/2/1). Structurally identical to the portfolio model's FdTerms. */
export type Compounding = "simple" | "monthly" | "quarterly" | "halfyearly" | "annually";
/** Savings crediting frequency (interest compounds when it's credited). */
export type CreditFrequency = "monthly" | "quarterly" | "halfyearly" | "annually";

const PERIODS_PER_YEAR: Record<Exclude<Compounding, "simple">, number> = {
  monthly: 12,
  quarterly: 4,
  halfyearly: 2,
  annually: 1,
};

const MONTHS_PER_PERIOD: Record<CreditFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  halfyearly: 6,
  annually: 12,
};

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365; // actual/365, matching xirr's day count

/**
 * Value of a fixed `principal` grown from `startDate` to `asOf` (capped at
 * `maturityDate` when given) at annual `ratePct` with the given compounding.
 * Never accrues before the start (t ≤ 0 → principal). A pathological rate can
 * overflow to Infinity; a non-finite result falls back to `principal` so it can't
 * poison a net-worth total.
 */
export function compoundValue(
  principal: number,
  ratePct: number,
  compounding: Compounding,
  startDate: string,
  asOf: string,
  maturityDate?: string,
): number {
  const startMs = Date.parse(startDate);
  let endMs = Date.parse(asOf);
  if (maturityDate) {
    const matMs = Date.parse(maturityDate);
    if (Number.isFinite(matMs)) endMs = Math.min(endMs, matMs);
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return principal;
  const years = (endMs - startMs) / (MS_PER_DAY * DAYS_PER_YEAR);
  if (years <= 0 || !(ratePct > 0)) return principal;
  const r = ratePct / 100;
  const n = PERIODS_PER_YEAR[compounding === "simple" ? "annually" : compounding];
  const v =
    compounding === "simple"
      ? principal * (1 + r * years)
      : principal * Math.pow(1 + r / n, n * years);
  return Number.isFinite(v) ? v : principal;
}

/** A dated, signed change to an account's balance (deposit +, withdrawal −), in
 *  the account's own currency. */
export interface BalanceDelta {
  date: string;
  amount: number;
}

/**
 * Interest earned up to `asOf` on a FLUCTUATING balance, by the daily-balance
 * method compounded at `frequency`. `openingBalance` is the balance at
 * `openingDate`; `deltas` are later signed changes (each ISO date + amount in the
 * account's own currency). Returns ONLY the accrued interest — add it to the plain
 * balance for the total. Interest-on-interest accrues at each crediting boundary
 * (openingDate + k periods); between boundaries the balance is constant so each
 * segment earns balance·rate·days/365.
 *
 * Returns 0 when the rate is non-positive, dates are unusable, or no time has
 * elapsed. An ESTIMATE — for exact figures leave interest off and record interest
 * credits as income instead.
 */
export function accruedInterest(
  openingBalance: number,
  openingDate: string | undefined,
  deltas: BalanceDelta[],
  ratePct: number,
  frequency: CreditFrequency,
  asOf: string,
): number {
  if (!(ratePct > 0)) return 0;
  const endMs = Date.parse(asOf);
  if (!Number.isFinite(endMs)) return 0;

  // Accrual starts at the opening date; failing that, the earliest activity; and
  // with neither, there's nothing to accrue on.
  let start = openingDate;
  if (!start || !Number.isFinite(Date.parse(start))) {
    start = undefined;
    for (const x of deltas) {
      if (!Number.isFinite(Date.parse(x.date))) continue;
      if (start === undefined || x.date < start) start = x.date;
    }
  }
  if (start === undefined) return 0;
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs) || startMs >= endMs) return 0;

  // Starting balance folds in everything already applied on/before the start;
  // deltas after `asOf` haven't happened yet for accrual. `future` holds the
  // dated changes that land within (start, asOf].
  let balance = openingBalance;
  const future: { ms: number; amount: number }[] = [];
  for (const x of deltas) {
    const ms = Date.parse(x.date);
    if (!Number.isFinite(ms)) continue;
    if (ms <= startMs) balance += x.amount;
    else if (ms <= endMs) future.push({ ms, amount: x.amount });
  }

  // Boundary timeline: every crediting date and every delta date inside
  // (start, asOf], ending at asOf. The balance is constant between boundaries.
  const rate = ratePct / 100;
  const periodMonths = MONTHS_PER_PERIOD[frequency];
  const credits: number[] = [];
  for (let k = 1; ; k++) {
    const b = Date.parse(addMonthsIso(start, periodMonths * k));
    if (!Number.isFinite(b) || b >= endMs) break;
    credits.push(b);
  }
  const creditSet = new Set(credits);
  const points = [...new Set([...future.map((f) => f.ms), ...credits, endMs])].sort((a, b) => a - b);
  // Sum the dated changes by timestamp once, so applying them per point is O(1)
  // instead of scanning `future` at every point (O(points × deltas)).
  const futureByMs = new Map<number, number>();
  for (const f of future) futureByMs.set(f.ms, (futureByMs.get(f.ms) ?? 0) + f.amount);

  let total = 0;
  let periodAccrued = 0;
  let prev = startMs;
  for (const p of points) {
    const days = (p - prev) / MS_PER_DAY;
    // No interest is earned while the account is over-drawn — a savings account
    // pays on a positive balance, it doesn't charge negative interest on a debit
    // (an overdraft is a separate, differently-priced product). Accrual resumes
    // once deposits bring the balance back positive.
    const earning = balance > 0 ? balance : 0;
    const seg = earning * rate * (days / DAYS_PER_YEAR);
    total += seg;
    periodAccrued += seg;
    // At a crediting boundary the period's interest joins the balance (compounds).
    if (creditSet.has(p)) {
      balance += periodAccrued;
      periodAccrued = 0;
    }
    // Apply balance changes dated exactly here, AFTER crediting the closing period.
    balance += futureByMs.get(p) ?? 0;
    prev = p;
  }
  return Number.isFinite(total) ? total : 0;
}
