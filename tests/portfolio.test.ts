// Tests for the portfolio domain: holding XIRR/value/quality and net-worth
// rollups. Run with tsx (see package.json).

import {
  currentHoldingValue,
  dataQuality,
  fdAccrualValuation,
  fdMaturityInfo,
  fdMaturityWatch,
  fdValue,
  firstDepositDate,
  isFdDueSoon,
  holdingPnl,
  holdingXirr,
  netUnits,
  portfolioReturn,
  validateFdInput,
  withFdAccrual,
} from "../src/features/portfolio/domain/holdings";
import { accountBalances, accountBalancesByPerson, netWorth, sumAccountBalances, totalReturn } from "../src/features/portfolio/domain/networth";
import { categoryTotals, filterTransactions, flowSummary, monthlyTotals, type TxnFilter } from "../src/features/portfolio/domain/transactions";
import {
  autopayId,
  desiredAutopayTransfers,
  isAutopayTransaction,
  planAutopayReconcile,
} from "../src/features/portfolio/domain/autopay";
import { accountOptions, categoryOptions, composeAccountExtras, fdMaturityStatus, personOptions } from "../src/features/portfolio/ui/helpers";
import type { PortfolioState } from "../src/features/portfolio/state/store";
import { accruedInterest, compoundValue } from "../src/lib/money/interest";
import { xirr, type Cashflow } from "../src/lib/money/xirr";
import { addMonthsIso, addTenureIso, daysInMonth, ddmmyyyyToIso, formatDdmmyyyy, isoFromParts, isoToDdmmyyyy } from "../src/lib/util/date";
import type { Account, Category, Holding, HoldingEvent, Transaction } from "../src/features/portfolio/model/types";
import type { FxTable } from "../src/lib/money/currency";
import { done, eq, near, ok, section } from "./_harness";

const ev = (e: Partial<HoldingEvent> & Pick<HoldingEvent, "type" | "date">): HoldingEvent => ({
  id: Math.random().toString(36).slice(2),
  holdingId: "h1",
  ...e,
});

// ---------------------------------------------------------------------------
section("[networth] unconvertible cross-currency transfer is skipped, not mis-booked");
{
  const accounts: Account[] = [
    { id: "A1", name: "USD", type: "bank", currency: "USD", personId: "shared" },
    { id: "A2", name: "INR", type: "bank", currency: "INR", personId: "shared" },
  ];
  const txns: Transaction[] = [
    {
      id: "t1",
      date: "2026-01-01",
      type: "transfer",
      accountId: "A1",
      personId: "shared",
      amount: 100,
      currency: "USD",
      transferToAccountId: "A2",
      updatedAt: "",
    },
  ];
  const noInr: FxTable = { base: "USD", rates: { USD: 1 } }; // no INR rate
  const bal = accountBalances(accounts, txns, noInr);
  eq(bal.get("A1"), 0, "source NOT debited (whole transfer skipped when unconvertible)");
  eq(bal.get("A2"), 0, "dest NOT credited a mis-scaled raw amount");
  const fx: FxTable = { base: "USD", rates: { USD: 1, INR: 80 } };
  const bal2 = accountBalances(accounts, txns, fx);
  eq(bal2.get("A1"), -100, "with a rate: source debited 100 USD");
  near(bal2.get("A2") ?? 0, 8000, 0, "dest credited 100 USD → 8000 INR");
}

section("[holding] opening units without a cost → gain unknown, not full value");
{
  const events = [
    ev({ type: "opening", date: "2025-01-01", units: 10 }), // quantity set, cost blank
    ev({ type: "valuation", date: "2026-06-28", amount: 20000 }),
  ];
  const pnl = holdingPnl(events);
  eq(pnl.invested, 0, "invested 0 (no cost recorded)");
  near(pnl.value ?? 0, 20000, 0, "value present");
  eq(pnl.absoluteGain, null, "gain null (cost unknown) — NOT 20000 as a free gain");
}

section("[holding] SELLING an unknown-basis position doesn't fake a realized gain");
{
  const events = [
    ev({ type: "opening", date: "2025-01-01", units: 10 }), // quantity only, no cost
    ev({ type: "sell", date: "2026-01-01", units: 10, price: 200 }), // proceeds 2000
  ];
  const pnl = holdingPnl(events);
  eq(pnl.invested, 0, "no cost recorded");
  near(pnl.income, 2000, 0, "proceeds counted as income");
  eq(pnl.absoluteGain, null, "gain null (basis unknown) — NOT 2000 as a fake realized gain");
}

section("[holding] closed position WITH a real basis still reports realized gain");
{
  const events = [
    ev({ type: "buy", date: "2025-01-01", units: 10, price: 100 }), // invested 1000
    ev({ type: "sell", date: "2026-01-01", units: 10, price: 150 }), // proceeds 1500
  ];
  const pnl = holdingPnl(events);
  near(pnl.invested, 1000, 0, "invested 1000");
  eq(pnl.absoluteGain, 500, "realized gain 1500 − 1000");
}

section("[holding] fully-sold FRACTIONAL position is closed (float residue snapped)");
{
  const events = [
    ev({ type: "buy", date: "2025-01-01", units: 0.1, price: 100 }),
    ev({ type: "buy", date: "2025-02-01", units: 0.2, price: 100 }),
    ev({ type: "sell", date: "2026-01-01", units: 0.3, price: 150 }),
  ];
  eq(netUnits(events), 0, "0.1 + 0.2 − 0.3 snaps to 0 (not 5.5e-17)");
  eq(currentHoldingValue(events), null, "closed → no current value");
  near(holdingPnl(events).absoluteGain ?? NaN, 15, 1e-9, "realized gain 0.3×(150−100)=15 (not null)");
}

section("[holding] a valuation AFTER a sell-out doesn't inflate value / net worth");
{
  const events = [
    ev({ type: "buy", date: "2025-01-01", units: 100, price: 100 }), // invested 10000
    ev({ type: "sell", date: "2026-01-01", units: 100, price: 150 }), // proceeds 15000, closed
    ev({ type: "valuation", date: "2026-02-01", amount: 9999 }), // stray valuation
  ];
  eq(currentHoldingValue(events), null, "closed → ignore the stray valuation (not 9999)");
  near(holdingPnl(events).absoluteGain ?? NaN, 5000, 1e-9, "realized 15000−10000 = 5000 (NOT 14999)");
}

section("[holding] netUnits counts opening units (live-priceable position)");
{
  // Amount-only opening → units untracked (can't live-price).
  eq(netUnits([ev({ type: "opening", date: "2025-01-01", amount: 5000 })]), null, "amount-only opening → null");
  // Opening with units + a later buy → summed net position.
  const units = netUnits([
    ev({ type: "opening", date: "2025-01-01", units: 0.085, amount: 5000 }),
    ev({ type: "buy", date: "2026-01-01", units: 0.01, price: 60000 }),
  ]);
  near(units ?? 0, 0.095, 0, "opening units + buy units");
}

// ---------------------------------------------------------------------------
section("[holding] legacy opening + valuation → estimated since-inception XIRR");
{
  // Invest 100k in 2020, worth 200k in 2024 → 2^(1/4) - 1 ≈ 18.92%.
  const events = [
    ev({ type: "opening", date: "2020-01-01", amount: 100_000 }),
    ev({ type: "valuation", date: "2024-01-01", amount: 200_000 }),
  ];
  const r = holdingXirr(events);
  // actual/365 day count over a span that includes a leap day → tol a touch loose.
  near(r ?? NaN, Math.pow(2, 0.25) - 1, 5e-3, "≈18.9% since-inception");
  eq(dataQuality(events), "cost-estimate", "data quality = cost-estimate");
  eq(currentHoldingValue(events), 200_000, "current value = latest valuation");
}

section("[holding] value-only (no cost) → XIRR null, quality value-only");
{
  const events = [ev({ type: "valuation", date: "2024-01-01", amount: 50_000 })];
  eq(holdingXirr(events), null, "no cost basis → XIRR null");
  eq(dataQuality(events), "value-only", "data quality = value-only");
}

section("[holding] complete history (buys) → quality complete + accumulating skips dividends");
{
  const events = [
    ev({ type: "buy", date: "2022-01-01", units: 100, price: 100 }), // -10,000
    ev({ type: "buy", date: "2023-01-01", units: 50, price: 120 }), // -6,000
    ev({ type: "valuation", date: "2024-01-01", amount: 20_000 }),
  ];
  eq(dataQuality(events), "complete", "data quality = complete");
  const pnl = holdingPnl(events);
  near(pnl.invested, 16_000, 1e-9, "invested = 16,000");
  near(pnl.absoluteGain ?? NaN, 4_000, 1e-9, "absolute gain = 4,000 (no dividends needed)");
  const r = holdingXirr(events);
  ok(r !== null && r > 0, "positive XIRR computed");
}

section("[holding] same-date valuation: the most recently recorded one wins");
{
  const events = [
    ev({ type: "valuation", date: "2026-06-01", amount: 1000, createdAt: "2026-06-01T10:00:00Z" }),
    ev({ type: "valuation", date: "2026-06-01", amount: 1500, createdAt: "2026-06-01T11:00:00Z" }),
  ];
  eq(currentHoldingValue(events), 1500, "corrected (later createdAt) value wins, not the stale first");
}

section("[holding] same-DAY activity after a valuation makes it stale (createdAt order)");
{
  const events = [
    ev({ type: "buy", date: "2026-06-01", units: 100, price: 100, createdAt: "2026-06-01T09:00:00Z" }),
    ev({ type: "valuation", date: "2026-06-01", amount: 12_000, createdAt: "2026-06-01T10:00:00Z" }),
    // sell entered LATER the same calendar day → valuation is now stale
    ev({ type: "sell", date: "2026-06-01", units: 100, price: 130, createdAt: "2026-06-01T11:00:00Z" }),
  ];
  eq(currentHoldingValue(events), null, "valuation stale (same-day sell recorded after it)");
}

section("[holding] legacy same-day valuation+sell with NO createdAt → conservatively stale");
{
  // No createdAt on either (imported/legacy) → can't order → fail to honest "—"
  // instead of a UUID coin-flip that might show a fresh value for a sold position.
  const events = [
    ev({ type: "valuation", date: "2026-06-01", amount: 12_000 }),
    ev({ type: "sell", date: "2026-06-01", units: 100, price: 130 }),
  ];
  eq(currentHoldingValue(events), null, "ambiguous same-day legacy → stale (null)");
}

section("[holding] same-day valuation recorded AFTER activity is current (not stale)");
{
  const events = [
    ev({ type: "buy", date: "2026-06-01", units: 100, price: 100, createdAt: "2026-06-01T09:00:00Z" }),
    ev({ type: "valuation", date: "2026-06-01", amount: 12_000, createdAt: "2026-06-01T11:00:00Z" }),
  ];
  eq(currentHoldingValue(events), 12_000, "valuation after the buy is current");
}

section("[holding] XIRR is null for an OPEN position with a stale valuation");
{
  const events = [
    ev({ type: "buy", date: "2022-01-01", units: 200, price: 100 }), // -20,000
    ev({ type: "valuation", date: "2022-06-01", amount: 25_000 }), // stale: sell is later
    ev({ type: "sell", date: "2023-01-01", units: 100, price: 160 }), // +16,000, 100 units still held
  ];
  eq(currentHoldingValue(events), null, "value null (stale)");
  eq(holdingXirr(events), null, "XIRR null too — no confident wrong number");
}

