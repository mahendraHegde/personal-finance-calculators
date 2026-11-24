// Math correctness checks for the retirement calculator.
//
// These are not unit tests in the conventional sense — there's no test
// runner or framework dependency.  Each block runs a scenario and compares
// the result to a closed-form analytic expectation (compound-interest
// formula, FV-of-annuity, annuity-exhaustion, etc.).  The suite exits with
// code 0 when every assertion passes, otherwise non-zero.
//
// Run with:  npm test
//
// Add new scenarios as inline blocks; keep one analytic identity per check.
// Expected values must come from the closed-form maths, never from running
// the engine and pasting its output.
//
// Conventions the closed forms assume (see src/utils/retirement.ts):
//   * returns are annual CAGR; a SIP compounds at (1 + r)^(1/12) - 1 a month
//   * retirement living expenses are withdrawn at the start of each month

import {
  calculateRetirement,
  sanitizeAges,
  simulateRetirementPath,
} from "../src/utils/retirement";
import type { RetirementCalculationsResult } from "../src/types/retirement";
import { runMonteCarloSimulation } from "../src/utils/monteCarlo";

// Monthly rate equivalent to an annual CAGR given in percent.
const monthlyRate = (annualPct: number): number =>
  Math.pow(1 + annualPct / 100, 1 / 12) - 1;

// ---------------------------------------------------------------------------
// Tiny assertion helpers — no framework dependency
// ---------------------------------------------------------------------------

let failures = 0;

const eq = (a: number, b: number, tolPct: number, label: string): void => {
  const diff = Math.abs(a - b) / Math.max(1, Math.abs(b));
  if (!(diff <= tolPct)) {
    console.error(
      `  ✗ ${label}: got ${a.toFixed(4)}, expected ${b.toFixed(4)} (diff ${(diff * 100).toFixed(4)}% > ${(tolPct * 100).toFixed(3)}%)`,
    );
    failures++;
    return;
  }
  console.log(`  ✓ ${label}: ${a.toFixed(2)} ≈ ${b.toFixed(2)}`);
};

const assert = (cond: boolean, label: string): void => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
};

const section = (title: string): void => {
  console.log(`\n${title}`);
};

// ---------------------------------------------------------------------------
// CORE ACCUMULATION MATH
// ---------------------------------------------------------------------------

section("[1] Pure compound growth on existing bucket: P × (1+r)^n");
{
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "X", amount: 1_000_000, return: 10 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  eq(
    r.corpusAtRetirement,
    1_000_000 * Math.pow(1.10, 30),
    1e-9,
    "1L @ 10% × 30y",
  );
  eq(r.weightedReturn, 10, 1e-9, "weighted return = 10%");
}

section(
  "[2] Pure SIP: PMT × ((1+m)^n - 1) / m with m = 1.12^(1/12) - 1 (CAGR-consistent)",
);
{
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 12 }],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  const r_m = monthlyRate(12);
  const months = 360;
  const expected = 10_000 * ((Math.pow(1 + r_m, months) - 1) / r_m);
  eq(r.corpusAtRetirement, expected, 1e-9, "₹10K × 360mo @ 12% CAGR");
}

section("[3] Multi-bucket drift biases weighted return toward fast bucket");
{
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [
      { id: 1, name: "Slow", amount: 1_000_000, return: 4 },
      { id: 2, name: "Fast", amount: 1_000_000, return: 12 },
    ],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  const slow = 1_000_000 * Math.pow(1.04, 30);
  const fast = 1_000_000 * Math.pow(1.12, 30);
  const expectedWR = (slow * 4 + fast * 12) / (slow + fast);
  eq(r.corpusAtRetirement, slow + fast, 1e-9, "corpus = slow + fast");
  eq(r.weightedReturn, expectedWR, 1e-9, "drifted weighted return");
  assert(r.weightedReturn > 8, "drifted > today's 8%");
}

section("[4] Weighted return at retirement audit: existing + SIP mix");
{
  const r = calculateRetirement({
    currentAge: 50,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 100_000, return: 10 }],
    monthlySavingsBuckets: [{ id: 1, name: "RD", amount: 1_000, return: 5 }],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  const eqAt60 = 100_000 * Math.pow(1.10, 10);
  const rm = monthlyRate(5);
  const sipAt60 = 1_000 * ((Math.pow(1 + rm, 120) - 1) / rm);
  const expectedWR = (eqAt60 * 10 + sipAt60 * 5) / (eqAt60 + sipAt60);
  eq(r.corpusAtRetirement, eqAt60 + sipAt60, 1e-9, "corpus");
  eq(r.weightedReturn, expectedWR, 1e-9, "weighted return at retirement");
}

// ---------------------------------------------------------------------------
// DECUMULATION & INFLATION
// ---------------------------------------------------------------------------

section(
  "[5] Decumulation matches the monthly annuity-due exhaustion formula",
);
{
  const C = 10_000_000;
  const r = 0.06;
  const W = 1_000_000;
  const sim = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: W,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "All", amount: C, return: r * 100 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 130,
  });
  // Start-of-month withdrawals w = W/12, monthly growth q = 1 + m.
  // Balance after n months: C·q^n − w·q·(q^n − 1)/m = 0
  //   ⇒ n = −ln(1 − C·m/(w·q)) / ln q   (months)
  // The old end-of-year model (W taken after a full year of growth) gave
  // 15.73 years here; money spent through the year doesn't earn that return.
  const m = monthlyRate(r * 100);
  const w = W / 12;
  const q = 1 + m;
  const expected = -Math.log(1 - (C * m) / (w * q)) / Math.log(q) / 12;
  // The engine resolves depletion to within one month.
  eq(sim.yearsAfterRetirement, expected, 1 / 12 / expected, "years to exhaustion");
}

section("[6] Inflation: expenses at retirement = today × (1+i)^N");
{
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "X", amount: 0, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  const expected = 50_000 * 12 * Math.pow(1.06, 30);
  eq(r.annualExpensesAtRetirement, expected, 1e-9, "expense at retirement");
}

// ---------------------------------------------------------------------------
// ONE-TIME EXPENSES
// ---------------------------------------------------------------------------

section("[7] One-time expense fires at correct year with correct futureValue");
{
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 1,
      expenseType: "yearly",
      investmentBuckets: [{ id: 1, name: "X", amount: 10_000_000, return: 0 }],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Car",
          yearsFromNow: 5,
          currentCost: 1_000_000,
          inflationRate: 5,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  const expectedFV = 1_000_000 * Math.pow(1.05, 5);
  const yr4 = sim.steps.find((s) => s.year === 4)!;
  const yr5 = sim.steps.find((s) => s.year === 5)!;
  eq(yr4.corpus, 10_000_000, 1e-9, "corpus untouched at year 4");
  eq(yr5.corpus, 10_000_000 - expectedFV, 1e-9, "year-5 corpus reduction");
  eq(
    sim.futureOneTimeExpenses[0].futureValue,
    expectedFV,
    1e-9,
    "futureValue",
  );
}

section("[8] yearsFromNow=0 expense fires before year 1");
{
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 1,
      expenseType: "yearly",
      investmentBuckets: [{ id: 1, name: "X", amount: 1_000_000, return: 0 }],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Now",
          yearsFromNow: 0,
          currentCost: 300_000,
          inflationRate: 5,
        },
      ],
      targetAge: 70,
    },
    {},
  );
  const yr1 = sim.steps.find((s) => s.year === 1)!;
  eq(yr1.corpus, 700_000, 1e-9, "year-1 corpus after yr-0 expense");
  eq(sim.startingCorpus, 700_000, 1e-12, "starting corpus is after the year-0 goal");
}

// ---------------------------------------------------------------------------
// SINKING FUNDS (linkedSavingsBucketId)
// ---------------------------------------------------------------------------

section("[9] Linked SIP protects equity from being drained");
{
  const base = {
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly" as const,
    investmentBuckets: [{ id: 1, name: "Eq", amount: 5_000_000, return: 12 }],
    monthlySavingsBuckets: [
      { id: 1, name: "Cash", amount: 20_000, return: 6 },
    ],
    targetAge: 90,
  };
  const without = calculateRetirement({
    ...base,
    oneTimeExpenses: [
      {
        id: 1,
        name: "Car",
        yearsFromNow: 5,
        currentCost: 1_000_000,
        inflationRate: 0,
      },
    ],
  });
  const withLink = calculateRetirement({
    ...base,
    oneTimeExpenses: [
      {
        id: 1,
        name: "Car",
        yearsFromNow: 5,
        currentCost: 1_000_000,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
    ],
  });
  assert(
    withLink.corpusAtRetirement > without.corpusAtRetirement,
    "with-link corpus > without-link (equity protected)",
  );
}

section("[10] Linked SIP shortfall: drains SIP, then pulls pro-rata");
{
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 1,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "Eq", amount: 10_000_000, return: 0 },
      ],
      monthlySavingsBuckets: [
        { id: 1, name: "Tiny", amount: 1_000, return: 0 },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Big",
          yearsFromNow: 1,
          currentCost: 1_000_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  // SIP ₹12K drained, ₹988K shortfall from equity.  End: equity=₹9,012,000.
  const yr1 = sim.steps.find((s) => s.year === 1)!;
  eq(yr1.corpus, 9_012_000, 1e-9, "linked-drain plus pro-rata shortfall");
}

section("[11] Dangling link (bucket id deleted) → falls through to pro-rata");
{
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 1,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "A", amount: 5_000_000, return: 0 },
        { id: 2, name: "B", amount: 5_000_000, return: 0 },
      ],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Car",
          yearsFromNow: 1,
          currentCost: 1_000_000,
          inflationRate: 0,
          linkedSavingsBucketId: 999,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  const yr1 = sim.steps.find((s) => s.year === 1)!;
  eq(yr1.corpus, 9_000_000, 1e-9, "dangling link → pro-rata");
}

section(
  "[12] Two linked expenses on same SIP same year: first drains, second falls through",
);
{
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 1,
      expenseType: "yearly",
      investmentBuckets: [{ id: 1, name: "Eq", amount: 1_000_000, return: 0 }],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 0 },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "A",
          yearsFromNow: 5,
          currentCost: 300_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
        {
          id: 2,
          name: "B",
          yearsFromNow: 5,
          currentCost: 400_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  // SIP balance at year 5 = ₹6L. A drains ₹3L. B drains ₹3L (rest of SIP),
  // ₹1L pro-rata from equity. Equity = ₹9L, SIP = 0. Total = ₹9L.
  const yr5 = sim.steps.find((s) => s.year === 5)!;
  eq(yr5.corpus, 900_000, 1e-9, "second expense pulls shortfall from equity");
}

section(
  "[13] Post-retirement linked expense: same-rate SIP is mathematically equivalent to no link",
);
{
  // When the SIP rate equals the existing-bucket rate, Jensen's inequality
  // cancels and the linked path produces an identical total corpus at year 35
  // (the only difference is internal accounting — pool vs main).  This is a
  // useful invariant: the link doesn't artificially help when rates match.
  const make = (linked: boolean) => ({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly" as const,
    investmentBuckets: [{ id: 1, name: "Eq", amount: 5_000_000, return: 8 }],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 5_000, return: 8 }],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Big",
        yearsFromNow: 35,
        currentCost: 1_000_000,
        inflationRate: 0,
        linkedSavingsBucketId: linked ? 1 : undefined,
      },
    ],
    targetAge: 90,
  });
  const linked = calculateRetirement(make(true));
  const unlinked = calculateRetirement(make(false));
  eq(
    linked.corpusAtRetirement,
    unlinked.corpusAtRetirement,
    1e-9,
    "corpusAtRetirement identical",
  );
  const yL = linked.yearlyData.find((s) => s.year === 35)!;
  const yU = unlinked.yearlyData.find((s) => s.year === 35)!;
  // FP noise is sub-1e-12 here; relax slightly for the longer linked path.
  eq(yL.corpus, yU.corpus, 1e-10, "year-35 total corpus identical");
}

// ---------------------------------------------------------------------------
// POST-RETIREMENT ALLOCATION
// ---------------------------------------------------------------------------

section("[14] Per-bucket compounding during decumulation");
{
  // Already retired with ₹1Cr.  50% Cash 4%, 50% Equity 12%.  No expenses.
  // After 10y: 50L × 1.04^10 + 50L × 1.12^10
  const sim = simulateRetirementPath(
    {
      currentAge: 60,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "All", amount: 10_000_000, return: 0 },
      ],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: [
        { id: 1, name: "Cash", allocationPct: 50, return: 4 },
        { id: 2, name: "Eq", allocationPct: 50, return: 12 },
      ],
      targetAge: 75,
    },
    {},
  );
  const yr10 = sim.steps.find((s) => s.year === 10)!;
  const expected =
    5_000_000 * Math.pow(1.04, 10) + 5_000_000 * Math.pow(1.12, 10);
  eq(yr10.corpus, expected, 1e-9, "year-10 sum of two compounding paths");
}

section("[15] Pro-rata withdrawal across post-retirement buckets");
{
  const sim = simulateRetirementPath(
    {
      currentAge: 60,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 200_000,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "All", amount: 1_000_000, return: 0 },
      ],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: [
        { id: 1, name: "A", allocationPct: 30, return: 0 },
        { id: 2, name: "B", allocationPct: 70, return: 0 },
      ],
      targetAge: 75,
    },
    {},
  );
  const yr1 = sim.steps.find((s) => s.year === 1)!;
  eq(yr1.corpus, 800_000, 1e-9, "₹10L corpus minus ₹2L expense");
}

section("[16] Allocation normalises (sum != 100%)");
{
  const a = simulateRetirementPath(
    {
      currentAge: 60,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "All", amount: 10_000_000, return: 0 },
      ],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: [
        { id: 1, name: "A", allocationPct: 50, return: 4 },
        { id: 2, name: "B", allocationPct: 50, return: 12 },
      ],
      targetAge: 75,
    },
    {},
  );
  const b = simulateRetirementPath(
    {
      currentAge: 60,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "All", amount: 10_000_000, return: 0 },
      ],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: [
        { id: 1, name: "A", allocationPct: 25, return: 4 },
        { id: 2, name: "B", allocationPct: 25, return: 12 },
      ],
      targetAge: 75,
    },
    {},
  );
  const ya = a.steps.find((s) => s.year === 10)!;
  const yb = b.steps.find((s) => s.year === 10)!;
  eq(yb.corpus, ya.corpus, 1e-9, "25/25 normalises to 50/50");
}

section("[17] Empty post-retirement buckets → legacy single-aggregate");
{
  const params = {
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "yearly" as const,
    investmentBuckets: [
      { id: 1, name: "Cash", amount: 5_000_000, return: 4 },
      { id: 2, name: "Eq", amount: 5_000_000, return: 12 },
    ],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 75,
  };
  const legacy = simulateRetirementPath(params, {});
  const yr10 = legacy.steps.find((s) => s.year === 10)!;
  // Legacy weighted return = 8%.  Corpus = ₹1Cr × 1.08^10
  eq(
    yr10.corpus,
    10_000_000 * Math.pow(1.08, 10),
    1e-9,
    "fallback uses weighted return",
  );

  // Per-bucket model with same allocation gives a higher number due to
  // Jensen's inequality on compounding.
  const explicit = simulateRetirementPath(
    {
      ...params,
      postRetirementBuckets: [
        { id: 1, name: "Cash", allocationPct: 50, return: 4 },
        { id: 2, name: "Eq", allocationPct: 50, return: 12 },
      ],
    },
    {},
  );
  const yr10e = explicit.steps.find((s) => s.year === 10)!;
  assert(
    yr10e.corpus > yr10.corpus,
    "per-bucket > aggregate (Jensen's inequality)",
  );
}

// ---------------------------------------------------------------------------
// EARMARKED POOLS (post-retirement linked one-time expenses)
// ---------------------------------------------------------------------------

section(
  "[E1] Only what the goal needs is held aside at retirement; the rest is main corpus",
);
{
  // SIP @ 8% for 10 years, linked to a ₹10L goal 5 years after retirement.
  // The pool keeps 10L / 1.08^5 (enough to grow into the goal at the SIP's
  // rate); the rest of the SIP joins the main corpus.  (It used to hold
  // back the whole SIP balance however small the goal.)
  const r = calculateRetirement({
    currentAge: 50,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 1_000_000, return: 8 }],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 8 }],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Edu",
        yearsFromNow: 15,
        currentCost: 1_000_000,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
    ],
    targetAge: 90,
  });
  // SIP at retirement = 10K × ((1+m)^120 − 1)/m with m = 1.08^(1/12) − 1
  const r_m = monthlyRate(8);
  const sipAtRet = 10_000 * ((Math.pow(1 + r_m, 120) - 1) / r_m);
  const eqAtRet = 1_000_000 * Math.pow(1.08, 10);
  const needed = 1_000_000 / Math.pow(1.08, 5);
  eq(r.earmarkedAtRetirement, needed, 1e-9, "earmarked = goal's present value");
  eq(
    r.mainCorpusAtRetirement,
    eqAtRet + sipAtRet - needed,
    1e-9,
    "mainCorpus = existing + rest of the SIP",
  );
  const edu = r.expenseFundings.find((f) => f.expenseId === 1)!;
  eq(edu.drainedFromLinked, 1_000_000, 1e-9, "pool pays the goal in full");
  assert(edu.surplusRolledOver === undefined, "nothing left over (sized exactly)");
  eq(
    r.corpusAtRetirement,
    eqAtRet + sipAtRet,
    1e-9,
    "total corpus unchanged",
  );
}

