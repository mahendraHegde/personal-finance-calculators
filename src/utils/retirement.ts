import type {
  ExpenseFundingSnapshot,
  FutureOneTimeExpense,
  InvestmentBucket,
  PostRetirementBucket,
  PostRetirementBucketAllocation,
  RetirementCalculationParams,
  RetirementCalculationsResult,
  TaxSettings,
  TaxTreatment,
  WithdrawalStrategy,
  YearlyProjection,
} from "../types/retirement";

// ---------------------------------------------------------------------------
// Modelling conventions (read this before changing the maths)
// ---------------------------------------------------------------------------
//
// * Every return the user enters is a long-run annualised return (CAGR), the
//   way fund factsheets and FD rates are quoted.  A lump sum at r% grows by
//   (1 + r) a year, and a monthly SIP in the same asset compounds at the
//   equivalent monthly rate (1 + r)^(1/12) - 1, so both grow identically.
//   (The common "r / 12" shortcut quietly turns 12% into 12.68% a year.)
//   A SIP's monthly amount can step up by a fixed % every year.
//
// * Before retirement, living costs are assumed to be paid from income; the
//   corpus only receives SIP contributions and pays one-time goals.
//
// * In retirement, each month's living cost is base spending (× the spending
//   phase for that age) plus healthcare (its own inflation), minus income
//   (pension, rent, ...).  What income doesn't cover is withdrawn at the
//   START of the month; spare income is invested.  Prices rise monthly.
//
// * A one-time goal "N years from now" is paid at exactly t = N years, i.e.
//   at the end of simulation year N.  Goals beyond the simulated horizon
//   (targetAge + HORIZON_BUFFER_YEARS) are left out of the plan.
//
// * A SIP linked to post-retirement goals keeps aside, at retirement, only
//   what those goals need: their cost discounted at the SIP's expected rate
//   path.  The rest joins the main corpus.  The earmarked pool is reserved
//   while the main corpus can pay living costs; once the main corpus cannot
//   cover a month, living costs draw on the pools before the plan counts as
//   having run out.  "Runs out" therefore means all money is gone.
//
// * Tax applies to post-retirement buckets only.  Pre-retirement returns
//   are entered after tax, so the corpus starts retirement with its cost
//   equal to its value (no gain taxed twice).  From then on each bucket
//   tracks its cost and withdrawals realise the gain part: equity gains
//   above the yearly exemption are taxed at the LTCG rate, "slabOnSale"
//   gains and "slabYearly" growth (taxed as it accrues) at the income-tax
//   rate.  Tax is settled from the corpus at the end of each year; gains
//   realised to pay it count toward the next year.
//
// * Monte Carlo: each year draws one market shock z shared by all buckets
//   (a single market factor, so buckets are perfectly correlated, which is
//   conservative).  A bucket's gross yearly factor is lognormal:
//       G = (1 + r) · exp(s · z)
//   whose MEDIAN is exactly (1 + r) and whose standard deviation equals the
//   bucket's volatility.  The median path therefore matches the deterministic
//   projection.  z is standard normal, or optionally a fat-tailed mixture
//   (calm years and rarer crisis years); s is calibrated for whichever is
//   used, so each bucket's volatility stays as entered.  Each simulated path
//   has its own random stream, so changing one input never reshuffles the
//   luck of other paths (the solver relies on this).
//   Inflation is mean-reverting: each year's surprise carries over by the
//   persistence factor (AR(1)); every year, including the first, has the
//   yearly spread entered.

// ---------------------------------------------------------------------------
// Internal mutable state types
// ---------------------------------------------------------------------------

interface ExistingBucketState {
  amount: number;
  rate: number;
  vol: number;
}

interface SavingsBucketState {
  id: number;
  name: string;
  // This year's monthly contribution (rises by stepUp every year).
  monthly: number;
  stepUp: number;
  rate: number;
  vol: number;
  // Optional glide settings copied from the user-supplied SIP definition.
  // When both are positive, the SIP's rate linearly transitions from `rate`
  // toward `targetRate` over the final `glideYears` before the SIP's
  // earliest pending linked goal.
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
  vol: number;
  // Volatility used to rank buckets from safest to riskiest ("buckets"
  // strategy).  Unlike `vol` it resolves a blank to the default volatility
  // even on the expected path, so the ranking is the same in both views.
  riskRank: number;
  tax: TaxTreatment;
  // Amount invested (cost), for tax.
  basis: number;
}

