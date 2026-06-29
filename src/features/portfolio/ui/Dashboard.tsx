// Dashboard: net worth, per-person + family rollup, asset allocation, monthly
// flow trend, and a holdings table with XIRR + data-quality badges.

import { useMemo } from "react";
import { formatCompactMoney, formatMoney, formatPercent, monthKey, todayIso } from "../../../lib/util/format";
import { tryConvert } from "../../../lib/money/currency";
import { accountBalances, accountBalancesByPerson, netWorth } from "../domain/networth";
import { currentHoldingValue, dataQuality, holdingXirr } from "../domain/holdings";
import { flowSummary, monthlyTotals } from "../domain/transactions";
import { usePortfolio } from "../state/context";
import { Badge, BarTrend, Card, Donut, EmptyState, SectionTitle, StatCard } from "./components";
import {
  displayFx,
  eventsByHolding,
  makeFxAt,
  ownerLabel,
  PALETTE,
  QUALITY_LABEL,
  QUALITY_TONE,
} from "./helpers";

export function Dashboard() {
  const { state } = usePortfolio();

  const view = useMemo(() => {
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
      balancesByPerson, // per-person rollup by transaction owner, not account owner
      holdings: state.holdings,
      holdingValues,
      fx,
    });

    const thisMonth = monthKey(todayIso());
    const monthTxns = state.transactions.filter((t) => monthKey(t.date) === thisMonth);
    const flow = flowSummary(monthTxns, base, fx);
    // Historical months use the rate for each transaction's own date.
    const trend = monthlyTotals(state.transactions, base, makeFxAt(state.fxRates, base, fx));

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

    // Exposure per account/broker (concentration check): each account's cash
    // balance PLUS the value of holdings sitting in it, in base currency. Shows
    // if too much is parked with one institution (counterparty risk) so you can
    // diversify. Assets only (positive) — liabilities aren't a concentration risk.
    const exposureMap = new Map<string, number>();
    const accIds = new Set(state.accounts.map((a) => a.id));
    const addExposure = (key: string, v: number): void => {
      exposureMap.set(key, (exposureMap.get(key) ?? 0) + v);
    };
    for (const a of state.accounts) {
      const v = tryConvert({ amount: balances.get(a.id) ?? 0, currency: a.currency }, base, fx);
      // Clamp cash at 0: a negative balance is a LIABILITY (you owe that
      // institution), not negative exposure. Netting it against holdings in the
      // same account would understate the assets actually at risk there.
      if (v !== null && Number.isFinite(v)) addExposure(a.id, Math.max(0, v));
    }
    for (const h of state.holdings) {
      const native = holdingValues.get(h.id);
      if (native == null || !Number.isFinite(native)) continue;
      const v = tryConvert({ amount: native, currency: h.currency }, base, fx);
      // A holding pointing at a missing/deleted account falls into "Unassigned"
      // rather than spawning a phantom "—" institution.
      const key = h.accountId && accIds.has(h.accountId) ? h.accountId : "__none";
      if (v !== null && Number.isFinite(v)) addExposure(key, v);
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

    // Currencies in use that can't be converted to the display base (no FX rate
    // yet) — these silently count as 0 in totals, so we warn rather than hide.
    const currencies = new Set<string>();
    state.accounts.forEach((a) => currencies.add(a.currency));
    state.holdings.forEach((h) => currencies.add(h.currency));
    state.transactions.forEach((t) => currencies.add(t.currency));
    const unconvertible = [...currencies].filter(
      (c) => tryConvert({ amount: 1, currency: c }, base, fx) === null,
    );

    return { nw, flow, trend, holdings, allocation, people, exposure, base, unconvertible };
  }, [state]);
  const base = view.base;

  if (state.accounts.length === 0 && state.holdings.length === 0) {
    return (
      <EmptyState>
        Add a person and an account (Accounts tab) or a holding (Investments tab) to see your dashboard.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      {view.unconvertible.length > 0 && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          No exchange rate for {view.unconvertible.join(", ")} — amounts in{" "}
          {view.unconvertible.length === 1 ? "it" : "them"} are counted as 0. Refresh rates in
          Settings.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={`Net worth (${base})`} value={formatCompactMoney(view.nw.total, base)} />
        <StatCard label="Assets" value={formatCompactMoney(view.nw.assets, base)} />
        <StatCard label="Liabilities" value={formatCompactMoney(view.nw.liabilities, base)} />
        <StatCard
          label="This month"
          value={formatMoney(view.flow.net, base)}
          sub={`+${formatMoney(view.flow.income, base)} / −${formatMoney(view.flow.expense, base)}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionTitle>By family member</SectionTitle>
          <div className="space-y-2">
            {view.people.map((p) => (
              <div key={p.owner} className="flex items-center justify-between text-sm">
                <span className="text-slate-600">{p.label}</span>
                <span className="font-medium text-slate-800">{formatMoney(p.value, base)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle>Allocation</SectionTitle>
          {view.allocation.length === 0 ? (
            <EmptyState>No holdings yet.</EmptyState>
          ) : (
            <div className="flex items-center gap-4">
              <Donut segments={view.allocation} />
              <div className="space-y-1 text-sm">
                {view.allocation.map((s) => (
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
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle>Monthly income vs expense</SectionTitle>
        <BarTrend data={view.trend} />
      </Card>

      {view.exposure.length > 0 && (
        <Card>
          <SectionTitle>By account / broker</SectionTitle>
          <p className="-mt-1 mb-3 text-xs text-slate-400">
            How much sits with each institution (cash + holdings held there). A large
            share in one place is concentration risk — consider spreading it out.
          </p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Donut segments={view.exposure} />
            <div className="flex-1 space-y-1 text-sm">
              {view.exposure.map((s) => (
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
          {view.exposure[0] && view.exposure[0].pct >= 40 && (
            <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {view.exposure[0].pct.toFixed(0)}% of your assets are with{" "}
              <span className="font-medium">{view.exposure[0].label}</span>. Spreading across
              more institutions reduces the impact if any one freezes or fails.
            </p>
          )}
        </Card>
      )}

      {view.holdings.length > 0 && (
        <Card>
          <SectionTitle>Holdings</SectionTitle>
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
                {view.holdings.map((h) => (
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
        </Card>
      )}
    </div>
  );
}