section(
  "[E2] Earmarked pool grows at SIP rate post-retirement (no contributions)",
);
{
  // Currently retired, ₹0 existing, just the SIP-balance-as-pool.
  // (Contrived: monthly amount 0, but accumulated 0 too.  Use a different
  // setup: short SIP that accumulates to a known value, then retire.)
  // Setup: 1y SIP at 12% with ₹100K/mo, retire at year 1.
  // SIP at year 1 = 100K × ((1+m)^12 − 1)/m with m = 1.12^(1/12) − 1
  // Linked to expense at year 6 (5 years post retirement).
  // Pool grows 5y at 12%: pool@year6 = sipAtRet * 1.12^5
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 31,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        { id: 1, name: "Goal", amount: 100_000, return: 12 },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Goal",
          yearsFromNow: 6,
          currentCost: 100_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 50,
    },
    {},
  );
  // Pool just before expense (after year-6 growth):
  // pool@yr6 = sipAtRet × 1.12^5
  const r_m = monthlyRate(12);
  const sipAtRet = 100_000 * ((Math.pow(1 + r_m, 12) - 1) / r_m);
  const poolGrown = sipAtRet * Math.pow(1.12, 5);
  // After expense ₹100K (futureValue, since inflationRate=0): pool = poolGrown - 100K
  // PendingCount = 0 → roll into main corpus.  Main corpus had 0; now has the leftover.
  // Total corpus end of year 6 = poolGrown - 100K.
  const yr6 = sim.steps.find((s) => s.year === 6)!;
  eq(
    yr6.corpus,
    poolGrown - 100_000,
    1e-9,
    "pool grew 5y @ 12% then drained ₹100K",
  );
}

section(
  "[E3] Pool drains first; shortfall pulled from main corpus pro-rata",
);
{
  // SIP accumulates a small balance, expense bigger than pool.
  // 5y of ₹1K/mo @ 0% → 60K. Existing: ₹10M @ 0%.
  // Expense at year 6 (1y post retirement) = ₹500K.
  // Pool grows 1y @ 0% = 60K.  Drain pool: 60K used, 440K shortfall.
  // Shortfall pulled from existing: existing - 440K.
  const sim = simulateRetirementPath(
    {
      currentAge: 25,
      retirementAge: 30,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "Eq", amount: 10_000_000, return: 0 },
      ],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 1_000, return: 0 },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Big",
          yearsFromNow: 6,
          currentCost: 500_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 50,
    },
    {},
  );
  // SIP at retirement = 1K × 60 = 60K (zero return).  At year 6 (1y after),
  // pool still 60K.  Expense ₹500K: drain 60K from pool, 440K from existing
  // → existing = ₹10M - 440K = 9,560,000.  Pool empty, pendingCount=0, rolls
  // into main (no-op since 0).  Total corpus end of year 6 = 9,560,000.
  const yr6 = sim.steps.find((s) => s.year === 6)!;
  eq(yr6.corpus, 9_560_000, 1e-9, "main corpus reduced by shortfall only");
}

section("[E4] Pool leftover rolls into main corpus when last expense fires");
{
  // SIP big enough that after the expense, leftover is meaningful.
  // 30y of ₹10K/mo @ 8% → ~₹15M.  Existing: ₹0.
  // Expense at year 31 (1y post retirement) = ₹1M.
  // Pool@yr31 = 15M × 1.08 = ~16.2M.  Drain ₹1M → 15.2M leftover.
  // Pool's pendingCount=0 → leftover rolls into main corpus.
  // Year-31 total = 15.2M (everything's in main now, pool gone).
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 8 },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Goal",
          yearsFromNow: 31,
          currentCost: 1_000_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  const r_m = monthlyRate(8);
  const sipAtRet = 10_000 * ((Math.pow(1 + r_m, 360) - 1) / r_m);
  const expectedAtYr31 = sipAtRet * 1.08 - 1_000_000;
  const yr31 = sim.steps.find((s) => s.year === 31)!;
  eq(yr31.corpus, expectedAtYr31, 1e-9, "leftover correctly accounted");
  // Year 32: the pool is gone and its leftover sits in the main corpus.
  // Everything was earmarked, so there is no main-corpus mix to fall back
  // on; the fallback uses the whole pre-retirement mix (the SIP's 8%).  It
  // used to be 0%, leaving the rolled-over money idle for the rest of life.
  const yr32 = sim.steps.find((s) => s.year === 32)!;
  eq(yr32.corpus, expectedAtYr31 * 1.08, 1e-9, "rolled-over money keeps earning 8%");
}

section("[E5] SIP linked to BOTH pre- and post-retirement expenses");
{
  // SIP @ 8% with ₹10K/mo over 30 years.  Pre-retirement expense at year 5
  // drains some of it.  Post-retirement expense at year 35 drains pool.
  // The pool is built from whatever's in the SIP at retirement after the
  // pre-retirement drain.
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "Eq", amount: 10_000_000, return: 8 },
      ],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 8 },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Pre",
          yearsFromNow: 5,
          currentCost: 500_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
        {
          id: 2,
          name: "Post",
          yearsFromNow: 35,
          currentCost: 500_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  // Just verify both expenses actually applied (corpus reduced).  Computing
  // the exact value is tedious but we can sanity-check the qualitative
  // behaviour:
  const yr5 = sim.steps.find((s) => s.year === 5)!;
  const yr35 = sim.steps.find((s) => s.year === 35)!;
  // At year 5, the ₹500K pre-retirement expense should be reflected in
  // oneTimeExpenses.
  eq(yr5.oneTimeExpenses, 500_000, 1e-9, "pre-expense recorded at year 5");
  eq(yr35.oneTimeExpenses, 500_000, 1e-9, "post-expense recorded at year 35");
  assert(
    yr5.corpus > 0 && yr35.corpus > 0,
    "corpus stays positive throughout",
  );
}

section(
  "[E6] Main corpus too small for living costs depletes (no pools to fall back on)",
);
{
  // Set up a scenario where main corpus runs out but pool has plenty.
  // The user should be flagged depleted (can't fund daily living) even
  // though earmarked money exists.
  // Existing: ₹500K @ 0%. Annual expenses: ₹1M.  Big SIP earmarked for a
  // late-life expense.
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1_000_000,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 500_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  // No earmarked, but base case: corpus = ₹500K, expenses = ₹1M/yr → depletes year 1.
  assert(!r.corpusLastsBeyondHorizon, "depletes when only main corpus");
  assert(r.yearsAfterRetirement < 1, "depletes within first year");
}

section(
  "[E7] One-time shortfall does NOT trigger depletion if regular is funded",
);
{
  // Main corpus large enough for regular expenses indefinitely.  An
  // unfunded one-time expense (no link, larger than corpus's pro-rata
  // capacity in that year) should NOT make corpus run out as long as
  // regular expenses are still covered.
  const sim = simulateRetirementPath(
    {
      currentAge: 60,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 100_000,
      expenseType: "yearly",
      investmentBuckets: [
        { id: 1, name: "Eq", amount: 50_000_000, return: 8 },
      ],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Huge",
          yearsFromNow: 5,
          currentCost: 200_000_000,
          inflationRate: 0,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  // Year 5: huge expense (₹20Cr) wipes the corpus.  But regular expense
  // (₹1L) for that year is processed AFTER the one-time, drawing from the
  // already-zero main corpus → regular shortfall ₹1L → depletion at year 5.
  // The point: the depletion is triggered by REGULAR shortfall, not the
  // one-time shortfall directly.
  assert(sim.depleted, "depletes due to regular shortfall after one-time wiped corpus");
}

// ---------------------------------------------------------------------------
// GLIDE PATH (de-risk before goal)
// ---------------------------------------------------------------------------

section("[G1] Glide reduces SIP rate in last N years before linked goal");
{
  // Setup: SIP @ 12% with ₹10K/mo for 10 years.  Goal at year 10.
  // Glide: target 6%, glideYears 3.
  // So years 1-7 use 12%, year 8 uses ~10% (1/3 progress), year 9 uses ~8%
  // (2/3 progress), year 10 uses 6% (full progress).
  //
  // We compare the no-glide run vs the with-glide run.  With-glide should
  // have a smaller SIP balance at year 10 because the last 3 years
  // compounded at lower rates.
  const base = {
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly" as const,
    investmentBuckets: [],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Edu",
        yearsFromNow: 10,
        currentCost: 0,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
    ],
    targetAge: 90,
  };
  const noGlide = simulateRetirementPath(
    {
      ...base,
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 12 },
      ],
    },
    {},
  );
  const withGlide = simulateRetirementPath(
    {
      ...base,
      monthlySavingsBuckets: [
        {
          id: 1,
          name: "SIP",
          amount: 10_000,
          return: 12,
          targetRate: 6,
          glideYears: 3,
        },
      ],
    },
    {},
  );
  // Year 9 corpus (just before goal fires at year 10): with-glide must be
  // smaller because year 8 and 9 used <12%.
  const ng9 = noGlide.steps.find((s) => s.year === 9)!;
  const wg9 = withGlide.steps.find((s) => s.year === 9)!;
  assert(wg9.corpus < ng9.corpus, "year-9 corpus smaller with glide");
  // Sanity: in year 8 (first glide year), with-glide corpus < no-glide corpus.
  const ng8 = noGlide.steps.find((s) => s.year === 8)!;
  const wg8 = withGlide.steps.find((s) => s.year === 8)!;
  assert(wg8.corpus < ng8.corpus, "year-8 corpus smaller with glide");
  // Sanity: in year 7 (BEFORE glide window), corpora should be identical.
  const ng7 = noGlide.steps.find((s) => s.year === 7)!;
  const wg7 = withGlide.steps.find((s) => s.year === 7)!;
  eq(wg7.corpus, ng7.corpus, 1e-9, "year-7 corpus identical (pre-glide)");
}

section("[G2] No linked goal → glide settings have no effect");
{
  // SIP with glide settings but NO linked one-time expense.  Should grow
  // at its normal rate forever.
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        {
          id: 1,
          name: "SIP",
          amount: 10_000,
          return: 12,
          targetRate: 6,
          glideYears: 3,
        },
      ],
      oneTimeExpenses: [],
      targetAge: 90,
    },
    {},
  );
  // At retirement (year 30), SIP should equal the analytic FV at 12%
  const r_m = monthlyRate(12);
  const expected = 10_000 * ((Math.pow(1 + r_m, 360) - 1) / r_m);
  eq(
    sim.corpusAtRetirement,
    expected,
    1e-9,
    "no-link glide is a no-op",
  );
}

section("[G3] Multiple linked goals → glide tracks the next pending one");
{
  // Two linked goals at years 10 and 20.  Glide window = 3 years.  So:
  // - years 8-10: glide for goal-1 (target 6%)
  // - year 10: goal-1 fires; goal-2 still pending
  // - years 11-17: full normal rate (no goal within 3 years)
  // - years 18-20: glide for goal-2
  const sim = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        {
          id: 1,
          name: "SIP",
          amount: 10_000,
          return: 12,
          targetRate: 6,
          glideYears: 3,
        },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "G1",
          yearsFromNow: 10,
          currentCost: 0,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
        {
          id: 2,
          name: "G2",
          yearsFromNow: 20,
          currentCost: 0,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  // No-glide reference for the same SIP.
  const noGlide = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 12 },
      ],
      oneTimeExpenses: [
        { id: 1, name: "G1", yearsFromNow: 10, currentCost: 0, inflationRate: 0 },
        { id: 2, name: "G2", yearsFromNow: 20, currentCost: 0, inflationRate: 0 },
      ],
      targetAge: 90,
    },
    {},
  );
  // Year 7 is fully BEFORE goal-1's glide window (which is years 8-10),
  // so the with-glide corpus must equal the no-glide corpus.
  const wg7 = sim.steps.find((s) => s.year === 7)!;
  const ng7 = noGlide.steps.find((s) => s.year === 7)!;
  eq(wg7.corpus, ng7.corpus, 1e-9, "year-7 before any glide window");
  // Year 10 onward, with-glide diverges (years 8-10 used reduced rates).
  const wg10 = sim.steps.find((s) => s.year === 10)!;
  const ng10 = noGlide.steps.find((s) => s.year === 10)!;
  assert(wg10.corpus < ng10.corpus, "year-10 with-glide < no-glide (goal-1 glide active)");
  // Year 17: glide-2's window is years 18-20.  Year 17 is OUTSIDE that
  // window, so the years 11-17 should compound at the same 12% in both
  // runs.  The gap between wg and ng should be exactly the gap from
  // year 10, scaled by whatever 7 years of equal-rate growth multiplies it
  // by — so the *difference* is non-zero but the *ratio* of accumulated
  // gap to balance should track.  Simplest assertion: year-17 wg < ng,
  // and the relative gap at year 17 is in the same ballpark as year 10
  // (within ~5% — contributions pull them slightly closer).
  const wg17 = sim.steps.find((s) => s.year === 17)!;
  const ng17 = noGlide.steps.find((s) => s.year === 17)!;
  assert(wg17.corpus < ng17.corpus, "year-17 with-glide still behind");
  const gap10 = (ng10.corpus - wg10.corpus) / ng10.corpus;
  const gap17 = (ng17.corpus - wg17.corpus) / ng17.corpus;
  // The gap shrinks as new contributions come in at full 12% in both runs,
  // but it shouldn't widen — that would mean glide is still active.
  assert(gap17 <= gap10 + 1e-9, "gap doesn't widen post-glide-1 (glide-2 not yet active)");
}

section("[G4] glideYears=0 disables glide (treated as no settings)");
{
  // Even with targetRate set, glideYears=0 means no glide.  Equivalent to
  // no settings.
  const a = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        {
          id: 1,
          name: "SIP",
          amount: 10_000,
          return: 12,
          targetRate: 6,
          glideYears: 0,
        },
      ],
      oneTimeExpenses: [
        { id: 1, name: "G", yearsFromNow: 10, currentCost: 0, inflationRate: 0, linkedSavingsBucketId: 1 },
      ],
      targetAge: 90,
    },
    {},
  );
  const b = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 12 },
      ],
      oneTimeExpenses: [
        { id: 1, name: "G", yearsFromNow: 10, currentCost: 0, inflationRate: 0, linkedSavingsBucketId: 1 },
      ],
      targetAge: 90,
    },
    {},
  );
  const a10 = a.steps.find((s) => s.year === 10)!;
  const b10 = b.steps.find((s) => s.year === 10)!;
  eq(a10.corpus, b10.corpus, 1e-9, "glideYears=0 ≡ no glide");
}

section("[G5] Glide applies to earmarked pool post-retirement too");
{
  // SIP @ 12% with goal at year 35 (post-retirement: retire at 60, currentAge
  // 30 → goal in retirement year 5).  Glide window 3, target 6%.
  // Pool is held aside.  In years 33, 34, 35 the pool grows at the gliding
  // rate, NOT the SIP's 12%.
  const withGlide = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        {
          id: 1,
          name: "SIP",
          amount: 10_000,
          return: 12,
          targetRate: 6,
          glideYears: 3,
        },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Goal",
          yearsFromNow: 35,
          currentCost: 10_000_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  const noGlide = simulateRetirementPath(
    {
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "yearly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 12 },
      ],
      oneTimeExpenses: [
        {
          id: 1,
          name: "Goal",
          yearsFromNow: 35,
          currentCost: 10_000_000,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  // The pool is sized to grow into the ₹1 Cr goal.  With the glide it
  // earns less, so more must be held back at retirement in the slower pool
  // and less joins the main corpus: the total at year 35 is lower.
  const wg35 = withGlide.steps.find((s) => s.year === 35)!;
  const ng35 = noGlide.steps.find((s) => s.year === 35)!;
  assert(
    wg35.corpus < ng35.corpus,
    "post-retirement glide reduces pool growth",
  );
}

// ---------------------------------------------------------------------------
// EXPENSE FUNDING SNAPSHOTS
// ---------------------------------------------------------------------------

section("[F1] Linked SIP fully funds expense → drainedFromLinked = cost, no shortfall");
{
  // Big SIP, small expense.  Expense at year 5 = ₹5L; SIP @ 12% with
  // ₹50K/mo accumulates ~₹40L by year 5 — way more than enough.
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 100_000_000, return: 12 }],
    monthlySavingsBuckets: [
      { id: 1, name: "SIP", amount: 50_000, return: 12 },
    ],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Car",
        yearsFromNow: 5,
        currentCost: 500_000,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
    ],
    targetAge: 90,
  });
  const f = r.expenseFundings.find((s) => s.expenseId === 1)!;
  eq(f.drainedFromLinked, 500_000, 1e-9, "drainedFromLinked = cost");
  eq(f.drainedFromMain, 0, 1e-9, "drainedFromMain = 0");
  eq(f.shortfall, 0, 1e-9, "shortfall = 0");
  assert(
    f.linkedBalanceBefore !== undefined && f.linkedBalanceBefore > 500_000,
    "linkedBalanceBefore > cost",
  );
}

