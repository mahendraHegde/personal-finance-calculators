// Dashboard. Everything is COLLAPSED by default and computed lazily: the heavy
// transaction/holding scans run only when you open a section (so the default
// load is O(1)). Net-worth-derived sections (net worth, allocation, by-account,
// holdings) share ONE scan; the monthly trend and the category breakdown each
// scan only when opened. Net-worth figures hide behind an eye (privacy); charts
// expand with a chevron. Charts show values on hover.

import { useMemo, useState } from "react";
import { formatCompactMoney, formatMoney, formatPercent, monthKey, todayIso } from "../../../lib/util/format";
import { tryConvert } from "../../../lib/money/currency";
import { accountBalances, accountBalancesByPerson, netWorth } from "../domain/networth";
import { currentHoldingValue, dataQuality, holdingXirr } from "../domain/holdings";
import { categoryTotals, flowSummary, monthlyTotals, type CategoryTotal } from "../domain/transactions";
import type { PortfolioState } from "../state/store";
import { usePortfolio } from "../state/context";
import { Badge, BarTrend, Donut, EmptyState, RevealCard, Select, StatCard } from "./components";
import {
  displayFx,
  eventsByHolding,
  makeFxAt,
  ownerLabel,
  PALETTE,
  QUALITY_LABEL,
  QUALITY_TONE,
} from "./helpers";

/** The full net-worth-derived view: one set of transaction/holding scans shared
 *  by the net worth, allocation, by-account, and holdings sections. Pure, run
 *  only when at least one of those sections is open. */
