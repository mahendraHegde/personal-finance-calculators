// Gap solver, saved-config migration + scenarios, and the read-only
// Portfolio → retirement import mapping.

import { done, eq, near, ok, section } from "./_harness";
import { runMonteCarloSimulation } from "../src/utils/monteCarlo";
import { extraSavingBucket, solveGaps, summarizePlan } from "../src/utils/retirementSolver";
import { buildImportPreview, type PortfolioSnapshot } from "../src/utils/portfolioImport";
import { placeTooltip } from "../src/components/retirement/format";
import type { MonteCarloParams } from "../src/types/retirement";

const base: MonteCarloParams = {
  currentAge: 35,
  retirementAge: 60,
  inflation: 6,
  monthlyExpenses: 90_000,
  expenseType: "monthly",
  investmentBuckets: [{ id: 1, name: "Eq", amount: 3_000_000, return: 11, volatility: 15 }],
  monthlySavingsBuckets: [{ id: 1, name: "SIP", amount: 30_000, return: 12, volatility: 16 }],
  oneTimeExpenses: [],
  postRetirementBuckets: [
    { id: 1, name: "Debt", allocationPct: 40, return: 7, volatility: 3 },
    { id: 2, name: "Eq", allocationPct: 60, return: 11, volatility: 15 },
  ],
  targetAge: 90,
  portfolioVolatility: 12,
  inflationVolatility: 1.5,
  inflationPersistence: 0.6,
  fatTails: true,
  iterations: 300,
  seed: 42,
};
const ITER = 300;
const success = (p: MonteCarloParams) => runMonteCarloSimulation({ ...p, iterations: ITER, seed: 42 }).successRate;

section("[S1] Solver answers are just enough to reach the target");
{
  const target = 0.9;
  const s = solveGaps(base, target, ITER);
  ok(s.currentSuccess < target, `starts below target (${(s.currentSuccess * 100).toFixed(1)}%)`);

  // Extra saving: meets the target, and noticeably less would not.
  ok(s.extraMonthlySaving !== null && s.extraMonthlySaving.value > 0, "extra saving found");
  const extra = s.extraMonthlySaving!.value;
  const tpl = extraSavingBucket(base, 2);
  const withExtra = (amount: number) =>
    success({ ...base, monthlySavingsBuckets: [...base.monthlySavingsBuckets, { ...tpl, amount }] });
  ok(withExtra(extra) >= target, `₹${extra}/month reaches ${(withExtra(extra) * 100).toFixed(1)}%`);
  ok(withExtra(extra * 0.99 - 200) < target, "1% less falls short");

  // Retirement age: the earliest that works; a year earlier doesn't.
  ok(s.earliestRetirementAge !== null, "retirement age found");
  const age = s.earliestRetirementAge!.value;
  ok(success({ ...base, retirementAge: age }) >= target, `retiring at ${age} works`);
  ok(success({ ...base, retirementAge: age - 1 }) < target, `retiring at ${age - 1} doesn't`);

  // Spending: the most that works; a bit more doesn't.
  ok(s.maxSpend !== null, "max spend found");
  const spend = s.maxSpend!.value;
  ok(spend < base.monthlyExpenses, "must spend less than now");
  ok(success({ ...base, monthlyExpenses: spend }) >= target, `₹${spend}/month works`);
  ok(success({ ...base, monthlyExpenses: spend * 1.02 + 300 }) < target, "2% more doesn't");
}

section("[S2] Solver: already on target, already retired, unreachable");
{
  const rich = { ...base, investmentBuckets: [{ id: 1, name: "Eq", amount: 80_000_000, return: 11, volatility: 15 }] };
  const s = solveGaps(rich, 0.9, ITER);
  eq(s.extraMonthlySaving?.value, 0, "no extra saving needed");
  ok(s.earliestRetirementAge !== null && s.earliestRetirementAge.value < 60, "could retire earlier");
  ok(s.maxSpend !== null && s.maxSpend.value > base.monthlyExpenses, "could spend more");

  const retired = { ...base, currentAge: 62, retirementAge: 62, monthlySavingsBuckets: [] };
  const r = solveGaps(retired, 0.9, ITER);
  eq(r.extraMonthlySaving, null, "already retired: saving isn't a lever");

  // A healthcare bill this large breaks the plan even with zero everyday
  // spending, so no spending level reaches the target.
  const sick = { ...base, healthcare: { monthlyCost: 500_000, inflation: 12 } };
  eq(solveGaps(sick, 0.9, ITER).maxSpend, null, "healthcare alone breaks it: no spend level works");
}

section("[S4] Solver answers meet the target after rounding, and tightly (default plan)");
{
  // The two cases that used to come back just under target (0.898, 0.946).
  const { defaultConfig } = await import("../src/utils/storage");
  const plan: MonteCarloParams = {
    ...defaultConfig,
    defaultVolatility: defaultConfig.portfolioVolatility,
    iterations: 500,
    seed: 42,
  };
  const at = (p: MonteCarloParams) => runMonteCarloSimulation({ ...p, iterations: 500, seed: 42 }).successRate;
  for (const [spend, target] of [[50_000, 0.9], [40_000, 0.95]] as const) {
    const p = { ...plan, monthlyExpenses: spend };
    const s = solveGaps(p, target, 500);
    ok(s.maxSpend !== null, `spend ₹${spend}, target ${target * 100}%: answer found`);
    const v = s.maxSpend!.value;
    ok(at({ ...p, monthlyExpenses: v }) >= target, `₹${v}/month really meets ${target * 100}%`);
    eq(s.maxSpend!.success, at({ ...p, monthlyExpenses: v }), "reported success is the success at that answer");
    ok(at({ ...p, monthlyExpenses: v * 1.006 + 100 }) < target, "a little more misses");
    if (s.extraMonthlySaving && s.extraMonthlySaving.value > 0) {
      const tpl = extraSavingBucket(p, 99);
      const withExtra = (a: number) => at({ ...p, monthlySavingsBuckets: [...p.monthlySavingsBuckets, { ...tpl, amount: a }] });
      const x = s.extraMonthlySaving.value;
      ok(withExtra(x) >= target, `₹${x} extra really meets it`);
      ok(withExtra(Math.max(0, x * 0.98 - 600)) < target, "a little less misses");
    }
  }
}