section("[holding] XIRR null for opening+adjustment with no real value");
{
  const events = [
    ev({ type: "opening", date: "2020-01-01", amount: 100_000 }),
    ev({ type: "adjustment", date: "2021-01-01", amount: 5_000 }),
  ];
  eq(holdingXirr(events), null, "no closing valuation / not closed → XIRR null");
}

section("[holding] valuation stale after a sell is NOT double-counted");
{
  const events = [
    ev({ type: "buy", date: "2022-01-01", units: 100, price: 100 }), // -10,000
    ev({ type: "valuation", date: "2022-06-01", amount: 12_000 }), // stale: sell is later
    ev({ type: "sell", date: "2023-01-01", units: 100, price: 150 }), // +15,000
  ];
  eq(currentHoldingValue(events), null, "stale valuation → null current value");
  eq(holdingPnl(events).value, null, "pnl value null (no phantom closing inflow)");
  const x = holdingXirr(events);
  ok(x !== null && x > 0, "realized XIRR from buy+sell only");
}

section("[holding] fully-closed position reports realized gain (not —)");
{
  const events = [
    ev({ type: "buy", date: "2022-01-01", units: 100, price: 100 }), // -10,000
    ev({ type: "sell", date: "2023-01-01", units: 100, price: 150 }), // +15,000, units net 0
  ];
  const pnl = holdingPnl(events);
  eq(pnl.value, null, "no current value (position closed)");
  near(pnl.absoluteGain ?? NaN, 5_000, 1e-9, "realized gain = 15,000 − 10,000");
}

section("[holding] dividend after the latest valuation marks it stale");
{
  const events = [
    ev({ type: "buy", date: "2022-01-01", units: 100, price: 100 }),
    ev({ type: "valuation", date: "2023-01-01", amount: 13_000 }),
    ev({ type: "dividend", date: "2023-06-01", amount: 500 }), // after valuation
  ];
  eq(currentHoldingValue(events), null, "pre-dividend valuation is stale → null");
}

section("[holding] payout dividend counted as inflow");
{
  const noDiv = [
    ev({ type: "buy", date: "2022-01-01", units: 100, price: 100 }),
    ev({ type: "valuation", date: "2024-01-01", amount: 11_000 }),
  ];
  const withDiv = [
    ev({ type: "buy", date: "2022-01-01", units: 100, price: 100 }),
    ev({ type: "dividend", date: "2023-01-01", amount: 1_000 }),
    ev({ type: "valuation", date: "2024-01-01", amount: 11_000 }),
  ];
  const a = holdingXirr(noDiv) ?? 0;
  const b = holdingXirr(withDiv) ?? 0;
  ok(b > a, "dividend inflow raises XIRR");
}

// ---------------------------------------------------------------------------
section("[networth] account balances from transactions");
{
  const accounts: Account[] = [
    { id: "A1", name: "Checking", type: "bank", currency: "USD", personId: "p1" },
    { id: "A2", name: "Savings", type: "bank", currency: "USD", personId: "p1" },
  ];
  const txns: Transaction[] = [
    { id: "t1", date: "2024-01-01", type: "income", accountId: "A1", personId: "p1", amount: 1000, currency: "USD", updatedAt: "" },
    { id: "t2", date: "2024-01-02", type: "expense", accountId: "A1", personId: "p1", amount: 300, currency: "USD", updatedAt: "" },
    { id: "t3", date: "2024-01-03", type: "transfer", accountId: "A1", personId: "p1", amount: 200, currency: "USD", transferToAccountId: "A2", updatedAt: "" },
  ];
  const bal = accountBalances(accounts, txns);
  near(bal.get("A1") ?? NaN, 500, 1e-9, "A1 = 1000 - 300 - 200 = 500");
  near(bal.get("A2") ?? NaN, 200, 1e-9, "A2 = +200 from transfer");
}

section("[networth] expense on a SHARED account is attributed to the txn owner, not 'shared'");
{
  const accounts: Account[] = [
    { id: "A1", name: "Shared", type: "bank", currency: "USD", personId: "shared" },
  ];
  const txns: Transaction[] = [
    { id: "i1", date: "2026-01-01", type: "income", accountId: "A1", personId: "shared", amount: 1000, currency: "USD", updatedAt: "" },
    { id: "e1", date: "2026-02-01", type: "expense", accountId: "A1", personId: "p1", amount: 300, currency: "USD", updatedAt: "" },
  ];
  const fx = { base: "USD", rates: {} };
  const balances = accountBalances(accounts, txns, fx);
  near(balances.get("A1") ?? NaN, 700, 1e-9, "account total = 1000 − 300");
  const balancesByPerson = accountBalancesByPerson(accounts, txns, fx);
  const nw = netWorth({ accounts, balances, balancesByPerson, holdings: [], holdingValues: new Map(), fx });
  near(nw.byPerson["shared"] ?? NaN, 1000, 1e-9, "shared keeps the +1000 income");
  near(nw.byPerson["p1"] ?? NaN, -300, 1e-9, "p1 is charged the −300 expense (not 'shared')");
  near((nw.byPerson["shared"] ?? 0) + (nw.byPerson["p1"] ?? 0), nw.total, 1e-9, "per-person sums to total");
  near(nw.total, 700, 1e-9, "total = 700");
}

section("[networth] excludeFromBalance (historical) transactions don't move balances");
{
  const accounts: Account[] = [{ id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "p1" }];
  const txns: Transaction[] = [
    { id: "i1", date: "2026-01-01", type: "income", accountId: "A1", personId: "p1", amount: 1000, currency: "USD", updatedAt: "" },
    { id: "h1", date: "2020-01-01", type: "expense", accountId: "A1", personId: "p1", amount: 500, currency: "USD", excludeFromBalance: true, updatedAt: "" },
  ];
  near(accountBalances(accounts, txns).get("A1") ?? NaN, 1000, 1e-9, "historical expense excluded → balance unchanged");
}

section("[networth] multi-currency rollup: total / assets / liabilities / per-person / allocation");
{
  const accounts: Account[] = [
    { id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "p1" },
    { id: "L1", name: "Loan", type: "liability", currency: "USD", personId: "p1" },
  ];
  const holdings: Holding[] = [
    { id: "H1", name: "Index Fund", personId: "p1", assetClass: "equity", currency: "INR", incomeMode: "accumulating" },
  ];
  const result = netWorth({
    accounts,
    balances: new Map([["A1", 1000], ["L1", -500]]),
    holdings,
    holdingValues: new Map([["H1", 16_000]]), // 16,000 INR / 80 = 200 USD
    fx: { base: "USD", rates: { INR: 80 } },
  });
  near(result.assets, 1200, 1e-9, "assets = 1000 + 200");
  near(result.liabilities, 500, 1e-9, "liabilities = 500");
  near(result.total, 700, 1e-9, "net worth = 700");
  near(result.byPerson["p1"] ?? NaN, 700, 1e-9, "p1 net = 700");
  near(result.byAssetClass.equity ?? NaN, 200, 1e-9, "equity allocation = 200 USD");
}

section("[networth] a self-transfer (same account both legs) nets to zero");
{
  const accounts: Account[] = [{ id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "shared" }];
  const txns: Transaction[] = [
    { id: "i1", date: "2025-01-01", type: "income", accountId: "A1", personId: "shared", amount: 1000, currency: "USD", updatedAt: "" },
    // Both legs land on A1 — must net out, not double-apply (per-leg, not total-effect).
    { id: "t1", date: "2025-02-01", type: "transfer", accountId: "A1", personId: "shared", amount: 100, currency: "USD", transferToAccountId: "A1", updatedAt: "" },
  ];
  near(accountBalances(accounts, txns).get("A1") ?? NaN, 1000, 1e-9, "self-transfer leaves the balance unchanged");
}

section("[networth] a cross-currency transfer is credited at the TRANSFER-date rate, not today's");
{
  const accounts: Account[] = [
    { id: "USD", name: "US", type: "bank", currency: "USD", personId: "shared" },
    { id: "INR", name: "IN", type: "bank", currency: "INR", personId: "shared" },
  ];
  const txns: Transaction[] = [
    { id: "t1", date: "2024-01-01", type: "transfer", accountId: "USD", personId: "shared", amount: 100, currency: "USD", transferToAccountId: "INR", updatedAt: "" },
  ];
  const atTransfer: FxTable = { base: "USD", rates: { USD: 1, INR: 80 } }; // rate on the transfer day
  const atToday: FxTable = { base: "USD", rates: { USD: 1, INR: 100 } }; // INR has since depreciated
  const fxAt = (date: string): FxTable => (date <= "2024-06-01" ? atTransfer : atToday);
  // Per-date resolver → the credit is LOCKED at the transfer-date rate (100·80 = 8000 INR),
  // so the INR balance doesn't drift as today's rate changes.
  near(accountBalances(accounts, txns, fxAt).get("INR") ?? NaN, 8000, 1e-9, "credited 8000 INR (transfer-date rate)");
  near(accountBalances(accounts, txns, fxAt).get("USD") ?? NaN, -100, 1e-9, "source debited 100 USD");
  // A plain table still converts at that table — unchanged behaviour for existing callers.
  near(accountBalances(accounts, txns, atToday).get("INR") ?? NaN, 10000, 1e-9, "single table → that table's rate (10000)");
}

section("[networth] transfer to a MISSING account is skipped whole (no money LOST)");
{
  const accounts: Account[] = [
    { id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "p1" },
  ]; // dest account "A2" intentionally absent (incomplete import / cross-device snapshot)
  const txns: Transaction[] = [
    { id: "t1", date: "2024-01-01", type: "income", accountId: "A1", personId: "p1", amount: 1000, currency: "USD", updatedAt: "" },
    { id: "t2", date: "2024-01-02", type: "transfer", accountId: "A1", personId: "p1", amount: 300, currency: "USD", transferToAccountId: "A2", updatedAt: "" },
  ];
  const bal = accountBalances(accounts, txns);
  near(bal.get("A1") ?? NaN, 1000, 1e-9, "source NOT debited when dest is missing (whole transfer skipped)");
  const nw = netWorth({ accounts, balances: bal, balancesByPerson: accountBalancesByPerson(accounts, txns), holdings: [], holdingValues: new Map(), fx: { base: "USD", rates: {} } });
  near(nw.total, 1000, 1e-9, "net worth = 1000 — the 300 did not vanish");
}

section("[networth] transfer FROM a missing account is skipped whole (no money FABRICATED)");
{
  const accounts: Account[] = [
    { id: "A2", name: "Brokerage", type: "brokerage", currency: "USD", personId: "p1" },
  ]; // source account "A1" absent
  const txns: Transaction[] = [
    { id: "t1", date: "2024-01-01", type: "transfer", accountId: "A1", personId: "p1", amount: 300, currency: "USD", transferToAccountId: "A2", updatedAt: "" },
  ];
  const bal = accountBalances(accounts, txns);
  near(bal.get("A2") ?? NaN, 0, 1e-9, "dest NOT credited when source is missing (no money created)");
  const nw = netWorth({ accounts, balances: bal, balancesByPerson: accountBalancesByPerson(accounts, txns), holdings: [], holdingValues: new Map(), fx: { base: "USD", rates: {} } });
  near(nw.total, 0, 1e-9, "net worth = 0 — nothing fabricated");
}

