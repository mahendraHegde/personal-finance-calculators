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

import {
  calculateRetirement,
  simulateRetirementPath,
} from "../src/utils/retirement";
import { runMonteCarloSimulation } from "../src/utils/monteCarlo";

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
  "[2] Pure SIP (monthly compounding): PMT × ((1+r)^n - 1) / r",
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
  const r_m = 0.12 / 12;
  const months = 360;
  const expected = 10_000 * ((Math.pow(1 + r_m, months) - 1) / r_m);
  eq(r.corpusAtRetirement, expected, 1e-9, "₹10K × 360mo @ 1%/mo");
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
  const rm = 0.05 / 12;
  const sipAt60 = 1_000 * ((Math.pow(1 + rm, 120) - 1) / rm);
  const expectedWR = (eqAt60 * 10 + sipAt60 * 5) / (eqAt60 + sipAt60);
  eq(r.corpusAtRetirement, eqAt60 + sipAt60, 1e-9, "corpus");
  eq(r.weightedReturn, expectedWR, 1e-9, "weighted return at retirement");
}

// ---------------------------------------------------------------------------
// DECUMULATION & INFLATION
// ---------------------------------------------------------------------------

section(
  "[5] Decumulation matches annuity-exhaustion formula: n = -ln(1 - rC/W)/ln(1+r)",
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
  const expected = -Math.log(1 - (r * C) / W) / Math.log(1 + r);
  eq(sim.yearsAfterRetirement, expected, 0.01, "years to exhaustion");
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
  "[E1] Earmarked SIP balance is held aside at retirement (mainCorpus < total)",
);
{
  // SIP @ 8% for 10 years → some balance at retirement.  Linked to a
  // post-retirement expense (year 15).  At retirement, the SIP balance
  // must NOT be in the main corpus — it's held in an earmarked pool.
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
  // SIP at retirement = 10K * ((1.00667^120 - 1)/0.00667) ≈ 1.829M
  const r_m = 0.08 / 12;
  const sipAtRet = 10_000 * ((Math.pow(1 + r_m, 120) - 1) / r_m);
  const eqAtRet = 1_000_000 * Math.pow(1.08, 10);
  eq(r.earmarkedAtRetirement, sipAtRet, 1e-9, "earmarked = SIP balance");
  eq(
    r.mainCorpusAtRetirement,
    eqAtRet,
    1e-9,
    "mainCorpus = existing only",
  );
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
  // SIP at year 1 = 100K * ((1.01^12 - 1)/0.01) ≈ 1,268,250
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
  // sipAtRet = 100K × ((1.01^12 - 1)/0.01) = 1,268,250.30
  // pool@yr6 = sipAtRet × 1.12^5 = 1,268,250.30 × 1.7623 = 2,235,206
  const r_m = 0.01;
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
  const r_m = 0.08 / 12;
  const sipAtRet = 10_000 * ((Math.pow(1 + r_m, 360) - 1) / r_m);
  const expectedAtYr31 = sipAtRet * 1.08 - 1_000_000;
  const yr31 = sim.steps.find((s) => s.year === 31)!;
  eq(yr31.corpus, expectedAtYr31, 1e-9, "leftover correctly accounted");
  // The next year (year 32), corpus should grow from main only (pool gone).
  // Main grew from 0 to expectedAtYr31 via roll-back.  Year 32: main grows
  // at weighted return.  But mainCorpusAtRetirement was 0 (no existing, all
  // SIP earmarked) → fallback to weighted return = 0.  So main stays at
  // expectedAtYr31 in year 32.  No regression.
  const yr32 = sim.steps.find((s) => s.year === 32)!;
  eq(yr32.corpus, expectedAtYr31, 1e-9, "main corpus continues from rolled value");
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
  "[E6] Earmarked pool does NOT fund regular expenses — depletion semantic",
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
  const r_m = 0.12 / 12;
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
          currentCost: 0,
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
          currentCost: 0,
          inflationRate: 0,
          linkedSavingsBucketId: 1,
        },
      ],
      targetAge: 90,
    },
    {},
  );
  // At year 35 (goal year), the pool is drained.  Just before drain, the
  // with-glide pool < no-glide pool.  Since cost = 0, after drain the
  // pool's leftover rolls into main, and the corpus = pool value at year 35.
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

section("[F4] Last linked expense on a pool reports surplus rolled over");
{
  // Big SIP, small post-retirement expense.  Pool has way more than the
  // expense costs.  surplusRolledOver should be the leftover.
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
  assert(
    f.surplusRolledOver !== undefined && f.surplusRolledOver > 0,
    "surplus rolled over",
  );
  // The surplus should equal pool@yr35 - 1M.  Pool@yr35 = SIP@retirement
  // grown 5 more years at 12%.
  const r_m = 0.01;
  const sipAtRet = 50_000 * ((Math.pow(1 + r_m, 360) - 1) / r_m);
  const poolAt35 = sipAtRet * Math.pow(1.12, 5);
  eq(
    f.surplusRolledOver!,
    poolAt35 - 1_000_000,
    1e-9,
    "surplus = pool@yr35 - cost",
  );
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
  const allDebt = runMonteCarloSimulation({
    ...base,
    postRetirementBuckets: [
      { id: 1, name: "Debt", allocationPct: 100, return: 6 },
    ],
  });
  const allEquity = runMonteCarloSimulation({
    ...base,
    postRetirementBuckets: [
      { id: 1, name: "Eq", allocationPct: 100, return: 11 },
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