section("[S5] Extra saving is invested like your current monthly savings");
{
  // Weighted by monthly amount; a blank volatility uses YOUR default (9 here).
  const p: MonteCarloParams = {
    ...base,
    portfolioVolatility: 9,
    monthlySavingsBuckets: [
      { id: 1, name: "A", amount: 10_000, return: 12 },
      { id: 2, name: "B", amount: 30_000, return: 8, volatility: 4 },
    ],
  };
  const b = extraSavingBucket(p, 7);
  near(b.return, (10 * 12 + 30 * 8) / 40, 1e-12, "return weighted by monthly amount");
  near(b.volatility!, (10 * 9 + 30 * 4) / 40, 1e-12, "blank volatility = your default 9");
  // No monthly savings: invested like your existing investments.
  const q = extraSavingBucket({ ...p, monthlySavingsBuckets: [], investmentBuckets: [
    { id: 1, name: "X", amount: 1_000_000, return: 7, volatility: 1 },
    { id: 2, name: "Y", amount: 3_000_000, return: 11 },
  ] }, 1);
  near(q.return, (1 * 7 + 3 * 11) / 4, 1e-12, "falls back to existing investments' mix");
  near(q.volatility!, (1 * 1 + 3 * 9) / 4, 1e-12, "with their volatilities");
}

section("[U1] Tooltip placement stays on screen");
{
  // vh 844, margin 8, gap 4.
  eq(placeTooltip(100, 116, 200, 844), 120, "fits below → below");
  eq(placeTooltip(700, 716, 200, 844), 496, "no room below → above (700 − 4 − 200)");
  const tall = placeTooltip(400, 416, 600, 844);
  ok(tall >= 8 && tall + 600 <= 844 - 8, `fits neither → clamped inside (${tall})`);
  eq(placeTooltip(20, 36, 828, 844), 8, "as tall as the screen → top margin");
  eq(placeTooltip(820, 836, 150, 844), 666, "button near the bottom → above");
}

section("[S3] Plan summary for side-by-side comparison");
{
  const sum = summarizePlan(base, ITER);
  eq(sum.retirementAge, 60, "retirement age");
  eq(sum.monthlySaving, 30_000, "monthly saving");
  eq(sum.annualSpend, 1_080_000, "yearly spend");
  near(sum.corpusAtRetirementToday * Math.pow(1.06, 25), sum.corpusAtRetirement, 1e-12, "today's money = future / 1.06^25");
  near(sum.successRate, success(base), 0.08, "success rate in line with a 300-run simulation");
}