interface GainsLedger {
  equity: number;
  slab: number;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

export const finiteOr = (
  v: number | undefined | null,
  fallback: number,
): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export const clampNum = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

// A bucket's own volatility when it has a usable one, else the default.
export const resolveVol = (v: number | undefined, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;

// Inflation floor: -5%/yr deflation cap.  Worse than any modern economy.
const INFLATION_FLOOR = -0.05;

// Volatility assumed for money that a glide path has moved into a "safe"
// asset (debt fund / FD-like).  A glide blends the SIP's volatility toward
// this as it blends the return toward the target rate.
export const DERISKED_VOLATILITY = 2;

// Volatility for a bucket left blank (roughly a balanced equity/debt mix).
export const DEFAULT_VOLATILITY = 12;

// Indian rules as of FY 2025-26; editable in the UI.
export const DEFAULT_TAX: TaxSettings = {
  incomeTaxRate: 20,
  ltcgRate: 12.5,
  ltcgExemption: 125_000,
};

export const DEFAULT_CASH_BUFFER_YEARS = 2;

// Fat-tailed market shocks: a calm/crisis mixture of normals with unit
// variance overall (so the volatility the user entered is unchanged) and
// excess kurtosis of 3.
const CRISIS_PROBABILITY = 0.1;
const CRISIS_SCALE = 2;
const CALM_SCALE = Math.sqrt(
  (1 - CRISIS_PROBABILITY * CRISIS_SCALE * CRISIS_SCALE) /
    (1 - CRISIS_PROBABILITY),
);
export const MAX_INFLATION_PERSISTENCE = 0.95;

// Scale s such that base·exp(s·z) has standard deviation volPct/100.
// Normal z: Var = base² · x · (x − 1) with x = exp(s²), solved in closed
// form.  Fat-tailed mixture z: Var/base² = M(2s) − M(s)² with
// M(t) = p·exp(t²k²/2) + (1 − p)·exp(t²l²/2); solved by bisection and
// memoised (it is called per bucket per simulated year).
const fatScaleCache = new Map<string, number>();
const shockScale = (base: number, volPct: number, fat: boolean): number => {
  const rel = volPct / 100 / base;
  if (!fat) {
    const x = (1 + Math.sqrt(1 + 4 * rel * rel)) / 2;
    return Math.sqrt(Math.log(x));
  }
  const key = `${base}|${volPct}`;
  const cached = fatScaleCache.get(key);
  if (cached !== undefined) return cached;
  const mgf = (t: number) =>
    CRISIS_PROBABILITY * Math.exp((t * t * CRISIS_SCALE * CRISIS_SCALE) / 2) +
    (1 - CRISIS_PROBABILITY) * Math.exp((t * t * CALM_SCALE * CALM_SCALE) / 2);
  const relVar = (s: number) => mgf(2 * s) - mgf(s) ** 2;
  const want = rel * rel;
  let lo = 0;
  let hi = 1;
  while (relVar(hi) < want && hi < 64) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (relVar(mid) < want) lo = mid;
    else hi = mid;
  }
  const s = (lo + hi) / 2;
  if (fatScaleCache.size > 10_000) fatScaleCache.clear();
  fatScaleCache.set(key, s);
  return s;
};

// Gross yearly growth factor for a bucket.  Deterministic when z = 0 or the
// bucket has no volatility.  See the conventions note at the top.
const grossFactor = (
  ratePct: number,
  volPct: number,
  z: number,
  fat = false,
): number => {
  const base = 1 + Math.max(-0.99, ratePct / 100);
  if (z === 0 || !(volPct > 0)) return base;
  return base * Math.exp(shockScale(base, volPct, fat) * z);
};

export interface SanitizedAges {
  currentAge: number;
  retirementAge: number;
  targetAge: number;
  // Last age simulated: targetAge plus a few years, so depletion just after
  // the plan age is still detected.
  horizonAge: number;
}

// Simulated years beyond the plan age.
export const HORIZON_BUFFER_YEARS = 5;
// Upper bounds on ages.  A typo like 600 would otherwise simulate hundreds of
// years on every keystroke.
const MAX_CURRENT_OR_RETIREMENT_AGE = 110;
const MAX_TARGET_AGE = 120;

// Ages are whole years.  A fractional age used to make every post-retirement
// simulation year fractional, so post-retirement one-time goals (indexed by
// whole years) were silently never applied.
export const sanitizeAges = (
  params: Pick<
    RetirementCalculationParams,
    "currentAge" | "retirementAge" | "targetAge"
  >,
): SanitizedAges => {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.round(v)));
  const currentAge = clamp(
    finiteOr(params.currentAge, 0),
    0,
    MAX_CURRENT_OR_RETIREMENT_AGE,
  );
  const retirementAge = clamp(
    finiteOr(params.retirementAge, currentAge),
    currentAge,
    MAX_CURRENT_OR_RETIREMENT_AGE,
  );
  const targetAge = clamp(
    finiteOr(params.targetAge, 90),
    retirementAge + 1,
    MAX_TARGET_AGE,
  );
  return {
    currentAge,
    retirementAge,
    targetAge,
    horizonAge: targetAge + HORIZON_BUFFER_YEARS,
  };
};

const resolveTax = (t: TaxSettings | undefined): TaxSettings => ({
  incomeTaxRate: clampNum(finiteOr(t?.incomeTaxRate, DEFAULT_TAX.incomeTaxRate), 0, 100),
  ltcgRate: clampNum(finiteOr(t?.ltcgRate, DEFAULT_TAX.ltcgRate), 0, 100),
  ltcgExemption: Math.max(0, finiteOr(t?.ltcgExemption, DEFAULT_TAX.ltcgExemption)),
});

const resolveStrategy = (s: WithdrawalStrategy | undefined): WithdrawalStrategy =>
  s === "rebalance" || s === "buckets" ? s : "proRata";

const TAX_TREATMENTS: readonly TaxTreatment[] = [
  "none",
  "equity",
  "slabOnSale",
  "slabYearly",
];
const resolveTreatment = (t: TaxTreatment | undefined): TaxTreatment =>
  t !== undefined && TAX_TREATMENTS.includes(t) ? t : "none";

const cloneBuckets = (
  buckets: InvestmentBucket[],
  defaultVol: number,
): ExistingBucketState[] =>
  buckets.map((b) => ({
    amount: Math.max(0, finiteOr(b.amount, 0)),
    rate: finiteOr(b.return, 0),
    vol: resolveVol(b.volatility, defaultVol),
  }));

const cloneSavings = (
  buckets: InvestmentBucket[],
  defaultVol: number,
): SavingsBucketState[] =>
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
      stepUp: clampNum(finiteOr(b.stepUpPct, 0) / 100, -0.99, 1),
      rate: finiteOr(b.return, 0),
      vol: resolveVol(b.volatility, defaultVol),
      targetRate,
      glideYears,
      accumulated: 0,
    };
  });

const sumExisting = (buckets: ExistingBucketState[]): number =>
  buckets.reduce((s, b) => s + b.amount, 0);

const sumSavings = (buckets: SavingsBucketState[]): number =>
  buckets.reduce((s, b) => s + b.accumulated, 0);

// Returns the investment growth earned.
const growExisting = (
  buckets: ExistingBucketState[],
  z: number,
  fat: boolean,
): number => {
  let growth = 0;
  for (const b of buckets) {
    const before = b.amount;
    b.amount *= grossFactor(b.rate, b.vol, z, fat);
    growth += b.amount - before;
  }
  return growth;
};

// How far through its glide a SIP is in the given simulation year: 0 outside
// the glide window (or with no glide / no pending linked goal), rising
// linearly to 1 in the goal year itself.
const glideProgress = (
  bucket: Pick<SavingsBucketState, "glideYears" | "targetRate">,
  currentYear: number,
  nextGoalYear: number | undefined,
): number => {
  const glide = bucket.glideYears;
  if (
    glide === undefined ||
    glide <= 0 ||
    bucket.targetRate === undefined ||
    nextGoalYear === undefined
  ) {
    return 0;
  }
  const yearsToGoal = nextGoalYear - currentYear;
  if (yearsToGoal >= glide) return 0;
  if (yearsToGoal <= 0) return 1;
  return 1 - yearsToGoal / glide;
};