section("[F2] Linked SIP can't fully cover → split between SIP and main");
{
  // Tiny SIP, large expense.  SIP balance at year 1 ≈ ₹12K (₹1K/mo for 12mo).
  // Expense ₹1M.  Drain ₹12K from SIP, ₹988K from existing.
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [
      { id: 1, name: "SIP", amount: 1_000, return: 0 },
    ],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Big",
        yearsFromNow: 1,
        currentCost: 1_000_000,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
    ],
    targetAge: 90,
  });
  const f = r.expenseFundings.find((s) => s.expenseId === 1)!;
  eq(f.drainedFromLinked, 12_000, 1e-9, "drainedFromLinked = SIP balance");
  eq(f.drainedFromMain, 988_000, 1e-9, "drainedFromMain = remainder");
  eq(f.shortfall, 0, 1e-9, "no shortfall (corpus had enough)");
}

section("[F3] Unlinked expense → drainedFromMain = full cost");
{
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Wedding",
        yearsFromNow: 5,
        currentCost: 500_000,
        inflationRate: 0,
      },
    ],
    targetAge: 90,
  });
  const f = r.expenseFundings.find((s) => s.expenseId === 1)!;
  eq(f.drainedFromLinked, 0, 1e-9, "no link → 0 from linked");
  eq(f.drainedFromMain, 500_000, 1e-9, "all from main");
  eq(f.shortfall, 0, 1e-9, "no shortfall");
  assert(
    f.linkedBalanceBefore === undefined,
    "linkedBalanceBefore undefined for unlinked expense",
  );
}

section("[F4] An exactly sized pool pays its goal with nothing left over");
{
  // Big SIP, small post-retirement goal.  Only 10L / 1.12^5 is held back
  // at retirement; the rest of the SIP is main corpus from day one.  On the
  // expected path the pool lands exactly on the cost, so no surplus is
  // reported.  (Surpluses arise in Monte Carlo when the pool beats its
  // expected return; see [52].)
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "yearly",
    investmentBuckets: [],
    monthlySavingsBuckets: [
      { id: 1, name: "Big SIP", amount: 50_000, return: 12 },
    ],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Education",
        yearsFromNow: 35,
        currentCost: 1_000_000,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
    ],
    targetAge: 90,
  });
  const f = r.expenseFundings.find((s) => s.expenseId === 1)!;
  eq(f.drainedFromLinked, 1_000_000, 1e-9, "drained full cost from pool");
  eq(f.drainedFromMain, 0, 1e-9, "no main draw");
  assert(f.surplusRolledOver === undefined, "no surplus on the expected path");
  const r_m = monthlyRate(12);
  const sipAtRet = 50_000 * ((Math.pow(1 + r_m, 360) - 1) / r_m);
  const held = 1_000_000 / Math.pow(1.12, 5);
  eq(r.earmarkedAtRetirement, held, 1e-9, "held back = present value of the goal");
  eq(r.mainCorpusAtRetirement, sipAtRet - held, 1e-9, "rest is main corpus");
}

section("[F5] Multiple linked expenses on one SIP — each tracked separately");
{
  // Two expenses linked to same SIP.  First drains some, second drains
  // more.  Each gets its own funding snapshot.
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [
      { id: 1, name: "SIP", amount: 50_000, return: 12 },
    ],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Car",
        yearsFromNow: 5,
        currentCost: 500_000,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
      {
        id: 2,
        name: "Wedding",
        yearsFromNow: 10,
        currentCost: 1_000_000,
        inflationRate: 0,
        linkedSavingsBucketId: 1,
      },
    ],
    targetAge: 90,
  });
  const car = r.expenseFundings.find((s) => s.expenseId === 1)!;
  const wedding = r.expenseFundings.find((s) => s.expenseId === 2)!;
  // Car is fully funded (SIP has plenty by year 5).
  eq(car.drainedFromLinked, 500_000, 1e-9, "car: SIP funds full cost");
  eq(car.drainedFromMain, 0, 1e-9, "car: no main draw");
  // Wedding too.
  eq(wedding.drainedFromLinked, 1_000_000, 1e-9, "wedding: SIP funds full cost");
  eq(wedding.drainedFromMain, 0, 1e-9, "wedding: no main draw");
  // The wedding's linkedBalanceBefore should reflect SIP balance AT year 10
  // AFTER all prior drains (no drains in this test happen between years 5
  // and 10 since car already fired).  Important: linkedBalanceBefore must
  // be the SIP balance just before THIS expense fires, not the original.
  assert(
    wedding.linkedBalanceBefore !== undefined &&
      wedding.linkedBalanceBefore > 0,
    "wedding's linkedBalanceBefore captured",
  );
}

section("[F6] One-time shortfall recorded when corpus exhausted");
{
  // Tiny corpus, huge expense at year 1 (no link).  Expense cost > corpus.
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 1,
    expenseType: "yearly",
    investmentBuckets: [{ id: 1, name: "Tiny", amount: 100_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Huge",
        yearsFromNow: 1,
        currentCost: 1_000_000,
        inflationRate: 0,
      },
    ],
    targetAge: 90,
  });
  const f = r.expenseFundings.find((s) => s.expenseId === 1)!;
  eq(f.drainedFromLinked, 0, 1e-9, "no link");
  eq(f.drainedFromMain, 100_000, 1e-9, "drained the whole corpus");
  eq(f.shortfall, 900_000, 1e-9, "shortfall = remainder");
}

// ---------------------------------------------------------------------------
// MONTE CARLO
// ---------------------------------------------------------------------------

section("[18] MC at zero volatility ≡ deterministic (every age, every percentile)");
{
  const params = {
    currentAge: 35,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 80_000,
    expenseType: "monthly" as const,
    investmentBuckets: [
      { id: 1, name: "Eq", amount: 5_000_000, return: 12 },
      { id: 2, name: "Db", amount: 3_000_000, return: 8 },
    ],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 30_000, return: 12 }],
    oneTimeExpenses: [
      {
        id: 1,
        name: "Edu",
        yearsFromNow: 12,
        currentCost: 2_000_000,
        inflationRate: 8,
      },
    ],
    postRetirementBuckets: [
      { id: 1, name: "Cash", allocationPct: 10, return: 6 },
      { id: 2, name: "Debt", allocationPct: 30, return: 8 },
      { id: 3, name: "Eq", allocationPct: 60, return: 11 },
    ],
    targetAge: 90,
  };
  const det = calculateRetirement(params);
  const mc = runMonteCarloSimulation({
    ...params,
    portfolioVolatility: 0,
    inflationVolatility: 0,
    iterations: 10,
    seed: 1,
  });
  const at60 = det.yearlyData.find((d) => d.age === 60)!;
  const at90 = det.yearlyData.find((d) => d.age === 90)!;
  const mcAt60 = mc.percentiles.find((p) => p.age === 60)!;
  const mcAt90 = mc.percentiles.find((p) => p.age === 90)!;
  eq(mcAt60.p50, at60.corpus, 1e-9, "MC P50@60 ≡ det@60");
  eq(mcAt60.p10, at60.corpus, 1e-9, "MC P10@60 ≡ det@60");
  eq(mcAt60.p90, at60.corpus, 1e-9, "MC P90@60 ≡ det@60");
  eq(mcAt90.p50, at90.corpus, 1e-9, "MC P50@90 ≡ det@90");
}

section("[19] MC dispersion grows with horizon");
{
  const mc = runMonteCarloSimulation({
    currentAge: 30,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "X", amount: 5_000_000, return: 10 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
    portfolioVolatility: 15,
    inflationVolatility: 1.5,
    iterations: 3000,
    seed: 7,
  });
  const at35 = mc.percentiles.find((p) => p.age === 35)!;
  const at50 = mc.percentiles.find((p) => p.age === 50)!;
  const at60 = mc.percentiles.find((p) => p.age === 60)!;
  const spread = (p: typeof at35) => p.p90 - p.p10;
  assert(spread(at35) < spread(at50), "spread@50 > spread@35");
  assert(spread(at50) < spread(at60), "spread@60 > spread@50");
}

section("[20] MC monotonicity: more savings → higher success");
{
  const base = {
    currentAge: 30,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 80_000,
    expenseType: "monthly" as const,
    investmentBuckets: [{ id: 1, name: "X", amount: 2_000_000, return: 11 }],
    oneTimeExpenses: [],
    targetAge: 90,
    portfolioVolatility: 14,
    inflationVolatility: 1.5,
    iterations: 1500,
    seed: 99,
  };
  const lowSIP = runMonteCarloSimulation({
    ...base,
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 20_000, return: 11 }],
  });
  const highSIP = runMonteCarloSimulation({
    ...base,
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 60_000, return: 11 }],
  });
  console.log(
    `   low-SIP success ${(lowSIP.successRate * 100).toFixed(1)}%, high-SIP success ${(highSIP.successRate * 100).toFixed(1)}%`,
  );
  assert(highSIP.successRate > lowSIP.successRate, "monotone in savings");
}

section("[21] All-equity post-retirement → wider MC band than all-debt");
{
  const base = {
    currentAge: 60,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 100_000,
    expenseType: "monthly" as const,
    investmentBuckets: [
      { id: 1, name: "All", amount: 30_000_000, return: 9 },
    ],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
    portfolioVolatility: 15,
    inflationVolatility: 1.5,
    iterations: 2000,
    seed: 11,
  };
  // Realistic per-asset volatility (the old version gave both the same 15%
  // and only "passed" because equity compounds from a bigger base).
  const allDebt = runMonteCarloSimulation({
    ...base,
    postRetirementBuckets: [
      { id: 1, name: "Debt", allocationPct: 100, return: 6, volatility: 4 },
    ],
  });
  const allEquity = runMonteCarloSimulation({
    ...base,
    postRetirementBuckets: [
      { id: 1, name: "Eq", allocationPct: 100, return: 11, volatility: 16 },
    ],
  });
  const at80 = (m: typeof allDebt) => m.percentiles.find((p) => p.age === 80)!;
  const debtSpread = at80(allDebt).p90 - at80(allDebt).p10;
  const equitySpread = at80(allEquity).p90 - at80(allEquity).p10;
  console.log(
    `   debt P10–P90 spread ₹${(debtSpread / 1e7).toFixed(1)} Cr, equity ₹${(equitySpread / 1e7).toFixed(1)} Cr`,
  );
  assert(equitySpread > debtSpread, "equity allocation has wider band");
}

// ---------------------------------------------------------------------------
// ROBUSTNESS / EDGE CASES
// ---------------------------------------------------------------------------

section("[22] Already retired (currentAge == retirementAge)");
{
  const r = calculateRetirement({
    currentAge: 65,
    retirementAge: 65,
    inflation: 6,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "X", amount: 30_000_000, return: 8 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  eq(r.yearsToRetirement, 0, 1e-9, "yearsToRetirement");
  eq(r.corpusAtRetirement, 30_000_000, 1e-9, "corpus = today");
  eq(r.weightedReturn, 8, 1e-9, "weighted = bucket return");
  eq(r.annualExpensesAtRetirement, 1_200_000, 1e-9, "no inflation buildup");
}

section("[23] Empty corpus + positive expenses depletes within year 1");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  eq(r.corpusAtRetirement, 0, 1e-9, "corpus = 0");
  assert(r.yearsAfterRetirement < 1, "depletes within first year");
  assert(!r.corpusLastsBeyondHorizon, "does not last beyond horizon");
}

section("[24] NaN inputs do not corrupt results");
{
  const r = calculateRetirement({
    currentAge: NaN as unknown as number,
    retirementAge: 60,
    inflation: NaN as unknown as number,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [
      { id: 1, name: "X", amount: NaN as unknown as number, return: 8 },
    ],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  assert(Number.isFinite(r.corpusAtRetirement), "corpus is finite");
  assert(Number.isFinite(r.yearsAfterRetirement), "years is finite");
  assert(Number.isFinite(r.survivalAge), "survival is finite");
}

section("[25] Negative real return causes early depletion");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 10,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "X", amount: 10_000_000, return: 4 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  assert(r.realReturn < 0, "real return is negative");
  assert(!r.corpusLastsBeyondHorizon, "corpus depletes before targetAge");
}

// ---------------------------------------------------------------------------
// REGRESSIONS FOUND IN THE NOV-2026 AUDIT
// Each block pins a bug that the earlier suite did not catch because its
// expectations were derived from the code itself.
// ---------------------------------------------------------------------------

section("[26] SIP and lump sum in the same asset compound identically");
{
  // ₹1,000 a month for one year at 12% CAGR.  A contribution made j months
  // before year end is a lump sum held for j/12 years, so it must grow by
  // 1.12^(j/12), exactly like an existing bucket would.  (The old r/12
  // convention grew it at 1.01^j, i.e. 12.68% a year.)
  const r = calculateRetirement({
    currentAge: 59,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "yearly",
    investmentBuckets: [],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 1_000, return: 12 }],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  let expected = 0;
  for (let j = 0; j < 12; j++) expected += 1_000 * Math.pow(1.12, j / 12);
  eq(r.corpusAtRetirement, expected, 1e-12, "Σ 1000 × 1.12^(j/12)");
}

section("[27] Retirement year 1: start-of-month withdrawals, monthly growth");
{
  // C = ₹1Cr at 8%, ₹6L/yr, no inflation.  After 12 months:
  //   C·q^12 − w·q·(q^12 − 1)/(q − 1),  q = 1.08^(1/12), w = 50K
  const C = 10_000_000;
  const sim = simulateRetirementPath({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "All", amount: C, return: 8 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  const q = 1 + monthlyRate(8);
  const expected =
    C * Math.pow(q, 12) - 50_000 * q * (Math.pow(q, 12) - 1) / (q - 1);
  eq(sim.steps[0].corpus, expected, 1e-12, "year-1 corpus");
  // Strictly less than the old "grow a full year, then pay ₹6L" model.
  assert(sim.steps[0].corpus < C * 1.08 - 600_000, "below year-end-withdrawal model");
}

section("[28] Living costs rise every month in retirement");
{
  // ₹1L/month today, 6% inflation, retire in 10 years.  Retirement year 1
  // spends Σ_{j=0}^{11} 1L × 1.06^(10 + j/12).
  const sim = simulateRetirementPath({
    currentAge: 50,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "All", amount: 100_000_000, return: 8 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  let expected = 0;
  for (let j = 0; j < 12; j++) expected += 100_000 * Math.pow(1.06, 10 + j / 12);
  const yr11 = sim.steps.find((s) => s.year === 11)!;
  eq(yr11.regularExpenses, expected, 1e-12, "first retirement year spend");
  eq(yr11.inflationIndex, Math.pow(1.06, 11), 1e-12, "price level after 11 years");
}

section("[29] Fractional ages are rounded, not silently dropping goals");
{
  // Previously currentAge 30.5 made every post-retirement year fractional
  // (30.5, 31.5, …) and the whole-year goal map never matched: the goal
  // vanished from the projection.
  const params = {
    currentAge: 30.4,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "yearly" as const,
    investmentBuckets: [{ id: 1, name: "A", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [
      { id: 1, name: "Late goal", yearsFromNow: 35, currentCost: 1_000_000, inflationRate: 0 },
    ],
    targetAge: 90,
  };
  const r = calculateRetirement(params);
  eq(r.currentAge, 30, 0, "age rounded to 30");
  assert(
    r.expenseFundings.some((f) => f.expenseName === "Late goal" && f.drainedFromMain === 1_000_000),
    "post-retirement goal applied",
  );
  assert(r.yearlyData.every((s) => Number.isInteger(s.year)), "whole-year steps");
}

section("[30] Contributions are cash in; growth closes the books every year");
{
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 50,
    inflation: 6,
    monthlyExpenses: 20_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 2_000_000, return: 11 }],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 12 }],
    oneTimeExpenses: [
      { id: 1, name: "Car", yearsFromNow: 5, currentCost: 800_000, inflationRate: 5 },
      { id: 2, name: "Trip", yearsFromNow: 25, currentCost: 300_000, inflationRate: 6 },
    ],
    targetAge: 80,
  });
  // Solvent throughout, so requested living costs = paid living costs.
  assert(r.corpusLastsBeyondHorizon, "scenario stays solvent");
  const y20 = r.yearlyData.find((s) => s.year === 20)!;
  eq(y20.contributions, 120_000, 1e-12, "year-20 contributions = 12 × ₹10K");
  // corpus_t = corpus_{t−1} + contributions + growth − regular paid − one-time paid
  let prev = 2_000_000;
  let worst = 0;
  for (const s of r.yearlyData) {
    const oneTimePaid = r.expenseFundings
      .filter((f) => f.yearsFromNow === s.year)
      .reduce((a, f) => a + f.drainedFromLinked + f.drainedFromMain, 0);
    const implied = prev + s.contributions + s.growth - s.regularExpenses - oneTimePaid;
    worst = Math.max(worst, Math.abs(implied - s.corpus) / Math.max(1, s.corpus));
    prev = s.corpus;
  }
  assert(worst < 1e-9, `ledger identity holds every year (worst rel err ${worst.toExponential(1)})`);
}

section("[31] Goals after the money runs out are reported as unpaid");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 3_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [
      { id: 1, name: "Early", yearsFromNow: 1, currentCost: 100_000, inflationRate: 0 },
      { id: 2, name: "Late", yearsFromNow: 10, currentCost: 500_000, inflationRate: 0 },
    ],
    targetAge: 90,
  });
  // ₹30L, ₹12L/yr, ₹1L goal at year 1 → runs out in year 3.
  assert(!r.lastsToTargetAge, "plan fails");
  const late = r.expenseFundings.find((f) => f.expenseName === "Late");
  assert(late !== undefined, "late goal still listed");
  assert(late?.afterDepletion === true && late.shortfall === 500_000, "late goal flagged unpaid");
}