section("[networth] valid same-currency transfer nets to zero + per-person sums to total");
{
  const accounts: Account[] = [
    { id: "A1", name: "Bank", type: "bank", currency: "USD", personId: "p1" },
    { id: "A2", name: "Brokerage", type: "brokerage", currency: "USD", personId: "p2" },
  ];
  const txns: Transaction[] = [
    { id: "t1", date: "2024-01-01", type: "income", accountId: "A1", personId: "p1", amount: 1000, currency: "USD", updatedAt: "" },
    { id: "t2", date: "2024-01-02", type: "transfer", accountId: "A1", personId: "shared", amount: 400, currency: "USD", transferToAccountId: "A2", updatedAt: "" },
  ];
  const bal = accountBalances(accounts, txns);
  near(bal.get("A1") ?? NaN, 600, 1e-9, "A1 = 1000 − 400");
  near(bal.get("A2") ?? NaN, 400, 1e-9, "A2 = +400");
  const nw = netWorth({ accounts, balances: bal, balancesByPerson: accountBalancesByPerson(accounts, txns), holdings: [], holdingValues: new Map(), fx: { base: "USD", rates: {} } });
  near(nw.total, 1000, 1e-9, "net worth = 1000 (transfer nets to zero)");
  const sumByPerson = Object.values(nw.byPerson).reduce((s, v) => s + v, 0);
  near(sumByPerson, nw.total, 1e-9, "sum(byPerson) === total");
}