// Return and volatility for a SIP (or its earmarked pool) at a given glide
// progress.  The glide is modelled as moving a growing share of the money
// into a low-volatility asset that earns targetRate.
const glidedRateAndVol = (
  bucket: Pick<SavingsBucketState, "rate" | "vol" | "targetRate">,
  progress: number,
): { rate: number; vol: number } => {
  if (!(progress > 0) || bucket.targetRate === undefined) {
    return { rate: bucket.rate, vol: bucket.vol };
  }
  const safeVol = Math.min(bucket.vol, DERISKED_VOLATILITY);
  return {
    rate: bucket.rate + (bucket.targetRate - bucket.rate) * progress,
    vol: bucket.vol + (safeVol - bucket.vol) * progress,
  };
};

// One year of end-of-month contributions with monthly compounding at the
// CAGR-consistent monthly rate, then the yearly step-up.  Same formula in
// deterministic (z = 0) and Monte Carlo paths, so MC at zero volatility
// collapses exactly to the deterministic projection.
const advanceSavings = (
  buckets: SavingsBucketState[],
  z: number,
  progressById: Map<number, number>,
  fat: boolean,
): { growth: number; contributions: number } => {
  let growth = 0;
  let contributions = 0;
  for (const b of buckets) {
    const { rate, vol } = glidedRateAndVol(b, progressById.get(b.id) ?? 0);
    const yearly = grossFactor(rate, vol, z, fat);
    const monthly = Math.pow(yearly, 1 / 12);
    // Σ_{j=0}^{11} monthly^j: contribution j months before year end grows j
    // months.
    const annuity =
      Math.abs(monthly - 1) < 1e-12 ? 12 : (yearly - 1) / (monthly - 1);
    const paidIn = b.monthly * 12;
    growth += b.accumulated * (yearly - 1) + b.monthly * (annuity - 12);
    b.accumulated = b.accumulated * yearly + b.monthly * annuity;
    contributions += paidIn;
    b.monthly *= 1 + b.stepUp;
  }
  return { growth, contributions };
};

// Withdraw a one-time expense pro-rata across all accumulation buckets.
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
  const keep = 1 - amount / total;
  for (const b of existing) b.amount *= keep;
  for (const b of savings) b.accumulated *= keep;
  return 0;
};

// ---- Decumulation-phase helpers (operate on RetirementBucketState[]) -----

const sumRetBuckets = (buckets: RetirementBucketState[]): number => {
  let s = 0;
  for (const b of buckets) s += b.amount;
  return s;
};

// Sell `amount` (≤ b.amount) from a bucket, recording the realised gain.
const sellFrom = (
  b: RetirementBucketState,
  amount: number,
  gains: GainsLedger,
) => {
  if (!(amount > 0) || !(b.amount > 0)) return;
  let gain: number;
  if (amount >= b.amount) {
    gain = b.amount - b.basis;
    b.amount = 0;
    b.basis = 0;
  } else {
    const basisSold = b.basis * (amount / b.amount);
    gain = amount - basisSold;
    b.basis -= basisSold;
    b.amount -= amount;
  }
  if (b.tax === "equity") gains.equity += gain;
  else if (b.tax === "slabOnSale") gains.slab += gain;
  // "slabYearly" growth is taxed as it accrues; "none" is untaxed.
};

const buyInto = (b: RetirementBucketState, amount: number) => {
  if (!(amount > 0)) return;
  b.amount += amount;
  b.basis += amount;
};

// Below this the main corpus counts as empty: rounding dust (a few paise
// left by an exactly-sized earmark) must not decide how new money is split.
const EMPTY_CORPUS_RUPEES = 1;
// A shortfall smaller than one paisa is floating-point dust (e.g. a pension
// exactly equal to spending), not money running out.
const MONEY_EPSILON = 0.01;

// Add new money to the main corpus (spare income, or a pool's leftover after
// its last goal): pro-rata to current values, i.e. the current mix; when the
// main corpus is empty, by the user's allocation.
const addToRetBuckets = (
  buckets: RetirementBucketState[],
  amount: number,
  allocationShares: number[],
) => {
  if (!(amount > 0) || buckets.length === 0) return;
  const total = sumRetBuckets(buckets);
  const byMix = total > EMPTY_CORPUS_RUPEES;
  for (let i = 0; i < buckets.length; i++) {
    const share = byMix ? buckets[i].amount / total : allocationShares[i];
    buyInto(buckets[i], amount * share);
  }
};

