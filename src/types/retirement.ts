export interface InvestmentBucket {
  id: number;
  name: string;
  amount: number;
  return: number;
  // Optional glide-path settings — only meaningful for *monthly savings*
  // (SIP) buckets that are linked to a one-time expense.  When both fields
  // are set, the SIP's effective rate transitions linearly from `return`
  // down to `targetRate` over the final `glideYears` years before the
  // earliest pending linked goal.  After the goal fires, if the bucket has
  // a *next* linked goal, the glide tracks that one.  When no linked goal
  // is pending, glide settings are inactive and the SIP grows at `return`.
  targetRate?: number;
  glideYears?: number;
}

// Allocation knob for the decumulation phase.  At retirement the corpus is
// rebalanced into these buckets according to allocationPct (normalised across
// all buckets so the user doesn't have to land exactly on 100%).  Each
// bucket compounds at its own return through retirement, and regular/one-time
// expenses are pulled pro-rata across all of them.
export interface PostRetirementBucket {
  id: number;
  name: string;
  allocationPct: number;
  return: number;
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
  // Post-retirement: the SIP's at-retirement balance is held aside as an
  // earmarked pool that continues to compound at the SIP's rate (no
  // contributions — those stop at retirement) until the linked expense
  // fires; any leftover then rolls back into the main corpus.
  linkedSavingsBucketId?: number;
}

export interface FutureOneTimeExpense extends OneTimeExpense {
  futureValue: number;
  ageWhenDue: number;
}

export interface YearlyProjection {
  year: number;
  corpus: number;
  regularExpenses: number;
  oneTimeExpenses: number;
  oneTimeItems: FutureOneTimeExpense[];
  age: number;
  isRetired: boolean;
  contributions: number;
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
  // Amount the corpus could not cover.  Almost always zero unless the
  // user is severely under-saved; one-time shortfalls do NOT trigger
  // depletion (only regular-expense shortfalls do).
  shortfall: number;
  // The linked SIP's accumulated balance (or the pool's amount) just
  // before this expense was applied.  Undefined when the expense is
  // unlinked or the linked bucket no longer exists.
  linkedBalanceBefore?: number;
  // For the LAST pending linked expense on an earmarked pool (post-
  // retirement only), this is the leftover that rolls into the main
  // corpus.  Undefined otherwise.
  surplusRolledOver?: number;
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
  // Sum of earmarked SIP balances held aside for post-retirement linked
  // one-time expenses.  Each pool continues to compound at its SIP's rate
  // until the linked expense fires; any leftover then rolls into the main
  // corpus.
  earmarkedAtRetirement: number;
  weightedReturn: number;
  realReturn: number;
  yearsToRetirement: number;
  yearsAfterRetirement: number;
  annualExpenses: number;
  annualExpensesAtRetirement: number;
  futureOneTimeExpenses: FutureOneTimeExpense[];
  yearlyData: YearlyProjection[];
  survivalAge: number;
  corpusLastsBeyondHorizon: boolean;
  postRetirementAllocation: PostRetirementBucketAllocation[];
  // Per-expense funding breakdown, one entry per one-time expense in
  // chronological order.  Lets the UI show whether each goal was fully
  // funded by its linked SIP, partially funded with main-corpus shortfall,
  // or unlinked-and-pulled-pro-rata.
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
}

export interface MonteCarloParams extends RetirementCalculationParams {
  portfolioVolatility: number;
  inflationVolatility: number;
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
  successRate: number;
  percentiles: MonteCarloPercentilePoint[];
  depletionAges: number[];
  medianDepletionAge: number;
  medianFinalCorpus: number;
  p10FinalCorpus: number;
  p90FinalCorpus: number;
  targetAge: number;
}
