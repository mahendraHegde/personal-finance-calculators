export interface InvestmentBucket {
  id: number;
  name: string;
  amount: number;
  // Long-run annualised return (CAGR), in percent, after tax.
  return: number;
  // Annualised standard deviation of yearly returns, in percent.  Only used
  // by the Monte Carlo simulation.  Undefined → the simulation's default
  // volatility.  0 is honoured (e.g. a fixed deposit).
  volatility?: number;
  // Optional glide-path settings — only meaningful for *monthly savings*
  // (SIP) buckets that are linked to a one-time expense.  When both fields
  // are set, the SIP's effective rate transitions linearly from `return`
  // down to `targetRate` over the final `glideYears` years before the
  // earliest pending linked goal.  After the goal fires, if the bucket has
  // a *next* linked goal, the glide tracks that one.  When no linked goal
  // is pending, glide settings are inactive and the SIP grows at `return`.
  targetRate?: number;
  glideYears?: number;
  // Monthly savings only: % by which the monthly amount rises every year
  // (e.g. with salary).  Undefined/0 → flat.
  stepUpPct?: number;
}

// How a post-retirement bucket is taxed when money comes out of it.
// - "none": the return entered is already after tax, or the asset is
//   tax-free (PPF, EPF).  No tax is computed.
// - "equity": long-term capital gains tax on the gain part of every
//   withdrawal, above a yearly exemption (equity funds and shares).
// - "slabOnSale": the gain part of a withdrawal is taxed at your income-tax
//   rate (debt funds bought after April 2023).
// - "slabYearly": the year's growth is taxed at your income-tax rate every
//   year, withdrawn or not (FDs, RDs, bonds, SCSS).
export type TaxTreatment = "none" | "equity" | "slabOnSale" | "slabYearly";

export interface TaxSettings {
  // Marginal income-tax rate in retirement, percent.  Used for slab-taxed
  // buckets and taxable income streams.
  incomeTaxRate: number;
  // Long-term capital gains rate on equity, percent.
  ltcgRate: number;
  // Equity gains exempt from tax each year, in rupees (not inflated).
  ltcgExemption: number;
}

// How living costs are drawn from the post-retirement buckets.
// - "proRata": from every bucket in proportion to its value; the mix drifts.
// - "rebalance": pro-rata, and the buckets are reset to the target
//   allocation at the end of every year.
// - "buckets": spend from the safest bucket (lowest volatility) first; at
//   year end refill it to `cashBufferYears` of spending from the growth
//   buckets, but only from a bucket that did not lose money that year.
export type WithdrawalStrategy = "proRata" | "rebalance" | "buckets";

// Regular income in retirement (pension, annuity, rent, part-time work).
// Only counts from retirement onward; income before retirement is assumed to
// be part of what funds your savings.
export interface IncomeStream {
  id: number;
  name: string;
  // Per month.  For growth "inflation" this is in today's money; otherwise
  // it is the actual amount paid in the first year.
  monthlyAmount: number;
  startAge: number;
  // Paid while age < endAge.  Undefined → for life.  An end age at or
  // before the start age means it is never paid.
  endAge?: number;
  growth: "inflation" | "fixed" | "custom";
  // Yearly growth in percent when growth = "custom".
  growthRate?: number;
  // Taxed at TaxSettings.incomeTaxRate.
  taxable?: boolean;
}

// From `fromAge`, base living costs are `percentOfBase`% of the amount
// entered (e.g. less travel in your 80s).  Healthcare is separate.
export interface SpendingPhase {
  id: number;
  fromAge: number;
  percentOfBase: number;
}

export interface HealthcareCosts {
  // Per month, in today's money.
  monthlyCost: number;
  // Medical inflation, percent a year (usually above general inflation).
  inflation: number;
  // Undefined → from retirement.
  startAge?: number;
}

// Allocation knob for the decumulation phase.  At retirement the corpus is
// split into these buckets according to allocationPct (normalised across all
// buckets so the user doesn't have to land exactly on 100%).  Each bucket
// compounds at its own return through retirement; spending and one-time
// expenses are drawn according to the withdrawal strategy.
export interface PostRetirementBucket {
  id: number;
  name: string;
  allocationPct: number;
  return: number;
  // See InvestmentBucket.volatility.
  volatility?: number;
  // Undefined → "none" (return is after tax).  With any other treatment,
  // `return` is the pre-tax return and tax is computed on withdrawals.
  taxTreatment?: TaxTreatment;
}