section("[P1] Portfolio import: values, FX, FD rate, archived, missing values, owners");
{
  const today = "2026-11-24";
  const snapshot: PortfolioSnapshot = {
    people: [
      { id: "p1", name: "Asha" },
      { id: "p2", name: "Ravi" },
    ],
    fxRates: [
      { id: "old", date: "2025-01-01", base: "USD", rates: { USD: 1, INR: 80 } },
      { id: "new", date: "2026-11-01", base: "USD", rates: { USD: 1, INR: 83 } },
    ],
    settings: undefined,
    holdings: [
      { id: "h1", name: "Index fund", personId: "p1", assetClass: "equity", currency: "INR", incomeMode: "accumulating" },
      { id: "h2", name: "US ETF", personId: "p2", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
      { id: "h3", name: "Bank FD", personId: "p1", assetClass: "debt", currency: "INR", incomeMode: "accumulating", fd: { ratePct: 7, compounding: "quarterly" } },
      { id: "h4", name: "Old fund", personId: "p1", assetClass: "equity", currency: "INR", incomeMode: "accumulating", archived: true },
      { id: "h5", name: "Unvalued stock", personId: "p1", assetClass: "equity", currency: "INR", incomeMode: "accumulating" },
      { id: "h6", name: "Plot", personId: "shared", assetClass: "realestate", currency: "INR", incomeMode: "accumulating" },
      { id: "h7", name: "Yen bond", personId: "p2", assetClass: "debt", currency: "JPY", incomeMode: "accumulating" },
    ],
    holdingEvents: [
      { id: "e1", holdingId: "h1", date: "2026-11-20", type: "valuation", amount: 100_000 },
      { id: "e2", holdingId: "h2", date: "2026-11-20", type: "valuation", amount: 1_000 },
      { id: "e3", holdingId: "h3", date: "2025-11-24", type: "opening", amount: 200_000 },
      { id: "e4", holdingId: "h4", date: "2026-11-20", type: "valuation", amount: 999_999 },
      { id: "e5", holdingId: "h5", date: "2025-01-01", type: "buy", units: 10, price: 100 },
      { id: "e6", holdingId: "h6", date: "2026-11-20", type: "valuation", amount: 5_000_000 },
      { id: "e7", holdingId: "h7", date: "2026-11-20", type: "valuation", amount: 100_000 },
    ],
  };
  const all = buildImportPreview(snapshot, "all", today);
  const group = (k: string) => all.groups.find((g) => g.key === k);
  near(group("equity")!.amount, 100_000 + 1_000 * 83, 1e-12, "equity: INR + USD at the newest rate");
  ok(group("equity")!.items.length === 2, "archived and unvalued holdings left out of equity");
  // ₹2L for a year at 7% compounded quarterly ≈ 2L × 1.0175^4 ≈ ₹2.144L.
  const fd = group("fd")!.amount;
  ok(fd > 214_000 && fd < 215_000, `FD accrues a year of interest (${fd.toFixed(0)})`);
  // 7% compounded quarterly grows 1.0175^4 − 1 = 7.19% a year.
  eq(group("fd")!.suggestedReturn, 7.2, "FD suggests its yearly interest, compounding included");
  eq(group("fd")!.suggestedVolatility, 0, "FD volatility 0");
  eq(group("realestate")!.includeByDefault, false, "real estate not included by default");
  ok(all.skipped.some((s) => s.name === "Unvalued stock · Asha"), "unvalued holding reported, with its owner");
  ok(all.skipped.some((s) => s.name === "Yen bond · Ravi" && s.reason.includes("JPY")), "missing FX rate reported");
  ok(!all.skipped.some((s) => s.name.startsWith("Old fund")), "archived holding silently skipped");
  eq(group("equity")!.items.join(" | "), "Index fund · Asha | US ETF · Ravi", "item names carry their owner");
  eq(group("realestate")!.items.join(" | "), "Plot · Shared", "shared items say Shared");

  const asha = buildImportPreview(snapshot, "p1", today);
  near(asha.groups.find((g) => g.key === "equity")!.amount, 100_000, 1e-12, "owner filter: only Asha's equity");
  ok(!asha.groups.some((g) => g.key === "realestate"), "owner filter excludes shared");
  const shared = buildImportPreview(snapshot, "shared", today);
  ok(shared.groups.length === 1 && shared.groups[0].key === "realestate", "shared filter");

  const overridden = buildImportPreview(
    {
      ...snapshot,
      settings: {
        id: "app",
        displayCurrency: "INR",
        deviceId: "d",
        author: "a",
        fxOverrides: { INR: 90 },
      } as unknown as PortfolioSnapshot["settings"],
    },
    "p2",
    today,
  );
  near(overridden.groups.find((g) => g.key === "equity")!.amount, 90_000, 1e-12, "manual FX override wins");
}

section("[P2] Import: FD rate weighted by value, compounded, rounded; unknown asset class kept");
{
  const today = "2026-11-24";
  type Comp = "simple" | "monthly" | "quarterly" | "halfyearly" | "annually";
  const fd = (id: string, rate: number, compounding: Comp = "annually") => ({
    id,
    name: id,
    personId: "p1",
    assetClass: "debt" as const,
    currency: "INR",
    incomeMode: "accumulating" as const,
    fd: { ratePct: rate, compounding },
  });
  // Manual valuations dated today pin each FD's value (no accrual yet).
  const val = (id: string, amount: number) => ({
    id: `v-${id}`,
    holdingId: id,
    date: today,
    type: "valuation" as const,
    amount,
    createdAt: `${today}T09:00:00Z`,
  });
  const weighted = buildImportPreview(
    { people: [], fxRates: [], holdings: [fd("a", 6), fd("b", 8)], holdingEvents: [val("a", 100_000), val("b", 300_000)] },
    "all",
    today,
  );
  eq(weighted.groups[0].suggestedReturn, 7.5, "(1L × 6% + 3L × 8%) / 4L = 7.5%");
  const rounded = buildImportPreview(
    { people: [], fxRates: [], holdings: [fd("a", 7.17), fd("b", 7.05)], holdingEvents: [val("a", 100_000), val("b", 100_000)] },
    "all",
    today,
  );
  eq(rounded.groups[0].suggestedReturn, 7.1, "7.11% rounds to 7.1%");
  const odd = buildImportPreview(
    {
      people: [],
      fxRates: [],
      holdings: [{ id: "x", name: "Mystery", personId: "p1", assetClass: "bonds" as never, currency: "INR", incomeMode: "accumulating" }],
      holdingEvents: [val("x", 50_000)],
    },
    "all",
    today,
  );
  ok(odd.groups.length === 1 && odd.groups[0].key === "other" && odd.groups[0].amount === 50_000, "unknown class goes to Other");
  const builtin = buildImportPreview(
    {
      people: [],
      fxRates: [],
      holdings: [{ id: "y", name: "Odd", personId: "p1", assetClass: "toString" as never, currency: "INR", incomeMode: "accumulating" }],
      holdingEvents: [val("y", 20_000)],
    },
    "all",
    today,
  );
  ok(builtin.groups.length === 1 && builtin.groups[0].key === "other", "a class named like an object built-in still goes to Other");

  // Compounding counts: the suggestion is the yearly growth, (1 + r/n)^n − 1.
  const compounded = (rate: number, c: Comp, tax = 0) =>
    buildImportPreview({ people: [], fxRates: [], holdings: [fd("a", rate, c)], holdingEvents: [val("a", 100_000)] }, "all", today, tax)
      .groups[0].suggestedReturn;
  eq(compounded(12, "monthly"), 12.7, "12% monthly: 1.01^12 − 1 = 12.68%");
  eq(compounded(8, "halfyearly"), 8.2, "8% half-yearly: 1.04^2 − 1 = 8.16%");
  eq(compounded(7, "quarterly", 30), 5, "7% quarterly (7.19%) after 30% tax = 5.03%");
  eq(compounded(7, "simple"), 7, "simple interest: 7% a year");
  // An FD that pays its interest out doesn't compound.
  eq(
    buildImportPreview(
      { people: [], fxRates: [], holdings: [{ ...fd("a", 7, "quarterly"), incomeMode: "payout" as const }], holdingEvents: [val("a", 100_000)] },
      "all",
      today,
    ).groups[0].suggestedReturn,
    7,
    "payout FD: just its rate",
  );
  // A rate so large the weighting overflows falls back to the FD default.
  eq(compounded(1e306, "annually"), 6, "overflowing rate → default, never Infinity");
  // Exactly one year: over a 366-day span 25% would read 25.08% → 25.1.
  eq(compounded(25, "annually"), 25, "annual compounding over exactly one year");

  // The tax rate is clamped to 0..100 and a non-number counts as 0.
  eq(compounded(8, "annually", 150), 0, "tax above 100% counts as 100%: no return, never negative");
  eq(compounded(8, "annually", -5), 8, "negative tax counts as 0");
  eq(compounded(8, "annually", Number.NaN), 8, "NaN tax counts as 0");

  // Holdings with no positive, finite value aren't imported; a closed
  // position (all sold) isn't reported as left out either.
  const holding = (id: string) => ({ id, name: id, personId: "p1", assetClass: "equity" as const, currency: "INR", incomeMode: "accumulating" as const });
  const guards = buildImportPreview(
    {
      people: [{ id: "p1", name: "Asha" }],
      fxRates: [],
      holdings: [holding("Good"), holding("Zero"), holding("Negative"), holding("Infinite"), holding("Sold")],
      holdingEvents: [
        val("Good", 10_000),
        val("Zero", 0),
        val("Negative", -5_000),
        val("Infinite", Number.POSITIVE_INFINITY),
        { id: "b", holdingId: "Sold", date: "2025-01-01", type: "buy" as const, units: 10, price: 100 },
        { id: "s", holdingId: "Sold", date: "2026-01-01", type: "sell" as const, units: 10, price: 120 },
      ],
    },
    "all",
    today,
  );
  eq(guards.groups.length, 1, "one group");
  eq(guards.groups[0].amount, 10_000, "zero, negative and infinite holdings add nothing");
  eq(guards.groups[0].items.join(" | "), "Good · Asha", "only the valued holding is listed");
  eq(guards.skipped.length, 0, "a closed position isn't reported as left out");
}

section("[P3] Import: account balances as the Portfolio computes them, by account owner");
{
  const today = "2026-11-24";
  const acct = (id: string, type: string, personId: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, type, currency: "INR", personId, ...extra }) as never;
  // The Portfolio files every transfer as "shared" (manual transfers and
  // credit-card auto-pay), so that's how the fixtures do it too.
  const txn = (id: string, type: string, accountId: string, personId: string, amount: number, extra: Record<string, unknown> = {}) =>
    ({ id, date: "2026-06-01", type, accountId, personId, amount, currency: "INR", updatedAt: "2026-06-01T00:00:00Z", ...extra }) as never;
  const snapshot: PortfolioSnapshot = {
    people: [{ id: "p1", name: "Asha" }, { id: "p2", name: "Ravi" }],
    fxRates: [{ id: "fx", date: "2026-11-01", base: "USD", rates: { USD: 1, INR: 83 } }],
    holdings: [],
    holdingEvents: [],
    accounts: [
      acct("Joint savings", "bank", "shared", { openingBalance: 200_000 }),
      acct("Wallet", "cash", "p1", { openingBalance: 5_000 }),
      acct("Old SB", "bank", "p1", { openingBalance: 100_000, archived: true }),
      acct("Zerodha cash", "brokerage", "p1", { openingBalance: 25_000 }),
      acct("Bank FD", "fd", "p2", { openingBalance: 300_000, openingBalanceDate: today, interest: { ratePct: 7, frequency: "annually" } }),
      acct("US checking", "bank", "p2", { currency: "USD", openingBalance: 1_000 }),
      acct("Exchange", "crypto", "p2", { openingBalance: 40_000 }),
      acct("Plot", "realestate", "shared", { openingBalance: 3_000_000 }),
      acct("Card", "creditcard", "p1", { openingBalance: 0 }),
      acct("Overpaid card", "creditcard", "p1", { openingBalance: 5_000 }),
      acct("Home loan", "liability", "p2", { openingBalance: 500_000 }),
    ],
    transactions: [
      txn("t1", "income", "Joint savings", "p1", 50_000), // Asha's salary into the joint account
      txn("t2", "expense", "Joint savings", "p2", 20_000), // Ravi's groceries from it
      txn("t3", "expense", "Card", "p1", 15_000),
      // Card bill paid from the joint account, and an ATM withdrawal from the
      // archived account into the wallet: both transfers filed as shared.
      txn("t4", "transfer", "Joint savings", "shared", 15_000, { transferToAccountId: "Card" }),
      txn("t5", "transfer", "Old SB", "shared", 10_000, { transferToAccountId: "Wallet" }),
    ],
  };
  const pick = (owner: string, tax = 0) => {
    const pv = buildImportPreview(snapshot, owner, today, tax);
    return (k: string) => pv.groups.find((x) => x.key === k);
  };
  const all = pick("all");
  // Joint 2L + 50K − 20K − 15K = 2.15L; wallet 15K; Old SB 90K (archived but
  // still holding money, which the Portfolio Dashboard counts); Zerodha 25K;
  // US $1,000 × 83.
  near(all("bank")!.amount, 215_000 + 15_000 + 90_000 + 25_000 + 83_000, 1e-12, "everyone: bank & cash accounts");
  near(all("fd")!.amount, 300_000, 1e-12, "FD account");
  near(all("crypto")!.amount, 40_000, 1e-12, "crypto account");
  near(all("realestate")!.amount, 3_000_000, 1e-12, "real-estate account");
  eq(all("realestate")!.includeByDefault, false, "real estate not ticked by default");
  eq(all("bank")!.includeByDefault, true, "bank ticked by default");
  eq(all("bank")!.suggestedVolatility, 0, "bank volatility 0");
  const everyItem = buildImportPreview(snapshot, "all", today).groups.flatMap((g) => g.items);
  eq(everyItem.length, 8, "the eight asset accounts imported");
  ok(
    !everyItem.some((n) => ["Card", "Overpaid card", "Home loan"].some((d) => n.startsWith(`${d} ·`))),
    "credit cards and loans left out, even with a positive balance",
  );
  eq(
    [...all("bank")!.items].sort().join(" | "),
    ["Joint savings · Shared", "Wallet · Asha", "Old SB · Asha", "Zerodha cash · Asha", "US checking · Ravi"].sort().join(" | "),
    "bank group lists each account with its owner",
  );
  // Each account counts in full for its owner, so the owners add up to
  // everyone (shared transfers don't strand money under "shared").
  near(pick("p1")("bank")!.amount, 15_000 + 90_000 + 25_000, 1e-12, "Asha: wallet + Old SB + Zerodha");
  near(pick("shared")("bank")!.amount, 215_000, 1e-12, "shared: the joint account");
  near(pick("p2")("bank")!.amount, 83_000, 1e-12, "Ravi: US checking");
  ok(pick("shared")("fd") === undefined, "Ravi's FD isn't shared");
  // Interest: the FD account's 7% suggested as is, then after a 30% tax.
  eq(all("fd")!.suggestedReturn, 7, "FD account's own rate");
  eq(pick("all", 30)("fd")!.suggestedReturn, 4.9, "after 30% tax: 7 × 0.7");
  // Bank group: Joint 2.15L, Old SB 90K and US 83K have no rate (savings
  // default 3%); the wallet (cash) and Zerodha (brokerage cash) earn 0%.
  // (3.88L × 3%) / 4.28L = 2.7196%, × 0.7 = 1.904% → 1.9%.
  eq(pick("all", 30)("bank")!.suggestedReturn, 1.9, "bank: unrated savings at 3%, cash and brokerage at 0%, after 30% tax");
  eq(pick("all")("bank")!.suggestedReturn, 2.7, "same, before tax");
  eq(pick("p1")("bank")!.suggestedReturn, Math.round(((90_000 * 3) / 130_000) * 10) / 10, "Asha: only Old SB earns the default");

  // Savings interest credited monthly compounds: 4% → 1.00333^12 − 1 = 4.07%.
  const monthly = buildImportPreview(
    {
      ...snapshot,
      accounts: [acct("Monthly SB", "bank", "p1", { openingBalance: 100_000, interest: { ratePct: 4, frequency: "monthly" } })],
      transactions: [],
    },
    "all",
    today,
  );
  eq(monthly.groups[0].suggestedReturn, 4.1, "savings rate compounded at its crediting frequency");

  // Savings interest accrues as in the Portfolio: 1L at 4% a year → 1.04L.
  // A NaN rate counts as unknown (group default), not as a number.
  const interest = buildImportPreview(
    {
      ...snapshot,
      accounts: [
        acct("High-yield", "bank", "p1", { openingBalance: 100_000, openingBalanceDate: "2025-11-24", interest: { ratePct: 4, frequency: "annually" } }),
        acct("Odd", "bank", "p1", { openingBalance: 100_000, interest: { ratePct: Number.NaN, frequency: "annually" } }),
      ],
      transactions: [],
    },
    "all",
    today,
  );
  near(interest.groups[0].amount, 104_000 + 100_000, 1e-12, "savings interest accrued");
  eq(interest.groups[0].suggestedReturn, Math.round(((104_000 * 4 + 100_000 * 3) / 204_000) * 10) / 10, "NaN rate counts at the default");

  // A transfer into a USD account is credited at ITS date's rate (80), then
  // valued at the newest rate (83): ₹80K → $1,000 → ₹83K (not ₹80K).
  const fxTransfer = buildImportPreview(
    {
      ...snapshot,
      fxRates: [
        { id: "old", date: "2025-01-01", base: "USD", rates: { USD: 1, INR: 80 } },
        { id: "new", date: "2026-11-01", base: "USD", rates: { USD: 1, INR: 83 } },
      ],
      accounts: [
        acct("INR savings", "bank", "p1", { openingBalance: 100_000 }),
        acct("USD account", "bank", "p1", { currency: "USD", openingBalance: 0 }),
      ],
      transactions: [txn("x", "transfer", "INR savings", "shared", 80_000, { date: "2025-01-01", transferToAccountId: "USD account" })],
    },
    "all",
    today,
  );
  near(fxTransfer.groups[0].amount, 20_000 + 83_000, 1e-9, "cross-currency transfer at its own date's rate, valued at today's");

  // A corrupt infinite balance is ignored rather than imported as ∞.
  const inf = buildImportPreview(
    { ...snapshot, accounts: [acct("Broken", "bank", "p1", { openingBalance: Number.POSITIVE_INFINITY })], transactions: [] },
    "all",
    today,
  );
  eq(inf.groups.length, 0, "infinite balance ignored");

  // A foreign account with no rate is reported, not silently dropped.
  const noRate = buildImportPreview({ ...snapshot, fxRates: [] }, "p2", today);
  ok(noRate.skipped.some((x) => x.name === "US checking · Ravi"), "missing USD→INR rate reported");
}