// Build the decumulation buckets from user-supplied allocations.  If no
// buckets are configured (or every allocation is 0%), falls back to a single
// synthetic bucket with the at-retirement weighted return and volatility.
const allocatePostRetirement = (
  corpusAtRetirement: number,
  weightedReturnAtRetirement: number,
  weightedVolAtRetirement: number,
  postRetirementBuckets: PostRetirementBucket[] | undefined,
  defaultVol: number,
  rankDefaultVol: number,
): {
  buckets: RetirementBucketState[];
  allocation: PostRetirementBucketAllocation[];
} => {
  const corpus = Math.max(0, corpusAtRetirement);
  const aggregated = (allocationPct: number) => ({
    buckets: [
      {
        id: 0,
        name: "Aggregated",
        amount: corpus,
        rate: weightedReturnAtRetirement,
        vol: weightedVolAtRetirement,
        riskRank: weightedVolAtRetirement,
        tax: "none" as TaxTreatment,
        basis: corpus,
      },
    ],
    allocation: [
      {
        id: 0,
        name: "Aggregated",
        allocationPct,
        normalizedPct: 100,
        amount: corpus,
        return: weightedReturnAtRetirement,
      },
    ],
  });
  if (!postRetirementBuckets || postRetirementBuckets.length === 0) {
    return aggregated(100);
  }
  const sanitized = postRetirementBuckets.map((b) => ({
    id: b.id,
    name: b.name,
    rate: finiteOr(b.return, 0),
    vol: resolveVol(b.volatility, defaultVol),
    riskRank: resolveVol(b.volatility, rankDefaultVol),
    tax: resolveTreatment(b.taxTreatment),
    pct: Math.max(0, finiteOr(b.allocationPct, 0)),
  }));
  const totalPct = sanitized.reduce((s, b) => s + b.pct, 0);
  // All allocations zero: fall back to a single aggregate so the user doesn't
  // get a stuck-at-zero corpus that ignores what they accumulated.
  if (totalPct === 0) return aggregated(0);
  const buckets: RetirementBucketState[] = [];
  const allocation: PostRetirementBucketAllocation[] = [];
  for (const b of sanitized) {
    const share = b.pct / totalPct;
    const amount = corpus * share;
    buckets.push({
      id: b.id,
      name: b.name,
      amount,
      rate: b.rate,
      vol: b.vol,
      riskRank: b.riskRank,
      tax: b.tax,
      basis: amount,
    });
    allocation.push({
      id: b.id,
      name: b.name,
      allocationPct: b.pct,
      normalizedPct: share * 100,
      amount,
      return: b.rate,
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

// Box-Muller standard-normal draw.
const standardNormal = (rng: () => number): number => {
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
  lastSimulatedYear: number,
): FutureOneTimeExpense[] =>
  oneTimeExpenses.map((expense) => {
    const yearsFromNow = Math.max(0, Math.round(finiteOr(expense.yearsFromNow, 0)));
    // At or below -100% a "price" would go negative or flip sign.
    const inflationRate = Math.max(-100, finiteOr(expense.inflationRate, 0));
    const currentCost = Math.max(0, finiteOr(expense.currentCost, 0));
    return {
      ...expense,
      yearsFromNow,
      inflationRate,
      currentCost,
      futureValue:
        currentCost * Math.pow(1 + inflationRate / 100, yearsFromNow),
      ageWhenDue: currentAge + yearsFromNow,
      withinHorizon: yearsFromNow <= lastSimulatedYear,
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
  // Default annualised stdev of returns, in percent (e.g., 12 = 12%), for
  // buckets that have no volatility of their own.  Ignored when rng is
  // undefined.
  portfolioVolatility?: number;
  // Annualised stdev of inflation, in percent.  Ignored when rng is undefined.
  inflationVolatility?: number;
  // 0..0.95, see MonteCarloParams.  Ignored when rng is undefined.
  inflationPersistence?: number;
  // Fat-tailed market shocks.  Ignored when rng is undefined.
  fatTails?: boolean;
}

export interface SimulationResult extends SanitizedAges {
  steps: YearlyProjection[];
  // Corpus today after any "due now" (year-0) one-time expenses.
  startingCorpus: number;
  annualExpenses: number;
  // Living costs and income per year at the start of retirement.
  annualLivingAtRetirement: number;
  annualIncomeAtRetirement: number;
  // Total at-retirement wealth: existing buckets + ALL SIPs (incl earmarked).
  corpusAtRetirement: number;
  // Slice that flows into the post-retirement decumulation pool.  Equals
  // corpusAtRetirement minus earmarkedAtRetirement.
  mainCorpusAtRetirement: number;
  // Sum of earmarked pools at the retirement transition.
  earmarkedAtRetirement: number;
  // Value-weighted return of everything accumulated at retirement.
  weightedReturnAtRetirement: number;
  // Blended return of the decumulation buckets at retirement.
  postRetirementReturn: number;
  yearsAfterRetirement: number;
  survivalAge: number;
  depleted: boolean;
  incomeCoverageAtDepletion?: number;
  finalCorpus: number;
  yearsToRetirement: number;
  futureOneTimeExpenses: FutureOneTimeExpense[];
  // Cumulative realised inflation factor from today to retirement.  In the
  // deterministic case this is (1 + inflation)^yearsToRetirement.
  cumulativeInflationToRetirement: number;
  // The per-bucket post-retirement allocation snapshotted at the moment of
  // retirement.
  postRetirementAllocation: PostRetirementBucketAllocation[];
  // Per-expense funding breakdown — see ExpenseFundingSnapshot.
  expenseFundings: ExpenseFundingSnapshot[];
}

export function simulateRetirementPath(
  params: RetirementCalculationParams,
  opts: SimulationOptions = {},
): SimulationResult {
  // ---- Sanitize inputs ---------------------------------------------------
  const { currentAge, retirementAge, targetAge, horizonAge } =
    sanitizeAges(params);
  const inflation = finiteOr(params.inflation, 0);
  const expectedInflation = Math.max(INFLATION_FLOOR, inflation / 100);
  const expenseInput = Math.max(0, finiteOr(params.monthlyExpenses, 0));
  const annualExpenses =
    params.expenseType === "yearly" ? expenseInput : expenseInput * 12;
  const yearsToRetirement = retirementAge - currentAge;
  const tax = resolveTax(params.tax);
  const strategy = resolveStrategy(params.withdrawalStrategy);
  const cashBufferYears = Math.max(
    0,
    finiteOr(params.cashBufferYears, DEFAULT_CASH_BUFFER_YEARS),
  );

  // Spending phases, sorted; the factor for an age is the latest phase that
  // has started (100% before the first one).
  const phases = (params.spendingPhases ?? [])
    .map((p) => ({
      fromAge: finiteOr(p.fromAge, Infinity),
      factor: Math.max(0, finiteOr(p.percentOfBase, 100)) / 100,
    }))
    .filter((p) => Number.isFinite(p.fromAge))
    .sort((a, b) => a.fromAge - b.fromAge);
  const phaseFactor = (age: number): number => {
    let f = 1;
    for (const p of phases) if (p.fromAge <= age) f = p.factor;
    return f;
  };

  // Healthcare: today's monthly cost growing at its own inflation.  In
  // Monte Carlo it rides on realised general inflation plus a fixed premium.
  const healthMonthlyToday = Math.max(0, finiteOr(params.healthcare?.monthlyCost, 0));
  const healthInflation = Math.max(-0.99, finiteOr(params.healthcare?.inflation, 0) / 100);
  const healthStartAge = finiteOr(params.healthcare?.startAge, retirementAge);
  const healthPremium = (1 + healthInflation) / (1 + expectedInflation);
  const healthPremiumMonthly = Math.pow(healthPremium, 1 / 12);

  // Paid while startAge <= age < endAge.  An end age at or before the start
  // age means the income is never paid (the UI flags it); only a blank end
  // age means "for life".
  const incomeStreams = (params.incomeStreams ?? []).map((s) => {
    const startAge = finiteOr(s.startAge, retirementAge);
    return {
      monthly:
        Math.max(0, finiteOr(s.monthlyAmount, 0)) *
        (s.taxable ? 1 - tax.incomeTaxRate / 100 : 1),
      startAge,
      endAge: finiteOr(s.endAge, Infinity),
      growth: s.growth === "fixed" || s.growth === "custom" ? s.growth : "inflation",
      growthRate: Math.max(-0.99, finiteOr(s.growthRate, 0) / 100),
    };
  });

  // Monthly living cost and income at the START of the year in which you are
  // `age`, `yearsFromNow` years from today, when the price level is
  // `priceIndex`.  Shared by the year loop and the cash-buffer refill (which
  // sizes next year's need).
  const incomeAmount = (s: (typeof incomeStreams)[number], age: number, priceIndex: number) =>
    s.growth === "inflation"
      ? s.monthly * priceIndex
      : s.growth === "fixed"
        ? s.monthly
        : s.monthly * Math.pow(1 + s.growthRate, age - s.startAge);
  const incomeActive = (s: (typeof incomeStreams)[number], age: number) =>
    s.startAge <= age && age < s.endAge;
  const monthlyFlows = (age: number, yearsFromNow: number, priceIndex: number) => {
    let income = 0;
    for (const s of incomeStreams) if (incomeActive(s, age)) income += incomeAmount(s, age, priceIndex);
    return {
      base: (annualExpenses / 12) * priceIndex * phaseFactor(age),
      health:
        age >= healthStartAge
          ? healthMonthlyToday * priceIndex * Math.pow(healthPremium, yearsFromNow)
          : 0,
      income,
    };
  };

  // The simulation runs to horizonAge (a few years past the user's target) so
  // depletion just *after* targetAge is still detected.
  const maxYearsAfterRetirement = Math.max(1, horizonAge - retirementAge);
  const lastSimulatedYear = yearsToRetirement + maxYearsAfterRetirement;

  const futureOneTimeExpenses = buildFutureOneTimeExpenses(
    params.oneTimeExpenses,
    currentAge,
    lastSimulatedYear,
  );
  const oneTimeByYear = indexByYear(futureOneTimeExpenses);

  // For each SIP, the *sorted* list of years at which one of its linked
  // in-horizon expenses fires.  Used by the glide-path logic to find the
  // next pending goal each year.
  const linkedGoalsBySipId = new Map<number, number[]>();
  for (const e of futureOneTimeExpenses) {
    if (e.linkedSavingsBucketId === undefined || !e.withinHorizon) continue;
    const list = linkedGoalsBySipId.get(e.linkedSavingsBucketId) ?? [];
    list.push(e.yearsFromNow);
    linkedGoalsBySipId.set(e.linkedSavingsBucketId, list);
  }
  for (const list of linkedGoalsBySipId.values()) {
    list.sort((a, b) => a - b);
  }
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
  const defaultVol = rng ? Math.max(0, finiteOr(opts.portfolioVolatility, 0)) : 0;
  const sigmaI = rng
    ? Math.max(0, finiteOr(opts.inflationVolatility, 0)) / 100
    : 0;
  const persistence = rng
    ? clampNum(finiteOr(opts.inflationPersistence, 0), 0, MAX_INFLATION_PERSISTENCE)
    : 0;
  const fatTails = Boolean(rng && opts.fatTails);
  const drawMarket = (): number => {
    if (!rng) return 0;
    const z = standardNormal(rng);
    if (!fatTails) return z;
    return z * (rng() < CRISIS_PROBABILITY ? CRISIS_SCALE : CALM_SCALE);
  };
  // AR(1) on the deviation from expected inflation, scaled so each year's
  // spread is sigmaI.  It starts from a random point of its long-run range,
  // so the first years are as uncertain as later ones.
  let inflationDeviation = sigmaI > 0 && rng ? sigmaI * standardNormal(rng) : 0;
  const innovationScale = Math.sqrt(1 - persistence * persistence);
  const drawInflation = (): number => {
    if (sigmaI > 0 && rng) {
      inflationDeviation =
        persistence * inflationDeviation +
        sigmaI * innovationScale * standardNormal(rng);
    }
    return Math.max(INFLATION_FLOOR, inflation / 100 + inflationDeviation);
  };

  // ---- Mutable corpus state + output buffers ---------------------------
  const existing = cloneBuckets(params.investmentBuckets, defaultVol);
  const savings = cloneSavings(params.monthlySavingsBuckets, defaultVol);
  const steps: YearlyProjection[] = [];
  const expenseFundings: ExpenseFundingSnapshot[] = [];
  let cumulativeInflation = 1;

  // Apply any "due now" expenses (yearsFromNow == 0) before the year-1 step.
  const yr0 = oneTimeByYear.get(0);
  if (yr0) {
    for (const e of yr0) {
      expenseFundings.push(applyAccumulationExpense(existing, savings, e));
    }
  }
  const startingCorpus = sumExisting(existing) + sumSavings(savings);

  // ---- Accumulation phase ------------------------------------------------
  const progress = new Map<number, number>();
  for (let year = 1; year <= yearsToRetirement; year++) {
    const z = drawMarket();
    const realisedInflation = drawInflation();

    let growth = growExisting(existing, z, fatTails);
    for (const sb of savings) {
      progress.set(sb.id, glideProgress(sb, year, nextGoalYearForSip(sb.id, year)));
    }
    const saved = advanceSavings(savings, z, progress, fatTails);
    growth += saved.growth;

    const oneTimeForYear = oneTimeByYear.get(year) ?? [];
    let oneTimeAmount = 0;
    for (const e of oneTimeForYear) {
      const f = applyAccumulationExpense(existing, savings, e);
      expenseFundings.push(f);
      oneTimeAmount += f.futureValue;
    }

    cumulativeInflation *= 1 + realisedInflation;
    steps.push({
      year,
      age: currentAge + year,
      isRetired: false,
      corpus: sumExisting(existing) + sumSavings(savings),
      regularExpenses: 0,
      oneTimeExpenses: oneTimeAmount,
      oneTimeItems: oneTimeForYear,
      contributions: saved.contributions,
      growth,
      incomeReceived: 0,
      healthcareExpenses: 0,
      taxPaid: 0,
      livingCostsFromEarmarked: 0,
      inflationIndex: cumulativeInflation,
    });
  }
  const cumulativeInflationToRetirement = cumulativeInflation;

  // ---- Earmarked pools ---------------------------------------------------
  // A SIP linked to post-retirement goals inside the horizon keeps aside only
  // what those goals need: each goal's cost discounted back to retirement
  // along the SIP's expected (deterministic, glided) rate path.  The rest of
  // the SIP joins the main corpus.  Pre-retirement linked goals already
  // drained their SIP during accumulation.
  interface EarmarkedPool {
    sip: SavingsBucketState;
    amount: number;
    pendingExpenseCount: number;
    // This year's monthly growth factor (set at the start of each year).
    monthlyFactor: number;
  }
  const goalsBySip = new Map<number, FutureOneTimeExpense[]>();
  for (const e of futureOneTimeExpenses) {
    if (
      e.linkedSavingsBucketId !== undefined &&
      e.yearsFromNow > yearsToRetirement &&
      e.withinHorizon &&
      savings.some((s) => s.id === e.linkedSavingsBucketId)
    ) {
      const list = goalsBySip.get(e.linkedSavingsBucketId) ?? [];
      list.push(e);
      goalsBySip.set(e.linkedSavingsBucketId, list);
    }
  }
  const earmarkedPools = new Map<number, EarmarkedPool>();
  // Non-earmarked part of each earmarked SIP: joins the main corpus.
  const sipExcess: { amount: number; rate: number; vol: number }[] = [];
  for (const sb of savings) {
    const goals = goalsBySip.get(sb.id);
    if (!goals) continue;
    goals.sort((a, b) => a.yearsFromNow - b.yearsFromNow);
    let factor = 1;
    let required = 0;
    let gi = 0;
    const lastGoalYear = goals[goals.length - 1].yearsFromNow;
    for (let y = yearsToRetirement + 1; y <= lastGoalYear; y++) {
      const { rate } = glidedRateAndVol(
        sb,
        glideProgress(sb, y, nextGoalYearForSip(sb.id, y)),
      );
      factor *= 1 + Math.max(-0.99, rate / 100);
      while (gi < goals.length && goals[gi].yearsFromNow === y) {
        required += Math.max(0, goals[gi].futureValue) / factor;
        gi++;
      }
    }
    const poolAmount = Math.min(sb.accumulated, required);
    earmarkedPools.set(sb.id, {
      sip: sb,
      amount: poolAmount,
      pendingExpenseCount: goals.length,
      monthlyFactor: 1,
    });
    sipExcess.push({ amount: sb.accumulated - poolAmount, rate: sb.rate, vol: sb.vol });
  }

  // ---- Lock in retirement-time state -----------------------------------
  let mainCorpusAtRetirement = 0;
  let rateSum = 0;
  let volSum = 0;
  const addMain = (amount: number, rate: number, vol: number) => {
    mainCorpusAtRetirement += amount;
    rateSum += amount * rate;
    volSum += amount * vol;
  };
  for (const b of existing) addMain(b.amount, b.rate, b.vol);
  for (const sb of savings) {
    if (!earmarkedPools.has(sb.id)) addMain(sb.accumulated, sb.rate, sb.vol);
  }
  for (const x of sipExcess) addMain(x.amount, x.rate, x.vol);
  let earmarkedAtRetirement = 0;
  for (const pool of earmarkedPools.values()) {
    earmarkedAtRetirement += pool.amount;
    rateSum += pool.amount * pool.sip.rate;
    volSum += pool.amount * pool.sip.vol;
  }
  const corpusAtRetirement = mainCorpusAtRetirement + earmarkedAtRetirement;
  // The whole pre-retirement mix (pools included, since their leftovers join
  // the main corpus later).  Used when no allocation is configured.
  const weightedReturnAtRetirement =
    corpusAtRetirement > 0 ? rateSum / corpusAtRetirement : 0;
  const weightedVolAtRetirement =
    corpusAtRetirement > 0 ? volSum / corpusAtRetirement : defaultVol;

  // ---- Build per-bucket decumulation state ------------------------------
  const { buckets: retBuckets, allocation: postRetirementAllocation } =
    allocatePostRetirement(
      mainCorpusAtRetirement,
      weightedReturnAtRetirement,
      weightedVolAtRetirement,
      params.postRetirementBuckets,
      defaultVol,
      Math.max(0, finiteOr(params.defaultVolatility, DEFAULT_VOLATILITY)),
    );
  const postRetirementReturn = postRetirementAllocation.reduce(
    (s, a) => s + (a.normalizedPct / 100) * a.return,
    0,
  );
  // Same order as retBuckets (both built in one pass).
  const allocationShares = postRetirementAllocation.map(
    (a) => a.normalizedPct / 100,
  );
  // "buckets" strategy: spend from the safest bucket first; refill it from
  // the riskiest bucket that didn't lose money this year.
  const bySafety = retBuckets
    .map((b, i) => ({ i, rank: b.riskRank, rate: b.rate }))
    .sort((a, b) => a.rank - b.rank || a.rate - b.rate)
    .map((x) => x.i);
  const refillSources = bySafety.slice(1).reverse();

  let gains: GainsLedger = { equity: 0, slab: 0 };
  // Withdraw from the main corpus following the strategy; returns the amount
  // actually withdrawn (≤ amount).  Realised gains go to the current ledger.
  const withdrawMain = (amount: number): number => {
    const total = sumRetBuckets(retBuckets);
    if (!(amount > 0) || total <= 0) return 0;
    const take = Math.min(amount, total);
    if (strategy === "buckets") {
      let left = take;
      for (const i of bySafety) {
        if (left <= 0) break;
        const t = Math.min(left, retBuckets[i].amount);
        sellFrom(retBuckets[i], t, gains);
        left -= t;
      }
      return take - Math.max(0, left);
    }
    const ratio = take / total;
    for (const b of retBuckets) sellFrom(b, b.amount * ratio, gains);
    return take;
  };
  const poolTotal = (): number => {
    let s = 0;
    for (const p of earmarkedPools.values()) s += p.amount;
    return s;
  };
  // Pro-rata draw from the earmarked pools (untaxed: pools use the SIP's
  // after-tax return).  Caller checks there is enough.
  const drawPools = (amount: number, total: number) => {
    const keep = total > 0 ? Math.max(0, 1 - amount / total) : 0;
    for (const p of earmarkedPools.values()) p.amount *= keep;
  };

  let depleted = false;
  let depletionYear = Infinity;
  let yearsAfterRetirement = maxYearsAfterRetirement;
  let incomeCoverageAtDepletion: number | undefined;
  let lastCorpus = corpusAtRetirement;
  let annualLivingAtRetirement = 0;
  let annualIncomeAtRetirement = 0;
  const monthlyFactors = new Array<number>(retBuckets.length).fill(1);
  const yearlyGross = new Array<number>(retBuckets.length).fill(1);
  const accruedGrowth = new Array<number>(retBuckets.length).fill(0);
  const incomeAmounts: number[] = [];
  const incomeFactors: number[] = [];

  for (let k = 1; k <= maxYearsAfterRetirement; k++) {
    const year = yearsToRetirement + k;
    const ageAtStart = retirementAge + k - 1;
    const z = drawMarket();
    const realisedInflation = drawInflation();
    const monthlyInflation = Math.pow(1 + realisedInflation, 1 / 12);

    for (let i = 0; i < retBuckets.length; i++) {
      yearlyGross[i] = grossFactor(retBuckets[i].rate, retBuckets[i].vol, z, fatTails);
      monthlyFactors[i] = Math.pow(yearlyGross[i], 1 / 12);
      accruedGrowth[i] = 0;
    }
    const pools = [...earmarkedPools.values()];
    for (const pool of pools) {
      const { rate, vol } = glidedRateAndVol(
        pool.sip,
        glideProgress(pool.sip, year, nextGoalYearForSip(pool.sip.id, year)),
      );
      pool.monthlyFactor = Math.pow(grossFactor(rate, vol, z, fatTails), 1 / 12);
    }

    // Living costs and income for the first month of this year
    // (cumulativeInflation is the price level at the start of the year);
    // each then grows month by month at its own rate.
    const start = monthlyFlows(ageAtStart, year - 1, cumulativeInflation);
    let baseMonthly = start.base;
    let healthMonthly = start.health;
    const healthMonthlyFactor = monthlyInflation * healthPremiumMonthly;
    incomeAmounts.length = 0;
    incomeFactors.length = 0;
    for (const s of incomeStreams) {
      if (!incomeActive(s, ageAtStart)) continue;
      incomeAmounts.push(incomeAmount(s, ageAtStart, cumulativeInflation));
      incomeFactors.push(
        s.growth === "inflation"
          ? monthlyInflation
          : s.growth === "fixed"
            ? 1
            : Math.pow(1 + s.growthRate, 1 / 12),
      );
    }
    if (k === 1) {
      annualLivingAtRetirement = 12 * (start.base + start.health);
      annualIncomeAtRetirement = 12 * start.income;
    }

    let livingPaid = 0;
    let healthPaid = 0;
    let incomeReceived = 0;
    let livingFromEarmarked = 0;
    // Investment growth actually earned this year, tracked per bucket (not
    // backed out of the corpus change, so the yearly ledger is a real
    // conservation check).
    let growth = 0;
    for (let m = 0; m < 12; m++) {
      const living = baseMonthly + healthMonthly;
      let income = 0;
      for (const a of incomeAmounts) income += a;
      incomeReceived += income;
      const need = living - income;
      if (need <= 0) {
        addToRetBuckets(retBuckets, -need, allocationShares);
        livingPaid += living;
        healthPaid += healthMonthly;
      } else {
        const fromMain = withdrawMain(need);
        const short = need - fromMain;
        // Unpaid rounding dust (< 1 paisa); kept out of livingPaid so the
        // yearly ledger stays exact.
        let dust = 0;
        if (short > 0) {
          // The main corpus can't cover this month.  Living costs come
          // before a future goal, so dip into the earmarked pools before
          // declaring the money gone; the goal then shows the shortfall.
          const pt = poolTotal();
          if (pt > 0 && short <= pt) {
            drawPools(short, pt);
            livingFromEarmarked += short;
          } else if (short - pt <= MONEY_EPSILON) {
            for (const p of earmarkedPools.values()) p.amount = 0;
            livingFromEarmarked += pt;
            dust = short - pt;
          } else {
            // Depletion = living costs can no longer be funded from
            // anything.  A shortfall on a one-time goal alone is not.
            for (const p of earmarkedPools.values()) p.amount = 0;
            livingFromEarmarked += pt;
            const covered = income + fromMain + pt;
            livingPaid += covered;
            healthPaid += healthMonthly * (covered / living);
            depleted = true;
            depletionYear = year;
            // The money ran out part-way through this month's withdrawal
            // (income keeps paying its share, but the savings are gone).
            yearsAfterRetirement = k - 1 + (m + (fromMain + pt) / need) / 12;
            incomeCoverageAtDepletion = Math.min(1, income / living);
            break;
          }
        }
        livingPaid += living - dust;
        healthPaid += healthMonthly * ((living - dust) / living);
      }
      for (let i = 0; i < retBuckets.length; i++) {
        const b = retBuckets[i];
        const before = b.amount;
        b.amount *= monthlyFactors[i];
        const g = b.amount - before;
        growth += g;
        accruedGrowth[i] += g;
      }
      for (const pool of pools) {
        const before = pool.amount;
        pool.amount *= pool.monthlyFactor;
        growth += pool.amount - before;
      }
      baseMonthly *= monthlyInflation;
      healthMonthly *= healthMonthlyFactor;
      for (let s = 0; s < incomeAmounts.length; s++) {
        incomeAmounts[s] *= incomeFactors[s];
      }
    }

    // ---- Year end: goals, pool leftovers, strategy, tax -----------------
    const oneTimeForYear = depleted ? [] : (oneTimeByYear.get(year) ?? []);
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
          pool.pendingExpenseCount = Math.max(0, pool.pendingExpenseCount - 1);
          // Leftover after the LAST linked goal rolls into the main corpus
          // below.  Ignore rounding dust from an exactly-sized pool.
          if (pool.pendingExpenseCount === 0 && pool.amount > 1) {
            surplusRolledOver = pool.amount;
          }
        }
      }

      const drainedFromMain = remaining > 0 ? withdrawMain(remaining) : 0;
      const shortfall = Math.max(0, remaining - drainedFromMain);

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

    for (const [id, pool] of [...earmarkedPools]) {
      if (pool.pendingExpenseCount <= 0) {
        addToRetBuckets(retBuckets, pool.amount, allocationShares);
        earmarkedPools.delete(id);
      }
    }

    let taxPaid = 0;
    if (!depleted) {
      if (strategy === "rebalance") {
        const total = sumRetBuckets(retBuckets);
        const deficits: number[] = [];
        for (let i = 0; i < retBuckets.length; i++) {
          const excess = retBuckets[i].amount - total * allocationShares[i];
          if (excess > 0) sellFrom(retBuckets[i], excess, gains);
          deficits.push(Math.max(0, -excess));
        }
        for (let i = 0; i < retBuckets.length; i++) buyInto(retBuckets[i], deficits[i]);
      } else if (strategy === "buckets" && retBuckets.length > 1) {
        // Refill the safe bucket to `cashBufferYears` of next year's net
        // spending (next year's spending phase, healthcare and income, at
        // next year's prices), selling only from buckets that didn't lose
        // money this year.
        const next = monthlyFlows(ageAtStart + 1, year, cumulativeInflation * (1 + realisedInflation));
        const safe = retBuckets[bySafety[0]];
        let deficit =
          cashBufferYears * 12 * Math.max(0, next.base + next.health - next.income) -
          safe.amount;
        for (const i of refillSources) {
          if (deficit <= 0) break;
          if (yearlyGross[i] < 1) continue;
          const t = Math.min(deficit, retBuckets[i].amount);
          sellFrom(retBuckets[i], t, gains);
          buyInto(safe, t);
          deficit -= t;
        }
      }

      // Interest-type buckets are taxed on the year's growth, withdrawn or
      // not (sales from them record no gain, so nothing is taxed twice).
      for (let i = 0; i < retBuckets.length; i++) {
        if (retBuckets[i].tax === "slabYearly") gains.slab += accruedGrowth[i];
      }
      const taxDue =
        (Math.max(0, gains.equity - tax.ltcgExemption) * tax.ltcgRate) / 100 +
        (Math.max(0, gains.slab) * tax.incomeTaxRate) / 100;
      // Gains realised while paying this tax count toward next year.
      gains = { equity: 0, slab: 0 };
      if (taxDue > 0) {
        taxPaid = withdrawMain(taxDue);
        const unpaid = taxDue - taxPaid;
        if (unpaid > 0) {
          const pt = poolTotal();
          if (pt > 0 && unpaid <= pt) {
            drawPools(unpaid, pt);
            taxPaid += unpaid;
          } else if (unpaid - pt <= MONEY_EPSILON) {
            // Sub-paisa rounding dust left unpaid.
            for (const p of earmarkedPools.values()) p.amount = 0;
            taxPaid += pt;
          } else {
            for (const p of earmarkedPools.values()) p.amount = 0;
            taxPaid += pt;
            depleted = true;
            depletionYear = year + 1;
            yearsAfterRetirement = k;
            const living = baseMonthly + healthMonthly;
            let income = 0;
            for (const a of incomeAmounts) income += a;
            incomeCoverageAtDepletion = living > 0 ? Math.min(1, income / living) : 1;
          }
        }
      }
    }

    cumulativeInflation *= 1 + realisedInflation;
    const corpusEnd = sumRetBuckets(retBuckets) + poolTotal();
    lastCorpus = corpusEnd;

    steps.push({
      year,
      age: currentAge + year,
      isRetired: true,
      corpus: corpusEnd,
      regularExpenses: livingPaid,
      livingCostsFromEarmarked: livingFromEarmarked,
      oneTimeExpenses: totalOneTimeAmount,
      oneTimeItems: oneTimeForYear,
      contributions: 0,
      growth,
      incomeReceived,
      healthcareExpenses: healthPaid,
      taxPaid,
      inflationIndex: cumulativeInflation,
    });

    if (depleted) break;
  }

  // Goals that came due after the money ran out were never paid.  Report
  // them instead of letting them silently vanish from the breakdown.
  if (depleted) {
    const unpaid = futureOneTimeExpenses
      .filter((e) => e.yearsFromNow >= depletionYear && e.withinHorizon)
      .sort((a, b) => a.yearsFromNow - b.yearsFromNow);
    for (const e of unpaid) {
      expenseFundings.push({
        expenseId: e.id,
        expenseName: e.name,
        yearsFromNow: e.yearsFromNow,
        ageWhenDue: e.ageWhenDue,
        futureValue: e.futureValue,
        drainedFromLinked: 0,
        drainedFromMain: 0,
        shortfall: e.futureValue,
        afterDepletion: true,
      });
    }
  }

  return {
    currentAge,
    retirementAge,
    targetAge,
    horizonAge,
    steps,
    startingCorpus,
    annualExpenses,
    annualLivingAtRetirement,
    annualIncomeAtRetirement,
    corpusAtRetirement,
    mainCorpusAtRetirement,
    earmarkedAtRetirement,
    weightedReturnAtRetirement,
    postRetirementReturn,
    yearsAfterRetirement,
    survivalAge: retirementAge + yearsAfterRetirement,
    depleted,
    incomeCoverageAtDepletion,
    finalCorpus: Math.max(0, lastCorpus),
    yearsToRetirement,
    futureOneTimeExpenses,
    cumulativeInflationToRetirement,
    postRetirementAllocation,
    expenseFundings,
  };
}

// ---------------------------------------------------------------------------
// Public deterministic API
// ---------------------------------------------------------------------------

// Fisher real return, in percent: (1 + nominal) / (1 + inflation) - 1.
export const realReturnPct = (nominalPct: number, inflationPct: number): number =>
  ((1 + nominalPct / 100) / (1 + inflationPct / 100) - 1) * 100;

export function calculateRetirement(
  params: RetirementCalculationParams,
): RetirementCalculationsResult {
  const sim = simulateRetirementPath(params);
  // Same floor the simulation applies.
  const inflation = Math.max(INFLATION_FLOOR * 100, finiteOr(params.inflation, 0));
  const netNeed = Math.max(0, sim.annualLivingAtRetirement - sim.annualIncomeAtRetirement);

  return {
    totalCorpus: sim.corpusAtRetirement,
    corpusAtRetirement: sim.corpusAtRetirement,
    mainCorpusAtRetirement: sim.mainCorpusAtRetirement,
    earmarkedAtRetirement: sim.earmarkedAtRetirement,
    inflationIndexAtRetirement: sim.cumulativeInflationToRetirement,
    weightedReturn: sim.weightedReturnAtRetirement,
    realReturn: realReturnPct(sim.weightedReturnAtRetirement, inflation),
    postRetirementReturn: sim.postRetirementReturn,
    postRetirementRealReturn: realReturnPct(sim.postRetirementReturn, inflation),
    initialWithdrawalRate:
      sim.mainCorpusAtRetirement > 0
        ? netNeed / sim.mainCorpusAtRetirement
        : netNeed > 0
          ? Infinity
          : 0,
    annualIncomeAtRetirement: sim.annualIncomeAtRetirement,
    incomeCoverageAtDepletion: sim.incomeCoverageAtDepletion,
    currentAge: sim.currentAge,
    retirementAge: sim.retirementAge,
    targetAge: sim.targetAge,
    horizonAge: sim.horizonAge,
    startingCorpus: sim.startingCorpus,
    inflation,
    yearsToRetirement: sim.yearsToRetirement,
    yearsAfterRetirement: sim.yearsAfterRetirement,
    annualExpenses: sim.annualExpenses,
    annualExpensesAtRetirement: sim.annualLivingAtRetirement,
    futureOneTimeExpenses: sim.futureOneTimeExpenses,
    yearlyData: sim.steps,
    survivalAge: sim.survivalAge,
    corpusLastsBeyondHorizon: !sim.depleted,
    lastsToTargetAge: !sim.depleted || sim.survivalAge >= sim.targetAge,
    postRetirementAllocation: sim.postRetirementAllocation,
    expenseFundings: sim.expenseFundings,
  };
}