section("[32] Real return uses the Fisher formula; withdrawal rate reported");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 30_000_000, return: 12 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    postRetirementBuckets: [
      { id: 1, name: "Debt", allocationPct: 50, return: 7 },
      { id: 2, name: "Eq", allocationPct: 50, return: 11 },
    ],
    targetAge: 90,
  });
  eq(r.realReturn, (1.12 / 1.06 - 1) * 100, 1e-12, "real = 1.12/1.06 − 1, not 12 − 6");
  eq(r.postRetirementReturn, 9, 1e-12, "post-retirement blended return");
  eq(r.postRetirementRealReturn, (1.09 / 1.06 - 1) * 100, 1e-12, "post-retirement real");
  eq(r.initialWithdrawalRate, 1_200_000 / 30_000_000, 1e-12, "withdrawal rate 4%");
}

section("[33] MC honours per-bucket volatility (an FD does not swing like equity)");
{
  // Same plan, default volatility 15%.  With the FD bucket marked as 0%
  // volatility and no inflation noise, every path is the deterministic one.
  const base = {
    currentAge: 60,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 120_000,
    expenseType: "monthly" as const,
    investmentBuckets: [{ id: 1, name: "FD", amount: 45_000_000, return: 7.5, volatility: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
    portfolioVolatility: 15,
    inflationVolatility: 0,
    iterations: 300,
    seed: 3,
  };
  const det = calculateRetirement(base);
  const fd = runMonteCarloSimulation({
    ...base,
    postRetirementBuckets: [{ id: 1, name: "FD", allocationPct: 100, return: 7.5, volatility: 0 }],
  });
  const p80 = fd.percentiles.find((p) => p.age === 80)!;
  assert(det.lastsToTargetAge && p80.p50 > 0, "scenario is solvent at 80");
  eq(p80.p10, p80.p90, 1e-12, "no spread at all");
  eq(fd.successRate, det.lastsToTargetAge ? 1 : 0, 0, "success rate = deterministic verdict");
  // Leaving the volatility blank falls back to the default 15%.
  const blank = runMonteCarloSimulation({
    ...base,
    postRetirementBuckets: [{ id: 1, name: "FD", allocationPct: 100, return: 7.5 }],
  });
  const b80 = blank.percentiles.find((p) => p.age === 80)!;
  assert(b80.p90 > b80.p10 * 1.5, "blank volatility uses the default");
}

section("[34] MC median path matches the CAGR you entered");
{
  // One lump sum, no flows: deterministic = P × 1.12^30.  Before the fix the
  // MC median was ~26% lower (arithmetic-mean draws + volatility drag).
  const mc = runMonteCarloSimulation({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 1_000_000, return: 12, volatility: 16 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 61,
    portfolioVolatility: 16,
    inflationVolatility: 0,
    iterations: 6000,
    seed: 1,
  });
  const p60 = mc.percentiles.find((p) => p.age === 60)!;
  eq(p60.p50, 1_000_000 * Math.pow(1.12, 30), 0.04, "MC P50 ≈ P × 1.12^30");
}

section("[35] MC yearly return has the volatility the user typed");
{
  // One year, one bucket at 10% ± 20%.  Sample stdev of the yearly factor
  // should be ≈ 0.20 and the median ≈ 1.10.
  let seed = 12345;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const factors: number[] = [];
  for (let i = 0; i < 40_000; i++) {
    const sim = simulateRetirementPath(
      {
        currentAge: 59,
        retirementAge: 60,
        inflation: 0,
        monthlyExpenses: 0,
        expenseType: "yearly",
        investmentBuckets: [{ id: 1, name: "X", amount: 1, return: 10, volatility: 20 }],
        monthlySavingsBuckets: [],
        oneTimeExpenses: [],
        targetAge: 61,
      },
      { rng, portfolioVolatility: 0, inflationVolatility: 0 },
    );
    factors.push(sim.corpusAtRetirement);
  }
  const mean = factors.reduce((a, b) => a + b, 0) / factors.length;
  const sd = Math.sqrt(factors.reduce((a, b) => a + (b - mean) ** 2, 0) / (factors.length - 1));
  const median = factors.slice().sort((a, b) => a - b)[factors.length / 2];
  // eq() is absolute below 1, so check the relative error explicitly: a
  // naive s = vol/100 gives sd ≈ 0.227 (+13%) and must fail here.
  assert(Math.abs(sd / 0.2 - 1) < 0.02, `stdev of yearly factor ${sd.toFixed(4)} within 2% of 0.20`);
  eq(median, 1.1, 0.01, "median yearly factor");
  assert(Math.min(...factors) > 0, "never loses more than 100%");
}

section("[36] MC success = living costs funded until target age");
{
  // Deterministically runs out at ~92: inside the +5y simulation buffer but
  // after the target age of 90.  That is a success, not a failure.
  const params = {
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly" as const,
    investmentBuckets: [{ id: 1, name: "A", amount: 38_400_000, return: 0, volatility: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  };
  const det = calculateRetirement(params);
  eq(det.survivalAge, 92, 1e-9, "deterministic survival 92");
  assert(det.lastsToTargetAge && !det.corpusLastsBeyondHorizon, "lasts to 90, not to 95");
  const mc = runMonteCarloSimulation({
    ...params,
    portfolioVolatility: 0,
    inflationVolatility: 0,
    iterations: 50,
    seed: 1,
  });
  eq(mc.successRate, 1, 0, "counted as success");
}

section("[37] MC 'today's money' bands deflate each path by its own inflation");
{
  const mc = runMonteCarloSimulation({
    currentAge: 30,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 1_000_000, return: 6, volatility: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 70,
    portfolioVolatility: 0,
    inflationVolatility: 0,
    iterations: 20,
    seed: 1,
  });
  const real50 = mc.realPercentiles.find((p) => p.age === 50)!;
  eq(real50.p50, 1_000_000, 1e-9, "6% return vs 6% inflation keeps real value flat");
}

// ---------------------------------------------------------------------------
// ROUND-2 REGRESSIONS: behaviours an adversarial mutation pass showed the
// suite did not pin (each block names the mutant it kills).
// ---------------------------------------------------------------------------

// Worst relative error of corpus_t = corpus_{t−1} + contributions + growth
// − living costs paid − one-time paid, over every simulated year.
const ledgerWorst = (r: RetirementCalculationsResult): number => {
  let prev = r.startingCorpus;
  let worst = 0;
  for (const s of r.yearlyData) {
    const oneTimePaid = r.expenseFundings
      .filter((f) => f.yearsFromNow === s.year)
      .reduce((a, f) => a + f.drainedFromLinked + f.drainedFromMain, 0);
    const implied =
      prev + s.contributions + s.growth + s.incomeReceived - s.regularExpenses - oneTimePaid - s.taxPaid;
    worst = Math.max(worst, Math.abs(implied - s.corpus) / Math.max(1, Math.abs(s.corpus), prev));
    prev = s.corpus;
  }
  return worst;
};

section("[38] Goal due in the depletion year: listed exactly once, as unpaid");
{
  // ₹30L, ₹1L/month, no growth.  Year 1: 12L + 1L goal → 17L.  Year 2 → 5L.
  // Year 3: five months, then out.  The year-3 goal is due at the END of
  // year 3, after the money ran out.  Kills: `>=` → `>` (goal dropped),
  // processing goals in the depletion year (double count), pushing the
  // unpaid list twice.
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 3_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [
      { id: 1, name: "Y1", yearsFromNow: 1, currentCost: 100_000, inflationRate: 0 },
      { id: 2, name: "Y3", yearsFromNow: 3, currentCost: 200_000, inflationRate: 0 },
      { id: 3, name: "Y10", yearsFromNow: 10, currentCost: 500_000, inflationRate: 0 },
      // Age 100: beyond the simulated horizon (95), so never listed.
      { id: 4, name: "Y40", yearsFromNow: 40, currentCost: 500_000, inflationRate: 0 },
    ],
    targetAge: 90,
  });
  eq(r.survivalAge, 62 + 5 / 12, 1e-9, "runs out five months into year 3");
  eq(r.expenseFundings.length, 3, 0, "three goals in the horizon, three entries");
  assert(!r.futureOneTimeExpenses.find((e) => e.id === 4)!.withinHorizon, "age-100 goal flagged outside horizon");
  for (const id of [1, 2, 3]) {
    eq(r.expenseFundings.filter((f) => f.expenseId === id).length, 1, 0, `goal ${id} listed once`);
  }
  const y3 = r.expenseFundings.find((f) => f.expenseId === 2)!;
  assert(y3.afterDepletion === true && y3.drainedFromMain === 0, "depletion-year goal unpaid");
  assert(r.expenseFundings.find((f) => f.expenseId === 1)!.afterDepletion !== true, "earlier goal paid");
}

section("[39] Main corpus empty: living costs draw on goal savings before 'runs out'");
{
  // Retire in a year.  ₹10L main corpus, plus a ₹1L/month SIP for that year
  // (₹12L) linked to a ₹5L goal at age 69.  No growth, no inflation, so the
  // pool holds back exactly ₹5L and ₹7L joins the main corpus (₹17L).
  // Living costs ₹1L/month: main pays 17 months, the pool the next 5, so
  // the money lasts 22 months, not 17.  The goal is then unpaid.
  const r = calculateRetirement({
    currentAge: 59,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Main", amount: 1_000_000, return: 0 }],
    monthlySavingsBuckets: [{ id: 1, name: "Goal SIP", amount: 100_000, return: 0 }],
    oneTimeExpenses: [
      { id: 1, name: "Goal", yearsFromNow: 10, currentCost: 500_000, inflationRate: 0, linkedSavingsBucketId: 1 },
    ],
    targetAge: 90,
  });
  eq(r.earmarkedAtRetirement, 500_000, 1e-12, "₹5L earmarked (the goal's cost)");
  eq(r.mainCorpusAtRetirement, 1_700_000, 1e-12, "₹17L main corpus");
  eq(r.survivalAge, 60 + 22 / 12, 1e-9, "lasts 22 months");
  const yr2 = r.yearlyData.find((s) => s.year === 2)!; // first retired year
  const yr3 = r.yearlyData.find((s) => s.year === 3)!;
  eq(yr2.livingCostsFromEarmarked, 0, 0, "main pays all of year 1");
  eq(yr3.livingCostsFromEarmarked, 500_000, 1e-9, "five months from goal savings in year 2");
  const goal = r.expenseFundings.find((f) => f.expenseId === 1)!;
  assert(goal.afterDepletion === true, "goal unpaid once everything is gone");
  assert(ledgerWorst(r) < 1e-9, "ledger holds with pool-funded living costs");
}

section("[40] A linked goal beyond the horizon does not lock its SIP away");
{
  // Plan to 85 (simulated to 90).  The SIP is linked to a goal at age 109,
  // which is outside the plan, so its balance is ordinary retirement money.
  const r = calculateRetirement({
    currentAge: 59,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Main", amount: 0, return: 0 }],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 100_000, return: 0 }],
    oneTimeExpenses: [
      { id: 1, name: "Far", yearsFromNow: 50, currentCost: 100_000, inflationRate: 0, linkedSavingsBucketId: 1 },
    ],
    targetAge: 85,
  });
  eq(r.earmarkedAtRetirement, 0, 0, "nothing earmarked");
  eq(r.mainCorpusAtRetirement, 1_200_000, 1e-12, "SIP balance is main corpus");
  // A goal exactly at the last simulated age (90 = 85 + 5) is still in.
  const atEdge = calculateRetirement({
    currentAge: 59,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Main", amount: 1_000_000, return: 0 }],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 100_000, return: 0 }],
    oneTimeExpenses: [
      { id: 1, name: "Edge", yearsFromNow: 31, currentCost: 100_000, inflationRate: 0, linkedSavingsBucketId: 1 },
    ],
    targetAge: 85,
  });
  eq(atEdge.earmarkedAtRetirement, 100_000, 1e-12, "goal at the horizon still holds back its cost");
  eq(atEdge.expenseFundings.filter((f) => f.expenseId === 1).length, 1, 0, "and is paid");
}

section("[41] Today's-money bands use each path's own inflation");
{
  // Asset is certain (vol 0) so nominal values are identical on every path;
  // only inflation varies.  Real values must therefore spread.  Kills
  // deflating by deterministic inflation, and ignoring inflation volatility.
  const mc = runMonteCarloSimulation({
    currentAge: 30,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 1_000_000, return: 8, volatility: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 61,
    portfolioVolatility: 15,
    inflationVolatility: 2,
    iterations: 2000,
    seed: 5,
  });
  const n60 = mc.percentiles.find((p) => p.age === 60)!;
  const r60 = mc.realPercentiles.find((p) => p.age === 60)!;
  eq(n60.p10, n60.p90, 1e-12, "nominal: no spread");
  assert(r60.p90 > r60.p10 * 1.15, "real: spread from inflation alone");
  eq(r60.p50, (1_000_000 * Math.pow(1.08, 30)) / Math.pow(1.06, 30), 0.03, "real median ≈ nominal / 1.06^30");
}

section("[42] Withdrawal rate = retirement-date spend / corpus excluding earmarked");
{
  // Kills: using today's spend, and dividing by the total incl. earmarked.
  const r = calculateRetirement({
    currentAge: 50,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Eq", amount: 10_000_000, return: 8 }],
    monthlySavingsBuckets: [{ id: 1, name: "Goal SIP", amount: 10_000, return: 8 }],
    oneTimeExpenses: [
      { id: 1, name: "Trip", yearsFromNow: 15, currentCost: 500_000, inflationRate: 6, linkedSavingsBucketId: 1 },
    ],
    targetAge: 90,
  });
  // Main corpus = equity + the SIP minus what the trip needs (its cost at
  // age 65, 500K × 1.06^15, discounted 5 years at the SIP's 8%).
  const m8 = monthlyRate(8);
  const sip = 10_000 * ((Math.pow(1 + m8, 120) - 1) / m8);
  const held = (500_000 * Math.pow(1.06, 15)) / Math.pow(1.08, 5);
  eq(r.earmarkedAtRetirement, held, 1e-12, "trip's present value held back");
  const main = 10_000_000 * Math.pow(1.08, 10) + sip - held;
  const expected = (600_000 * Math.pow(1.06, 10)) / main;
  eq(r.initialWithdrawalRate, expected, 1e-12, "6L × 1.06^10 / main corpus");
}

section("[43] 'Bad case' age is the 10th percentile of depletion ages");
{
  const mc = runMonteCarloSimulation({
    currentAge: 60,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 150_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Mix", amount: 40_000_000, return: 10, volatility: 14 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
    portfolioVolatility: 14,
    inflationVolatility: 1.5,
    iterations: 1500,
    seed: 21,
  });
  const sorted = mc.depletionAges.slice().sort((a, b) => a - b);
  const idx = (sorted.length - 1) * 0.1;
  const lo = Math.floor(idx);
  const p10 = sorted[lo] + (sorted[Math.ceil(idx)] - sorted[lo]) * (idx - lo);
  assert(mc.successRate < 0.9, `scenario has failures (success ${(mc.successRate * 100).toFixed(0)}%)`);
  eq(mc.p10DepletionAge, p10, 1e-12, "p10DepletionAge = P10 of depletion ages");
  assert(mc.p10DepletionAge < mc.medianDepletionAge || mc.medianDepletionAge === 90, "P10 below median");
}

section("[44] Glide path also lowers volatility (and never raises it)");
{
  const run = (sip: { volatility: number; glide: boolean }) =>
    runMonteCarloSimulation({
      currentAge: 30,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "monthly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        {
          id: 1,
          name: "SIP",
          amount: 10_000,
          return: 12,
          volatility: sip.volatility,
          ...(sip.glide ? { targetRate: 12, glideYears: 4 } : {}),
        },
      ],
      // Cost 0: the goal only anchors the glide window (years 7 to 10).
      oneTimeExpenses: [
        { id: 1, name: "Goal", yearsFromNow: 10, currentCost: 0, inflationRate: 0, linkedSavingsBucketId: 1 },
      ],
      targetAge: 61,
      portfolioVolatility: 0,
      inflationVolatility: 0,
      iterations: 3000,
      seed: 8,
    });
  // targetRate = return, so the glide changes ONLY volatility: any change
  // in spread is the volatility blend.
  const spread = (m: ReturnType<typeof run>) => {
    const p = m.percentiles.find((x) => x.age === 40)!;
    return Math.log(p.p90 / p.p10);
  };
  const high = spread(run({ volatility: 16, glide: false }));
  const highGlide = spread(run({ volatility: 16, glide: true }));
  assert(highGlide < 0.7 * high, `16% vol: glide narrows the band (${highGlide.toFixed(3)} vs ${high.toFixed(3)})`);
  const low = spread(run({ volatility: 1, glide: false }));
  const lowGlide = spread(run({ volatility: 1, glide: true }));
  assert(lowGlide <= low + 1e-12, `1% vol: glide does not raise it (${lowGlide.toFixed(4)} vs ${low.toFixed(4)})`);
}