section("[P4] Import: edge balances, tax only on interest, FX overrides, defaults, owners list");
{
  const today = "2026-11-24";
  const acct = (id: string, type: string, personId: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, type, currency: "INR", personId, ...extra }) as never;
  const valued = (id: string, personId: string, assetClass: string, amount: number, archived = false) => ({
    holding: { id, name: id, personId, assetClass, currency: "INR", incomeMode: "accumulating", ...(archived ? { archived } : {}) } as never,
    event: { id: `v-${id}`, holdingId: id, date: today, type: "valuation", amount } as never,
  });
  const people = [{ id: "p1", name: "Asha" }];
  const fxRates = [{ id: "fx", date: "2026-11-01", base: "USD", rates: { USD: 1, INR: 83 } }];

  // Zero and negative (overdrawn) balances add nothing and aren't listed.
  const edge = buildImportPreview(
    {
      people,
      fxRates,
      holdings: [],
      holdingEvents: [],
      accounts: [
        acct("Main", "bank", "p1", { openingBalance: 10_000 }),
        acct("Empty", "bank", "p1", { openingBalance: 0 }),
        acct("Overdrawn", "bank", "p1", { openingBalance: -5_000 }),
        acct("Empty FD", "fd", "p1", { openingBalance: 0 }),
      ],
      transactions: [],
    },
    "all",
    today,
  );
  eq(edge.groups.length, 1, "only the bank group (the empty FD makes no group)");
  eq(edge.groups[0].amount, 10_000, "zero and negative balances don't reduce or add");
  eq(edge.groups[0].items.join(" | "), "Main · Asha", "zero and negative balances not listed");

  // Income tax applies only to FD and bank interest suggestions.
  const mix = [
    valued("Nifty", "p1", "equity", 100_000),
    valued("Gilt", "p1", "debt", 100_000),
    valued("SGB", "p1", "gold", 100_000),
    valued("Liquid", "p1", "cash", 100_000),
    valued("Misc", "p1", "other", 100_000),
  ];
  const taxed = buildImportPreview(
    {
      people,
      fxRates,
      holdings: mix.map((m) => m.holding),
      holdingEvents: mix.map((m) => m.event),
      accounts: [acct("Coins", "crypto", "p1", { openingBalance: 10_000 }), acct("Flat", "realestate", "p1", { openingBalance: 10_000 })],
      transactions: [],
    },
    "all",
    today,
    30,
  );
  const ret = (k: string) => taxed.groups.find((g) => g.key === k)!.suggestedReturn;
  eq(
    ["equity", "debt", "gold", "cash", "other", "crypto", "realestate"].map(ret).join(","),
    "11,6.5,8,3.5,8,12,6",
    "tax rate leaves market-linked suggestions alone",
  );
  eq(
    taxed.groups.map((g) => g.key).join(","),
    "equity,debt,cash,gold,crypto,other,realestate",
    "groups shown in a fixed order, real estate last",
  );

  // Nothing rated: FD and bank groups suggest their defaults (6% and 3%).
  const unrated = buildImportPreview(
    {
      people,
      fxRates,
      holdings: [],
      holdingEvents: [],
      accounts: [acct("Plain FD", "fd", "p1", { openingBalance: 50_000 }), acct("Plain SB", "bank", "p1", { openingBalance: 50_000 })],
      transactions: [],
    },
    "all",
    today,
  );
  eq(unrated.groups.map((g) => `${g.key}:${g.suggestedReturn}`).join(","), "fd:6,bank:3", "unrated FD 6%, unrated bank 3%");

  // Manual FX overrides also price a recent cross-currency transfer: with
  // INR overridden to 90, ₹90K sent on 20 Nov buys $1,000, worth ₹90K, so
  // nothing appears or vanishes in the transfer (₹10K + ₹90K = ₹1L).
  const overridden = buildImportPreview(
    {
      people,
      fxRates,
      settings: { id: "app", displayCurrency: "INR", deviceId: "d", author: "a", fxOverrides: { INR: 90 } } as never,
      holdings: [],
      holdingEvents: [],
      accounts: [
        acct("INR savings", "bank", "p1", { openingBalance: 100_000 }),
        acct("USD account", "bank", "p1", { currency: "USD", openingBalance: 0 }),
      ],
      transactions: [
        {
          id: "x",
          date: "2026-11-20",
          type: "transfer",
          accountId: "INR savings",
          transferToAccountId: "USD account",
          personId: "shared",
          amount: 90_000,
          currency: "INR",
          updatedAt: "2026-11-20T00:00:00Z",
        } as never,
      ],
    },
    "all",
    today,
  );
  near(overridden.groups[0].amount, 100_000, 1e-9, "recent transfer uses the overridden rate");

  // An FD account without a rate counts at the FD default (6%).
  const fds = buildImportPreview(
    {
      people,
      fxRates,
      holdings: [],
      holdingEvents: [],
      accounts: [
        acct("Rated FD", "fd", "p1", { openingBalance: 100_000, openingBalanceDate: today, interest: { ratePct: 8, frequency: "annually" } }),
        acct("Unrated FD", "fd", "p1", { openingBalance: 100_000 }),
      ],
      transactions: [],
    },
    "all",
    today,
  );
  eq(fds.groups[0].suggestedReturn, 7, "(8% + 6% default) / 2");

  // A brokerage account with a rate set earns that rate, like any account.
  const ratedBroker = buildImportPreview(
    {
      people,
      fxRates,
      holdings: [],
      holdingEvents: [],
      accounts: [acct("Sweep", "brokerage", "p1", { openingBalance: 100_000, openingBalanceDate: today, interest: { ratePct: 5, frequency: "annually" } })],
      transactions: [],
    },
    "all",
    today,
  );
  eq(ratedBroker.groups[0].suggestedReturn, 5, "brokerage cash with a rate uses it");

  // An account type this version doesn't know is reported, not dropped.
  const unknownType = buildImportPreview(
    { people, fxRates, holdings: [], holdingEvents: [], accounts: [acct("Gift card", "voucher", "p1", { openingBalance: 2_000 })], transactions: [] },
    "all",
    today,
  );
  eq(unknownType.groups.length, 0, "unknown account type not imported");
  ok(
    unknownType.skipped.some((x) => x.name === "Gift card · Asha" && x.reason.includes("voucher")),
    "unknown account type reported",
  );

  // Owner list: active people always; archived people only if they still
  // own something with a value, or something left out (so picking them
  // shows it); an owner id not in the people list appears as Unknown.
  const nifty = valued("Nifty", "gone", "equity", 50_000);
  const oldFund = valued("Old fund", "archivedHolding", "equity", 50_000, true);
  const sold = [
    { id: "sb", holdingId: "Sold fund", date: "2025-01-01", type: "buy", units: 5, price: 100 },
    { id: "ss", holdingId: "Sold fund", date: "2026-01-01", type: "sell", units: 5, price: 110 },
  ] as never[];
  const ownersSnapshot: PortfolioSnapshot = {
    people: [
      { id: "p1", name: "Asha" },
      { id: "idle", name: "Idle" },
      { id: "gone", name: "Dad", archived: true },
      { id: "acctOnly", name: "Mum", archived: true },
      { id: "archivedHolding", name: "Uncle", archived: true },
      { id: "cardOnly", name: "Aunt", archived: true },
      { id: "drained", name: "Grandpa", archived: true },
      { id: "soldOut", name: "Cousin", archived: true },
      { id: "unvalued", name: "Nephew", archived: true },
      { id: "zeroHold", name: "Niece", archived: true },
      { id: "fxHold", name: "Brother", archived: true },
      { id: "fxAcct", name: "Sister", archived: true },
      { id: "oddType", name: "Friend", archived: true },
      { id: "zeroFx", name: "Neighbour", archived: true },
      { id: "zeroOdd", name: "Tenant", archived: true },
    ] as never,
    fxRates,
    holdings: [
      nifty.holding,
      oldFund.holding,
      { id: "Sold fund", name: "Sold fund", personId: "soldOut", assetClass: "equity", currency: "INR", incomeMode: "accumulating" } as never,
      { id: "No price", name: "No price", personId: "unvalued", assetClass: "equity", currency: "INR", incomeMode: "accumulating" } as never,
      valued("Worthless", "zeroHold", "equity", 0).holding,
      { ...(valued("Yen fund", "fxHold", "equity", 10_000).holding as object), currency: "JPY" } as never,
      { ...(valued("Yen nothing", "zeroFx", "equity", 0).holding as object), currency: "JPY" } as never,
    ],
    holdingEvents: [
      nifty.event,
      oldFund.event,
      ...sold,
      { id: "np", holdingId: "No price", date: "2025-01-01", type: "buy", units: 5, price: 100 } as never,
      valued("Worthless", "zeroHold", "equity", 0).event,
      valued("Yen fund", "fxHold", "equity", 10_000).event,
      valued("Yen nothing", "zeroFx", "equity", 0).event,
    ],
    accounts: [
      acct("Mum SB", "bank", "acctOnly", { openingBalance: 1_000 }),
      acct("Aunt card", "creditcard", "cardOnly", { openingBalance: 0 }),
      acct("Grandpa SB", "bank", "drained", { openingBalance: 0 }),
      acct("Stray", "bank", "nobody", { openingBalance: 1_000 }),
      acct("Joint", "bank", "shared", { openingBalance: 2_000 }),
      acct("Voucher", "voucher", "p1", { openingBalance: 500 }),
      acct("Yen SB", "bank", "fxAcct", { currency: "JPY", openingBalance: 10_000 }),
      acct("Points", "voucher", "oddType", { openingBalance: 300 }),
      acct("Empty points", "voucher", "zeroOdd", { openingBalance: 0 }),
    ],
    transactions: [],
  };
  const owners = buildImportPreview(ownersSnapshot, "all", today);
  eq(
    owners.people.map((p) => `${p.id}${p.archived ? "*" : ""}`).join(","),
    "p1,idle,gone*,acctOnly*,unvalued*,fxHold*,fxAcct*,oddType*,nobody",
    "archived people listed (and marked) only when they own something with a value or left out",
  );
  // Left out: the unpriced holding, the yen fund, the yen account and the two
  // vouchers with a balance (not the empty one, nor the worthless yen fund).
  eq(owners.skipped.length, 5, "five items left out");
  eq(owners.people.find((p) => p.id === "nobody")?.name, "Unknown", "an owner missing from the people list shows as Unknown");
  // Every owner view (each listed person + shared) adds up to everyone.
  const total = (pv: { groups: { amount: number }[] }) => pv.groups.reduce((s, g) => s + g.amount, 0);
  const perOwner = [...owners.people.map((p) => p.id), "shared"].map((id) => buildImportPreview(ownersSnapshot, id, today));
  ok(
    perOwner.every((pv) => JSON.stringify(pv.people) === JSON.stringify(owners.people)),
    "the owner list is the same whoever is selected",
  );
  near(perOwner.reduce((s, pv) => s + total(pv), 0), total(owners), 1e-9, "owner views add up to Everyone");
  eq(
    perOwner.reduce((s, pv) => s + pv.skipped.length, 0),
    owners.skipped.length,
    "every left-out item shows under one owner",
  );
  near(
    buildImportPreview(
      { people: owners.people as never, fxRates, holdings: [nifty.holding], holdingEvents: [nifty.event] },
      "gone",
      today,
    ).groups[0].amount,
    50_000,
    1e-12,
    "an archived owner's money shows under their name",
  );
  ok(owners.groups.find((g) => g.key === "bank")!.items.includes("Stray · Unknown"), "unknown owner id labelled Unknown");
}