function computeHeavy(state: PortfolioState) {
  const { fx, base } = displayFx(state);
  const balances = accountBalances(state.accounts, state.transactions, fx);
  const balancesByPerson = accountBalancesByPerson(state.accounts, state.transactions, fx);
  const byHolding = eventsByHolding(state);
  const holdingValues = new Map(
    state.holdings.map((h) => [h.id, currentHoldingValue(byHolding.get(h.id) ?? [])]),
  );
  const nw = netWorth({
    accounts: state.accounts,
    balances,
    balancesByPerson,
    holdings: state.holdings,
    holdingValues,
    fx,
  });

  const thisMonth = monthKey(todayIso());
  const monthTxns = state.transactions.filter((t) => monthKey(t.date) === thisMonth);
  const flow = flowSummary(monthTxns, base, fx);

  const holdings = state.holdings
    .map((h) => {
      const events = byHolding.get(h.id) ?? [];
      const native = currentHoldingValue(events);
      return {
        holding: h,
        value: native === null ? null : tryConvert({ amount: native, currency: h.currency }, base, fx),
        xirr: holdingXirr(events),
        quality: dataQuality(events),
      };
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const allocation = Object.entries(nw.byAssetClass)
    .map(([label, value], i) => ({ label, value: value ?? 0, color: PALETTE[i % PALETTE.length] }))
    .sort((a, b) => b.value - a.value);

  const people = Object.entries(nw.byPerson)
    .map(([owner, value]) => ({ owner, label: ownerLabel(state, owner), value }))
    .sort((a, b) => b.value - a.value);

  // Exposure per account/broker (concentration): each account's cash balance PLUS
  // the value of holdings sitting in it, assets only (positive). Clamp cash at 0
  // (a negative balance is a liability, not negative exposure); a holding pointing
  // at a missing account falls into "Unassigned".
  const exposureMap = new Map<string, number>();
  const accIds = new Set(state.accounts.map((a) => a.id));
  const add = (key: string, v: number): void => {
    exposureMap.set(key, (exposureMap.get(key) ?? 0) + v);
  };
  for (const a of state.accounts) {
    const v = tryConvert({ amount: balances.get(a.id) ?? 0, currency: a.currency }, base, fx);
    if (v !== null && Number.isFinite(v)) add(a.id, Math.max(0, v));
  }
  for (const h of state.holdings) {
    const native = holdingValues.get(h.id);
    if (native == null || !Number.isFinite(native)) continue;
    const v = tryConvert({ amount: native, currency: h.currency }, base, fx);
    const key = h.accountId && accIds.has(h.accountId) ? h.accountId : "__none";
    if (v !== null && Number.isFinite(v)) add(key, v);
  }
  const accName = (id: string): string =>
    id === "__none" ? "Unassigned" : (state.accounts.find((a) => a.id === id)?.name ?? "—");
  const exposureAssets = [...exposureMap.values()].reduce((s, v) => s + (v > 0 ? v : 0), 0);
  const exposure = [...exposureMap]
    .map(([id, value]) => ({ id, label: accName(id), value }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((e, i) => ({
      ...e,
      color: PALETTE[i % PALETTE.length],
      pct: exposureAssets > 0 ? (e.value / exposureAssets) * 100 : 0,
    }));

  return { base, nw, flow, holdings, allocation, people, exposure };
}

export function Dashboard() {
  const { state } = usePortfolio();
  const { base } = displayFx(state); // cheap (no scan): just the latest rates + display ccy

  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const isOpen = (k: string): boolean => open.has(k);
  const toggle = (k: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // Shared heavy scan — computed once, and ONLY when a section that needs it is open.
  const needHeavy = isOpen("networth") || isOpen("allocation") || isOpen("exposure") || isOpen("holdings");
  const heavy = useMemo(() => (needHeavy ? computeHeavy(state) : null), [state, needHeavy]);

  // Monthly trend is a separate scan (per-date FX), gated on its own section.
  const showTrend = isOpen("trend");
  const trend = useMemo(() => {
    if (!showTrend) return null;
    const { fx, base: b } = displayFx(state);
    return monthlyTotals(state.transactions, b, makeFxAt(state.fxRates, b, fx));
  }, [state, showTrend]);

  // Currencies in use with no rate to the display base silently count as 0 in
  // money figures. The warning only matters once a money figure is actually shown
  // (everything's hidden by default), so we compute it only then — keeping the
  // collapsed default free of scans. We DO scan transactions here: an imported /
  // cross-device snapshot can carry a transaction in a currency that's on no
  // current account or holding, and that amount would silently zero into the
  // "This month" flow + trend; accounts+holdings alone wouldn't catch it.
  const anyMoneyShown = needHeavy || showTrend || isOpen("categories");
  const unconvertible = useMemo(() => {
    if (!anyMoneyShown) return [] as string[];
    const { fx, base: b } = displayFx(state);
    const ccy = new Set<string>();
    state.accounts.forEach((a) => ccy.add(a.currency));
    state.holdings.forEach((h) => ccy.add(h.currency));
    state.transactions.forEach((t) => ccy.add(t.currency));
    return [...ccy].filter((c) => tryConvert({ amount: 1, currency: c }, b, fx) === null);
  }, [state, anyMoneyShown]);

  if (state.accounts.length === 0 && state.holdings.length === 0) {
    return (
      <EmptyState>
        Add a person and an account (Accounts tab) or a holding (Investments tab) to see your dashboard.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      {unconvertible.length > 0 && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          No exchange rate for {unconvertible.join(", ")} — amounts in{" "}
          {unconvertible.length === 1 ? "it" : "them"} are counted as 0. Refresh rates in Settings.
        </div>
      )}

      <RevealCard
        title="Net worth"
        subtitle={isOpen("networth") ? undefined : `Tap the eye to show your balances (${base})`}
        variant="eye"
        open={isOpen("networth")}
        onToggle={() => toggle("networth")}
      >
        {heavy && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label={`Net worth (${base})`} value={formatCompactMoney(heavy.nw.total, base)} />
              <StatCard label="Assets" value={formatCompactMoney(heavy.nw.assets, base)} />
              <StatCard label="Liabilities" value={formatCompactMoney(heavy.nw.liabilities, base)} />
              <StatCard
                label="This month"
                value={formatMoney(heavy.flow.net, base)}
                sub={`+${formatMoney(heavy.flow.income, base)} / −${formatMoney(heavy.flow.expense, base)}`}
              />
            </div>
            {heavy.people.length > 0 && (
              <div>
                <div className="mb-2 text-sm font-medium text-slate-600">By family member</div>
                <div className="space-y-2">
                  {heavy.people.map((p) => (
                    <div key={p.owner} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">{p.label}</span>
                      <span className="font-medium text-slate-800">{formatMoney(p.value, base)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </RevealCard>

      <RevealCard
        title="Allocation"
        subtitle="Investments by asset class"
        open={isOpen("allocation")}
        onToggle={() => toggle("allocation")}
      >
        {heavy &&
          (heavy.allocation.length === 0 ? (
            <EmptyState>No holdings yet.</EmptyState>
          ) : (
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <Donut segments={heavy.allocation} format={(v) => formatCompactMoney(v, base)} />
              <div className="flex-1 space-y-1 text-sm">
                {heavy.allocation.map((s) => (
                  <div key={s.label} className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />
                    <span className="capitalize text-slate-600">{s.label}</span>
                    <span className="ml-auto font-medium text-slate-800">
                      {formatCompactMoney(s.value, base)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
      </RevealCard>

      <RevealCard
        title="By account / broker"
        subtitle="How much sits with each institution — spot concentration risk"
        open={isOpen("exposure")}
        onToggle={() => toggle("exposure")}
      >
        {heavy &&
          (heavy.exposure.length === 0 ? (
            <EmptyState>No accounts or holdings with a positive balance yet.</EmptyState>
          ) : (
            <>
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <Donut segments={heavy.exposure} format={(v) => formatCompactMoney(v, base)} />
                <div className="flex-1 space-y-1 text-sm">
                  {heavy.exposure.map((s) => (
                    <div key={s.id} className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />
                      <span className="text-slate-600">{s.label}</span>
                      <span className="ml-auto tabular-nums text-slate-400">{s.pct.toFixed(0)}%</span>
                      <span className="w-24 text-right font-medium tabular-nums text-slate-800">
                        {formatCompactMoney(s.value, base)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              {heavy.exposure[0] && heavy.exposure[0].pct >= 40 && (
                <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {heavy.exposure[0].pct.toFixed(0)}% of your assets are with{" "}
                  <span className="font-medium">{heavy.exposure[0].label}</span>. Spreading across more
                  institutions reduces the impact if any one freezes or fails.
                </p>
              )}
            </>
          ))}
      </RevealCard>

      <RevealCard
        title="Monthly income vs expense"
        subtitle="Last 12 months — hover a month for the figures"
        open={isOpen("trend")}
        onToggle={() => toggle("trend")}
      >
        {trend && <BarTrend data={trend} format={(v) => formatCompactMoney(v, base)} />}
      </RevealCard>

      <RevealCard
        title="Spending & income by category"
        subtitle="Where money goes and comes from, by category"
        open={isOpen("categories")}
        onToggle={() => toggle("categories")}
      >
        <CategoryBreakdown />
      </RevealCard>

      <RevealCard title="Holdings" subtitle="Value, return, and data quality" open={isOpen("holdings")} onToggle={() => toggle("holdings")}>
        {heavy &&
          (heavy.holdings.length === 0 ? (
            <EmptyState>No holdings yet.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-slate-400">
                    <th className="pb-2">Holding</th>
                    <th className="pb-2">Owner</th>
                    <th className="pb-2 text-right">Value ({base})</th>
                    <th className="pb-2 text-right">XIRR</th>
                    <th className="pb-2 text-right">Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {heavy.holdings.map((h) => (
                    <tr key={h.holding.id} className="border-t border-slate-100">
                      <td className="py-2 font-medium text-slate-700">{h.holding.name}</td>
                      <td className="py-2 text-slate-500">{ownerLabel(state, h.holding.personId)}</td>
                      <td className="py-2 text-right text-slate-700">
                        {h.value === null ? "—" : formatMoney(h.value, base)}
                      </td>
                      <td className="py-2 text-right text-slate-700">{formatPercent(h.xirr)}</td>
                      <td className="py-2 text-right">
                        <Badge tone={QUALITY_TONE[h.quality]}>{QUALITY_LABEL[h.quality]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </RevealCard>
    </div>
  );
}

// Expense + income grouped by category for a chosen year. Mounted only when its
// card is open, so the full-transaction scans here never cost anything on the
// default dashboard load.
function CategoryBreakdown() {
  const { state } = usePortfolio();
  const [year, setYear] = useState<string>(todayIso().slice(0, 4));

  const years = useMemo(() => {
    const set = new Set<string>([todayIso().slice(0, 4)]);
    for (const t of state.transactions) set.add(t.date.slice(0, 4));
    return [...set].sort((a, b) => (a < b ? 1 : -1));
  }, [state.transactions]);

  const data = useMemo(() => {
    const { fx, base: b } = displayFx(state);
    const txns = year
      ? state.transactions.filter((t) => t.date.slice(0, 4) === year)
      : state.transactions;
    return {
      base: b,
      expense: categoryTotals(txns, state.categories, "expense", b, fx),
      income: categoryTotals(txns, state.categories, "income", b, fx),
    };
  }, [state, year]);

  return (
    <div className="space-y-4">
      <div className="w-32">
        <Select
          value={year}
          onChange={setYear}
          options={[{ value: "", label: "All years" }, ...years.map((y) => ({ value: y, label: y }))]}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <CategoryList title="Expenses" rows={data.expense} base={data.base} tone="bg-rose-400" />
        <CategoryList title="Income" rows={data.income} base={data.base} tone="bg-green-400" />
      </div>
    </div>
  );
}

function CategoryList({
  title,
  rows,
  base,
  tone,
}: {
  title: string;
  rows: CategoryTotal[];
  base: string;
  tone: string;
}) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-600">{title}</span>
        <span className="text-sm font-semibold text-slate-800">{formatMoney(total, base)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">None in this period.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.categoryId}>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600">{r.name}</span>
                <span className="tabular-nums text-slate-700">
                  {formatCompactMoney(r.total, base)}
                  <span className="ml-2 text-xs text-slate-400">
                    {total > 0 ? Math.round((r.total / total) * 100) : 0}%
                  </span>
                </span>
              </div>
              <div className="mt-0.5 h-1.5 rounded bg-slate-100">
                <div
                  className={`h-1.5 rounded ${tone}`}
                  style={{ width: `${max > 0 ? (r.total / max) * 100 : 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