section("[45] Age sanitising: rounding, ordering, caps; MC uses the same ages");
{
  const a = sanitizeAges({ currentAge: 30.4, retirementAge: 59.6, targetAge: 59 });
  assert(a.currentAge === 30 && a.retirementAge === 60 && a.targetAge === 61 && a.horizonAge === 66, "rounded + target pushed past retirement");
  const b = sanitizeAges({ currentAge: 70, retirementAge: 60, targetAge: 65 });
  assert(b.retirementAge === 70 && b.targetAge === 71, "retired already; plan age follows");
  const c = sanitizeAges({ currentAge: 30, retirementAge: 600, targetAge: 900 });
  assert(c.retirementAge === 110 && c.targetAge === 120, "typos capped");
  const params = {
    currentAge: 30.4,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 40_000,
    expenseType: "monthly" as const,
    investmentBuckets: [{ id: 1, name: "A", amount: 5_000_000, return: 10 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  };
  const det = calculateRetirement(params);
  const mc = runMonteCarloSimulation({ ...params, portfolioVolatility: 0, inflationVolatility: 0, iterations: 5, seed: 1 });
  eq(mc.percentiles[0].age, 30, 0, "MC starts at the rounded age");
  eq(mc.percentiles.find((p) => p.age === 75)!.p50, det.yearlyData.find((d) => d.age === 75)!.corpus, 1e-12, "MC ≡ det at 75");
}

section("[46] Volatility 0 is honoured for SIPs, earmarked pools and the fallback");
{
  const base = {
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly" as const,
    portfolioVolatility: 15,
    inflationVolatility: 0,
    iterations: 400,
    seed: 2,
  };
  const noSpread = (m: ReturnType<typeof runMonteCarloSimulation>, age: number) => {
    const p = m.percentiles.find((x) => x.age === age)!;
    return p.p90 > 0 && Math.abs(p.p90 - p.p10) / p.p90 < 1e-12;
  };
  const sip = runMonteCarloSimulation({
    ...base,
    currentAge: 40,
    retirementAge: 50,
    investmentBuckets: [],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 10, volatility: 0 }],
    oneTimeExpenses: [],
    targetAge: 60,
  });
  assert(noSpread(sip, 50), "SIP with volatility 0");
  const pool = runMonteCarloSimulation({
    ...base,
    currentAge: 40,
    retirementAge: 50,
    investmentBuckets: [],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 10, volatility: 0 }],
    oneTimeExpenses: [
      { id: 1, name: "Late", yearsFromNow: 18, currentCost: 0, inflationRate: 0, linkedSavingsBucketId: 1 },
    ],
    targetAge: 70,
  });
  assert(noSpread(pool, 55), "earmarked pool inherits volatility 0");
  const fallback = runMonteCarloSimulation({
    ...base,
    currentAge: 50,
    retirementAge: 55,
    investmentBuckets: [{ id: 1, name: "FD", amount: 1_000_000, return: 7, volatility: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 80,
  });
  assert(noSpread(fallback, 70), "no allocation → fallback keeps volatility 0");
}

section("[47] Survival age resolves within the month");
{
  // ₹12.5L at 0% paying ₹1L/month: 12 full months, then half a month.
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 1_250_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  eq(r.survivalAge, 60 + 12.5 / 12, 1e-9, "12.5 months");
}

section("[48] Ledger holds in the year the money runs out");
{
  // Living costs reported for the depletion year are what was actually paid.
  const r = calculateRetirement({
    currentAge: 55,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 120_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 15_000_000, return: 9 }],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 20_000, return: 11 }],
    oneTimeExpenses: [
      { id: 1, name: "Roof", yearsFromNow: 8, currentCost: 700_000, inflationRate: 6 },
    ],
    postRetirementBuckets: [
      { id: 1, name: "Debt", allocationPct: 40, return: 7 },
      { id: 2, name: "Eq", allocationPct: 60, return: 11 },
    ],
    targetAge: 90,
  });
  assert(!r.lastsToTargetAge, "scenario depletes");
  const last = r.yearlyData[r.yearlyData.length - 1];
  assert(ledgerWorst(r) < 1e-9, `ledger identity every year (worst ${ledgerWorst(r).toExponential(1)})`);
  assert(last.corpus === 0, "nothing left at the end");
}

section("[49] Goal inflation at or below -100% cannot make a cost negative");
{
  const r = calculateRetirement({
    currentAge: 40,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 10_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 5_000_000, return: 8 }],
    monthlySavingsBuckets: [],
    // (1 − 1.5)^n is negative for odd n: one goal before and one after
    // retirement (the two phases pay goals through different code).
    oneTimeExpenses: [
      { id: 1, name: "Odd pre", yearsFromNow: 3, currentCost: 100_000, inflationRate: -150 },
      { id: 2, name: "Odd post", yearsFromNow: 25, currentCost: 100_000, inflationRate: -150 },
    ],
    targetAge: 90,
  });
  eq(r.expenseFundings.length, 2, 0, "both goals reported");
  for (const f of r.expenseFundings) {
    assert(f.futureValue >= 0 && f.shortfall >= 0 && f.drainedFromMain >= 0, `${f.expenseName}: no negative amounts`);
  }
}

section("[50] Pool raid with real returns: matches an independent month loop");
{
  // Retire in a year.  Main: ₹10L at 8%.  Two SIPs (₹50K/month at 6% and at
  // 10%) earmarked for goals at 74 and 79.  Living costs ₹1L/month today,
  // 6% inflation.  Main runs out part-way through a month, the pools then
  // pay pro-rata, and everything runs out in year 2 of retirement.  The
  // reference below is written from the stated rules, not from the engine.
  const r = calculateRetirement({
    currentAge: 59,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "Main", amount: 1_000_000, return: 8 }],
    monthlySavingsBuckets: [
      { id: 1, name: "A", amount: 50_000, return: 6 },
      { id: 2, name: "B", amount: 50_000, return: 10 },
    ],
    oneTimeExpenses: [
      { id: 1, name: "Goal A", yearsFromNow: 15, currentCost: 500_000, inflationRate: 0, linkedSavingsBucketId: 1 },
      { id: 2, name: "Goal B", yearsFromNow: 20, currentCost: 500_000, inflationRate: 0, linkedSavingsBucketId: 2 },
    ],
    targetAge: 90,
  });
  const q = (pct: number) => Math.pow(1 + pct / 100, 1 / 12);
  const sipFV = (pct: number) => {
    let fv = 0;
    for (let j = 0; j < 12; j++) fv += 50_000 * Math.pow(1 + pct / 100, j / 12);
    return fv;
  };
  // At retirement each pool holds back its goal's present value (₹5L
  // discounted 14 / 19 years at 6% / 10%); the rest joins the main corpus.
  // With no allocation set, the main corpus earns the value-weighted mix of
  // everything at retirement.
  const sipA = sipFV(6);
  const sipB = sipFV(10);
  let poolA = Math.min(sipA, 500_000 / Math.pow(1.06, 14));
  let poolB = Math.min(sipB, 500_000 / Math.pow(1.1, 19));
  const eqty = 1_000_000 * 1.08;
  const mainRate = (eqty * 8 + sipA * 6 + sipB * 10) / (eqty + sipA + sipB);
  let main = eqty + (sipA - poolA) + (sipB - poolB);
  let w = 100_000 * 1.06;
  let survival = NaN;
  let transitionWasPartial = false;
  const years: { corpus: number; paid: number; fromPools: number }[] = [];
  for (let k = 1; k <= 35 && Number.isNaN(survival); k++) {
    let paid = 0;
    let fromPools = 0;
    for (let m = 0; m < 12; m++) {
      if (main >= w) {
        main -= w;
        paid += w;
      } else {
        if (main > 0) transitionWasPartial = true;
        const need = w - main;
        const pt = poolA + poolB;
        if (pt >= need) {
          poolA -= (need * poolA) / pt;
          poolB -= (need * poolB) / pt;
          paid += w;
          fromPools += need;
          main = 0;
        } else {
          survival = 60 + (k - 1) + (m + (main + pt) / w) / 12;
          paid += main + pt;
          fromPools += pt;
          main = poolA = poolB = 0;
          break;
        }
      }
      main *= q(mainRate);
      poolA *= q(6);
      poolB *= q(10);
      w *= q(6);
    }
    years.push({ corpus: main + poolA + poolB, paid, fromPools });
  }
  assert(transitionWasPartial, "main runs out part-way through a month");
  eq(r.survivalAge, survival, 1e-10, "survival age");
  const retired = r.yearlyData.filter((s) => s.isRetired);
  eq(retired.length, years.length, 0, "same number of retired years");
  years.forEach((y, i) => {
    const s = retired[i];
    eq(s.corpus, y.corpus, 1e-9, `age ${s.age}: corpus`);
    eq(s.regularExpenses, y.paid, 1e-9, `age ${s.age}: living costs paid`);
    eq(s.livingCostsFromEarmarked, y.fromPools, 1e-9, `age ${s.age}: of which from goal savings`);
  });
  assert(ledgerWorst(r) < 1e-9, "ledger conserves money (growth tracked per bucket)");
}

section("[51] Deflation is floored at -5% in the simulation and the real return");
{
  const r = calculateRetirement({
    currentAge: 50,
    retirementAge: 60,
    inflation: -10,
    monthlyExpenses: 10_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 5_000_000, return: 8 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  eq(r.inflation, -5, 0, "effective inflation");
  eq(r.yearlyData[0].inflationIndex, 0.95, 1e-12, "price level after one year");
  eq(r.realReturn, (1.08 / 0.95 - 1) * 100, 1e-12, "real return uses the floor");
}

section("[52] A pool's leftover rejoins the main corpus by mix, or by allocation if empty");
{
  // On the expected path a right-sized pool ends at zero, so leftovers only
  // happen when the pool beats its expected return.  A scripted random
  // stream makes every year exactly a +1σ market year (z = 1).
  const zOne = () => {
    let i = 0;
    return () => (i++ % 2 === 0 ? Math.exp(-0.5) : 0); // Box-Muller → z = 1
  };
  // Gross factor of a 0%-return, 10%-volatility asset in a z = 1 year:
  // exp(s) with s chosen so the factor's stdev is 0.10 (see grossFactor).
  const x = (1 + Math.sqrt(1 + 4 * 0.1 * 0.1)) / 2;
  const G = Math.exp(Math.sqrt(Math.log(x)));
  let sipFV = 0;
  for (let j = 0; j < 12; j++) sipFV += 100_000 * Math.pow(G, j / 12);
  const sip = [{ id: 1, name: "SIP", amount: 100_000, return: 0, volatility: 10 }];
  const opts = (rng: () => number) => ({ rng, portfolioVolatility: 0, inflationVolatility: 0 });

  // (a) The goal costs exactly the SIP's balance, so the whole SIP is held
  //     back and the main corpus starts empty.  Two +1σ years later the
  //     pool has sipFV × (G² − 1) left, split 25/75 by the allocation.
  const empty = simulateRetirementPath(
    {
      currentAge: 59,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "monthly",
      investmentBuckets: [],
      monthlySavingsBuckets: sip,
      oneTimeExpenses: [
        { id: 1, name: "Goal", yearsFromNow: 3, currentCost: sipFV, inflationRate: 0, linkedSavingsBucketId: 1 },
      ],
      postRetirementBuckets: [
        { id: 1, name: "Cash", allocationPct: 25, return: 0, volatility: 0 },
        { id: 2, name: "Eq", allocationPct: 75, return: 10, volatility: 0 },
      ],
      targetAge: 80,
    },
    opts(zOne()),
  );
  const leftA = sipFV * (G * G - 1);
  assert(empty.mainCorpusAtRetirement < 1e-6, "(a) main corpus starts empty");
  eq(empty.expenseFundings[0].surplusRolledOver!, leftA, 1e-9, "(a) surplus reported");
  eq(empty.steps.find((s) => s.year === 4)!.corpus, leftA * 0.25 + leftA * 0.75 * 1.1, 1e-9, "(a) split by allocation");

  // (b) ₹10L main corpus, 50/50 at 0% and 10%, drifts for five years; the
  //     pool's leftover sipFV × (G⁵ − 1) then follows the current mix.
  const drifted = simulateRetirementPath(
    {
      currentAge: 59,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "monthly",
      investmentBuckets: [{ id: 1, name: "Main", amount: 1_000_000, return: 0, volatility: 0 }],
      monthlySavingsBuckets: sip,
      oneTimeExpenses: [
        { id: 1, name: "Goal", yearsFromNow: 6, currentCost: sipFV, inflationRate: 0, linkedSavingsBucketId: 1 },
      ],
      postRetirementBuckets: [
        { id: 1, name: "Cash", allocationPct: 50, return: 0, volatility: 0 },
        { id: 2, name: "Eq", allocationPct: 50, return: 10, volatility: 0 },
      ],
      targetAge: 80,
    },
    opts(zOne()),
  );
  const leftB = sipFV * (Math.pow(G, 5) - 1);
  const cash = 500_000;
  const eqty = 500_000 * Math.pow(1.1, 5);
  const t = cash + eqty;
  const expected = cash + (leftB * cash) / t + (eqty + (leftB * eqty) / t) * 1.1;
  eq(drifted.steps.find((s) => s.year === 7)!.corpus, expected, 1e-9, "(b) split by current mix");
}

// ---------------------------------------------------------------------------
// NEW FEATURES (Nov 2026): step-up, income, phases, healthcare, tax,
// withdrawal strategies, right-sized earmarks, realistic Monte Carlo.
// ---------------------------------------------------------------------------

// Deterministic linear-congruential stream for sampling tests.
const lcg = (seed: number) => {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
};

section("[53] SIP step-up: a growing annuity");
{
  // ₹10K/month rising 10% a year, 12% CAGR, 20 years:
  //   Σ_y 10K·1.1^(y−1) · A · 1.12^(20−y),  A = Σ_{j=0}^{11} 1.12^(j/12)
  const r = calculateRetirement({
    currentAge: 40,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 12, stepUpPct: 10 }],
    oneTimeExpenses: [],
    targetAge: 90,
  });
  let A = 0;
  for (let j = 0; j < 12; j++) A += Math.pow(1.12, j / 12);
  let fv = 0;
  for (let y = 1; y <= 20; y++) fv += 10_000 * Math.pow(1.1, y - 1) * A * Math.pow(1.12, 20 - y);
  eq(r.corpusAtRetirement, fv, 1e-12, "corpus at retirement");
  eq(r.yearlyData[4].contributions, 120_000 * Math.pow(1.1, 4), 1e-12, "year-5 contributions");
}

