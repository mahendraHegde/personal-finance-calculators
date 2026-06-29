// Tests for the portfolio domain: holding XIRR/value/quality and net-worth
// rollups. Run with tsx (see package.json).

import {
  currentHoldingValue,
  dataQuality,
  holdingPnl,
  holdingXirr,
  netUnits,
} from "../src/features/portfolio/domain/holdings";
import { accountBalances, accountBalancesByPerson, netWorth } from "../src/features/portfolio/domain/networth";
import type { Account, Holding, HoldingEvent, Transaction } from "../src/features/portfolio/model/types";
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

done();
