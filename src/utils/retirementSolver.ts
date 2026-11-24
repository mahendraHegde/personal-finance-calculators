// "What would it take?" solver: for a target Monte Carlo success rate, find
//   - the extra monthly saving (until retirement) that reaches it,
//   - the earliest retirement age that reaches it,
//   - the highest base spending that still reaches it.
//
// Every evaluation reuses the same random seed and the Monte Carlo gives
// each path its own stream (common random numbers), so a path sees the same
// luck whatever the lever.  Success is then monotone in saving and in
// spending, and bisection converges cleanly.  It is only nearly monotone in
// retirement age (retiring later also keeps the pre-retirement mix longer,
// which can occasionally cost a path), so that search is a bisection that
// returns an age verified to meet the target.  Money answers are rounded to
// ₹100 and re-checked, so a returned value always meets the target.

import type { InvestmentBucket, MonteCarloParams } from "../types/retirement";
import { runMonteCarloSimulation } from "./monteCarlo";
import { calculateRetirement, finiteOr, resolveVol, sanitizeAges } from "./retirement";

export interface LeverResult {
  // The lever's value (₹/month, age, or spend in the input's unit).
  value: number;
  // Success rate at that value.
  success: number;
}

export interface GapSolution {
  targetSuccess: number;
  currentSuccess: number;
  iterations: number;
  // Extra flat monthly saving until retirement.  value 0 when the plan
  // already meets the target.  null when it can't be reached that way
  // (already retired, or it would take more than MAX_EXTRA_SAVING).
  extraMonthlySaving: LeverResult | null;
  // Earliest whole-year retirement age meeting the target; may be earlier
  // than planned.  null when even the latest possible age misses.
  earliestRetirementAge: LeverResult | null;
  // Highest base spending (same unit as the input: per month or per year,
  // today's money) meeting the target.  null when even zero misses (e.g.
  // goals or healthcare alone break the plan).
  maxSpend: LeverResult | null;
}

export const DEFAULT_SOLVER_ITERATIONS = 500;
const MAX_EXTRA_SAVING = 5_000_000; // ₹50 lakh a month
const MAX_SPEND_FACTOR = 1e6;
const ROUNDING = 100; // answers in whole ₹100s
const MAX_ROUNDING_STEPS = 50;

// Mix for the hypothetical extra SIP: invested like your current monthly
// savings (weighted by amount), else like your existing investments, else a
// balanced 10%.
export const extraSavingBucket = (
  params: MonteCarloParams,
  id: number,
): InvestmentBucket => {
  const defaultVol = Math.max(0, finiteOr(params.portfolioVolatility, 0));
  const blend = (items: { w: number; r: number; v: number }[]) => {
    const total = items.reduce((s, x) => s + x.w, 0);
    if (!(total > 0)) return null;
    return {
      r: items.reduce((s, x) => s + x.w * x.r, 0) / total,
      v: items.reduce((s, x) => s + x.w * x.v, 0) / total,
    };
  };
  const vol = (b: InvestmentBucket) => resolveVol(b.volatility, defaultVol);
  const mix =
    blend(
      params.monthlySavingsBuckets.map((b) => ({
        w: Math.max(0, finiteOr(b.amount, 0)),
        r: finiteOr(b.return, 0),
        v: vol(b),
      })),
    ) ??
    blend(
      params.investmentBuckets.map((b) => ({
        w: Math.max(0, finiteOr(b.amount, 0)),
        r: finiteOr(b.return, 0),
        v: vol(b),
      })),
    ) ?? { r: 10, v: defaultVol };
  return { id, name: "Extra saving", amount: 0, return: mix.r, volatility: mix.v };
};