section("[54] Income streams: fixed, indexed + taxed, custom growth, start/end ages");
{
  // (a) ₹1L/month costs, ₹40K fixed pension, ₹60L at 0%: lasts 100 months.
  const a = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 6_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    incomeStreams: [{ id: 1, name: "Pension", monthlyAmount: 40_000, startAge: 60, growth: "fixed" }],
    targetAge: 90,
  });
  eq(a.survivalAge, 60 + 100 / 12, 1e-9, "(a) survival with a pension");
  eq(a.annualIncomeAtRetirement, 480_000, 1e-12, "(a) income at retirement");
  eq(a.initialWithdrawalRate, (1_200_000 - 480_000) / 6_000_000, 1e-12, "(a) net withdrawal rate");

  // (b) 6% inflation, 0% return.  Rent ₹50K/month today's money, indexed,
  //     taxed at 30%, ages 65 to 75; annuity ₹20K growing 3%/yr for life;
  //     part-time ₹30K fixed until 62.  Month-by-month reference.
  const b = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 20_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    tax: { incomeTaxRate: 30, ltcgRate: 12.5, ltcgExemption: 125_000 },
    incomeStreams: [
      { id: 1, name: "Rent", monthlyAmount: 50_000, startAge: 65, endAge: 75, growth: "inflation", taxable: true },
      { id: 2, name: "Annuity", monthlyAmount: 20_000, startAge: 60, growth: "custom", growthRate: 3 },
      { id: 3, name: "Part-time", monthlyAmount: 30_000, startAge: 60, endAge: 62, growth: "fixed" },
    ],
    targetAge: 90,
  });
  let corpus = 20_000_000;
  for (let k = 1; k <= 16; k++) {
    const age = 60 + k - 1;
    let income = 0;
    for (let m = 0; m < 12; m++) {
      const t = k - 1 + m / 12;
      let inc = 20_000 * Math.pow(1.03, t);
      if (age < 62) inc += 30_000;
      if (age >= 65 && age < 75) inc += 50_000 * 0.7 * Math.pow(1.06, t);
      income += inc;
      corpus -= 100_000 * Math.pow(1.06, t) - inc;
    }
    const s = b.yearlyData[k - 1];
    eq(s.incomeReceived, income, 1e-12, `(b) age ${age}: income`);
    eq(s.corpus, corpus, 1e-12, `(b) age ${age}: corpus`);
  }

  // (c) Income above costs is invested: ₹2L pension, ₹1L costs, 0% return.
  const c = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 1_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    incomeStreams: [{ id: 1, name: "Pension", monthlyAmount: 200_000, startAge: 60, growth: "fixed" }],
    targetAge: 90,
  });
  eq(c.yearlyData[2].corpus, 1_000_000 + 3 * 1_200_000, 1e-12, "(c) spare income invested");
  assert(ledgerWorst(a) < 1e-9 && ledgerWorst(b) < 1e-9 && ledgerWorst(c) < 1e-9, "ledger holds with income");
}

section("[55] Spending phases change base spending by age");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 30_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    spendingPhases: [
      { id: 2, fromAge: 80, percentOfBase: 60 },
      { id: 1, fromAge: 70, percentOfBase: 80 },
    ],
    targetAge: 90,
  });
  eq(r.yearlyData.find((s) => s.age === 70)!.regularExpenses, 1_200_000, 1e-12, "age 69-70: 100%");
  eq(r.yearlyData.find((s) => s.age === 71)!.regularExpenses, 960_000, 1e-12, "age 70-71: 80%");
  eq(r.yearlyData.find((s) => s.age === 81)!.regularExpenses, 720_000, 1e-12, "age 80-81: 60%");
  eq(r.yearlyData.find((s) => s.age === 90)!.corpus, 30_000_000 - 12_000_000 - 9_600_000 - 7_200_000, 1e-12, "corpus at 90");
}

section("[56] Healthcare: its own inflation, from its start age");
{
  // ₹10K/month today at 10% medical inflation (6% general), from age 65.
  const r = calculateRetirement({
    currentAge: 55,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 100_000_000, return: 8 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    healthcare: { monthlyCost: 10_000, inflation: 10, startAge: 65 },
    targetAge: 90,
  });
  const yearHealth = (startAge: number) => {
    let h = 0;
    for (let j = 0; j < 12; j++) h += 10_000 * Math.pow(1.1, startAge - 55 + j / 12);
    return h;
  };
  eq(r.yearlyData.find((s) => s.age === 65)!.healthcareExpenses, 0, 0, "none before 65");
  eq(r.yearlyData.find((s) => s.age === 66)!.healthcareExpenses, yearHealth(65), 1e-12, "age 65-66");
  eq(r.yearlyData.find((s) => s.age === 76)!.healthcareExpenses, yearHealth(75), 1e-12, "age 75-76");
  const base = (startAge: number) => {
    let b = 0;
    for (let j = 0; j < 12; j++) b += 50_000 * Math.pow(1.06, startAge - 55 + j / 12);
    return b;
  };
  eq(r.yearlyData.find((s) => s.age === 76)!.regularExpenses, base(75) + yearHealth(75), 1e-12, "spend = base + health");
  eq(r.annualExpensesAtRetirement, 600_000 * Math.pow(1.06, 5), 1e-12, "no healthcare yet at 60");
}

// Reference for one taxable bucket: retire with V (cost B), withdraw w a
// month, grow at q a month; returns per-year {tax, corpus}.
const taxReference = (
  V0: number,
  B0: number,
  w: number,
  rate: number,
  years: number,
  taxOf: (gains: number, accrued: number) => number,
  yearly: boolean,
) => {
  const q = Math.pow(1 + rate, 1 / 12);
  let V = V0;
  let B = B0;
  let carried = 0; // gain realised paying last year's tax
  const out: { tax: number; corpus: number }[] = [];
  for (let y = 0; y < years; y++) {
    let gains = carried;
    let accrued = 0;
    for (let m = 0; m < 12; m++) {
      gains += w * (1 - B / V);
      B -= (B * w) / V;
      V -= w;
      accrued += V * (q - 1);
      V *= q;
    }
    if (yearly) B = V;
    const tax = taxOf(gains, accrued);
    carried = yearly ? 0 : tax * (1 - B / V);
    B -= (B * tax) / V;
    V -= tax;
    out.push({ tax, corpus: V });
  }
  return out;
};

section("[57] Equity: LTCG on the gain part of withdrawals, above the exemption");
{
  // ₹1Cr today at 10% (after tax) for 10 years, then 100% equity at 10%.
  // Pre-retirement returns are already after tax, so the corpus starts
  // retirement with cost = value: only growth after retirement is taxed.
  // (It used to carry today's ₹1Cr cost forward and tax the pre-retirement
  // growth a second time.)
  const params = (treatment: "equity" | "slabOnSale" | "slabYearly", incomeTaxRate: number) =>
    calculateRetirement({
      currentAge: 50,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 200_000,
      expenseType: "monthly",
      investmentBuckets: [{ id: 1, name: "Eq", amount: 10_000_000, return: 10 }],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: [{ id: 1, name: "Eq", allocationPct: 100, return: 10, taxTreatment: treatment }],
      tax: { incomeTaxRate, ltcgRate: 12.5, ltcgExemption: 125_000 },
      targetAge: 90,
    });
  const V0 = 10_000_000 * Math.pow(1.1, 10);
  const eqRef = taxReference(V0, V0, 200_000, 0.1, 3, (g) => 0.125 * Math.max(0, g - 125_000), false);
  const r = params("equity", 30);
  eqRef.forEach((y, i) => {
    const s = r.yearlyData[10 + i];
    eq(s.taxPaid, y.tax, 1e-9, `equity year ${i + 1}: tax`);
    eq(s.corpus, y.corpus, 1e-9, `equity year ${i + 1}: corpus`);
  });
  assert(ledgerWorst(r) < 1e-9, "ledger holds with tax");

  section("[58] Debt fund (taxed on sale) and FD (taxed yearly) at the income-tax rate");
  const saleRef = taxReference(V0, V0, 200_000, 0.1, 3, (g) => 0.3 * Math.max(0, g), false);
  const sale = params("slabOnSale", 30);
  saleRef.forEach((y, i) => {
    eq(sale.yearlyData[10 + i].taxPaid, y.tax, 1e-9, `on sale year ${i + 1}: tax`);
    eq(sale.yearlyData[10 + i].corpus, y.corpus, 1e-9, `on sale year ${i + 1}: corpus`);
  });
  const yearlyRef = taxReference(V0, V0, 200_000, 0.1, 3, (_g, acc) => 0.3 * Math.max(0, acc), true);
  const fd = params("slabYearly", 30);
  yearlyRef.forEach((y, i) => {
    eq(fd.yearlyData[10 + i].taxPaid, y.tax, 1e-9, `yearly year ${i + 1}: tax on growth`);
    eq(fd.yearlyData[10 + i].corpus, y.corpus, 1e-9, `yearly year ${i + 1}: corpus`);
  });
  const none = params("slabYearly", 0);
  eq(none.yearlyData[10].taxPaid, 0, 0, "0% income tax → no tax");
}

section("[59] Rebalancing yearly vs letting the mix drift");
{
  const run = (strategy: "rebalance" | "proRata") =>
    calculateRetirement({
      currentAge: 60,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "monthly",
      investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0 }],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: [
        { id: 1, name: "Debt", allocationPct: 50, return: 0 },
        { id: 2, name: "Eq", allocationPct: 50, return: 10 },
      ],
      withdrawalStrategy: strategy,
      targetAge: 90,
    });
  eq(run("rebalance").yearlyData[9].corpus, 10_000_000 * Math.pow(1.05, 10), 1e-12, "rebalanced: 1.05^10");
  eq(run("proRata").yearlyData[9].corpus, 5_000_000 + 5_000_000 * Math.pow(1.1, 10), 1e-12, "drifting: 0.5 + 0.5·1.1^10");
}

section("[60] Bucket strategy: spend from cash, refill it from equity after a good year");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    postRetirementBuckets: [
      { id: 2, name: "Eq", allocationPct: 80, return: 12, volatility: 16 },
      { id: 1, name: "Cash", allocationPct: 20, return: 6, volatility: 1 },
    ],
    withdrawalStrategy: "buckets",
    cashBufferYears: 2,
    targetAge: 90,
  });
  const qc = Math.pow(1.06, 1 / 12);
  const qe = Math.pow(1.12, 1 / 12);
  let cash = 2_000_000;
  let eqty = 8_000_000;
  let refilled = false;
  for (let y = 0; y < 6; y++) {
    for (let m = 0; m < 12; m++) {
      const fromCash = Math.min(cash, 50_000);
      cash -= fromCash;
      eqty -= 50_000 - fromCash;
      cash *= qc;
      eqty *= qe;
    }
    const top = 2 * 12 * 50_000 - cash;
    if (top > 0) {
      cash += top;
      eqty -= top;
      refilled = true;
    }
    eq(r.yearlyData[y].corpus, cash + eqty, 1e-12, `year ${y + 1}`);
  }
  assert(refilled, "a refill happened in the window");
}

section("[61] Persistent inflation: same yearly spread, surprises carry over");
{
  const rng = lcg(4242);
  const xs: number[] = [];
  const pairs: [number, number][] = [];
  for (let path = 0; path < 400; path++) {
    const sim = simulateRetirementPath(
      {
        currentAge: 30,
        retirementAge: 60,
        inflation: 6,
        monthlyExpenses: 0,
        expenseType: "monthly",
        investmentBuckets: [],
        monthlySavingsBuckets: [],
        oneTimeExpenses: [],
        targetAge: 90,
      },
      { rng, portfolioVolatility: 0, inflationVolatility: 2, inflationPersistence: 0.7 },
    );
    const inf = sim.steps.map((s, i) => s.inflationIndex / (i === 0 ? 1 : sim.steps[i - 1].inflationIndex) - 1);
    for (let t = 20; t < inf.length; t++) {
      xs.push(inf[t]);
      pairs.push([inf[t - 1], inf[t]]);
    }
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const cov = pairs.reduce((a, [p, c]) => a + (p - mean) * (c - mean), 0) / pairs.length;
  assert(Math.abs(sd / 0.02 - 1) < 0.05, `yearly spread ${(sd * 100).toFixed(2)}% ≈ 2%`);
  assert(Math.abs(cov / (sd * sd) - 0.7) < 0.05, `lag-1 correlation ${(cov / (sd * sd)).toFixed(3)} ≈ 0.7`);
}

section("[62] Fat tails: crisis years are more extreme, the median stays put");
{
  const sample = (fatTails: boolean) => {
    const rng = lcg(777);
    const logs: number[] = [];
    const facs: number[] = [];
    for (let i = 0; i < 40_000; i++) {
      const sim = simulateRetirementPath(
        {
          currentAge: 59,
          retirementAge: 60,
          inflation: 0,
          monthlyExpenses: 0,
          expenseType: "yearly",
          investmentBuckets: [{ id: 1, name: "X", amount: 1, return: 10, volatility: 20 }],
          monthlySavingsBuckets: [],
          oneTimeExpenses: [],
          targetAge: 61,
        },
        { rng, portfolioVolatility: 0, inflationVolatility: 0, fatTails },
      );
      facs.push(sim.corpusAtRetirement);
      logs.push(Math.log(sim.corpusAtRetirement));
    }
    const m = logs.reduce((a, b) => a + b, 0) / logs.length;
    const v = logs.reduce((a, b) => a + (b - m) ** 2, 0) / logs.length;
    const k = logs.reduce((a, b) => a + (b - m) ** 4, 0) / logs.length / (v * v);
    const fm = facs.reduce((a, b) => a + b, 0) / facs.length;
    const sd = Math.sqrt(facs.reduce((a, b) => a + (b - fm) ** 2, 0) / facs.length);
    const median = facs.slice().sort((a, b) => a - b)[facs.length / 2];
    return { k, sd, median };
  };
  const normal = sample(false);
  const fat = sample(true);
  assert(Math.abs(normal.k - 3) < 0.2, `normal kurtosis ${normal.k.toFixed(2)} ≈ 3`);
  assert(fat.k > 5, `fat-tailed kurtosis ${fat.k.toFixed(2)} ≈ 6`);
  // The shock scale is calibrated for the mixture, so volatility stays as
  // entered (it used to come out ~4% high).
  assert(Math.abs(fat.sd / 0.2 - 1) < 0.02, `volatility ${fat.sd.toFixed(3)} ≈ 0.20`);
  eq(fat.median, 1.1, 0.01, "median ≈ 1.10");
}

section("[63] Right-sized earmark follows the glide path's lower rates");
{
  // Goal 3 years after retirement, glide to 6% over 3 years: the pool earns
  // 10%, 8%, 6% in those years, so it must hold 10L / (1.10·1.08·1.06).
  const r = calculateRetirement({
    currentAge: 30,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 12, targetRate: 6, glideYears: 3 }],
    oneTimeExpenses: [
      { id: 1, name: "Goal", yearsFromNow: 33, currentCost: 1_000_000, inflationRate: 0, linkedSavingsBucketId: 1 },
    ],
    targetAge: 90,
  });
  eq(r.earmarkedAtRetirement, 1_000_000 / (1.1 * 1.08 * 1.06), 1e-12, "held back = 10L / (1.10·1.08·1.06)");
  const goal = r.expenseFundings.find((f) => f.expenseId === 1)!;
  eq(goal.drainedFromLinked, 1_000_000, 1e-9, "pool pays the goal exactly");
}

