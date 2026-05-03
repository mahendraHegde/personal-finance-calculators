import type {
  ExpenseFundingSnapshot,
  FutureOneTimeExpense,
  InvestmentBucket,
  PostRetirementBucket,
  PostRetirementBucketAllocation,
  RetirementCalculationParams,
  RetirementCalculationsResult,
  YearlyProjection,
} from "../types/retirement";

// ---------------------------------------------------------------------------
// Internal mutable state types
// ---------------------------------------------------------------------------

interface ExistingBucketState {
  amount: number;
  rate: number;
}

interface SavingsBucketState {
  id: number;
  name: string;
  monthly: number;
  rate: number;
  // Optional glide settings copied from the user-supplied SIP definition.
  // When both are positive, advanceSavings uses an effective rate that
  // linearly transitions from `rate` toward `targetRate` over the final
  // `glideYears` before the SIP's earliest pending linked goal.
  targetRate?: number;
  glideYears?: number;
  accumulated: number;
}

// Internal mutable state for the decumulation phase.  Each post-retirement
// bucket is a separate principal that compounds at its own rate.
interface RetirementBucketState {
  id: number;
  name: string;
  amount: number;
  rate: number;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

const finiteOr = (v: number | undefined | null, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const cloneBuckets = (buckets: InvestmentBucket[]): ExistingBucketState[] =>
  buckets.map((b) => ({
    amount: Math.max(0, finiteOr(b.amount, 0)),
    rate: finiteOr(b.return, 0),
  }));

const cloneSavings = (buckets: InvestmentBucket[]): SavingsBucketState[] =>
  buckets.map((b) => {
    const targetRate =
      b.targetRate !== undefined && Number.isFinite(b.targetRate)
        ? b.targetRate
        : undefined;
    const glideYears =
      b.glideYears !== undefined && Number.isFinite(b.glideYears) && b.glideYears > 0
        ? Math.floor(b.glideYears)
        : undefined;
    return {
      id: b.id,
      name: b.name,
      monthly: Math.max(0, finiteOr(b.amount, 0)),
      rate: finiteOr(b.return, 0),
      targetRate,
      glideYears,
      accumulated: 0,
    };
  });

const sumExisting = (buckets: ExistingBucketState[]): number =>
  buckets.reduce((s, b) => s + b.amount, 0);

const sumSavings = (buckets: SavingsBucketState[]): number =>
  buckets.reduce((s, b) => s + b.accumulated, 0);

// Hard floor on annual return: ‑95%/yr.  Even 2008-style crashes were ‑40%, so
// this only kicks in for absurd shock draws (≥6 sigma at vol=15%).  Without it
// extreme negative MC draws can flip bucket values negative.
const RETURN_FLOOR = -0.95;
// Inflation floor: ‑5%/yr deflation cap.  Worse than any modern economy.
const INFLATION_FLOOR = -0.05;

const growExisting = (buckets: ExistingBucketState[], shock: number) => {
  for (const b of buckets) {
    const r = Math.max(RETURN_FLOOR, b.rate / 100 + shock);
    b.amount *= 1 + r;
  }
};

// Compute the effective annual rate (in %) for a SIP at the given simulation
// year, taking the optional glide-path into account.  If glide is configured
// AND there is an upcoming linked goal within glideYears years, the rate
// linearly interpolates from the SIP's normal rate toward targetRate; outside
// the glide window the SIP uses its normal rate.
const effectiveSipRate = (
  bucket: SavingsBucketState,
  currentYear: number,
  nextGoalYear: number | undefined,
): number => {
  const glide = bucket.glideYears;
  const target = bucket.targetRate;
  if (
    glide === undefined ||
    glide <= 0 ||
    target === undefined ||
    nextGoalYear === undefined
  ) {
    return bucket.rate;
  }
  const yearsToGoal = nextGoalYear - currentYear;
  if (yearsToGoal >= glide) return bucket.rate;
  if (yearsToGoal <= 0) return target;
  // progress is the fraction of the glide already completed: 0 at the start
  // of the window, 1 at the goal year.
  const progress = 1 - yearsToGoal / glide;
  return bucket.rate + (target - bucket.rate) * progress;
};

// One year of monthly contributions + true monthly compounding for savings.
// Same formula in deterministic (shock=0) and MC paths: this guarantees that
// MC at sigma=0 collapses exactly to the deterministic projection.  An
// optional `effectiveRates` map overrides each bucket's per-year rate (used
// to apply glide-path settings); when not supplied each bucket uses its own
// `rate` as before.
const advanceSavings = (
  buckets: SavingsBucketState[],
  shock: number,
  effectiveRates?: Map<number, number>,
) => {
  for (const b of buckets) {
    const baseRate = effectiveRates?.get(b.id) ?? b.rate;
    const annualR = Math.max(RETURN_FLOOR, baseRate / 100 + shock);
    const r = annualR / 12;
    if (r === 0) {
      b.accumulated += b.monthly * 12;
    } else {
      const annualFactor = Math.pow(1 + r, 12);
      b.accumulated =
        b.accumulated * annualFactor +
        b.monthly * ((annualFactor - 1) / r);
    }
  }
};

// Withdraw a one-time expense pro-rata across all buckets.
// Returns the unfunded shortfall (positive when corpus could not cover it).
const withdrawProRata = (
  existing: ExistingBucketState[],
  savings: SavingsBucketState[],
  amount: number,
): number => {
  if (!(amount > 0)) return 0; // covers NaN / negative / zero
  const total = sumExisting(existing) + sumSavings(savings);
  if (total <= 0) return amount;
  if (amount >= total) {
    for (const b of existing) b.amount = 0;
    for (const b of savings) b.accumulated = 0;
    return amount - total;
  }
  const ratio = amount / total;
  for (const b of existing) b.amount *= 1 - ratio;
  for (const b of savings) b.accumulated *= 1 - ratio;
  return 0;
};

// ---- Decumulation-phase helpers (operate on RetirementBucketState[]) -----

const sumRetBuckets = (buckets: RetirementBucketState[]): number =>
  buckets.reduce((s, b) => s + b.amount, 0);

const growRetBuckets = (
  buckets: RetirementBucketState[],
  shock: number,
) => {
  for (const b of buckets) {
    const r = Math.max(RETURN_FLOOR, b.rate / 100 + shock);
    b.amount *= 1 + r;
  }
};

// Pro-rata withdrawal across post-retirement buckets.  Returns shortfall.
const withdrawRetProRata = (
  buckets: RetirementBucketState[],
  amount: number,
): number => {
  if (!(amount > 0)) return 0;
  const total = sumRetBuckets(buckets);
  if (total <= 0) return amount;
  if (amount >= total) {
    for (const b of buckets) b.amount = 0;
    return amount - total;
  }
  const ratio = amount / total;
  for (const b of buckets) b.amount *= 1 - ratio;
  return 0;
};

// Add money to retirement buckets pro-rata to current values.  Used when
// an earmarked pool's last linked expense has fired and any leftover is
// returned to the main corpus.  When all buckets happen to be at zero
// (corpus depleted), distribute equally so the money isn't lost.
const addToRetBucketsProRata = (
  buckets: RetirementBucketState[],
  amount: number,
) => {
  if (!(amount > 0) || buckets.length === 0) return;
  const total = sumRetBuckets(buckets);
  if (total <= 0) {
    const each = amount / buckets.length;
    for (const b of buckets) b.amount += each;
    return;
  }
  for (const b of buckets) {
    b.amount += amount * (b.amount / total);
  }
};

// Build the decumulation buckets from user-supplied allocations.  If no
// buckets are configured, falls back to a single synthetic bucket with the
// at-retirement weighted return — this preserves the legacy single-aggregate
// behaviour and keeps everything per-bucket internally.
const allocatePostRetirement = (
  corpusAtRetirement: number,
  weightedReturnAtRetirement: number,
  postRetirementBuckets: PostRetirementBucket[] | undefined,
): {
  buckets: RetirementBucketState[];
  allocation: PostRetirementBucketAllocation[];
} => {
  if (!postRetirementBuckets || postRetirementBuckets.length === 0) {
    return {
      buckets: [
        {
          id: 0,
          name: "Aggregated",
          amount: Math.max(0, corpusAtRetirement),
          rate: weightedReturnAtRetirement,
        },
      ],
      allocation: [
        {
          id: 0,
          name: "Aggregated",
          allocationPct: 100,
          normalizedPct: 100,
          amount: Math.max(0, corpusAtRetirement),
          return: weightedReturnAtRetirement,
        },
      ],
    };
  }
  const sanitized = postRetirementBuckets.map((b) => ({
    id: b.id,
    name: b.name,
    rate: finiteOr(b.return, 0),
    pct: Math.max(0, finiteOr(b.allocationPct, 0)),
  }));
  const totalPct = sanitized.reduce((s, b) => s + b.pct, 0);
  const norm = totalPct > 0 ? totalPct : 1;
  const buckets: RetirementBucketState[] = [];
  const allocation: PostRetirementBucketAllocation[] = [];
  for (const b of sanitized) {
    const normalisedPct = totalPct > 0 ? (b.pct / norm) * 100 : 0;
    const amount = Math.max(0, corpusAtRetirement) * (b.pct / norm);
    buckets.push({ id: b.id, name: b.name, amount, rate: b.rate });
    allocation.push({
      id: b.id,
      name: b.name,
      allocationPct: b.pct,
      normalizedPct: normalisedPct,
      amount,
      return: b.rate,
    });
  }
  // Edge case: all allocations are zero.  Fall back to single aggregate
  // so the user doesn't get a stuck-at-zero corpus that fails to track
  // the actual savings they accumulated.
  if (totalPct === 0) {
    buckets.length = 0;
    buckets.push({
      id: 0,
      name: "Aggregated",
      amount: Math.max(0, corpusAtRetirement),
      rate: weightedReturnAtRetirement,
    });
    allocation.length = 0;
    allocation.push({
      id: 0,
      name: "Aggregated",
      allocationPct: 0,
      normalizedPct: 100,
      amount: Math.max(0, corpusAtRetirement),
      return: weightedReturnAtRetirement,
    });
  }
  return { buckets, allocation };
};

// Apply a one-time expense during the accumulation phase, returning the
// per-expense funding breakdown.  Drains the linked SIP first (if any), then
// pulls the remainder pro-rata across all buckets (existing + savings).
// Dangling links (bucket deleted after the link was set) silently fall
// through to plain pro-rata.
const applyAccumulationExpense = (
  existing: ExistingBucketState[],
  savings: SavingsBucketState[],
  expense: FutureOneTimeExpense,
): ExpenseFundingSnapshot => {
  const futureValue = Math.max(0, expense.futureValue);
  let remaining = futureValue;
  let drainedFromLinked = 0;
  let linkedBalanceBefore: number | undefined;

  if (expense.linkedSavingsBucketId !== undefined) {
    const bucket = savings.find(
      (b) => b.id === expense.linkedSavingsBucketId,
    );
    if (bucket) {
      linkedBalanceBefore = bucket.accumulated;
      if (bucket.accumulated > 0 && remaining > 0) {
        const drained = Math.min(remaining, bucket.accumulated);
        bucket.accumulated -= drained;
        remaining -= drained;
        drainedFromLinked = drained;
      }
    }
  }
  const shortfall = withdrawProRata(existing, savings, remaining);
  const drainedFromMain = remaining - shortfall;
  return {
    expenseId: expense.id,
    expenseName: expense.name,
    yearsFromNow: expense.yearsFromNow,
    ageWhenDue: expense.ageWhenDue,
    futureValue,
    drainedFromLinked,
    drainedFromMain,
    shortfall,
    linkedBalanceBefore,
  };
};

// Box-Muller standard-normal draw.  Exported so monteCarlo.ts can share it.
export const standardNormal = (rng: () => number): number => {
  let u1 = rng();
  while (u1 <= Number.EPSILON) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

// ---------------------------------------------------------------------------
// Future one-time expense pre-processing
// ---------------------------------------------------------------------------

const buildFutureOneTimeExpenses = (
  oneTimeExpenses: RetirementCalculationParams["oneTimeExpenses"],
  currentAge: number,
): FutureOneTimeExpense[] =>
  oneTimeExpenses.map((expense) => {
    const yearsFromNow = Math.max(0, Math.round(finiteOr(expense.yearsFromNow, 0)));
    const inflationRate = finiteOr(expense.inflationRate, 0);
    const currentCost = Math.max(0, finiteOr(expense.currentCost, 0));
    return {
      ...expense,
      yearsFromNow,
      inflationRate,
      currentCost,
      futureValue:
        currentCost * Math.pow(1 + inflationRate / 100, yearsFromNow),
      ageWhenDue: currentAge + yearsFromNow,
    };
  });

const indexByYear = (
  expenses: FutureOneTimeExpense[],
): Map<number, FutureOneTimeExpense[]> => {
  const m = new Map<number, FutureOneTimeExpense[]>();
  for (const e of expenses) {
    const list = m.get(e.yearsFromNow);
    if (list) list.push(e);
    else m.set(e.yearsFromNow, [e]);
  }
  return m;
};

// ---------------------------------------------------------------------------
// Shared simulation primitive — used by deterministic and Monte Carlo alike
// ---------------------------------------------------------------------------

export interface SimulationOptions {
  rng?: () => number;
  // Annualised stdev of portfolio returns, in percent (e.g., 12 = 12%).
  // Ignored when rng is undefined.
  portfolioVolatility?: number;
  // Annualised stdev of inflation, in percent.  Ignored when rng is undefined.
  inflationVolatility?: number;
}

export interface SimulationResult {
  steps: YearlyProjection[];
  // Total at-retirement wealth: existing buckets + ALL SIPs (incl earmarked).
  corpusAtRetirement: number;
  // Slice that flows into the post-retirement decumulation pool.  Equals
  // corpusAtRetirement minus earmarkedAtRetirement.
  mainCorpusAtRetirement: number;
  // Sum of earmarked SIP balances at the retirement transition.  Each pool
  // continues to compound at its SIP's rate during retirement until the
  // linked one-time expense fires; any leftover then rolls into the main
  // corpus.
  earmarkedAtRetirement: number;
  weightedReturnAtRetirement: number;
  yearsAfterRetirement: number;
  survivalAge: number;
  depleted: boolean;
  finalCorpus: number;
  yearsToRetirement: number;
  futureOneTimeExpenses: FutureOneTimeExpense[];
  // Cumulative realised inflation factor from today to retirement.  In the
  // deterministic case this is (1 + inflation)^yearsToRetirement.
  cumulativeInflationToRetirement: number;
  // The per-bucket post-retirement allocation snapshotted at the moment of
  // retirement.  Useful for the UI to show ₹ amounts derived from the user's
  // %s and the actual at-retirement main corpus.
  postRetirementAllocation: PostRetirementBucketAllocation[];
  // Per-expense funding breakdown — see ExpenseFundingSnapshot.
  expenseFundings: ExpenseFundingSnapshot[];
}

export function simulateRetirementPath(
  params: RetirementCalculationParams,
  opts: SimulationOptions = {},
): SimulationResult {
  // ---- Sanitize inputs ---------------------------------------------------
  const currentAge = Math.max(0, finiteOr(params.currentAge, 0));
  const retirementAge = Math.max(currentAge, finiteOr(params.retirementAge, currentAge));
  const inflation = finiteOr(params.inflation, 0);
  const monthlyExpensesInput = Math.max(0, finiteOr(params.monthlyExpenses, 0));
  const expenseType = params.expenseType === "yearly" ? "yearly" : "monthly";
  const targetAge = Math.max(
    retirementAge + 1,
    finiteOr(params.targetAge, 90),
  );

  const annualExpenses =
    expenseType === "monthly" ? monthlyExpensesInput * 12 : monthlyExpensesInput;
  const yearsToRetirement = retirementAge - currentAge;

  // Run the simulation a few years past the user's target so we can detect
  // depletion that happens just *after* targetAge — better UX than truncating
  // exactly at the boundary.
  const horizonAge = targetAge + 5;
  const maxYearsAfterRetirement = Math.max(1, horizonAge - retirementAge);

  const futureOneTimeExpenses = buildFutureOneTimeExpenses(
    params.oneTimeExpenses,
    currentAge,
  );
  const oneTimeByYear = indexByYear(futureOneTimeExpenses);

  // For each SIP, the *sorted* list of years at which one of its linked
  // expenses fires.  Used by the glide-path logic to find the next pending
  // goal each year.
  const linkedGoalsBySipId = new Map<number, number[]>();
  for (const e of futureOneTimeExpenses) {
    if (e.linkedSavingsBucketId === undefined) continue;
    const list = linkedGoalsBySipId.get(e.linkedSavingsBucketId) ?? [];
    list.push(e.yearsFromNow);
    linkedGoalsBySipId.set(e.linkedSavingsBucketId, list);
  }
  for (const list of linkedGoalsBySipId.values()) {
    list.sort((a, b) => a - b);
  }
  // Returns the *next* linked-goal year >= currentYear for the given SIP,
  // or undefined if the SIP has no pending linked goal.
  const nextGoalYearForSip = (
    sipId: number,
    currentYear: number,
  ): number | undefined => {
    const goals = linkedGoalsBySipId.get(sipId);
    if (!goals) return undefined;
    return goals.find((g) => g >= currentYear);
  };

  // ---- Stochastic settings ----------------------------------------------
  const { rng } = opts;
  const sigmaR = rng
    ? Math.max(0, finiteOr(opts.portfolioVolatility, 0)) / 100
    : 0;
  const sigmaI = rng
    ? Math.max(0, finiteOr(opts.inflationVolatility, 0)) / 100
    : 0;

  // ---- Mutable corpus state + output buffers ---------------------------
  const existing = cloneBuckets(params.investmentBuckets);
  const savings = cloneSavings(params.monthlySavingsBuckets);
  const steps: YearlyProjection[] = [];
  const expenseFundings: ExpenseFundingSnapshot[] = [];
  let nominalAnnualExpenses = annualExpenses;
  let cumulativeInflation = 1;

  // Apply any "due now" expenses (yearsFromNow == 0) before the year-1 step.
  // Without this, immediate big purchases (e.g., wedding due this year) would
  // be silently dropped because the main loop starts at year=1.  Note: a
  // year-0 expense linked to a SIP gets ~no benefit from the link because the
  // SIP has not had time to accumulate — but it's harmless.
  const yr0 = oneTimeByYear.get(0);
  if (yr0) {
    for (const e of yr0) {
      expenseFundings.push(
        applyAccumulationExpense(existing, savings, e),
      );
    }
  }

  // ---- Accumulation phase ------------------------------------------------
  for (let year = 1; year <= yearsToRetirement; year++) {
    const age = currentAge + year;

    const rShock = sigmaR > 0 && rng ? standardNormal(rng) * sigmaR : 0;
    const iShock = sigmaI > 0 && rng ? standardNormal(rng) * sigmaI : 0;
    const realisedInflation = Math.max(INFLATION_FLOOR, inflation / 100 + iShock);

    growExisting(existing, rShock);
    const savingsBefore = sumSavings(savings);
    // Per-SIP effective rate for this year (factors in any glide).
    const sipRatesThisYear = new Map<number, number>();
    for (const sb of savings) {
      sipRatesThisYear.set(
        sb.id,
        effectiveSipRate(sb, year, nextGoalYearForSip(sb.id, year)),
      );
    }
    advanceSavings(savings, rShock, sipRatesThisYear);
    const contributions = sumSavings(savings) - savingsBefore;

    const oneTimeForYear = oneTimeByYear.get(year) ?? [];
    let oneTimeAmount = 0;
    for (const e of oneTimeForYear) {
      expenseFundings.push(
        applyAccumulationExpense(existing, savings, e),
      );
      oneTimeAmount += e.futureValue;
    }

    const corpus = sumExisting(existing) + sumSavings(savings);
    steps.push({
      year,
      age,
      isRetired: false,
      corpus,
      regularExpenses: 0,
      oneTimeExpenses: oneTimeAmount,
      oneTimeItems: oneTimeForYear,
      contributions,
    });

    nominalAnnualExpenses *= 1 + realisedInflation;
    cumulativeInflation *= 1 + realisedInflation;
  }

  // ---- Identify earmarked SIPs (those linked to a *post-retirement* one-time
  // expense).  Pre-retirement linked expenses already drained their SIP
  // during accumulation, so they don't earmark anything for the future. ----
  const earmarkedSipIds = new Set<number>();
  for (const e of futureOneTimeExpenses) {
    if (
      e.linkedSavingsBucketId !== undefined &&
      e.yearsFromNow > yearsToRetirement &&
      savings.some((s) => s.id === e.linkedSavingsBucketId)
    ) {
      earmarkedSipIds.add(e.linkedSavingsBucketId);
    }
  }

  // ---- Build the earmarked pools at the retirement transition ----
  // Each earmarked SIP's at-retirement balance becomes a separate pool that
  // continues to compound at the SIP's rate (no contributions — those stop at
  // retirement).  The pool tracks how many post-retirement linked expenses
  // are still pending; once that count reaches zero, any leftover rolls back
  // into the main corpus pro-rata.
  interface EarmarkedPool {
    sipId: number;
    name: string;
    amount: number;
    rate: number;
    targetRate?: number;
    glideYears?: number;
    pendingExpenseCount: number;
  }

  const earmarkedPools = new Map<number, EarmarkedPool>();
  for (const sb of savings) {
    if (!earmarkedSipIds.has(sb.id)) continue;
    let pendingCount = 0;
    for (const e of futureOneTimeExpenses) {
      if (
        e.linkedSavingsBucketId === sb.id &&
        e.yearsFromNow > yearsToRetirement
      ) {
        pendingCount++;
      }
    }
    if (pendingCount > 0) {
      earmarkedPools.set(sb.id, {
        sipId: sb.id,
        name: sb.name ?? "",
        amount: sb.accumulated,
        rate: sb.rate,
        targetRate: sb.targetRate,
        glideYears: sb.glideYears,
        pendingExpenseCount: pendingCount,
      });
    }
  }

  // ---- Lock in retirement-time state -----------------------------------
  // corpusAtRetirement is the *total* at retirement (incl. earmarked) — the
  // headline number the user accumulated.  The main corpus excludes
  // earmarked balances and is what flows into the decumulation pool.  The
  // weighted return is computed on the main-corpus components (existing +
  // non-earmarked savings) and used as the fallback rate when no
  // post-retirement allocation is configured.
  const existingValue = sumExisting(existing);
  const existingWeightedSum = existing.reduce(
    (s, b) => s + b.amount * b.rate,
    0,
  );
  let nonEarmarkedSavingsValue = 0;
  let nonEarmarkedSavingsWeightedSum = 0;
  let earmarkedSavingsValue = 0;
  for (const sb of savings) {
    if (earmarkedSipIds.has(sb.id)) {
      earmarkedSavingsValue += sb.accumulated;
    } else {
      nonEarmarkedSavingsValue += sb.accumulated;
      nonEarmarkedSavingsWeightedSum += sb.accumulated * sb.rate;
    }
  }
  const earmarkedAtRetirement = earmarkedSavingsValue;
  const corpusAtRetirement =
    existingValue + nonEarmarkedSavingsValue + earmarkedSavingsValue;
  const mainCorpusAtRetirement = existingValue + nonEarmarkedSavingsValue;
  const weightedReturnAtRetirement =
    mainCorpusAtRetirement > 0
      ? (existingWeightedSum + nonEarmarkedSavingsWeightedSum) /
        mainCorpusAtRetirement
      : 0;

  // ---- Build per-bucket decumulation state ------------------------------
  const { buckets: retBuckets, allocation: postRetirementAllocation } =
    allocatePostRetirement(
      mainCorpusAtRetirement,
      weightedReturnAtRetirement,
      params.postRetirementBuckets,
    );

  let depleted = false;
  let yearsAfterRetirement = maxYearsAfterRetirement;
  let lastCorpus = sumRetBuckets(retBuckets) + earmarkedAtRetirement;

  for (let k = 1; k <= maxYearsAfterRetirement; k++) {
    const year = yearsToRetirement + k;
    const age = currentAge + year;

    const rShock = sigmaR > 0 && rng ? standardNormal(rng) * sigmaR : 0;
    const iShock = sigmaI > 0 && rng ? standardNormal(rng) * sigmaI : 0;
    const realisedInflation = Math.max(INFLATION_FLOOR, inflation / 100 + iShock);

    // Grow main corpus and earmarked pools (single-factor shock applies to
    // both — same realised market in any given year).
    growRetBuckets(retBuckets, rShock);
    for (const pool of earmarkedPools.values()) {
      // The pool inherits the SIP's glide-path settings.  We mirror the
      // accumulation-phase logic by treating the pool as a degenerate
      // SIP (no contributions) for rate calculation.
      const baseRate = effectiveSipRate(
        {
          id: pool.sipId,
          name: pool.name,
          monthly: 0,
          rate: pool.rate,
          targetRate: pool.targetRate,
          glideYears: pool.glideYears,
          accumulated: pool.amount,
        },
        year,
        nextGoalYearForSip(pool.sipId, year),
      );
      const r = Math.max(RETURN_FLOOR, baseRate / 100 + rShock);
      pool.amount *= 1 + r;
    }

    // Process one-time expenses for the year.  Linked expenses drain their
    // pool first; any shortfall is pulled pro-rata from the main corpus.
    const oneTimeForYear = oneTimeByYear.get(year) ?? [];
    let totalOneTimeAmount = 0;
    for (const e of oneTimeForYear) {
      let remaining = e.futureValue;
      let drainedFromLinked = 0;
      let linkedBalanceBefore: number | undefined;
      let surplusRolledOver: number | undefined;

      if (e.linkedSavingsBucketId !== undefined) {
        const pool = earmarkedPools.get(e.linkedSavingsBucketId);
        if (pool) {
          linkedBalanceBefore = pool.amount;
          if (pool.amount > 0) {
            const drained = Math.min(remaining, pool.amount);
            pool.amount -= drained;
            remaining -= drained;
            drainedFromLinked = drained;
          }
          pool.pendingExpenseCount = Math.max(
            0,
            pool.pendingExpenseCount - 1,
          );
          // If this was the LAST pending linked expense for the pool, any
          // leftover will roll back into the main corpus below — record it
          // here so the user can see the surplus attached to this expense.
          if (pool.pendingExpenseCount === 0 && pool.amount > 0) {
            surplusRolledOver = pool.amount;
          }
        }
      }

      let drainedFromMain = 0;
      let shortfall = 0;
      if (remaining > 0) {
        // Shortfall absorbed by main corpus.  Note: this can drive the main
        // corpus to zero but does NOT trigger depletion on its own — only
        // failure to fund regular expenses does (see below).
        shortfall = withdrawRetProRata(retBuckets, remaining);
        drainedFromMain = remaining - shortfall;
      }

      expenseFundings.push({
        expenseId: e.id,
        expenseName: e.name,
        yearsFromNow: e.yearsFromNow,
        ageWhenDue: e.ageWhenDue,
        futureValue: e.futureValue,
        drainedFromLinked,
        drainedFromMain,
        shortfall,
        linkedBalanceBefore,
        surplusRolledOver,
      });
      totalOneTimeAmount += e.futureValue;
    }

    // Roll any pool whose linked expenses are all done into the main corpus.
    // Done in the same year so the leftover becomes available immediately —
    // matches the real-world expectation that money set aside for a goal
    // becomes ordinary spending money once the goal is funded.
    for (const [id, pool] of [...earmarkedPools]) {
      if (pool.pendingExpenseCount <= 0) {
        if (pool.amount > 0) {
          addToRetBucketsProRata(retBuckets, pool.amount);
        }
        earmarkedPools.delete(id);
      }
    }

    // Process regular expenses — always from the main corpus.  Earmarked
    // pools are reserved for their linked goals and don't fund daily living.
    const regularShortfall = withdrawRetProRata(
      retBuckets,
      nominalAnnualExpenses,
    );

    const regularThisYear = nominalAnnualExpenses;
    const earmarkedSumNow = Array.from(earmarkedPools.values()).reduce(
      (s, p) => s + p.amount,
      0,
    );
    const corpusEnd = sumRetBuckets(retBuckets) + earmarkedSumNow;
    lastCorpus = corpusEnd;

    steps.push({
      year,
      age,
      isRetired: true,
      corpus: corpusEnd,
      regularExpenses: regularThisYear,
      oneTimeExpenses: totalOneTimeAmount,
      oneTimeItems: oneTimeForYear,
      contributions: 0,
    });

    // Depletion = the user can no longer fund regular expenses.  A
    // shortfall in funding a one-time goal isn't depletion (the user
    // simply couldn't fully meet that specific goal).
    if (regularShortfall > 0 && !depleted) {
      depleted = true;
      const fraction =
        nominalAnnualExpenses > 0
          ? Math.max(
              0,
              Math.min(1, 1 - regularShortfall / nominalAnnualExpenses),
            )
          : 1;
      yearsAfterRetirement = k - 1 + fraction;
      break;
    }

    nominalAnnualExpenses *= 1 + realisedInflation;
  }

  const finalCorpus = Math.max(0, lastCorpus);
  const survivalAge = retirementAge + yearsAfterRetirement;

  return {
    steps,
    corpusAtRetirement,
    mainCorpusAtRetirement,
    earmarkedAtRetirement,
    weightedReturnAtRetirement,
    yearsAfterRetirement,
    survivalAge,
    depleted,
    finalCorpus,
    yearsToRetirement,
    futureOneTimeExpenses,
    cumulativeInflationToRetirement: cumulativeInflation,
    postRetirementAllocation,
    expenseFundings,
  };
}

// ---------------------------------------------------------------------------
// Public deterministic API
// ---------------------------------------------------------------------------

export function calculateRetirement(
  params: RetirementCalculationParams,
): RetirementCalculationsResult {
  const sim = simulateRetirementPath(params);

  const annualExpenses =
    params.expenseType === "monthly"
      ? Math.max(0, finiteOr(params.monthlyExpenses, 0)) * 12
      : Math.max(0, finiteOr(params.monthlyExpenses, 0));
  const annualExpensesAtRetirement =
    annualExpenses * sim.cumulativeInflationToRetirement;

  return {
    totalCorpus: sim.corpusAtRetirement,
    corpusAtRetirement: sim.corpusAtRetirement,
    mainCorpusAtRetirement: sim.mainCorpusAtRetirement,
    earmarkedAtRetirement: sim.earmarkedAtRetirement,
    weightedReturn: sim.weightedReturnAtRetirement,
    realReturn:
      sim.weightedReturnAtRetirement - finiteOr(params.inflation, 0),
    yearsToRetirement: sim.yearsToRetirement,
    yearsAfterRetirement: sim.yearsAfterRetirement,
    annualExpenses,
    annualExpensesAtRetirement,
    futureOneTimeExpenses: sim.futureOneTimeExpenses,
    yearlyData: sim.steps,
    survivalAge: sim.survivalAge,
    corpusLastsBeyondHorizon: !sim.depleted,
    postRetirementAllocation: sim.postRetirementAllocation,
    expenseFundings: sim.expenseFundings,
  };
}