section("[portfolio] money-weighted return (XIRR) across holdings, multi-currency");
{
  const usd: FxTable = { base: "USD", rates: { USD: 1, INR: 80 } };
  const fxAt = (): FxTable => usd; // flat rates for the test
  const holdings: Holding[] = [
    { id: "H1", name: "US ETF", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
    { id: "H2", name: "IN Fund", personId: "p1", assetClass: "equity", currency: "INR", incomeMode: "accumulating" },
    { id: "H3", name: "No basis", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
  ];
  const events = new Map<string, HoldingEvent[]>([
    // +50% over exactly one year (buy 100 → worth 150).
    ["H1", [ev({ type: "buy", date: "2024-01-01", units: 100, price: 1 }), ev({ type: "valuation", date: "2025-01-01", amount: 150 })]],
    // INR holding, also +50% over the year (8000 INR → 12000 INR); converts to USD 1:80.
    ["H2", [ev({ type: "buy", date: "2024-01-01", units: 80, price: 100 }), ev({ type: "valuation", date: "2025-01-01", amount: 12000 })]],
    // value-only (no cost basis) → excluded from the return.
    ["H3", [ev({ type: "valuation", date: "2025-01-01", amount: 999 })]],
  ]);
  const r = portfolioReturn(holdings, events, "USD", fxAt, "2025-01-01");
  eq(r.included, 2, "the two cost-basis holdings contribute; value-only one excluded");
  eq(r.total, 3, "all three counted in the total");
  near(r.invested, 200, 1e-9, "invested = 100 USD + 8000 INR/80 = 200 USD");
  near(r.value, 300, 1e-9, "value = 150 USD + 12000 INR/80 = 300 USD");
  near(r.xirr ?? NaN, 0.5, 0.02, "~50% p.a. money-weighted (both holdings +50% over 1y)");
}

section("[portfolio] a holding added TODAY (0-day span) is still counted, not dropped");
{
  const fxAt = (): FxTable => ({ base: "USD", rates: { USD: 1 } });
  const today = "2025-06-30";
  const holdings: Holding[] = [
    { id: "H1", name: "Bought today", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
  ];
  const events = new Map<string, HoldingEvent[]>([
    ["H1", [
      ev({ type: "buy", date: today, units: 100, price: 1, createdAt: "2025-06-30T10:00:00Z" }),
      ev({ type: "valuation", date: today, amount: 110, createdAt: "2025-06-30T11:00:00Z" }),
    ]],
  ]);
  const r = portfolioReturn(holdings, events, "USD", fxAt, today);
  eq(r.included, 1, "same-day holding IS counted (regression: was wrongly dropped)");
  near(r.invested, 100, 1e-9, "invested counted");
  near(r.value, 110, 1e-9, "value counted");
  eq(r.xirr, null, "annualized return undefined over a 0-day span → honest —, not a fake %");
}

section("[portfolio] same-day holding + a 1-year holding → both counted, return solvable");
{
  const fxAt = (): FxTable => ({ base: "USD", rates: { USD: 1 } });
  const asOf = "2025-01-01";
  const holdings: Holding[] = [
    { id: "H1", name: "Today", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
    { id: "H2", name: "One year", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
  ];
  const events = new Map<string, HoldingEvent[]>([
    ["H1", [
      ev({ type: "buy", date: asOf, units: 100, price: 1, createdAt: "2025-01-01T10:00:00Z" }),
      ev({ type: "valuation", date: asOf, amount: 110, createdAt: "2025-01-01T11:00:00Z" }),
    ]],
    ["H2", [ev({ type: "buy", date: "2024-01-01", units: 100, price: 1 }), ev({ type: "valuation", date: asOf, amount: 150 })]],
  ]);
  const r = portfolioReturn(holdings, events, "USD", fxAt, asOf);
  eq(r.included, 2, "both holdings counted");
  near(r.invested, 200, 1e-9, "invested = 100 + 100");
  near(r.value, 260, 1e-9, "value = 110 + 150");
  ok(r.xirr !== null && r.xirr > 0, "combined return solvable + positive (the 1yr holding gives a nonzero span)");
}

// --- Fixed-deposit auto-accrual -------------------------------------------
// (1-year spans use a NON-leap base year so actual/365 gives t = 1 exactly.)
const fdHolding = (fd: Holding["fd"], incomeMode: Holding["incomeMode"] = "accumulating"): Holding => ({
  id: "h1",
  name: "FD",
  personId: "shared",
  assetClass: "debt",
  currency: "USD",
  incomeMode,
  fd,
});

section("[fd] fdValue: compounding formulas over one year");
{
  const y = (c: "annually" | "quarterly" | "monthly" | "halfyearly" | "simple", rate: number) =>
    fdValue(1000, { ratePct: rate, compounding: c }, "2023-01-01", "2024-01-01");
  near(y("annually", 10), 1100, 1e-6, "annual: 1000·1.10");
  near(y("simple", 10), 1100, 1e-6, "simple: 1000·(1+0.10)");
  near(y("quarterly", 8), 1000 * Math.pow(1.02, 4), 1e-6, "quarterly: 1000·(1+0.08/4)^4");
  near(y("monthly", 12), 1000 * Math.pow(1.01, 12), 1e-6, "monthly: 1000·(1+0.12/12)^12");
  near(y("halfyearly", 6), 1000 * Math.pow(1.03, 2), 1e-6, "half-yearly: 1000·(1+0.06/2)^2");
}

section("[fd] fdValue: before start, zero rate, and maturity cap");
{
  const t = { ratePct: 10, compounding: "annually" as const };
  eq(fdValue(1000, t, "2024-01-01", "2023-06-01"), 1000, "asOf before start → principal (no negative accrual)");
  eq(fdValue(1000, { ratePct: 0, compounding: "annually" }, "2023-01-01", "2024-01-01"), 1000, "0% → principal");
  // Matures after 1 year; asking 3 years later still only accrues to maturity.
  near(
    fdValue(1000, { ratePct: 10, compounding: "annually", maturityDate: "2024-01-01" }, "2023-01-01", "2026-01-01"),
    1100,
    1e-6,
    "accrual stops at maturity (1 year), not 3",
  );
}

section("[fd] accrues from the opening principal at read time");
{
  const h = fdHolding({ ratePct: 10, compounding: "annually" });
  const events = [ev({ type: "opening", date: "2023-01-01", amount: 1000 })];
  const augmented = withFdAccrual(h, events, "2024-01-01");
  eq(augmented.length, 2, "a synthetic valuation is injected");
  near(currentHoldingValue(augmented)!, 1100, 1e-6, "value = accrued 1-year FD");
  // The estimate feeds pnl: gain = accrued value − principal.
  const pnl = holdingPnl(augmented);
  near(pnl.value!, 1100, 1e-6, "pnl.value = accrued");
  near(pnl.absoluteGain!, 100, 1e-6, "gain = 1100 − 1000");
  ok(holdingXirr(augmented) !== null, "XIRR solvable (accrued value is the closing inflow)");
}

section("[fd] a manual valuation RE-BASES (overrides) the accrual");
{
  const h = fdHolding({ ratePct: 10, compounding: "annually" });
  const events = [
    ev({ type: "opening", date: "2022-06-01", amount: 1000 }),
    ev({ type: "valuation", date: "2023-01-01", amount: 1200 }), // user reconciled to 1200
  ];
  // Accrues from the MANUAL 1200 @2023-01-01, NOT the 1000 opening → 1200·1.10.
  near(currentHoldingValue(withFdAccrual(h, events, "2024-01-01"))!, 1320, 1e-6, "re-based: 1200·1.10 = 1320");
}

section("[fd] non-FD holding is a no-op; FD without principal is null");
{
  const plain = fdHolding(undefined);
  const events = [ev({ type: "opening", date: "2023-01-01", amount: 1000 })];
  eq(withFdAccrual(plain, events, "2024-01-01"), events, "no fd terms → events unchanged (same reference)");
  const fd = fdHolding({ ratePct: 10, compounding: "annually" });
  eq(fdAccrualValuation(fd, [], "2024-01-01"), null, "FD with no principal/valuation → null (needs a deposit)");
}

section("[fd] a deposit dated TODAY still shows its value (not '—')");
{
  const h = fdHolding({ ratePct: 10, compounding: "annually" });
  // The deposit is dated the SAME day we're valuing (the create-FD-today path).
  const events = [ev({ type: "opening", date: "2024-01-01", amount: 1000, createdAt: "2024-01-01T10:00:00.000Z" })];
  near(
    currentHoldingValue(withFdAccrual(h, events, "2024-01-01"))!,
    1000,
    1e-6,
    "same-day deposit → principal (synthetic valuation isn't flagged stale by the same-date opening)",
  );
}

section("[fd] a withdrawal (sell) disables auto-accrual (no silent overstatement)");
{
  const h = fdHolding({ ratePct: 10, compounding: "annually" });
  const events = [
    ev({ type: "opening", date: "2023-01-01", amount: 1000 }),
    ev({ type: "sell", date: "2023-06-01", amount: 500 }),
  ];
  eq(fdAccrualValuation(h, events, "2024-01-01"), null, "FD with a withdrawal → no accrual (fall back to manual)");
  // Falls back to the raw events; with no manual valuation that's needs-valuation.
  eq(currentHoldingValue(withFdAccrual(h, events, "2024-01-01")), null, "value falls back to null, not an inflated figure");
}

section("[fd] multi-tranche accrues each deposit from its OWN date");
{
  const terms = { ratePct: 10, compounding: "annually" as const };
  const h = fdHolding(terms);
  const events = [
    ev({ type: "opening", date: "2023-01-01", amount: 1000 }),
    ev({ type: "buy", date: "2023-07-01", amount: 1000 }),
  ];
  const expected =
    fdValue(1000, terms, "2023-01-01", "2024-01-01") + fdValue(1000, terms, "2023-07-01", "2024-01-01");
  near(currentHoldingValue(withFdAccrual(h, events, "2024-01-01"))!, expected, 1e-6, "sum of per-tranche accruals");
  ok(expected < 2200, "less than the naive 'all principal from the earliest date' (2200) — no over-accrual");
}

section("[fd] a pathological rate can't poison net worth with Infinity");
{
  const v = fdValue(1000, { ratePct: 1e9, compounding: "monthly" }, "2000-01-01", "2030-01-01");
  eq(v, 1000, "non-finite result → principal (guarded)");
  ok(Number.isFinite(v), "value is always finite");
}

section("[fd] a PAYOUT FD does not auto-accrue (interest paid out, not compounded)");
{
  const terms = { ratePct: 10, compounding: "annually" as const };
  // Payout mode: interest is paid out (as dividends), principal doesn't compound —
  // auto-accruing would double-count (accrue on 1000 AND count the 50 payout).
  const payout = fdHolding(terms, "payout");
  const events = [
    ev({ type: "opening", date: "2023-01-01", amount: 1000 }),
    ev({ type: "dividend", date: "2023-06-01", amount: 50 }),
  ];
  eq(fdAccrualValuation(payout, events, "2024-01-01"), null, "payout FD → no synthetic accrual");
  // A dividend on an (accumulating) FD also disables accrual — it's not purely cumulative.
  const acc = fdHolding(terms, "accumulating");
  eq(fdAccrualValuation(acc, events, "2024-01-01"), null, "any dividend event → no accrual either");
  // A clean cumulative FD (no payouts) still accrues normally.
  eq(
    fdAccrualValuation(acc, [ev({ type: "opening", date: "2023-01-01", amount: 1000 })], "2024-01-01") !== null,
    true,
    "clean cumulative FD still accrues",
  );
}

// ---------------------------------------------------------------------------
// Savings-account interest (read-time, daily-balance) + opening balance.
// ---------------------------------------------------------------------------

section("[interest] compoundValue is the shared core behind fdValue");
{
  near(compoundValue(1000, 10, "annually", "2023-01-01", "2024-01-01"), 1100, 1e-6, "annual: 1000·1.10");
  near(compoundValue(1000, 8, "quarterly", "2023-01-01", "2024-01-01"), 1000 * Math.pow(1.02, 4), 1e-6, "quarterly");
  eq(compoundValue(1000, 0, "annually", "2023-01-01", "2024-01-01"), 1000, "0% → principal");
  eq(compoundValue(1000, 10, "annually", "2024-01-01", "2023-06-01"), 1000, "asOf before start → principal");
  near(
    compoundValue(1000, 10, "annually", "2023-01-01", "2026-01-01", "2024-01-01"),
    1100,
    1e-6,
    "capped at maturity (1 year, not 3)",
  );
  eq(compoundValue(1000, 1e9, "monthly", "2000-01-01", "2030-01-01"), 1000, "non-finite → principal (guarded)");
  // fdValue is a thin wrapper over compoundValue — identical results.
  eq(
    fdValue(1000, { ratePct: 8, compounding: "quarterly" }, "2023-01-01", "2024-01-01"),
    compoundValue(1000, 8, "quarterly", "2023-01-01", "2024-01-01"),
    "fdValue delegates to compoundValue (identical)",
  );
}

section("[interest] constant balance: more-frequent crediting earns more (compounding)");
{
  // Same balance/rate over 18 months — the only difference is how often interest is
  // credited (and thus compounds). More frequent ⇒ strictly more interest.
  const at = (f: "monthly" | "quarterly" | "halfyearly" | "annually") =>
    accruedInterest(1000, "2025-01-01", [], 12, f, "2026-06-30");
  // Over 18 months each has ≥1 more crediting boundary than the next, so more
  // frequent is STRICTLY greater (a >= here would pass even if compounding did
  // nothing — the point is to prove it does).
  ok(at("annually") > 0, "some interest accrues");
  ok(at("monthly") > at("quarterly"), "monthly > quarterly");
  ok(at("quarterly") > at("halfyearly"), "quarterly > half-yearly");
  ok(at("halfyearly") > at("annually"), "half-yearly > annually");
}

section("[interest] exactly one year, no crediting boundary → simple over the year");
{
  // Annually-credited, exactly 365 days: the only crediting date is asOf itself
  // (excluded), so it's plain balance·rate·1yr.
  near(accruedInterest(1000, "2025-01-01", [], 12, "annually", "2026-01-01"), 120, 1e-9, "1000·12%·1yr = 120");
  eq(accruedInterest(1000, "2025-01-01", [], 0, "annually", "2026-01-01"), 0, "0% rate → no interest");
  eq(accruedInterest(1000, "2026-01-01", [], 12, "annually", "2025-06-01"), 0, "asOf before opening → 0");
  eq(accruedInterest(0, undefined, [], 12, "annually", "2026-01-01"), 0, "no opening date + no activity → 0");
}

section("[interest] a withdrawal reduces the balance AND its future interest");
{
  // Same-day withdrawal halves the earning balance for the whole year.
  near(
    accruedInterest(1000, "2025-01-01", [{ date: "2025-01-01", amount: -500 }], 12, "annually", "2026-01-01"),
    60,
    1e-9,
    "500 earning for a year = 60 (not 120)",
  );
  // Mid-year withdrawal: full balance until the withdrawal, then nothing.
  const wDate = "2025-07-02";
  const days = (Date.parse(wDate) - Date.parse("2025-01-01")) / 86_400_000;
  near(
    accruedInterest(1000, "2025-01-01", [{ date: wDate, amount: -1000 }], 12, "annually", "2026-01-01"),
    (1000 * 0.12 * days) / 365,
    1e-9,
    "interest only for the days the money was there",
  );
}

section("[interest] opening date falls back to earliest activity when unset");
{
  near(
    accruedInterest(0, undefined, [{ date: "2025-01-01", amount: 1000 }], 12, "annually", "2026-01-01"),
    120,
    1e-9,
    "deposit dated 2025-01-01 earns a full year to 2026-01-01",
  );
}

section("[networth] opening balance seeds balance + net worth, not income");
{
  const accounts: Account[] = [
    { id: "A1", name: "HDFC", type: "bank", currency: "USD", personId: "p1", openingBalance: 5000 },
  ];
  const fx: FxTable = { base: "USD", rates: { USD: 1 } };
  eq(accountBalances(accounts, []).get("A1"), 5000, "opening balance seeds the balance");
  // An expense draws it down.
  const txns: Transaction[] = [
    { id: "t1", date: "2025-02-01", type: "expense", accountId: "A1", personId: "p1", amount: 1000, currency: "USD", updatedAt: "" },
  ];
  eq(accountBalances(accounts, txns).get("A1"), 4000, "expense reduces the seeded balance");
  const nw = netWorth({
    accounts,
    balances: accountBalances(accounts, txns),
    balancesByPerson: accountBalancesByPerson(accounts, txns),
    holdings: [],
    holdingValues: new Map(),
    fx,
  });
  near(nw.total, 4000, 1e-9, "opening balance is real money in net worth");
  near(nw.byPerson["p1"] ?? NaN, 4000, 1e-9, "attributed to the account owner");
}

section("[networth] savings interest shows in balance/net worth only when asOf is given");
{
  const accounts: Account[] = [
    {
      id: "S1",
      name: "Savings",
      type: "bank",
      currency: "USD",
      personId: "p1",
      openingBalance: 1000,
      openingBalanceDate: "2025-01-01",
      interest: { ratePct: 12, frequency: "annually" },
    },
  ];
  eq(accountBalances(accounts, []).get("S1"), 1000, "no asOf → plain balance, no interest");
  near(
    accountBalances(accounts, [], undefined, "2026-01-01").get("S1") ?? NaN,
    1120,
    1e-9,
    "with asOf → balance + one year of interest (1000 + 120)",
  );
  // A same-day expense reduces both the balance and the interest it earns.
  const txns: Transaction[] = [
    { id: "t1", date: "2025-01-01", type: "expense", accountId: "S1", personId: "p1", amount: 500, currency: "USD", updatedAt: "" },
  ];
  near(
    accountBalances(accounts, txns, undefined, "2026-01-01").get("S1") ?? NaN,
    560,
    1e-9,
    "500 balance + 60 interest = 560",
  );
  // Net worth (with asOf-derived balances) includes the interest, attributed to the owner.
  const bal = accountBalances(accounts, [], undefined, "2026-01-01");
  const byP = accountBalancesByPerson(accounts, [], undefined, "2026-01-01");
  const nw = netWorth({ accounts, balances: bal, balancesByPerson: byP, holdings: [], holdingValues: new Map(), fx: { base: "USD", rates: { USD: 1 } } });
  near(nw.total, 1120, 1e-9, "interest is real money in net worth");
  near(nw.byPerson["p1"] ?? NaN, 1120, 1e-9, "interest attributed to the account owner");
}

section("[networth] an account WITHOUT interest config never accrues (even with asOf)");
{
  const accounts: Account[] = [
    { id: "A1", name: "Cash", type: "bank", currency: "USD", personId: "p1", openingBalance: 1000, openingBalanceDate: "2025-01-01" },
  ];
  eq(accountBalances(accounts, [], undefined, "2026-01-01").get("A1"), 1000, "no interest config → balance unchanged by asOf");
}

section("[networth] allocation folds account cash by type; keeps equity; excludes liabilities");
{
  const fx: FxTable = { base: "USD", rates: { USD: 1 } };
  const accounts: Account[] = [
    { id: "SAV", name: "Savings", type: "bank", currency: "USD", personId: "shared", openingBalance: 10000 },
    { id: "FD", name: "FD", type: "fd", currency: "USD", personId: "shared", openingBalance: 5000 },
    { id: "CC", name: "Card", type: "creditcard", currency: "USD", personId: "shared", openingBalance: -2000 },
  ];
  const holdings: Holding[] = [
    { id: "h1", name: "Stock", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
  ];
  const holdingValues = new Map<string, number | null>([["h1", 8000]]);
  const nw = netWorth({
    accounts,
    balances: accountBalances(accounts, []),
    balancesByPerson: accountBalancesByPerson(accounts, []),
    holdings,
    holdingValues,
    fx,
  });
  near(nw.byAssetClass.cash ?? NaN, 10000, 1e-9, "bank balance → cash slice");
  near(nw.byAssetClass.debt ?? NaN, 5000, 1e-9, "fd account → debt slice");
  near(nw.byAssetClass.equity ?? NaN, 8000, 1e-9, "equity holding STILL counted (not removed)");
  eq(Object.keys(nw.byAssetClass).sort().join(","), "cash,debt,equity", "only those three classes — no credit-card slice");
  near(nw.liabilities, 2000, 1e-9, "the −2000 card is a liability, not an asset slice");
  near(nw.assets, 23000, 1e-9, "assets = 10000 cash + 5000 debt + 8000 equity");
}

section("[networth] brokerage cash and its holdings are separate slices (no double-count)");
{
  const fx: FxTable = { base: "USD", rates: { USD: 1 } };
  const accounts: Account[] = [
    { id: "BRK", name: "Broker", type: "brokerage", currency: "USD", personId: "shared", openingBalance: 3000 },
  ];
  const holdings: Holding[] = [
    { id: "h1", name: "ETF", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
  ];
  const holdingValues = new Map<string, number | null>([["h1", 7000]]);
  const nw = netWorth({
    accounts,
    balances: accountBalances(accounts, []),
    balancesByPerson: accountBalancesByPerson(accounts, []),
    holdings,
    holdingValues,
    fx,
  });
  near(nw.byAssetClass.cash ?? NaN, 3000, 1e-9, "uninvested brokerage cash → cash");
  near(nw.byAssetClass.equity ?? NaN, 7000, 1e-9, "the ETF holding → equity (distinct money)");
  near(nw.assets, 10000, 1e-9, "3000 cash + 7000 equity, no double-count");
}

section("[totalReturn] a savings account's interest IS its money-weighted return");
{
  const fxAt = (): FxTable => ({ base: "USD", rates: { USD: 1 } });
  // Non-leap span (2023 = 365 days) so actual/365 accrues an exact 100.
  const accounts: Account[] = [
    { id: "SAV", name: "Savings", type: "bank", currency: "USD", personId: "p1", openingBalance: 1000, openingBalanceDate: "2023-01-01", interest: { ratePct: 10, frequency: "annually" } },
  ];
  const r = totalReturn([], new Map(), accounts, [], "USD", fxAt, "2024-01-01");
  near(r.xirr ?? NaN, 0.1, 0.005, "1000 → 1100 over a year = ~10% p.a.");
  near(r.value, 1100, 1e-9, "value = balance incl. accrued interest");
  eq(r.included, 1, "the account contributed");
}

section("[totalReturn] holdings-only matches portfolioReturn (no accounts)");
{
  const fxAt = (): FxTable => ({ base: "USD", rates: { USD: 1 } });
  const holdings: Holding[] = [
    { id: "H1", name: "ETF", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
  ];
  const events = new Map<string, HoldingEvent[]>([
    ["H1", [ev({ type: "buy", date: "2024-01-01", units: 100, price: 1 }), ev({ type: "valuation", date: "2025-01-01", amount: 150 })]],
  ]);
  const pr = portfolioReturn(holdings, events, "USD", fxAt, "2025-01-01");
  const tr = totalReturn(holdings, events, [], [], "USD", fxAt, "2025-01-01");
  near(tr.xirr ?? NaN, pr.xirr ?? NaN, 1e-9, "no accounts → identical to the investment return");
  near(tr.value, pr.value, 1e-9, "same asset value");
}

section("[totalReturn] idle cash drags the blended return below investments-only");
{
  const fxAt = (): FxTable => ({ base: "USD", rates: { USD: 1 } });
  const holdings: Holding[] = [
    { id: "H1", name: "ETF", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
  ];
  const events = new Map<string, HoldingEvent[]>([
    ["H1", [ev({ type: "buy", date: "2024-01-01", units: 100, price: 1 }), ev({ type: "valuation", date: "2025-01-01", amount: 150 })]],
  ]);
  // A large 0%-interest cash pile alongside the +50% holding.
  const accounts: Account[] = [
    { id: "CASH", name: "Cash", type: "bank", currency: "USD", personId: "p1", openingBalance: 10000, openingBalanceDate: "2024-01-01" },
  ];
  const pr = portfolioReturn(holdings, events, "USD", fxAt, "2025-01-01");
  const tr = totalReturn(holdings, events, accounts, [], "USD", fxAt, "2025-01-01");
  ok((tr.xirr ?? 0) > 0, "still positive (the holding gained)");
  ok((tr.xirr ?? 0) < (pr.xirr ?? 0), "but well below the 50% investment return — idle cash drags it");
}

section("[totalReturn] credit-card / liabilities are excluded (assets-only)");
{
  const fxAt = (): FxTable => ({ base: "USD", rates: { USD: 1 } });
  const accounts: Account[] = [
    { id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "p1", openingBalance: 1000, openingBalanceDate: "2024-01-01" },
    { id: "CC", name: "Card", type: "creditcard", currency: "USD", personId: "p1", openingBalance: -500, openingBalanceDate: "2024-01-01" },
  ];
  const r = totalReturn([], new Map(), accounts, [], "USD", fxAt, "2025-01-01");
  near(r.value, 1000, 1e-9, "value = assets only (the −500 card is excluded, not netted)");
  eq(r.included, 1, "only the bank contributed; the card is a liability");
}

section("[totalReturn] a cross-currency transfer surfaces the FX gain/loss (date-locked credit)");
{
  // 100 USD moved into INR when USD/INR = 80 (so 8000 INR credited, locked). By asOf
  // INR has depreciated to 100/USD → that 8000 INR is worth only 80 USD. So you put
  // in 100 and hold 80 → a real base-currency loss the return should show.
  const atTransfer: FxTable = { base: "USD", rates: { USD: 1, INR: 80 } };
  const atToday: FxTable = { base: "USD", rates: { USD: 1, INR: 100 } };
  const fxAt = (date: string): FxTable => (date < "2024-09-01" ? atTransfer : atToday);
  const accounts: Account[] = [
    { id: "USD", name: "US", type: "bank", currency: "USD", personId: "p1", openingBalance: 100, openingBalanceDate: "2024-01-01" },
    { id: "INR", name: "IN", type: "bank", currency: "INR", personId: "p1" },
  ];
  const txns: Transaction[] = [
    { id: "t1", date: "2024-06-01", type: "transfer", accountId: "USD", personId: "p1", amount: 100, currency: "USD", transferToAccountId: "INR", updatedAt: "" },
  ];
  const r = totalReturn([], new Map(), accounts, txns, "USD", fxAt, "2025-01-01");
  near(r.value, 80, 1e-6, "assets = 8000 INR at today's rate = 80 USD");
  ok((r.xirr ?? 0) < 0, "negative return — the INR depreciation is captured, not hidden");
}

section("[totalReturn] a transfer to a MISSING account can't create a phantom flow");
{
  const fxAt = (): FxTable => ({ base: "USD", rates: { USD: 1 } });
  const accounts: Account[] = [
    { id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "p1", openingBalance: 1000, openingBalanceDate: "2024-01-01" },
  ];
  // Transfer OUT to an account NOT in `accounts` (incomplete import). The balance
  // engine skips the whole transfer, so the return series must too — otherwise a
  // phantom +400 inflow would fabricate a ~49% return.
  const txns: Transaction[] = [
    { id: "t1", date: "2024-07-01", type: "transfer", accountId: "BANK", personId: "p1", amount: 400, currency: "USD", transferToAccountId: "GONE", updatedAt: "" },
  ];
  const r = totalReturn([], new Map(), accounts, txns, "USD", fxAt, "2025-01-01");
  near(r.value, 1000, 1e-9, "terminal = 1000 (missing-endpoint transfer skipped)");
  ok(r.xirr === null || Math.abs(r.xirr) < 0.01, "≈0% — no phantom inflow inflating the return");
}

section("[xirr] a decades-long, many-flow series returns a sane rate or null — never a ~100 artefact");
{
  // A long span overflows the bisection domain floor to a non-finite NPV; the guard
  // must reject rather than return ~hi (= 10000%).
  const flows: Cashflow[] = [];
  for (let y = 1960; y <= 2021; y++) {
    flows.push({ date: `${y}-01-01`, amount: -1000 });
    flows.push({ date: `${y}-07-01`, amount: 1001 });
  }
  const r = xirr(flows);
  ok(r === null || Math.abs(r) < 5, "sane or null, never a ~100 (10000%) artefact");
}

section("[interest] an over-drawn balance earns no (negative) interest");
{
  // 100 opening, a same-day 500 withdrawal drives it to −400: no negative interest.
  eq(
    accruedInterest(100, "2025-01-01", [{ date: "2025-01-01", amount: -500 }], 12, "annually", "2026-01-01"),
    0,
    "negative balance → 0 interest, never charged",
  );
  // A later deposit restores a positive balance → interest resumes for the rest.
  const dep = "2025-07-02";
  const days = (Date.parse("2026-01-01") - Date.parse(dep)) / 86_400_000;
  near(
    accruedInterest(0, "2025-01-01", [{ date: dep, amount: 1000 }], 12, "annually", "2026-01-01"),
    (1000 * 0.12 * days) / 365,
    1e-9,
    "interest only accrues once the balance is positive",
  );
}

section("[interest] credit-card payoff via a dated transfer keeps savings interest honest");
{
  // Savings earns interest; expenses ride a credit card during the month and are
  // paid off by a month-end transfer FROM savings. Because the cash stays in
  // savings until the dated transfer, interest accrues on the FULL balance until
  // then, and on the reduced balance after — the daily-balance method, matching
  // reality (and NOT the understated figure you'd get booking each expense to
  // savings on its own date).
  const accounts: Account[] = [
    {
      id: "SAV",
      name: "Savings",
      type: "bank",
      currency: "USD",
      personId: "shared",
      openingBalance: 1000,
      openingBalanceDate: "2025-01-01",
      interest: { ratePct: 12, frequency: "annually" },
    },
    { id: "CC", name: "Card", type: "creditcard", currency: "USD", personId: "shared" },
  ];
  const payoff = "2025-07-02";
  const txns: Transaction[] = [
    { id: "t1", date: payoff, type: "transfer", accountId: "SAV", personId: "shared", amount: 400, currency: "USD", transferToAccountId: "CC", updatedAt: "" },
  ];
  const before = (Date.parse(payoff) - Date.parse("2025-01-01")) / 86_400_000;
  const after = (Date.parse("2026-01-01") - Date.parse(payoff)) / 86_400_000;
  const expectedInterest = (1000 * 0.12 * before) / 365 + (600 * 0.12 * after) / 365;
  const bal = accountBalances(accounts, txns, undefined, "2026-01-01");
  near(
    bal.get("SAV") ?? NaN,
    600 + expectedInterest,
    1e-9,
    "600 remaining + interest (1000 until payoff, 600 after)",
  );
  eq(bal.get("CC"), 400, "the payoff lands on the card (no interest — not an interest account)");
}

// ---------------------------------------------------------------------------
// Shared date utils + credit-card statement auto-pay.
// ---------------------------------------------------------------------------

section("[date] isoFromParts clamps day to the month; daysInMonth handles Feb");
{
  eq(daysInMonth(2025, 2), 28, "Feb 2025 = 28 days");
  eq(daysInMonth(2024, 2), 29, "Feb 2024 (leap) = 29 days");
  eq(isoFromParts(2025, 2, 31), "2025-02-28", "day 31 in Feb clamps to the 28th (no rollover)");
  eq(isoFromParts(2025, 4, 31), "2025-04-30", "day 31 in April clamps to the 30th");
  eq(isoFromParts(2025, 5, 10), "2025-05-10", "a normal day is unchanged");
  eq(addMonthsIso("2025-05-10", 1), "2025-06-10", "addMonthsIso rolls the month");
}

section("[date] dd/mm/yyyy <-> ISO (the date field's parsing)");
{
  eq(isoToDdmmyyyy("2025-01-30"), "30/01/2025", "ISO → dd/mm/yyyy for display");
  eq(isoToDdmmyyyy(""), "", "empty → empty");
  eq(ddmmyyyyToIso("30/01/2025"), "2025-01-30", "dd/mm/yyyy → ISO for storage");
  eq(ddmmyyyyToIso(""), "", "cleared → empty (emits a clear)");
  eq(ddmmyyyyToIso("30/01"), null, "partial → null (held, not emitted)");
  eq(ddmmyyyyToIso("31/02/2025"), null, "31 Feb rejected (not a real date)");
  eq(ddmmyyyyToIso("00/01/2025"), null, "day 0 rejected");
  eq(ddmmyyyyToIso("01/13/2025"), null, "month 13 rejected");
  eq(ddmmyyyyToIso("29/02/2024"), "2024-02-29", "leap day accepted");
  eq(ddmmyyyyToIso("29/02/2025"), null, "29 Feb in a non-leap year rejected");
  eq(ddmmyyyyToIso("01/01/0130"), null, "an implausibly-ancient typo year (<1900) is rejected");
  // Auto-format: typed digits group into dd/mm/yyyy.
  eq(formatDdmmyyyy("30012025"), "30/01/2025", "8 digits grouped with slashes");
  eq(formatDdmmyyyy("3001"), "30/01", "partial grouping mid-type");
  eq(formatDdmmyyyy("30/01/2025"), "30/01/2025", "already-slashed input normalised");
  eq(ddmmyyyyToIso(formatDdmmyyyy("30012025")), "2025-01-30", "type-digits round-trips to ISO");
}

// Builders for the auto-pay scenarios (all USD unless noted).
const ccAcct = (id: string, autopay?: Account["autopay"], currency = "USD"): Account => ({
  id,
  name: id,
  type: "creditcard",
  currency,
  personId: "shared",
  autopay,
});
const bankAcct = (id: string, currency = "USD"): Account => ({
  id,
  name: id,
  type: "bank",
  currency,
  personId: "shared",
});
const charge = (id: string, cardId: string, date: string, amount: number): Transaction => ({
  id,
  date,
  type: "expense",
  accountId: cardId,
  personId: "shared",
  amount,
  currency: "USD",
  updatedAt: "",
});
const manualPay = (id: string, from: string, to: string, date: string, amount: number): Transaction => ({
  id,
  date,
  type: "transfer",
  accountId: from,
  transferToAccountId: to,
  personId: "shared",
  amount,
  currency: "USD",
  updatedAt: "",
});

section("[autopay] one payoff per due cycle: statement balance as of close, dated at due");
{
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  // Both charges fall in the cycle closing 2025-05-10 (after 04-10, on/before 05-10).
  const txns = [charge("c1", "CC", "2025-04-15", 1000), charge("c2", "CC", "2025-05-05", 500)];
  const got = desiredAutopayTransfers(accounts, txns, "2025-06-30");
  eq(got.length, 1, "exactly one payoff (only the 05-10 cycle has charges and is due)");
  const p = got[0];
  eq(p.id, autopayId("CC", "2025-05-10"), "deterministic id keyed to the closing date");
  eq(p.amount, 1500, "pays the statement balance as of the closing date");
  // dueDay 5 ≤ statementDay 10 → the same-month 5th precedes the close, so it rolls
  // to the next month: 2025-06-05.
  eq(p.date, "2025-06-05", "due date rolled to next month (5th ≤ statement 10th)");
  eq(p.accountId, "BANK", "paid from the configured account");
  eq(p.transferToAccountId, "CC", "into the card");
  ok(isAutopayTransaction(p), "flagged as an autopay-managed transfer");
}

section("[autopay] real-world long gap: statement 10th, due 15th of NEXT month");
{
  // The user's example — statement closes 10 May, payment due 15 June.
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 15, dueNextMonth: true, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  const got = desiredAutopayTransfers(accounts, [charge("c1", "CC", "2025-05-01", 800)], "2025-06-30");
  eq(got.length, 1, "one payoff for the 05-10 cycle");
  eq(got[0].date, "2025-06-15", "due 15th of the month AFTER the statement closes");
  eq(got[0].amount, 800, "statement balance");
}

section("[autopay] no backfill: cycles closing before `since` get no payoff, carried debt sweeps into the first live cycle");
{
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-05-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  // A charge from March (its cycle closed 2025-04-10, before `since`).
  const got = desiredAutopayTransfers(accounts, [charge("c1", "CC", "2025-03-15", 1000)], "2025-06-30");
  eq(got.length, 1, "no past-dated payoff for the pre-`since` cycle");
  eq(got[0].id, autopayId("CC", "2025-05-10"), "carried balance is paid in the first cycle closing on/after `since`");
  ok(
    got.every((t) => t.date >= "2025-05-01"),
    "no payoff is dated before auto-pay was enabled",
  );
}

section("[autopay] a recorded manual payment nets out → nothing owed → no auto-payoff");
{
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  const txns = [
    charge("c1", "CC", "2025-05-03", 1000),
    manualPay("m1", "BANK", "CC", "2025-05-08", 1000), // paid it yourself before the close
  ];
  eq(desiredAutopayTransfers(accounts, txns, "2025-06-30").length, 0, "zero owed at close → no payoff (no double-pay)");
}

section("[autopay] multi-cycle: each payoff covers only that cycle's net new charges");
{
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  const txns = [
    charge("c1", "CC", "2025-04-15", 1000), // cycle closing 2025-05-10
    charge("c2", "CC", "2025-05-15", 500), //  cycle closing 2025-06-10
  ];
  const got = desiredAutopayTransfers(accounts, txns, "2025-08-01").sort((a, b) => (a.date < b.date ? -1 : 1));
  eq(got.length, 2, "two payoffs");
  eq(got[0].amount, 1000, "first cycle pays 1000");
  eq(got[0].date, "2025-06-05", "first due");
  eq(got[1].amount, 500, "second cycle pays only its OWN 500 (prior payoff netted)");
  eq(got[1].date, "2025-07-05", "second due");
}

section("[autopay] a statement that hasn't CLOSED yet is not considered");
{
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  // Charge lands in the cycle closing 2025-07-10 — after asOf, so it hasn't closed.
  const got = desiredAutopayTransfers(accounts, [charge("c1", "CC", "2025-06-15", 900)], "2025-07-01");
  eq(got.length, 0, "no closed statement covering the charge → nothing");
}

section("[autopay] a CLOSED-but-not-yet-due statement is returned (dated at its future due)");
{
  // Statement closes 2025-05-10, payment due 2025-06-15 (next month). As of 05-20
  // the statement HAS closed but isn't due — the desired set still includes it
  // (dated at the future due), so its membership doesn't depend on the clock; the
  // STORE decides not to materialise it early.
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 15, dueNextMonth: true, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  const got = desiredAutopayTransfers(accounts, [charge("c1", "CC", "2025-05-01", 800)], "2025-05-20");
  eq(got.length, 1, "the closed statement is desired");
  eq(got[0].date, "2025-06-15", "dated at the due date, which is after asOf");
  ok(got[0].date > "2025-05-20", "due is in the future relative to asOf");
}

section("[autopay] REGRESSION: due-next-month doesn't double-pay across cycles");
{
  // statement 10th, due 15th of the NEXT month (dueDay 15 > statementDay 10) — the
  // documented config. Cycle 1's payoff is due 06-15, AFTER cycle 2 closes (06-10),
  // so date-based netting would miss it and re-pay cycle 1's charges in cycle 2.
  // The running-total netting pays each cycle's OWN charges only.
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 15, dueNextMonth: true, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms), bankAcct("BANK")];
  const txns = [charge("c1", "CC", "2025-05-01", 800), charge("c2", "CC", "2025-06-01", 300)];
  const got = desiredAutopayTransfers(accounts, txns, "2025-08-01").sort((a, b) => (a.date < b.date ? -1 : 1));
  eq(got.length, 2, "two payoffs");
  eq(got[0].amount, 800, "cycle 1 pays its 800");
  eq(got[0].date, "2025-06-15", "due next month");
  eq(got[1].amount, 300, "cycle 2 pays only its OWN 300 (NOT 1100) — no double-pay");
  eq(got[1].date, "2025-07-15", "due next month");
}

section("[autopay] cross-currency payer is skipped (can't mis-scale a transfer)");
{
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" };
  const accounts = [ccAcct("CC", terms, "USD"), bankAcct("BANK", "INR")];
  eq(desiredAutopayTransfers(accounts, [charge("c1", "CC", "2025-05-01", 1000)], "2025-06-30").length, 0, "payer currency ≠ card → no payoff");
}

section("[autopay] disabled / archived cards generate nothing");
{
  const noConfig = [ccAcct("CC", undefined), bankAcct("BANK")];
  eq(desiredAutopayTransfers(noConfig, [charge("c1", "CC", "2025-05-01", 1000)], "2025-06-30").length, 0, "no autopay config → nothing");
  const terms = { fromAccountId: "BANK", statementDay: 10, dueDay: 5, since: "2025-01-01" };
  const archived = [{ ...ccAcct("CC", terms), archived: true }, bankAcct("BANK")];
  eq(desiredAutopayTransfers(archived, [charge("c1", "CC", "2025-05-01", 1000)], "2025-06-30").length, 0, "archived card → nothing");
}

section("[autopay] planAutopayReconcile: create-gate, update-on-change, delete-by-desire");
{
  const dueSoon = manualPay("autopay:CC:2025-05-10", "BANK", "CC", "2025-06-05", 800); // desired, due <= asOf
  const notDue = manualPay("autopay:CC:2025-06-10", "BANK", "CC", "2025-07-05", 300); // desired, due > asOf
  const asOf = "2025-06-20";

  // Nothing stored yet: create only the due one; the closed-but-not-due one waits.
  const p1 = planAutopayReconcile([], [dueSoon, notDue], asOf);
  eq(p1.toPut.length, 1, "only the due payoff is created");
  eq(p1.toPut[0].id, "autopay:CC:2025-05-10", "the due one");
  eq(p1.toDeleteIds.length, 0, "nothing to delete");

  // Idempotent: an already-matching stored row (differing only in updatedAt) → no put.
  const stored = { ...dueSoon, updatedAt: "2025-06-05T10:00:00Z", author: "me" };
  const p2 = planAutopayReconcile([stored], [dueSoon, notDue], asOf);
  eq(p2.toPut.length, 0, "matching row is left alone (ignores updatedAt/author)");
  eq(p2.toDeleteIds.length, 0, "and not deleted");

  // Changed amount → update.
  const p3 = planAutopayReconcile([{ ...dueSoon, amount: 999 }], [dueSoon], asOf);
  eq(p3.toPut.length, 1, "amount change → update");
  eq(p3.toPut[0].amount, 800, "to the desired amount");

  // A peer-created payoff whose due is still in THIS clock's future is KEPT (in
  // desired → not deleted), not ping-ponged.
  const p4 = planAutopayReconcile([notDue], [dueSoon, notDue], asOf);
  eq(p4.toDeleteIds.length, 0, "peer-created future-due payoff is kept");

  // No longer desired (auto-pay off / cycle credited) → delete.
  const p5 = planAutopayReconcile([dueSoon], [], asOf);
  eq(p5.toDeleteIds.length, 1, "one undesired payoff");
  eq(p5.toDeleteIds[0], "autopay:CC:2025-05-10", "undesired stored payoff is deleted");
  eq(p5.toPut.length, 0, "nothing to put");
}

section("[autopay] composeAccountExtras: parsing, drop-stray-date, since preservation");
{
  const base = {
    openingBalance: "",
    openingDate: "",
    interestEnabled: false,
    interestRate: "",
    interestFreq: "quarterly" as const,
    autopayEnabled: false,
    fromAccountId: "",
    statementDay: "",
    dueDay: "",
    dueNextMonth: false,
    existingSince: undefined,
    today: "2026-07-11",
  };
  // Opening-balance parsing.
  eq(composeAccountExtras({ ...base, openingBalance: "" }).openingBalance, undefined, "blank → undefined");
  eq(composeAccountExtras({ ...base, openingBalance: "abc" }).openingBalance, undefined, "NaN → undefined");
  eq(composeAccountExtras({ ...base, openingBalance: "1e999" }).openingBalance, undefined, "Infinity → undefined");
  eq(composeAccountExtras({ ...base, openingBalance: "-100" }).openingBalance, -100, "negative kept (liability/overdraft)");
  // Drop-stray-date: a date with neither balance nor interest is dropped.
  eq(composeAccountExtras({ ...base, openingDate: "2026-01-01" }).openingBalanceDate, undefined, "stray date dropped");
  eq(
    composeAccountExtras({ ...base, openingDate: "2026-01-01", openingBalance: "500" }).openingBalanceDate,
    "2026-01-01",
    "kept when there's a balance",
  );
  eq(
    composeAccountExtras({ ...base, openingDate: "2026-01-01", interestEnabled: true, interestRate: "3" }).openingBalanceDate,
    "2026-01-01",
    "kept when interest anchors it",
  );
  // Interest gate.
  eq(composeAccountExtras({ ...base, interestEnabled: true, interestRate: "0" }).interest, undefined, "0% → no interest");
  eq(composeAccountExtras({ ...base, interestEnabled: false, interestRate: "3" }).interest, undefined, "disabled → no interest");
  const withInterest = composeAccountExtras({ ...base, interestEnabled: true, interestRate: "3.5", interestFreq: "monthly" });
  eq(withInterest.interest?.ratePct, 3.5, "rate parsed");
  eq(withInterest.interest?.frequency, "monthly", "frequency carried");
  // Autopay `since` preservation vs default.
  const apBase = { ...base, autopayEnabled: true, fromAccountId: "BANK", statementDay: "10", dueDay: "5" };
  eq(composeAccountExtras(apBase).autopay?.since, "2026-07-11", "no prior since → defaults to today");
  eq(
    composeAccountExtras({ ...apBase, existingSince: "2025-01-01" }).autopay?.since,
    "2025-01-01",
    "prior since PRESERVED across edits (no re-backfill)",
  );
  eq(composeAccountExtras({ ...apBase, statementDay: "10.7" }).autopay?.statementDay, 10, "day truncated to integer");
  eq(composeAccountExtras({ ...base, autopayEnabled: false }).autopay, undefined, "disabled → no autopay");
}

section("[fdMaturityInfo] maturity date, days-until, and matured state");
{
  const fd = (maturityDate?: string): Holding => ({
    id: "F", name: "SBI FD", personId: "shared", assetClass: "debt", currency: "INR", incomeMode: "accumulating",
    fd: { ratePct: 7, compounding: "quarterly", maturityDate },
  });
  eq(fdMaturityInfo(fd("2027-03-15"), "2027-02-19")?.daysUntil, 24, "24 days until maturity");
  eq(fdMaturityInfo(fd("2027-03-15"), "2027-02-19")?.matured, false, "not matured yet");
  eq(fdMaturityInfo(fd("2027-02-19"), "2027-02-19")?.matured, true, "maturity == today → matured");
  eq(fdMaturityInfo(fd("2027-01-01"), "2027-02-19")?.matured, true, "past → matured");
  eq(fdMaturityInfo(fd("2027-01-01"), "2027-02-19")?.daysUntil, -49, "negative days once past");
  eq(fdMaturityInfo(fd(undefined), "2027-02-19"), null, "FD without a maturity date → null");
  eq(fdMaturityInfo({ id: "S", name: "AAPL", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating" }, "2027-02-19"), null, "non-FD holding → null");
  // Timezone-independent day math (UTC day-number diff, no DST drift).
  eq(fdMaturityInfo(fd("2027-03-01"), "2027-02-28")?.daysUntil, 1, "Feb→Mar boundary is exactly 1 day");
  // Malformed maturity dates (only reachable via a hand-edited/synced snapshot) are
  // rejected rather than rolled over by Date.UTC or turned into NaN — otherwise a
  // bogus value could silently fire the banner or show garbage.
  eq(fdMaturityInfo(fd("garbage"), "2027-02-19"), null, "non-date string → null");
  eq(fdMaturityInfo(fd("2027-13-45"), "2027-02-19"), null, "out-of-range parts → null (no rollover)");
  eq(fdMaturityInfo(fd("2027"), "2027-02-19"), null, "year-only → null");
  eq(fdMaturityInfo(fd("2027-3-1"), "2027-02-19"), null, "unpadded parts → null");
}

section("[networth] archived (settled) holdings are excluded from net worth");
{
  const usd: FxTable = { base: "USD", rates: { USD: 1 } };
  const holdings: Holding[] = [
    { id: "A", name: "Active", personId: "p1", assetClass: "equity", currency: "USD", incomeMode: "accumulating" },
    { id: "S", name: "Settled FD", personId: "p1", assetClass: "debt", currency: "USD", incomeMode: "accumulating", fd: { ratePct: 7, compounding: "quarterly" }, archived: true },
  ];
  const holdingValues = new Map<string, number | null>([
    ["A", 1000],
    ["S", 5000],
  ]);
  const nw = netWorth({ accounts: [], balances: new Map(), holdings, holdingValues, fx: usd });
  eq(nw.total, 1000, "only the active holding counts (settled FD excluded even though it has a value)");
  eq(nw.byAssetClass.debt ?? 0, 0, "settled FD adds nothing to the debt slice");
  eq(nw.byPerson["p1"] ?? 0, 1000, "per-person total excludes the settled FD");
}

section("[networth] settling an FD preserves net worth (value moves FD → account)");
{
  const usd: FxTable = { base: "USD", rates: { USD: 1 } };
  const fd: Holding = { id: "FD", name: "FD", personId: "p1", assetClass: "debt", currency: "USD", incomeMode: "accumulating", fd: { ratePct: 7, compounding: "quarterly" } };
  const before = netWorth({ accounts: [], balances: new Map(), holdings: [fd], holdingValues: new Map([["FD", 5000]]), fx: usd });
  eq(before.total, 5000, "before: the FD's 5000 is the whole net worth");
  // After settlement: the FD is archived and a bank account now holds the 5000 (the deposit).
  const bank: Account = { id: "BANK", name: "Bank", type: "bank", currency: "USD", personId: "p1" };
  const after = netWorth({
    accounts: [bank],
    balances: new Map([["BANK", 5000]]),
    holdings: [{ ...fd, archived: true }],
    holdingValues: new Map([["FD", 5000]]),
    fx: usd,
  });
  eq(after.total, 5000, "after: same net worth — money moved FD → bank, neither lost nor doubled");
}

section("[transactions] excludeFromReports keeps a transaction out of income/expense reports");
{
  const usd: FxTable = { base: "USD", rates: { USD: 1 } };
  const fxAt = (): FxTable => usd;
  const txn = (over: Partial<Transaction>): Transaction => ({
    id: Math.random().toString(36).slice(2),
    date: "2026-03-10",
    type: "income",
    accountId: "A",
    personId: "p1",
    amount: 100,
    currency: "USD",
    updatedAt: "",
    ...over,
  });
  const txns: Transaction[] = [
    txn({ type: "income", amount: 200 }), // real income
    txn({ type: "expense", amount: 50 }), // real expense
    txn({ type: "income", amount: 5000, excludeFromReports: true }), // FD settlement deposit
  ];
  const flow = flowSummary(txns, "USD", usd);
  eq(flow.income, 200, "flowSummary income excludes the settlement deposit");
  eq(flow.expense, 50, "flowSummary expense unaffected");
  eq(flow.net, 150, "flowSummary net unaffected by the settlement deposit");
  const months = monthlyTotals(txns, "USD", fxAt);
  eq(months.length, 1, "one month present");
  eq(months[0]!.income, 200, "monthlyTotals income excludes the settlement deposit");
  const cats = categoryTotals(txns, [], "income", "USD", usd);
  eq(
    cats.reduce((s, c) => s + c.total, 0),
    200,
    "categoryTotals income excludes the settlement deposit",
  );
}

section("[helpers] categoryOptions: shared top-level list, alphabetical by name, sentinel first");
{
  // Stored out of alphabetical order on purpose, to prove the sort.
  const cats: Category[] = [
    { id: "zoo", name: "Zoo" },
    { id: "apple", name: "Apple" },
    { id: "mango", name: "Mango" },
    { id: "sub", name: "Sub", parentId: "apple" }, // subcategory: not a top-level option
    { id: "arch", name: "Old", archived: true }, // archived: hidden from the picker
  ];
  const state = { categories: cats } as unknown as PortfolioState;
  const opts = categoryOptions(state);
  eq(opts[0]!.value, "", "first option is Uncategorized (empty value) — sentinel stays first");
  eq(opts.slice(1).map((o) => o.label).join(","), "Apple,Mango,Zoo", "top-level categories sorted alphabetically by name");
  const vals = opts.map((o) => o.value);
  ok(!vals.includes("sub"), "subcategory is not offered as a top-level option");
  ok(!vals.includes("arch"), "archived category excluded");
  ok(categoryOptions(state, "arch").map((o) => o.value).includes("arch"), "keepId re-includes an archived category");
}

section("[transactions] filterTransactions month predicate composes with date bounds");
{
  const t = (id: string, date: string): Transaction => ({
    id, date, type: "expense", accountId: "A", personId: "p1", amount: 1, currency: "USD", updatedAt: "",
  });
  const txns = [t("a", "2026-03-10"), t("b", "2026-07-04"), t("c", "2025-03-22"), t("d", "2026-03-31")];
  const ids = (f: TxnFilter): string => filterTransactions(txns, f).map((x) => x.id).sort().join(",");
  eq(ids({ month: "03" }), "a,c,d", "month alone → that month across ALL years");
  eq(ids({ from: "2026-01-01", to: "2026-12-31", month: "03" }), "a,d", "month within a year (composes with bounds)");
  eq(ids({ from: "2026-01-01", to: "2026-12-31" }), "a,b,d", "year bounds only → all months of that year");
  eq(ids({}), "a,b,c,d", "no filter → all");
}

section("[transactions] filterTransactions categoryIds matches any id in the set (parent + its children)");
{
  const t = (id: string, categoryId?: string): Transaction => ({
    id, date: "2026-01-01", type: "expense", accountId: "A", personId: "p1", amount: 1, currency: "USD", categoryId, updatedAt: "",
  });
  const txns = [t("a", "food"), t("b", "dining"), t("c", "salary"), t("d", undefined)];
  const ids = (f: TxnFilter): string => filterTransactions(txns, f).map((x) => x.id).sort().join(",");
  eq(ids({ categoryIds: ["food", "dining"] }), "a,b", "parent + its subcategory ids both match");
  eq(ids({ categoryIds: ["dining"] }), "b", "a single subcategory matches exactly");
  eq(ids({ categoryIds: ["salary"] }), "c", "an unrelated category matches only itself");
  eq(ids({ categoryIds: ["nope"] }), "", "no member matches → empty");
  eq(filterTransactions(txns, { categoryIds: ["food"] }).some((x) => x.id === "d"), false, "uncategorized txn excluded by a category filter");
}

section("[networth] cross-currency transfer credits the explicit transferToAmount (bypasses FX)");
{
  const accounts: Account[] = [
    { id: "usd", name: "USD", type: "bank", currency: "USD", personId: "p1" },
    { id: "thb", name: "THB", type: "bank", currency: "THB", personId: "p1" },
  ];
  // 100 USD out of the USD account; exactly 3450 THB credited to the THB account.
  const txns: Transaction[] = [
    { id: "t1", date: "2026-01-01", type: "transfer", accountId: "usd", transferToAccountId: "thb", personId: "p1", amount: 100, currency: "USD", transferToAmount: 3450, updatedAt: "" },
  ];
  // No FX table passed — the explicit target amount must still credit verbatim.
  const bal = sumAccountBalances(accountBalancesByPerson(accounts, txns));
  eq(bal.get("usd") ?? 0, -100, "source debited 100 in its own (USD) currency");
  eq(bal.get("thb") ?? 0, 3450, "dest credited the explicit 3450 THB, not an FX conversion");
  // Same-currency transfer (no transferToAmount) still credits the raw amount.
  const same: Transaction[] = [
    { id: "t2", date: "2026-01-01", type: "transfer", accountId: "usd", transferToAccountId: "thb", personId: "p1", amount: 50, currency: "USD", updatedAt: "" },
  ];
  const acc2: Account[] = [accounts[0]!, { ...accounts[1]!, currency: "USD" }];
  const bal2 = sumAccountBalances(accountBalancesByPerson(acc2, same));
  eq(bal2.get("thb") ?? 0, 50, "same-currency transfer credits the source amount as before");
}

section("[helpers] account & person dropdowns sort alphabetically (Shared sentinel first)");
{
  const state = {
    accounts: [
      { id: "z", name: "Zeta", type: "bank", currency: "USD", personId: "p1" },
      { id: "a", name: "Alpha", type: "bank", currency: "USD", personId: "p1" },
    ],
    people: [
      { id: "p2", name: "Bob" },
      { id: "p1", name: "Ann" },
    ],
  } as unknown as PortfolioState;
  eq(accountOptions(state).map((o) => o.label.split(" ")[0]).join(","), "Alpha,Zeta", "accounts sorted A→Z by name");
  const p = personOptions(state).map((o) => o.label);
  eq(p[0], "Shared", "Shared sentinel stays first");
  eq(p.slice(1).join(","), "Ann,Bob", "people sorted A→Z after Shared");
}

section("[addTenureIso] deposit tenure → maturity date");
{
  eq(addTenureIso("2025-01-15", 12, "months"), "2026-01-15", "12 months");
  eq(addTenureIso("2025-01-15", 1, "years"), "2026-01-15", "1 year == 12 months");
  eq(addTenureIso("2025-01-15", 444, "days"), "2026-04-04", "444 days");
  eq(addTenureIso("2025-01-31", 1, "months"), "2025-02-28", "31 Jan + 1 month clamps to 28 Feb (no rollover to March)");
  eq(addTenureIso("2024-02-29", 1, "years"), "2025-02-28", "leap day + 1 year clamps to 28 Feb");
  eq(addTenureIso("2025-11-30", 3, "months"), "2026-02-28", "crosses the year boundary");
  eq(addTenureIso("2025-01-15", 0, "months"), null, "zero tenure → null");
  eq(addTenureIso("2025-01-15", 1.5, "years"), null, "fractional tenure → null");
  eq(addTenureIso("", 12, "months"), null, "no start date → null");
  // Beyond a 4-digit year toISOString emits "+012025-…" or throws; return null instead.
  eq(addTenureIso("2025-01-15", 10000, "years"), null, "10000 years → null (not '+012025-01')");
  eq(addTenureIso("2025-01-15", 999999, "years"), null, "huge years → null, no RangeError");
  eq(addTenureIso("2025-01-15", 999999999, "days"), null, "huge days → null, no RangeError");
  eq(addTenureIso("2025-01-15", 7974, "years"), "9999-01-15", "year 9999 still allowed");
  eq(addTenureIso("9999-12-30", 1, "days"), "9999-12-31", "last representable day");
  eq(addTenureIso("9999-12-31", 1, "days"), null, "day into year 10000 → null (not '+010000-…')");
  eq(addTenureIso("9999-12-15", 1, "months"), null, "month into year 10000 → null");
  eq(addTenureIso("2025-01-15", 3_000_000, "days"), null, "finite but 5-digit-year days → null");
}

section("[validateFdInput] blocks FDs that would show no value or never be tracked");
{
  const ok0 = { isNew: true, principal: 100000, startDate: "2025-01-15", ratePct: 7.1, tenure: "", maturityDate: "2026-01-15", today: "2026-09-26" };
  eq(Object.keys(validateFdInput(ok0)).length, 0, "complete new FD → no errors");
  ok(validateFdInput({ ...ok0, principal: null }).principal !== undefined, "missing principal → error");
  ok(validateFdInput({ ...ok0, principal: 0 }).principal !== undefined, "zero principal → error");
  ok(validateFdInput({ ...ok0, startDate: "" }).startDate !== undefined, "missing deposit date → error (was silently 'today')");
  ok(validateFdInput({ ...ok0, startDate: "2026-10-01" }).startDate !== undefined, "future deposit date → error");
  ok(validateFdInput({ ...ok0, ratePct: null }).ratePct !== undefined, "missing rate → error");
  ok(validateFdInput({ ...ok0, ratePct: 710 }).ratePct !== undefined, "absurd rate → error");
  ok(validateFdInput({ ...ok0, ratePct: 0 }).ratePct !== undefined, "zero rate → error");
  ok(validateFdInput({ ...ok0, ratePct: -2 }).ratePct !== undefined, "negative rate → error");
  eq(validateFdInput({ ...ok0, ratePct: 100 }).ratePct, undefined, "100% is the upper bound, still accepted");
  eq(validateFdInput({ ...ok0, startDate: "2026-09-26", maturityDate: "2027-09-26" }).startDate, undefined, "deposit dated today is fine");
  ok(validateFdInput({ ...ok0, startDate: "2025-02-30" }).startDate !== undefined, "impossible deposit date → error");
  ok(validateFdInput({ ...ok0, maturityDate: "2026-02-30" }).maturityDate !== undefined, "impossible maturity date → error");
  // An impossible deposit date must not be used to judge the maturity (it's already flagged).
  eq(validateFdInput({ ...ok0, startDate: "2027-02-30", maturityDate: "2026-01-15" }).maturityDate, undefined, "invalid start not compared");
  ok(validateFdInput({ ...ok0, tenure: "1.5" }).tenure !== undefined, "fractional tenure → tenure error");
  ok(validateFdInput({ ...ok0, tenure: "0" }).tenure !== undefined, "zero tenure → tenure error");
  ok(validateFdInput({ ...ok0, tenure: "999999", maturityDate: "" }).tenure !== undefined, "tenure that yields no date → tenure error");
  eq(validateFdInput({ ...ok0, tenure: "12" }).tenure, undefined, "valid tenure with its maturity → ok");
  // Tenure typed before the deposit date: point at the missing date, not a bogus overflow.
  const noStart = validateFdInput({ ...ok0, startDate: "", tenure: "12", maturityDate: "" });
  eq(noStart.tenure, undefined, "no deposit date yet → no tenure overflow error");
  ok(/deposit date/.test(noStart.maturityDate ?? ""), "maturity error asks for the deposit date");
  ok(/tenure or maturity/.test(validateFdInput({ ...ok0, maturityDate: "" }).maturityDate ?? ""), "no tenure → asks for a tenure or maturity");
  ok(validateFdInput({ ...ok0, maturityDate: "" }).maturityDate !== undefined, "new FD needs a maturity date");
  ok(validateFdInput({ ...ok0, maturityDate: "2025-01-15" }).maturityDate !== undefined, "maturity on the deposit date → error");
  ok(validateFdInput({ ...ok0, maturityDate: "2024-12-01" }).maturityDate !== undefined, "maturity before deposit → error");
  // Editing: principal/date are managed in the transaction history, maturity optional.
  const edit = { isNew: false, principal: null, startDate: "2025-01-15", ratePct: 7.1, tenure: "", maturityDate: "", today: "2026-09-26" };
  eq(Object.keys(validateFdInput(edit)).length, 0, "edit without maturity is allowed");
  ok(validateFdInput({ ...edit, maturityDate: "2024-01-01" }).maturityDate !== undefined, "edit still checks maturity > deposit");
  eq(Object.keys(validateFdInput({ ...edit, startDate: "", maturityDate: "2027-01-01" })).length, 0, "edit with no recorded deposit: nothing to compare");
  // Legacy data the old form could produce must not block a rename...
  const legacy = { ...edit, startDate: "2026-06-01", maturityDate: "2026-05-01", ratePct: 120, stored: { ratePct: 120, maturityDate: "2026-05-01" } };
  eq(Object.keys(validateFdInput(legacy)).length, 0, "untouched legacy maturity/rate → rename allowed");
  // ...but changing those fields is still checked.
  ok(validateFdInput({ ...legacy, maturityDate: "2026-05-02" }).maturityDate !== undefined, "edited maturity still order-checked");
  ok(validateFdInput({ ...legacy, ratePct: 130 }).ratePct !== undefined, "edited rate still range-checked");
  ok(validateFdInput({ ...legacy, ratePct: 0 }).ratePct !== undefined, "rate 0 is never OK, stored or not");
}

section("[fdMaturityWatch] Dashboard list of matured / maturing FDs");
{
  const mk = (id: string, name: string, maturityDate?: string, extra: Partial<Holding> = {}): Holding => ({
    id, name, personId: "shared", assetClass: "debt", currency: "INR", incomeMode: "accumulating",
    fd: { ratePct: 7, compounding: "quarterly", maturityDate }, ...extra,
  });
  const today = "2026-09-26";
  const holdings: Holding[] = [
    mk("far", "Far", "2027-06-01"),
    mk("soon", "Soon", "2026-10-06"),
    mk("edge", "Edge", "2026-10-26"), // exactly 30 days → included
    mk("over", "Overdue", "2026-08-01"),
    mk("today", "Today", "2026-09-26"),
    mk("none", "No maturity"),
    mk("bad", "Bad date", "2026-13-40"),
    mk("settled", "Settled", "2026-09-01", { archived: true }),
    { id: "eq", name: "Stock", personId: "shared", assetClass: "equity", currency: "INR", incomeMode: "accumulating" },
  ];
  const w = fdMaturityWatch(holdings, () => [], today, 30);
  eq(w.due.map((d) => d.holding.id).join(","), "over,today,soon,edge", "overdue first, then soonest; far/settled/non-FD excluded");
  eq(w.due[0].info.daysUntil, -56, "overdue carries negative days");
  eq(w.missingMaturity.map((h) => h.id).join(","), "bad,none", "no/invalid maturity flagged (sorted by name)");
  // A sold-out FD (units netted to 0 after a sell) is inactive → not listed.
  const soldEvents: HoldingEvent[] = [
    { id: "b", holdingId: "soon", date: "2025-01-01", type: "buy", units: 1, price: 100 },
    { id: "s", holdingId: "soon", date: "2026-01-01", type: "sell", units: 1, price: 105 },
  ];
  const w2 = fdMaturityWatch(holdings, (id) => (id === "soon" ? soldEvents : []), today, 30);
  ok(!w2.due.some((d) => d.holding.id === "soon"), "closed FD excluded");
  // Same maturity → alphabetical, so the list order is stable.
  const tie = fdMaturityWatch([mk("b", "Beta", "2026-10-01"), mk("a", "Alpha", "2026-10-01")], () => [], today, 30);
  eq(tie.due.map((d) => d.holding.name).join(","), "Alpha,Beta", "same-day maturities sorted by name");
  // A closed FD with no maturity isn't nagged about either.
  const w3 = fdMaturityWatch([mk("n", "No mat")], () => soldEvents, today, 30);
  eq(w3.missingMaturity.length, 0, "closed FD without maturity not flagged");
}

section("[isFdDueSoon / firstDepositDate] shared FD rules");
{
  const m = (daysUntil: number) => ({ date: "2026-10-01", daysUntil, matured: daysUntil <= 0 });
  eq(isFdDueSoon(m(30), 30), true, "edge of the window is due");
  eq(isFdDueSoon(m(31), 30), false, "one day past the window is not");
  eq(isFdDueSoon(m(-5), 30), true, "matured is due");
  const ev = (id: string, date: string, type: HoldingEvent["type"]): HoldingEvent => ({ id, holdingId: "h", date, type, amount: 1 });
  eq(firstDepositDate([ev("1", "2025-05-01", "buy"), ev("2", "2025-01-10", "opening"), ev("3", "2024-01-01", "valuation")]), "2025-01-10", "earliest opening/buy, valuations ignored");
  eq(firstDepositDate([ev("1", "2024-01-01", "dividend")]), "", "no deposit → empty");
}

section("[fdMaturityStatus] relative maturity wording");
{
  eq(fdMaturityStatus(-3), "Matured 3 days ago", "past");
  eq(fdMaturityStatus(-1), "Matured yesterday", "yesterday");
  eq(fdMaturityStatus(0), "Matures today", "today");
  eq(fdMaturityStatus(1), "Matures tomorrow", "tomorrow");
  eq(fdMaturityStatus(12), "Matures in 12 days", "future");
}

done();