export function solveGaps(
  params: MonteCarloParams,
  targetSuccess = 0.9,
  iterations = DEFAULT_SOLVER_ITERATIONS,
): GapSolution {
  const target = Math.min(1, Math.max(0, targetSuccess));
  const seed = params.seed ?? 42;
  const success = (p: MonteCarloParams): number =>
    runMonteCarloSimulation({ ...p, iterations, seed }).successRate;
  const meets = (s: number) => s >= target - 1e-12;
  const currentSuccess = success(params);
  const ages = sanitizeAges(params);

  // ---- Extra monthly saving -------------------------------------------
  let extraMonthlySaving: LeverResult | null = null;
  if (meets(currentSuccess)) {
    extraMonthlySaving = { value: 0, success: currentSuccess };
  } else if (ages.retirementAge > ages.currentAge) {
    const id = Math.max(0, ...params.monthlySavingsBuckets.map((b) => b.id)) + 1;
    const template = extraSavingBucket(params, id);
    const withExtra = (amount: number) =>
      success({
        ...params,
        monthlySavingsBuckets: [...params.monthlySavingsBuckets, { ...template, amount }],
      });
    let lo = 0;
    let hi = 10_000;
    let sHi = withExtra(hi);
    while (!meets(sHi) && hi < MAX_EXTRA_SAVING) {
      lo = hi;
      hi *= 2;
      sHi = withExtra(hi);
    }
    if (meets(sHi)) {
      while (hi - lo > Math.max(ROUNDING, hi * 0.005)) {
        const mid = (lo + hi) / 2;
        const s = withExtra(mid);
        if (meets(s)) {
          hi = mid;
          sHi = s;
        } else lo = mid;
      }
      // Round up to ₹100, then make sure the rounded figure still meets it.
      let value = Math.ceil(hi / ROUNDING) * ROUNDING;
      let sValue = withExtra(value);
      for (let i = 0; i < MAX_ROUNDING_STEPS && !meets(sValue); i++) {
        value += ROUNDING;
        sValue = withExtra(value);
      }
      if (meets(sValue)) extraMonthlySaving = { value, success: sValue };
    }
  }

  // ---- Earliest retirement age ------------------------------------------
  let earliestRetirementAge: LeverResult | null = null;
  {
    const atAge = (age: number) => success({ ...params, retirementAge: age });
    let lo = ages.currentAge;
    let hi = ages.targetAge - 1;
    let sHi = hi === ages.retirementAge ? currentSuccess : atAge(hi);
    if (meets(sHi)) {
      // Smallest age that meets the target (success rises with age).
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const s = mid === ages.retirementAge ? currentSuccess : atAge(mid);
        if (meets(s)) {
          hi = mid;
          sHi = s;
        } else lo = mid + 1;
      }
      earliestRetirementAge = { value: hi, success: sHi };
    }
  }

  // ---- Highest spending -------------------------------------------------
  let maxSpend: LeverResult | null = null;
  {
    const current = Math.max(0, finiteOr(params.monthlyExpenses, 0));
    const atSpend = (spend: number) => success({ ...params, monthlyExpenses: spend });
    const s0 = atSpend(0);
    if (meets(s0)) {
      let lo = 0;
      let sLo = s0;
      let hi = Math.max(current, params.expenseType === "yearly" ? 12_000 : 1_000);
      let sHi = hi === current ? currentSuccess : atSpend(hi);
      if (meets(sHi)) {
        lo = hi;
        sLo = sHi;
        const cap = Math.max(hi, 1) * MAX_SPEND_FACTOR;
        while (meets(sHi) && hi < cap) {
          lo = hi;
          sLo = sHi;
          hi *= 2;
          sHi = atSpend(hi);
        }
      }
      while (hi - lo > Math.max(100, lo * 0.005)) {
        const mid = (lo + hi) / 2;
        const s = atSpend(mid);
        if (meets(s)) {
          lo = mid;
          sLo = s;
        } else hi = mid;
      }
      // Round down to ₹100, then make sure the rounded figure still meets it.
      let value = Math.floor(lo / ROUNDING) * ROUNDING;
      let sValue = value === lo ? sLo : atSpend(value);
      for (let i = 0; i < MAX_ROUNDING_STEPS && !meets(sValue) && value > 0; i++) {
        value = Math.max(0, value - ROUNDING);
        sValue = atSpend(value);
      }
      if (meets(sValue)) maxSpend = { value, success: sValue };
    }
  }

  return {
    targetSuccess: target,
    currentSuccess,
    iterations,
    extraMonthlySaving,
    earliestRetirementAge,
    maxSpend,
  };
}

// ---------------------------------------------------------------------------
// Side-by-side scenario comparison
// ---------------------------------------------------------------------------

export interface PlanSummary {
  retirementAge: number;
  targetAge: number;
  horizonAge: number;
  // Sum of the current monthly savings.
  monthlySaving: number;
  // Base spending per year at today's prices.
  annualSpend: number;
  corpusAtRetirement: number;
  // Same, in today's money.
  corpusAtRetirementToday: number;
  // Age the money runs out on the expected path; null = beyond the horizon.
  lastsToAge: number | null;
  withdrawalRate: number;
  successRate: number;
  badCaseAge: number;
}

export const DEFAULT_COMPARE_ITERATIONS = 1000;

export function summarizePlan(
  params: MonteCarloParams,
  iterations = DEFAULT_COMPARE_ITERATIONS,
): PlanSummary {
  const det = calculateRetirement(params);
  const mc = runMonteCarloSimulation({ ...params, iterations, seed: params.seed ?? 42 });
  return {
    retirementAge: det.retirementAge,
    targetAge: det.targetAge,
    horizonAge: det.horizonAge,
    monthlySaving: params.monthlySavingsBuckets.reduce(
      (s, b) => s + Math.max(0, finiteOr(b.amount, 0)),
      0,
    ),
    annualSpend: det.annualExpenses,
    corpusAtRetirement: det.corpusAtRetirement,
    corpusAtRetirementToday: det.corpusAtRetirement / det.inflationIndexAtRetirement,
    lastsToAge: det.corpusLastsBeyondHorizon ? null : det.survivalAge,
    withdrawalRate: det.initialWithdrawalRate,
    successRate: mc.successRate,
    badCaseAge: mc.p10DepletionAge,
  };
}