section("[C1] Saved configs: old ones load with new defaults; scenarios round-trip");
{
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  const storage = await import("../src/utils/storage");
  // A config saved before this release: no income, tax, phases, etc.
  store.set(
    "retirement_calculator_config",
    JSON.stringify({
      currentAge: 40,
      retirementAge: 58,
      inflation: 6,
      monthlyExpenses: 70_000,
      expenseType: "monthly",
      investmentBuckets: [{ id: 1, name: "Old", amount: 1, return: 8 }],
      oneTimeExpenses: [],
      nextBucketId: 2,
      nextExpenseId: 1,
      tax: { incomeTaxRate: 30 },
    }),
  );
  const loaded = storage.getInitialRetirementConfig();
  eq(loaded.currentAge, 40, "kept saved value");
  ok(Array.isArray(loaded.incomeStreams) && loaded.incomeStreams.length === 0, "income streams defaulted");
  eq(loaded.tax.incomeTaxRate, 30, "partial tax kept");
  eq(loaded.tax.ltcgRate, 12.5, "missing tax fields filled");
  eq(loaded.withdrawalStrategy, "proRata", "strategy defaulted");
  eq(loaded.healthcare.inflation, 10, "healthcare defaulted");

  ok(storage.saveScenarios([{ id: "a", name: "Retire 55", savedAt: "2026-11-24T00:00:00Z", config: loaded }]), "scenario saved");
  const list = storage.listScenarios();
  eq(list.length, 1, "one scenario back");
  eq(list[0].config.retirementAge, 58, "config round-trips");
  store.set("retirement_calculator_scenarios", "not json");
  eq(storage.listScenarios().length, 0, "corrupt storage → empty list, no crash");

  // Valid JSON with the wrong types must not crash the page.
  const bad = storage.normalizeConfig({
    currentAge: "40" as never,
    incomeStreams: null as never,
    spendingPhases: "oops" as never,
    healthcare: { monthlyCost: 5_000 } as never,
    tax: [] as never,
    monteCarloIterations: Number.NaN,
  });
  eq(bad.currentAge, storage.defaultConfig.currentAge, "string age → default");
  ok(Array.isArray(bad.incomeStreams) && bad.incomeStreams.length === 0, "null list → []");
  ok(Array.isArray(bad.spendingPhases) && bad.spendingPhases.length === 0, "string list → []");
  eq(bad.healthcare.monthlyCost, 5_000, "partial healthcare kept");
  eq(bad.healthcare.inflation, 10, "missing healthcare field filled");
  eq(bad.tax.ltcgRate, 12.5, "wrong-type tax → defaults");
  eq(bad.monteCarloIterations, storage.defaultConfig.monteCarloIterations, "NaN → default");
  const nulls = storage.normalizeConfig({ incomeStreams: [null] as never, investmentBuckets: [1, 2] as never });
  ok(nulls.incomeStreams.length === 0, "list of nulls → []");
  eq(nulls.investmentBuckets, storage.defaultConfig.investmentBuckets, "list of numbers → default");
  // A saved scenario missing newer fields comes back complete.
  store.set(
    "retirement_calculator_scenarios",
    JSON.stringify([
      {
        id: "old",
        name: "Old plan",
        savedAt: "2025-01-01T00:00:00Z",
        config: { currentAge: 45, inflation: 6, monthlyExpenses: 1, expenseType: "yearly", investmentBuckets: [], oneTimeExpenses: [], nextBucketId: 1, nextExpenseId: 1 },
      },
    ]),
  );
  const old = storage.listScenarios()[0];
  eq(old.config.withdrawalStrategy, "proRata", "old scenario gets new defaults");
  eq(old.config.currentAge, 45, "old scenario keeps its values");
}

done();