section("[64] Everything at once: money is conserved and MC at zero volatility ≡ deterministic");
{
  const params = {
    currentAge: 45,
    retirementAge: 58,
    inflation: 6,
    monthlyExpenses: 80_000,
    expenseType: "monthly" as const,
    investmentBuckets: [
      { id: 1, name: "Eq", amount: 6_000_000, return: 11 },
      { id: 2, name: "FD", amount: 2_000_000, return: 6.5 },
    ],
    monthlySavingsBuckets: [
      { id: 1, name: "SIP", amount: 40_000, return: 12, stepUpPct: 7 },
      { id: 2, name: "Goal SIP", amount: 15_000, return: 9, targetRate: 7, glideYears: 4 },
    ],
    oneTimeExpenses: [
      { id: 1, name: "Wedding", yearsFromNow: 18, currentCost: 2_500_000, inflationRate: 7, linkedSavingsBucketId: 2 },
      { id: 2, name: "Car", yearsFromNow: 22, currentCost: 1_200_000, inflationRate: 5 },
    ],
    postRetirementBuckets: [
      { id: 1, name: "Cash", allocationPct: 10, return: 6, taxTreatment: "slabYearly" as const },
      { id: 2, name: "Debt", allocationPct: 30, return: 7.5, taxTreatment: "slabOnSale" as const },
      { id: 3, name: "Eq", allocationPct: 60, return: 11, taxTreatment: "equity" as const },
    ],
    incomeStreams: [
      { id: 1, name: "Pension", monthlyAmount: 25_000, startAge: 60, growth: "inflation" as const, taxable: true },
      { id: 2, name: "Consulting", monthlyAmount: 300_000, startAge: 58, endAge: 61, growth: "fixed" as const, taxable: true },
    ],
    spendingPhases: [{ id: 1, fromAge: 75, percentOfBase: 85 }],
    healthcare: { monthlyCost: 8_000, inflation: 10 },
    tax: { incomeTaxRate: 20, ltcgRate: 12.5, ltcgExemption: 125_000 },
    targetAge: 92,
  };
  for (const strategy of ["proRata", "rebalance", "buckets"] as const) {
    const det = calculateRetirement({ ...params, withdrawalStrategy: strategy });
    assert(ledgerWorst(det) < 1e-9, `${strategy}: ledger conserves money`);
    assert(det.yearlyData.some((s) => s.taxPaid > 0) && det.yearlyData.some((s) => s.incomeReceived > s.regularExpenses), `${strategy}: tax and spare income both exercised`);
    const mc = runMonteCarloSimulation({
      ...params,
      withdrawalStrategy: strategy,
      portfolioVolatility: 0,
      inflationVolatility: 0,
      inflationPersistence: 0.7,
      fatTails: true,
      iterations: 5,
      seed: 3,
    });
    let worst = 0;
    for (const d of det.yearlyData) {
      const p = mc.percentiles.find((x) => x.age === d.age);
      if (p) worst = Math.max(worst, Math.abs(p.p50 - d.corpus) / Math.max(1, d.corpus));
    }
    assert(worst < 1e-12, `${strategy}: MC at zero volatility ≡ deterministic (worst ${worst.toExponential(1)})`);
  }
}

// ---------------------------------------------------------------------------
// ROUND-1 FEATURE REVIEW: behaviours the mutation pass found unpinned.
// ---------------------------------------------------------------------------

// Scripted market: every year has the same shock z (via Box-Muller with
// u1 = e^-0.5: z = cos(2π·u2)).  No inflation noise is drawn.
const constantZ = (u2: number) => {
  let i = 0;
  return () => (i++ % 2 === 0 ? Math.exp(-0.5) : u2);
};
// Gross yearly factor (1 + r)·exp(s·z), s chosen so its stdev is vol.
const grossRef = (ratePct: number, volPct: number, z: number) => {
  const base = 1 + ratePct / 100;
  if (!(volPct > 0)) return base;
  const rel = volPct / 100 / base;
  const x = (1 + Math.sqrt(1 + 4 * rel * rel)) / 2;
  return base * Math.exp(Math.sqrt(Math.log(x)) * z);
};

section("[65] Bucket strategy: safest first; refill sized to next year; only from buckets that didn't lose");
{
  // Cash 15% (6%, vol 1), Debt 25% (7.5%, vol 4), Equity 60% (12%, vol 16).
  // Spending ₹60K/month today, 5% inflation; healthcare ₹10K/month at 10%
  // from 61; a fixed ₹30K pension from 62.  Cash kept at 2 years.
  // In a −1σ year equity loses (≈ −2.7%) and debt still gains, so cash is
  // refilled from debt; in a +1σ year it's refilled from equity (riskiest).
  const plan = {
    currentAge: 60,
    retirementAge: 60,
    inflation: 5,
    monthlyExpenses: 60_000,
    expenseType: "monthly" as const,
    investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0, volatility: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    postRetirementBuckets: [
      { id: 3, name: "Equity", allocationPct: 60, return: 12, volatility: 16 },
      { id: 1, name: "Cash", allocationPct: 15, return: 6, volatility: 1 },
      { id: 2, name: "Debt", allocationPct: 25, return: 7.5, volatility: 4 },
    ],
    healthcare: { monthlyCost: 10_000, inflation: 10, startAge: 61 },
    incomeStreams: [{ id: 1, name: "Pension", monthlyAmount: 30_000, startAge: 62, growth: "fixed" as const }],
    withdrawalStrategy: "buckets" as const,
    cashBufferYears: 2,
    targetAge: 85,
  };
  for (const [label, u2, z] of [["−1σ years", 0.5, -1], ["+1σ years", 0, 1]] as const) {
    const sim = simulateRetirementPath(plan, { rng: constantZ(u2), portfolioVolatility: 0, inflationVolatility: 0 });
    const G = { cash: grossRef(6, 1, z), debt: grossRef(7.5, 4, z), eq: grossRef(12, 16, z) };
    const q = { cash: Math.pow(G.cash, 1 / 12), debt: Math.pow(G.debt, 1 / 12), eq: Math.pow(G.eq, 1 / 12) };
    const flows = (age: number, k: number) => ({
      base: 60_000 * Math.pow(1.05, k),
      health: age >= 61 ? 10_000 * Math.pow(1.1, k) : 0,
      income: age >= 62 ? 30_000 : 0,
    });
    const b = { cash: 1_500_000, debt: 2_500_000, eq: 6_000_000 };
    // The reference refills only from buckets with a non-negative year, so a
    // refill from the losing equity bucket would show up as a mismatch.
    let worst = 0;
    for (let k = 1; k <= 10; k++) {
      const age = 60 + k - 1;
      const f = flows(age, k - 1);
      let base = f.base;
      let health = f.health;
      for (let m = 0; m < 12; m++) {
        let need = base + health - f.income;
        if (need < 0) {
          const t = b.cash + b.debt + b.eq;
          b.cash -= (need * b.cash) / t;
          b.debt -= (need * b.debt) / t;
          b.eq -= (need * b.eq) / t;
          need = 0;
        }
        for (const key of ["cash", "debt", "eq"] as const) {
          const take = Math.min(need, b[key]);
          b[key] -= take;
          need -= take;
        }
        b.cash *= q.cash;
        b.debt *= q.debt;
        b.eq *= q.eq;
        base *= Math.pow(1.05, 1 / 12);
        health *= Math.pow(1.1, 1 / 12);
      }
      const n = flows(age + 1, k);
      let deficit = 2 * 12 * Math.max(0, n.base + n.health - n.income) - b.cash;
      for (const key of ["eq", "debt"] as const) {
        if (deficit <= 0) break;
        if (G[key] < 1) continue;
        const take = Math.min(deficit, b[key]);
        b[key] -= take;
        b.cash += take;
        deficit -= take;
      }
      const step = sim.steps[k - 1];
      worst = Math.max(worst, Math.abs(step.corpus - (b.cash + b.debt + b.eq)) / step.corpus);
    }
    assert(worst < 1e-9, `${label}: matches the rule-by-rule reference (worst ${worst.toExponential(1)})`);
  }
  // A blank volatility ranks as the default (12), on the expected path too:
  // Gold (8%, blank) sits between Cash (vol 1) and Equity (vol 16).
  const withGold = (vol: number | undefined) =>
    calculateRetirement({
      currentAge: 60,
      retirementAge: 60,
      inflation: 6,
      monthlyExpenses: 80_000,
      expenseType: "monthly",
      investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0 }],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: [
        { id: 1, name: "Cash", allocationPct: 20, return: 6, volatility: 1 },
        { id: 2, name: "Gold", allocationPct: 20, return: 8, volatility: vol },
        { id: 3, name: "Equity", allocationPct: 60, return: 12, volatility: 16 },
      ],
      withdrawalStrategy: "buckets",
      defaultVolatility: 12,
      targetAge: 90,
    });
  eq(withGold(undefined).survivalAge, withGold(12).survivalAge, 1e-12, "blank volatility = default 12 for ranking");
}

section("[66] Rebalancing to unequal weights");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    postRetirementBuckets: [
      { id: 1, name: "Debt", allocationPct: 30, return: 0 },
      { id: 2, name: "Eq", allocationPct: 70, return: 10 },
    ],
    withdrawalStrategy: "rebalance",
    targetAge: 90,
  });
  eq(r.yearlyData[7].corpus, 10_000_000 * Math.pow(0.3 + 0.7 * 1.1, 8), 1e-12, "30/70 rebalanced: ×1.07 a year");
}

section("[67] Rebalancing realises gains and adds cost to the bought bucket");
{
  // 50/50 equity (taxed) and cash (untaxed), equity at 20%, cash 0%.
  // Year 1: equity gains 20% of 50L = 10L; rebalancing sells 5L of it,
  // realising 5L × (10/60) of gain.  Taxed in year 1 at 12.5% above 1.25L.
  // Year 2 the bought cash has cost = value, so only fresh equity growth
  // counts.  Reference below.
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    postRetirementBuckets: [
      { id: 1, name: "Eq", allocationPct: 50, return: 20, taxTreatment: "equity" },
      { id: 2, name: "Cash", allocationPct: 50, return: 0 },
    ],
    withdrawalStrategy: "rebalance",
    tax: { incomeTaxRate: 0, ltcgRate: 12.5, ltcgExemption: 125_000 },
    targetAge: 90,
  });
  let eqV = 5_000_000;
  let eqB = 5_000_000;
  let cash = 5_000_000;
  let carried = 0;
  for (let y = 0; y < 3; y++) {
    eqV *= 1.2;
    const total = eqV + cash;
    const sell = eqV - total / 2;
    const gain = sell * (1 - eqB / eqV) + carried;
    eqB -= (eqB * sell) / eqV;
    eqV -= sell;
    cash += sell;
    const taxDue = 0.125 * Math.max(0, gain - 125_000);
    // Tax is paid pro-rata (rebalance strategy) from both buckets.
    const t2 = eqV + cash;
    const fromEq = (taxDue * eqV) / t2;
    carried = fromEq * (1 - eqB / eqV);
    eqB -= (eqB * fromEq) / eqV;
    eqV -= fromEq;
    cash -= taxDue - fromEq;
    eq(r.yearlyData[y].taxPaid, taxDue, 1e-9, `year ${y + 1}: tax on realised rebalancing gain`);
    eq(r.yearlyData[y].corpus, eqV + cash, 1e-9, `year ${y + 1}: corpus`);
  }
}

section("[68] Tax that can't be paid at year end runs the money out");
{
  // ₹10L FD-type bucket at 50% growth taxed at 100% yearly, ₹80K/month
  // spending, and a ₹1L goal at the end of year 1: after paying the goal,
  // the year's tax exceeds what's left, so the money runs out at exactly 61.
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 80_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "All", amount: 1_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [
      { id: 1, name: "Goal 1", yearsFromNow: 1, currentCost: 100_000, inflationRate: 0 },
      { id: 2, name: "Goal 2", yearsFromNow: 3, currentCost: 100_000, inflationRate: 0 },
    ],
    postRetirementBuckets: [{ id: 1, name: "FD", allocationPct: 100, return: 50, taxTreatment: "slabYearly" }],
    tax: { incomeTaxRate: 100, ltcgRate: 12.5, ltcgExemption: 125_000 },
    targetAge: 90,
  });
  const q = Math.pow(1.5, 1 / 12);
  let V = 1_000_000;
  let accrued = 0;
  for (let m = 0; m < 12; m++) {
    V -= 80_000;
    accrued += V * (q - 1);
    V *= q;
  }
  V -= 100_000; // goal 1
  assert(accrued > V, "set-up: tax due exceeds what's left");
  eq(r.survivalAge, 61, 0, "runs out at exactly 61");
  eq(r.yearlyData[0].taxPaid, V, 1e-9, "pays all that's left as tax");
  eq(r.yearlyData[0].corpus, 0, 0, "nothing left");
  eq(r.expenseFundings.filter((f) => f.expenseId === 1).length, 1, 0, "goal 1 listed once (paid)");
  const g2 = r.expenseFundings.filter((f) => f.expenseId === 2);
  assert(g2.length === 1 && g2[0].afterDepletion === true, "goal 2 listed once, unpaid");
}

section("[69] Healthcare share of the month the money runs out");
{
  // ₹12.5L at 0%, ₹80K base + ₹20K healthcare a month, no inflation: 12
  // full months then half a month.  Healthcare paid = 12 × 20K + 0.5 × 20K.
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 80_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 1_250_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    healthcare: { monthlyCost: 20_000, inflation: 0 },
    targetAge: 90,
  });
  eq(r.yearlyData[1].healthcareExpenses, 10_000, 1e-9, "half a month of healthcare in the last year");
  eq(r.yearlyData[1].regularExpenses, 50_000, 1e-9, "half a month of spending in the last year");
}

section("[70] Income: custom growth counts from its own start; end ≤ start is never paid");
{
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 10_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 50_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    incomeStreams: [
      { id: 1, name: "Annuity", monthlyAmount: 20_000, startAge: 65, growth: "custom", growthRate: 3 },
      { id: 2, name: "Typo", monthlyAmount: 99_999, startAge: 62, endAge: 55, growth: "fixed" },
      { id: 3, name: "Zero-length", monthlyAmount: 88_888, startAge: 62, endAge: 62, growth: "fixed" },
    ],
    targetAge: 90,
  });
  let expected = 0;
  for (let j = 0; j < 12; j++) expected += 20_000 * Math.pow(1.03, 1 + j / 12);
  eq(r.yearlyData.find((s) => s.age === 67)!.incomeReceived, expected, 1e-12, "age 66-67: 20K × 1.03^(1 + j/12)");
  eq(r.yearlyData.find((s) => s.age === 63)!.incomeReceived, 0, 0, "end ≤ start: never paid");
}

section("[71] Glide ignores linked goals beyond the plan horizon");
{
  const run = (glide: boolean) =>
    calculateRetirement({
      currentAge: 50,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 0,
      expenseType: "monthly",
      investmentBuckets: [],
      monthlySavingsBuckets: [
        { id: 1, name: "SIP", amount: 10_000, return: 12, ...(glide ? { targetRate: 4, glideYears: 15 } : {}) },
      ],
      // Age 71 with plan age 65 (horizon 70): outside the plan.
      oneTimeExpenses: [{ id: 1, name: "Far", yearsFromNow: 21, currentCost: 100_000, inflationRate: 0, linkedSavingsBucketId: 1 }],
      targetAge: 65,
    });
  eq(run(true).corpusAtRetirement, run(false).corpusAtRetirement, 1e-12, "no glide toward an out-of-plan goal");
}

section("[72] Input clamps: no negative money from odd inputs");
{
  const r = calculateRetirement({
    currentAge: 40,
    retirementAge: 45,
    inflation: 6,
    monthlyExpenses: 50_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 5_000_000, return: 8 }],
    monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 10_000, return: 10, stepUpPct: 500 }],
    oneTimeExpenses: [],
    incomeStreams: [
      { id: 1, name: "Negative", monthlyAmount: -50_000, startAge: 45, growth: "fixed" },
      { id: 2, name: "Over-taxed", monthlyAmount: 40_000, startAge: 45, growth: "fixed", taxable: true },
    ],
    healthcare: { monthlyCost: -5_000, inflation: 10 },
    spendingPhases: [{ id: 1, fromAge: 50, percentOfBase: -40 }],
    tax: { incomeTaxRate: 150, ltcgRate: -10, ltcgExemption: -1 },
    targetAge: 80,
  });
  eq(r.yearlyData[1].contributions, 2 * r.yearlyData[0].contributions, 1e-12, "step-up capped at 100% a year");
  eq(r.annualIncomeAtRetirement, 0, 0, "negative income → 0; 100%+ tax → nothing left, not negative");
  eq(r.yearlyData.find((s) => s.age === 46)!.healthcareExpenses, 0, 0, "negative healthcare → 0");
  eq(r.yearlyData.find((s) => s.age === 51)!.regularExpenses, 0, 0, "negative phase → 0% spending");
  assert(
    r.yearlyData.every((s) => s.corpus >= 0 && s.incomeReceived >= 0 && s.regularExpenses >= 0 && s.taxPaid >= 0),
    "no negative amounts anywhere",
  );
}

section("[73] Each simulated path keeps its own luck when an input changes");
{
  // More spending must never raise the success rate.  With one shared
  // random stream, a path that ran out early shifted every later path's
  // numbers, and success went UP with spending in a third of small steps.
  const plan = {
    currentAge: 30,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 0,
    expenseType: "monthly" as const,
    investmentBuckets: [
      { id: 1, name: "FD", amount: 1_000_000, return: 7, volatility: 1 },
      { id: 2, name: "Eq", amount: 3_000_000, return: 12, volatility: 16 },
    ],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    postRetirementBuckets: [
      { id: 1, name: "Debt", allocationPct: 40, return: 7.5, volatility: 4 },
      { id: 2, name: "Eq", allocationPct: 60, return: 12, volatility: 16 },
    ],
    targetAge: 90,
    portfolioVolatility: 12,
    inflationVolatility: 1.5,
    inflationPersistence: 0.6,
    fatTails: true,
    iterations: 600,
    seed: 42,
  };
  let prev = 1;
  let rises = 0;
  for (let spend = 40_000; spend <= 56_000; spend += 500) {
    const sr = runMonteCarloSimulation({ ...plan, monthlyExpenses: spend }).successRate;
    if (sr > prev + 1e-12) rises++;
    prev = sr;
  }
  eq(rises, 0, 0, "success never rises with more spending");
}