export interface OneTimeExpense {
  id: number;
  name: string;
  yearsFromNow: number;
  currentCost: number;
  inflationRate: number;
  // Optional sinking-fund link.  When set, the named monthly-savings bucket
  // is drained first when this expense fires.  Any shortfall falls through
  // to a pro-rata withdrawal across the rest of the corpus.
  //
  // Pre-retirement: the SIP is drained directly during the accumulation
  // year in which the expense fires (the SIP keeps contributing afterwards
  // with whatever remains).
  //
  // Post-retirement: at retirement only what the linked goals need (their
  // cost discounted at the SIP's expected rate) is held aside as an
  // earmarked pool; the rest joins the main corpus.  The pool keeps
  // compounding at the SIP's rate until its goals are paid; any leftover
  // then rolls into the main corpus.  It pays living costs only if the main
  // corpus runs out first.
  linkedSavingsBucketId?: number;
}

export interface FutureOneTimeExpense extends OneTimeExpense {
  futureValue: number;
  ageWhenDue: number;
  // False when the goal falls after the simulated horizon (targetAge +
  // buffer); such goals are left out of the plan.
  withinHorizon: boolean;
}

export interface YearlyProjection {
  year: number;
  // Corpus at the end of the year, in future (nominal) rupees.
  corpus: number;
  // Living costs (base spending + healthcare) actually paid during the year,
  // from income or the corpus (retired years only; in the year the money
  // runs out this is less than was needed).
  // Ledger: corpus = previous + contributions + growth + incomeReceived
  //                  − regularExpenses − one-time paid − taxPaid.
  regularExpenses: number;
  // Part of regularExpenses that had to come out of money earmarked for
  // future goals because the main corpus was already empty.
  livingCostsFromEarmarked: number;
  oneTimeExpenses: number;
  oneTimeItems: FutureOneTimeExpense[];
  age: number;
  isRetired: boolean;
  // Cash actually put in during the year (monthly savings × 12).  Excludes
  // investment growth.
  contributions: number;
  // Investment return earned during the year (can be negative in Monte
  // Carlo paths).
  growth: number;
  // Income received during the year after tax (retired years only).
  incomeReceived: number;
  // Part of regularExpenses that was healthcare.
  healthcareExpenses: number;
  // Tax paid out of the corpus on withdrawals and interest.
  taxPaid: number;
  // Price level at the end of the year relative to today (1 = today).
  // corpus / inflationIndex is the corpus in today's money.
  inflationIndex: number;
}

export interface PostRetirementBucketAllocation {
  id: number;
  name: string;
  allocationPct: number;
  normalizedPct: number;
  amount: number;
  return: number;
}

// Per-expense funding breakdown produced by the simulator.  Tells the user
// how each one-time expense was actually paid for in the projection — what
// came from the linked SIP/earmarked-pool, what came from the general
// corpus, whether there was a shortfall, and (for the last linked expense
// on a pool) whether any surplus rolled into the corpus.
export interface ExpenseFundingSnapshot {
  expenseId: number;
  expenseName: string;
  yearsFromNow: number;
  ageWhenDue: number;
  // Total cost of the expense at the time it fires (inflation-adjusted).
  futureValue: number;
  // Amount drawn from the linked SIP balance (pre-retirement) or the
  // earmarked pool (post-retirement).  Zero when the expense isn't linked.
  drainedFromLinked: number;
  // Amount drawn pro-rata from the rest of the corpus.  Equals
  // (futureValue - drainedFromLinked - shortfall).
  drainedFromMain: number;
  // Amount the corpus could not cover (the whole cost when the money had
  // already run out).  A one-time shortfall does NOT by itself mean the plan
  // ran out; only failing to pay living costs does.
  shortfall: number;
  // The linked SIP's accumulated balance (or the pool's amount) just
  // before this expense was applied.  Undefined when the expense is
  // unlinked or the linked bucket no longer exists.
  linkedBalanceBefore?: number;
  // For the LAST pending linked expense on an earmarked pool (post-
  // retirement only), this is the leftover that rolls into the main
  // corpus.  Undefined otherwise.
  surplusRolledOver?: number;
  // True when the money ran out before this expense came due, so it was
  // never paid (shortfall = futureValue).
  afterDepletion?: boolean;
}

