// XIRR — internal rate of return for irregularly-dated cash flows.
// Pure, dependency-free. Returns the annualised rate as a decimal (0.12 = 12%),
// or null when it isn't computable (fewer than 2 flows, or no sign change —
// e.g. a holding with no cost basis).

export interface Cashflow {
  /** ISO date string, epoch ms, or Date. */
  date: string | number | Date;
  /** Negative = money out (investment), positive = money in (proceeds/value). */
  amount: number;
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function toMs(d: string | number | Date): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === "number") return d;
  return new Date(d).getTime();
}

interface Normalised {
  years: number; // years from the earliest flow
  amount: number;
}

function npv(flows: Normalised[], rate: number): number {
  let sum = 0;
  for (const f of flows) sum += f.amount / Math.pow(1 + rate, f.years);
  return sum;
}

function dNpv(flows: Normalised[], rate: number): number {
  let sum = 0;
  for (const f of flows) {
    if (f.years === 0) continue;
    sum += (-f.years * f.amount) / Math.pow(1 + rate, f.years + 1);
  }
  return sum;
}

export function xirr(cashflows: Cashflow[], guess = 0.1): number | null {
  const valid = cashflows.filter((c) => Number.isFinite(c.amount) && c.amount !== 0);
  if (valid.length < 2) return null;

  const hasPos = valid.some((c) => c.amount > 0);
  const hasNeg = valid.some((c) => c.amount < 0);
  if (!hasPos || !hasNeg) return null; // no sign change → no IRR

  // Fail CLOSED on bad dates: an invalid/empty date → NaN times → NaN NPV, which
  // would otherwise slip past the bisection bracket check and return an absurd
  // rate. Reject instead of inventing a number.
  const times = valid.map((c) => toMs(c.date));
  if (times.some((t) => !Number.isFinite(t))) return null;

  const t0 = Math.min(...times);
  // Zero-day span (every flow on ONE date): there's no elapsed time to annualize
  // over, so an IRR is undefined regardless of the net. Reject explicitly — a
  // break-even 0-span series makes NPV a constant zero, which would otherwise let
  // Newton's first step return the initial guess as a bogus "solved" rate.
  if (t0 === Math.max(...times)) return null;
  // Collapse flows that share a date by summing their amounts: they have the same
  // `years`, so NPV is IDENTICAL, but the solved vector shrinks from one-per-leg to
  // one-per-distinct-date. This keeps npv/bisection fast when a caller passes a flow
  // per transaction over a long ledger (e.g. the blended totalReturn).
  const byYears = new Map<number, number>();
  for (let i = 0; i < valid.length; i++) {
    const years = (times[i] - t0) / MS_PER_YEAR;
    byYears.set(years, (byYears.get(years) ?? 0) + valid[i].amount);
  }
  const flows: Normalised[] = [...byYears].map(([years, amount]) => ({ years, amount }));

  // Newton–Raphson from the guess.
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(flows, rate);
    if (Math.abs(f) < 1e-7) return rate;
    const df = dNpv(flows, rate);
    if (df === 0 || !Number.isFinite(df)) break;
    const next = rate - f / df;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-9) return next;
    rate = next <= -0.999999 ? (rate - 0.999999) / 2 : next; // stay in domain
  }

  // Bisection fallback over a wide bracket (lo matches Newton's domain floor).
  let lo = -0.999999;
  let hi = 100;
  let flo = npv(flows, lo);
  const fhi = npv(flows, hi);
  // A very long span (decades) makes (1+lo)^years ≈ 1e6^years overflow to ±Infinity,
  // so npv is non-finite at the domain floor. `NaN > 0` is false, so without this
  // guard the bracket check would pass and bisection would return a bogus ~hi (≈100
  // = 10000%). Reject a non-finite (or non-bracketing) bracket → honest null.
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(flows, mid);
    if (Math.abs(fmid) < 1e-7) return mid;
    if (flo * fmid < 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  const result = (lo + hi) / 2;
  return Number.isFinite(result) ? result : null;
}