section("[74] Persistent inflation is as uncertain in year 1 as later");
{
  const rng = lcg(99);
  const first: number[] = [];
  for (let i = 0; i < 6000; i++) {
    const sim = simulateRetirementPath(
      {
        currentAge: 59,
        retirementAge: 60,
        inflation: 6,
        monthlyExpenses: 0,
        expenseType: "monthly",
        investmentBuckets: [],
        monthlySavingsBuckets: [],
        oneTimeExpenses: [],
        targetAge: 61,
      },
      { rng, portfolioVolatility: 0, inflationVolatility: 2, inflationPersistence: 0.9 },
    );
    first.push(sim.steps[0].inflationIndex - 1);
  }
  const m = first.reduce((a, b) => a + b, 0) / first.length;
  const sd = Math.sqrt(first.reduce((a, b) => a + (b - m) ** 2, 0) / first.length);
  assert(Math.abs(sd / 0.02 - 1) < 0.05, `first-year spread ${(sd * 100).toFixed(2)}% ≈ 2% (was 0.88% at persistence 0.9)`);
}

// ---------------------------------------------------------------------------
// ROUND-2 FEATURE REVIEW: remaining unpinned behaviours.
// ---------------------------------------------------------------------------

// Expected-path reference for the bucket strategy with no income, healthcare,
// tax or inflation: spend `w` a month from buckets in `order`; refill the
// first to `cashYears` of spending from the others, riskiest (last) first.
const bucketStrategyRef = (
  amounts: number[],
  rates: number[],
  order: number[],
  w: number,
  cashYears: number,
  years: number,
) => {
  const b = [...amounts];
  const q = rates.map((r) => Math.pow(1 + r / 100, 1 / 12));
  const out: number[] = [];
  for (let y = 0; y < years; y++) {
    for (let m = 0; m < 12; m++) {
      let need = w;
      for (const i of order) {
        const t = Math.min(need, b[i]);
        b[i] -= t;
        need -= t;
      }
      for (let i = 0; i < b.length; i++) b[i] *= q[i];
    }
    let deficit = cashYears * 12 * w - b[order[0]];
    for (const i of order.slice(1).reverse()) {
      if (deficit <= 0) break;
      const t = Math.min(deficit, b[i]);
      b[i] -= t;
      b[order[0]] += t;
      deficit -= t;
    }
    out.push(b.reduce((a, x) => a + x, 0));
  }
  return out;
};

section("[75] Bucket strategy ranks by volatility, not by return; blank = 12 when no default is given");
{
  const run = (buckets: { pct: number; ret: number; vol?: number }[], defaultVolatility?: number) =>
    calculateRetirement({
      currentAge: 60,
      retirementAge: 60,
      inflation: 0,
      monthlyExpenses: 70_000,
      expenseType: "monthly",
      investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0 }],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      postRetirementBuckets: buckets.map((b, i) => ({
        id: i + 1,
        name: `B${i}`,
        allocationPct: b.pct,
        return: b.ret,
        volatility: b.vol,
      })),
      withdrawalStrategy: "buckets",
      cashBufferYears: 1,
      defaultVolatility,
      targetAge: 90,
    }).yearlyData.map((s) => s.corpus);
  // Gold earns less than Debt but swings far more, so Debt is spent first.
  const a = run([{ pct: 20, ret: 6, vol: 1 }, { pct: 30, ret: 8, vol: 15 }, { pct: 50, ret: 9, vol: 4 }], 12);
  const aRef = bucketStrategyRef([2e6, 3e6, 5e6], [6, 8, 9], [0, 2, 1], 70_000, 1, 8);
  let worst = 0;
  aRef.forEach((v, i) => (worst = Math.max(worst, Math.abs(a[i] - v) / v)));
  assert(worst < 1e-9, `order Cash → Debt (vol 4) → Gold (vol 15) (worst ${worst.toExponential(1)})`);
  // No default given: a blank volatility ranks as 12, between 1 and 15.
  const b = run([{ pct: 20, ret: 6, vol: 1 }, { pct: 30, ret: 8 }, { pct: 50, ret: 7, vol: 15 }]);
  const bRef = bucketStrategyRef([2e6, 3e6, 5e6], [6, 8, 7], [0, 1, 2], 70_000, 1, 8);
  worst = 0;
  bRef.forEach((v, i) => (worst = Math.max(worst, Math.abs(b[i] - v) / v)));
  assert(worst < 1e-9, `blank volatility ranks as 12 by default (worst ${worst.toExponential(1)})`);
  // Your own default counts, not just 12: with default 14 a blank Gold ranks
  // after Debt at 13.
  const d = run([{ pct: 20, ret: 6, vol: 1 }, { pct: 30, ret: 8 }, { pct: 50, ret: 7, vol: 13 }], 14);
  const dRef = bucketStrategyRef([2e6, 3e6, 5e6], [6, 8, 7], [0, 2, 1], 70_000, 1, 8);
  worst = 0;
  dRef.forEach((v, i) => (worst = Math.max(worst, Math.abs(d[i] - v) / v)));
  assert(worst < 1e-9, `blank volatility ranks as YOUR default (14) (worst ${worst.toExponential(1)})`);
  // Equal volatility: the lower-return bucket is treated as the safer one.
  const c = run([{ pct: 50, ret: 9, vol: 5 }, { pct: 50, ret: 6, vol: 5 }], 12);
  const cRef = bucketStrategyRef([5e6, 5e6], [9, 6], [1, 0], 70_000, 1, 8);
  worst = 0;
  cRef.forEach((v, i) => (worst = Math.max(worst, Math.abs(c[i] - v) / v)));
  assert(worst < 1e-9, `tie on volatility: lower return first (worst ${worst.toExponential(1)})`);
}

section("[76] Buying during a rebalance adds cost, so selling it later isn't over-taxed");
{
  // Two equity buckets, A at 30% and B flat, rebalanced 50/50 each year, with
  // ₹1L a month spent pro-rata.  B is bought every year and sold every month
  // for spending: its gains are small only if the purchases count as cost.
  const r = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 100_000,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "All", amount: 10_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    postRetirementBuckets: [
      { id: 1, name: "A", allocationPct: 50, return: 30, taxTreatment: "equity" },
      { id: 2, name: "B", allocationPct: 50, return: 0, taxTreatment: "equity" },
    ],
    withdrawalStrategy: "rebalance",
    tax: { incomeTaxRate: 0, ltcgRate: 12.5, ltcgExemption: 125_000 },
    targetAge: 90,
  });
  const v = [5_000_000, 5_000_000];
  const c = [5_000_000, 5_000_000];
  const qA = Math.pow(1.3, 1 / 12);
  let gains = 0;
  const sell = (i: number, amt: number) => {
    const basisSold = c[i] * (amt / v[i]);
    gains += amt - basisSold;
    c[i] -= basisSold;
    v[i] -= amt;
  };
  const proRata = (amt: number) => {
    const t = v[0] + v[1];
    const s0 = (v[0] * amt) / t;
    const s1 = (v[1] * amt) / t;
    sell(0, s0);
    sell(1, s1);
  };
  for (let y = 0; y < 3; y++) {
    for (let m = 0; m < 12; m++) {
      proRata(100_000);
      v[0] *= qA;
    }
    const half = (v[0] + v[1]) / 2;
    const excess = v[0] - half;
    sell(0, excess);
    v[1] += excess;
    c[1] += excess; // the purchase is cost
    const taxDue = 0.125 * Math.max(0, gains - 125_000);
    gains = 0;
    proRata(taxDue);
    eq(r.yearlyData[y].taxPaid, taxDue, 1e-9, `year ${y + 1}: tax`);
    eq(r.yearlyData[y].corpus, v[0] + v[1], 1e-9, `year ${y + 1}: corpus`);
  }
}

section("[77] Monte Carlo details: seed, persistence cap, fat tails on any return, default tax rate");
{
  const plan = {
    currentAge: 40,
    retirementAge: 60,
    inflation: 6,
    monthlyExpenses: 60_000,
    expenseType: "monthly" as const,
    investmentBuckets: [{ id: 1, name: "Eq", amount: 5_000_000, return: 11, volatility: 15 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    targetAge: 90,
    portfolioVolatility: 12,
    inflationVolatility: 2,
    iterations: 300,
  };
  const a = runMonteCarloSimulation({ ...plan, seed: 1 });
  const a2 = runMonteCarloSimulation({ ...plan, seed: 1 });
  const b = runMonteCarloSimulation({ ...plan, seed: 2 });
  eq(a.percentiles[20].p50, a2.percentiles[20].p50, 0, "same seed → same result");
  assert(a.percentiles[20].p50 !== b.percentiles[20].p50, "different seed → different result");
  const capped = runMonteCarloSimulation({ ...plan, seed: 1, inflationPersistence: 5 });
  const at95 = runMonteCarloSimulation({ ...plan, seed: 1, inflationPersistence: 0.95 });
  eq(capped.realPercentiles[30].p50, at95.realPercentiles[30].p50, 0, "persistence above 0.95 is capped at 0.95");
  const at90 = runMonteCarloSimulation({ ...plan, seed: 1, inflationPersistence: 0.9 });
  assert(at90.realPercentiles[30].p50 !== at95.realPercentiles[30].p50, "…and not at a lower value like 0.9");

  // A retirement bucket at 100% return and 20% volatility with fat tails:
  // the yearly factor's spread must still be 0.20 (calibration depends on
  // the return too, not only on the volatility).
  const rng = lcg(31337);
  const f: number[] = [];
  for (let i = 0; i < 30_000; i++) {
    const sim = simulateRetirementPath(
      {
        currentAge: 60,
        retirementAge: 60,
        inflation: 0,
        monthlyExpenses: 0,
        expenseType: "monthly",
        investmentBuckets: [{ id: 1, name: "All", amount: 1, return: 0 }],
        monthlySavingsBuckets: [],
        oneTimeExpenses: [],
        postRetirementBuckets: [{ id: 1, name: "Wild", allocationPct: 100, return: 100, volatility: 20 }],
        targetAge: 61,
      },
      { rng, portfolioVolatility: 0, inflationVolatility: 0, fatTails: true },
    );
    f.push(sim.steps[0].corpus);
  }
  const mean = f.reduce((x, y) => x + y, 0) / f.length;
  const sd = Math.sqrt(f.reduce((x, y) => x + (y - mean) ** 2, 0) / f.length);
  assert(Math.abs(sd / 0.2 - 1) < 0.03, `fat-tailed retirement bucket at 100%: spread ${sd.toFixed(3)} ≈ 0.20`);
  // ...and the tails really are fat there (normal shocks give ≈ 3).
  const kurt = (xs: number[]) => {
    const ls = xs.map(Math.log);
    const m = ls.reduce((x, y) => x + y, 0) / ls.length;
    const v = ls.reduce((x, y) => x + (y - m) ** 2, 0) / ls.length;
    return ls.reduce((x, y) => x + (y - m) ** 4, 0) / ls.length / (v * v);
  };
  assert(kurt(f) > 5, `retirement bucket kurtosis ${kurt(f).toFixed(2)} ≈ 6`);
  // At high volatility the calibration matters most (a normal-shock scale
  // used with fat-tailed shocks gives ~45% instead of 40%), so check the
  // spread of a 0%-return, 40%-volatility retirement bucket and SIP.
  const sdOf = (xs: number[]) => {
    const m = xs.reduce((x, y) => x + y, 0) / xs.length;
    return Math.sqrt(xs.reduce((x, y) => x + (y - m) ** 2, 0) / xs.length);
  };
  const wildRng = lcg(2024);
  const wild: number[] = [];
  for (let i = 0; i < 30_000; i++) {
    const sim = simulateRetirementPath(
      {
        currentAge: 60,
        retirementAge: 60,
        inflation: 0,
        monthlyExpenses: 0,
        expenseType: "monthly",
        investmentBuckets: [{ id: 1, name: "All", amount: 1, return: 0 }],
        monthlySavingsBuckets: [],
        oneTimeExpenses: [],
        postRetirementBuckets: [{ id: 1, name: "Wild", allocationPct: 100, return: 0, volatility: 40 }],
        targetAge: 61,
      },
      { rng: wildRng, portfolioVolatility: 0, inflationVolatility: 0, fatTails: true },
    );
    wild.push(sim.steps[0].corpus);
  }
  assert(Math.abs(sdOf(wild) / 0.4 - 1) < 0.04, `retirement bucket at 40% vol: spread ${sdOf(wild).toFixed(3)} ≈ 0.40`);
  // SIP: recover each year's growth factor G from the year-end balance
  // 1000 × (G − 1) / (G^(1/12) − 1) by bisection, then check its spread.
  const annuity = (G: number) => (Math.abs(G - 1) < 1e-12 ? 12 : (G - 1) / (Math.pow(G, 1 / 12) - 1));
  const invert = (a: number) => {
    let lo = 0.01;
    let hi = 20;
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2;
      if (annuity(mid) < a) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const sipRng = lcg(4711);
  const sipG: number[] = [];
  const sipBal: number[] = [];
  for (let i = 0; i < 30_000; i++) {
    const sim = simulateRetirementPath(
      {
        currentAge: 59,
        retirementAge: 60,
        inflation: 0,
        monthlyExpenses: 0,
        expenseType: "monthly",
        investmentBuckets: [],
        monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 1_000, return: 0, volatility: 40 }],
        oneTimeExpenses: [],
        targetAge: 61,
      },
      { rng: sipRng, portfolioVolatility: 0, inflationVolatility: 0, fatTails: true },
    );
    sipBal.push(sim.corpusAtRetirement);
    sipG.push(invert(sim.corpusAtRetirement / 1_000));
  }
  assert(Math.abs(sdOf(sipG) / 0.4 - 1) < 0.04, `SIP at 40% vol: yearly factor spread ${sdOf(sipG).toFixed(3)} ≈ 0.40`);
  assert(kurt(sipBal) > 4, `SIP balance kurtosis ${kurt(sipBal).toFixed(2)} (normal ≈ 3)`);

  // No tax settings given: taxable income is taxed at the 20% default.
  const t = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 0,
    expenseType: "monthly",
    investmentBuckets: [{ id: 1, name: "A", amount: 1_000_000, return: 0 }],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    incomeStreams: [{ id: 1, name: "Pension", monthlyAmount: 10_000, startAge: 60, growth: "fixed", taxable: true }],
    targetAge: 90,
  });
  eq(t.annualIncomeAtRetirement, 96_000, 1e-12, "default income-tax rate 20%");
}

section("[78] A pension exactly equal to spending is not 'running out'");
{
  // No savings, 80% spending phase from retirement, and an inflation-linked
  // pension equal to 80% of spending: need = 0 up to floating-point dust.
  for (const inflation of [5, 6, 7.3]) {
    const r = calculateRetirement({
      currentAge: 50,
      retirementAge: 60,
      inflation,
      monthlyExpenses: 62_500,
      expenseType: "monthly",
      investmentBuckets: [],
      monthlySavingsBuckets: [],
      oneTimeExpenses: [],
      spendingPhases: [{ id: 1, fromAge: 60, percentOfBase: 80 }],
      incomeStreams: [{ id: 1, name: "Pension", monthlyAmount: 50_000, startAge: 60, growth: "inflation" }],
      targetAge: 90,
    });
    assert(r.corpusLastsBeyondHorizon, `${inflation}% inflation: covered for life (survival ${r.survivalAge.toFixed(2)})`);
  }
  // A genuine one-rupee gap still runs out.
  const gap = calculateRetirement({
    currentAge: 60,
    retirementAge: 60,
    inflation: 0,
    monthlyExpenses: 50_001,
    expenseType: "monthly",
    investmentBuckets: [],
    monthlySavingsBuckets: [],
    oneTimeExpenses: [],
    incomeStreams: [{ id: 1, name: "Pension", monthlyAmount: 50_000, startAge: 60, growth: "fixed" }],
    targetAge: 90,
  });
  assert(!gap.lastsToTargetAge && gap.survivalAge === 60, "₹1 a month short with no savings runs out at once");
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
if (failures === 0) {
  console.log("ALL CHECKS PASSED");
  process.exit(0);
} else {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