export interface RetirementCalculationsResult {
  totalCorpus: number;
  // Total accumulated wealth at retirement (existing buckets + ALL SIP
  // balances, including earmarked).  This is the headline number.
  corpusAtRetirement: number;
  // The slice of corpusAtRetirement that's actually allocated to the
  // post-retirement decumulation pool.  Equals corpusAtRetirement minus
  // earmarkedAtRetirement.
  mainCorpusAtRetirement: number;
  // Money held aside at retirement for post-retirement linked goals: each
  // goal's cost discounted at its SIP's expected rate.  Each pool keeps
  // compounding at its SIP's rate until its goals are paid; any leftover
  // then rolls into the main corpus.  Pools pay living costs only once the
  // main corpus is empty.
  earmarkedAtRetirement: number;
  // Price level at retirement relative to today.  Divide a retirement-date
  // amount by this to express it in today's money.
  inflationIndexAtRetirement: number;
  // Value-weighted return of the accumulated portfolio at the moment of
  // retirement (before it is reallocated).
  weightedReturn: number;
  // Inflation-adjusted weightedReturn: (1 + nominal) / (1 + inflation) - 1.
  realReturn: number;
  // Blended return of the post-retirement allocation, i.e. the return the
  // corpus actually earns while it is being drawn down.
  postRetirementReturn: number;
  postRetirementRealReturn: number;
  // First-year spending not covered by income / main corpus at retirement.
  initialWithdrawalRate: number;
  // Yearly income at retirement, after tax (rate at the start of retirement).
  annualIncomeAtRetirement: number;
  // When the money runs out: the share of living costs income still covers
  // at that point (0..1).  Undefined when it doesn't run out.
  incomeCoverageAtDepletion?: number;
  currentAge: number;
  retirementAge: number;
  targetAge: number;
  // Last simulated age (targetAge + a buffer).
  horizonAge: number;
  // Inflation the simulation actually used (the input, floored at -5%).
  inflation: number;
  // Corpus today after any one-time expenses due now.
  startingCorpus: number;
  yearsToRetirement: number;
  yearsAfterRetirement: number;
  // Base living costs per year in today's money (as entered).
  annualExpenses: number;
  // Living costs per year at the start of retirement (base × phase +
  // healthcare), in rupees of that date.
  annualExpensesAtRetirement: number;
  futureOneTimeExpenses: FutureOneTimeExpense[];
  yearlyData: YearlyProjection[];
  survivalAge: number;
  // True when regular expenses are funded through the whole simulated
  // horizon (horizonAge).
  corpusLastsBeyondHorizon: boolean;
  // True when the money lasts at least until targetAge.
  lastsToTargetAge: boolean;
  postRetirementAllocation: PostRetirementBucketAllocation[];
  // Per-expense funding breakdown, one entry per one-time expense inside the
  // simulated horizon (withinHorizon), in chronological order.  Lets the UI
  // show whether each goal was fully funded by its linked SIP, partially
  // funded with main-corpus shortfall, unlinked-and-pulled-pro-rata, or not
  // paid because the money had run out.
  expenseFundings: ExpenseFundingSnapshot[];
}

export interface RetirementCalculationParams {
  currentAge: number;
  retirementAge: number;
  inflation: number;
  monthlyExpenses: number;
  expenseType: "monthly" | "yearly";
  investmentBuckets: InvestmentBucket[];
  monthlySavingsBuckets: InvestmentBucket[];
  oneTimeExpenses: OneTimeExpense[];
  targetAge?: number;
  // Post-retirement allocation.  Empty/undefined → fall back to the legacy
  // single-aggregate model (corpus grows at the value-weighted return locked
  // in at retirement).  When present, decumulation uses per-bucket
  // compounding.
  postRetirementBuckets?: PostRetirementBucket[];
  // Volatility (%) for buckets left blank.  Only used to rank buckets from
  // safest to riskiest for the "buckets" strategy, so the expected path and
  // the Monte Carlo rank them the same way.  Defaults to 12.
  defaultVolatility?: number;
  incomeStreams?: IncomeStream[];
  spendingPhases?: SpendingPhase[];
  healthcare?: HealthcareCosts;
  tax?: TaxSettings;
  withdrawalStrategy?: WithdrawalStrategy;
  // "buckets" strategy: years of spending to keep in the safest bucket.
  cashBufferYears?: number;
}

export interface MonteCarloParams extends RetirementCalculationParams {
  // Default volatility (% std dev) for any bucket that has no volatility of
  // its own.
  portfolioVolatility: number;
  inflationVolatility: number;
  // 0..0.95: how much of a year's inflation surprise carries into the next
  // year (AR(1)).  0 → independent years.
  inflationPersistence?: number;
  // Occasional crisis years: market shocks drawn from a fat-tailed mixture
  // with the same volatility.
  fatTails?: boolean;
  iterations: number;
  targetAge: number;
  seed?: number;
}

export interface MonteCarloPercentilePoint {
  age: number;
  year: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  mean: number;
}

export interface MonteCarloResult {
  iterations: number;
  // Share of paths whose regular expenses stay funded until targetAge.
  successRate: number;
  // Corpus percentiles in future (nominal) rupees.
  percentiles: MonteCarloPercentilePoint[];
  // Corpus percentiles in today's money (each path deflated by its own
  // realised inflation).
  realPercentiles: MonteCarloPercentilePoint[];
  depletionAges: number[];
  medianDepletionAge: number;
  // Age by which the worst 10% of paths have run out (targetAge if fewer
  // than 10% fail).
  p10DepletionAge: number;
  medianFinalCorpus: number;
  p10FinalCorpus: number;
  p90FinalCorpus: number;
  realMedianFinalCorpus: number;
  realP10FinalCorpus: number;
  realP90FinalCorpus: number;
  targetAge: number;
}
