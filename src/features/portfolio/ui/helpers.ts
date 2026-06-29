// Small view-model helpers shared across screens: display FX, owner/account/
// category option lists, and per-holding event grouping.

import type { CurrencyCode, FxTable } from "../../../lib/money/currency";
import { rebase } from "../../../lib/money/currency";
import type { PortfolioState } from "../state/store";
import { SHARED } from "../model/types";
import type { DataQuality, FxRateSnapshot, HoldingEvent, Owner } from "../model/types";

/** Badge styling + label for a holding's data-quality classification. */
export const QUALITY_TONE: Record<DataQuality, string> = {
  complete: "green",
  "cost-estimate": "amber",
  "value-only": "slate",
  "needs-valuation": "red",
};
export const QUALITY_LABEL: Record<DataQuality, string> = {
  complete: "exact",
  "cost-estimate": "estimate",
  "value-only": "value-only",
  "needs-valuation": "needs value",
};

/** FX table re-expressed in the user's chosen display currency (falls back). */
export function displayFx(state: PortfolioState): { fx: FxTable; base: CurrencyCode } {
  const base = state.settings.displayCurrency;
  try {
    return { fx: rebase(state.fx, base), base };
  } catch {
    return { fx: state.fx, base: state.fx.base };
  }
}

/** Build a per-date FX resolver from cached rate snapshots: for a given date it
 *  uses the newest snapshot on or before that date (else the earliest available,
 *  else the current table), rebased to `base`. Lets historical charts use
 *  period-appropriate rates instead of today's. */
export function makeFxAt(
  fxRates: FxRateSnapshot[],
  base: CurrencyCode,
  current: FxTable,
): (date: string) => FxTable {
  const sorted = [...fxRates].sort((a, b) => (a.date < b.date ? -1 : 1));
  return (date: string): FxTable => {
    // Binary search for the newest snapshot with date <= the target — O(log n)
    // per call instead of O(n), so pricing a long transaction history against
    // many daily snapshots stays linearithmic rather than quadratic.
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].date <= date) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // For a date BEFORE the earliest cached snapshot we fall back to that earliest
    // one (there is no better data — the rate cache is device-local and never
    // back-filled). KNOWN LIMITATION: on a fresh device, or for transactions older
    // than the first cached rate, historical foreign-currency amounts are converted
    // at a recent-ish rate, so the multi-currency trend for old years is only
    // approximate. USD-base (or single-currency) data is unaffected.
    const snap = idx >= 0 ? sorted[idx] : sorted[0];
    if (!snap) return current;
    try {
      return rebase({ base: snap.base, rates: snap.rates }, base);
    } catch {
      return current;
    }
  };
}

export function ownerLabel(state: PortfolioState, owner: Owner): string {
  if (owner === SHARED) return "Shared";
  return state.people.find((p) => p.id === owner)?.name ?? "Unknown";
}

export function personOptions(
  state: PortfolioState,
  includeShared = true,
): Array<{ value: string; label: string }> {
  const opts = state.people.map((p) => ({ value: p.id, label: p.name }));
  return includeShared ? [{ value: SHARED, label: "Shared" }, ...opts] : opts;
}

export function accountOptions(state: PortfolioState): Array<{ value: string; label: string }> {
  return state.accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }));
}

/** Accounts that can HOLD investments (where you buy units) — brokerages and
 *  crypto exchanges. Used for the holding's "broker" field, so cash-flow accounts
 *  (bank/cash/credit card/liability) don't clutter it. */
export function brokerAccountOptions(state: PortfolioState): Array<{ value: string; label: string }> {
  return state.accounts
    .filter((a) => a.type === "brokerage" || a.type === "crypto")
    .map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }));
}

/** Top-level categories of a kind (for the primary category dropdown). */
export function categoryOptions(
  state: PortfolioState,
  kind: "expense" | "income",
): Array<{ value: string; label: string }> {
  return [
    { value: "", label: "Uncategorized" },
    ...state.categories
      .filter((c) => c.kind === kind && !c.parentId)
      .map((c) => ({ value: c.id, label: c.name })),
  ];
}

/** Subcategories of a given parent (for the secondary dropdown). */
export function subcategoryOptions(
  state: PortfolioState,
  parentId: string,
): Array<{ value: string; label: string }> {
  if (!parentId) return [{ value: "", label: "—" }];
  return [
    { value: "", label: "(none)" },
    ...state.categories.filter((c) => c.parentId === parentId).map((c) => ({ value: c.id, label: c.name })),
  ];
}

/** Display path for a stored (leaf) category id: "Parent › Sub" or "Name". */
export function categoryPath(state: PortfolioState, categoryId?: string): string {
  if (!categoryId) return "";
  const c = state.categories.find((x) => x.id === categoryId);
  if (!c) return "Unknown";
  if (!c.parentId) return c.name;
  const parent = state.categories.find((x) => x.id === c.parentId);
  return `${parent?.name ?? "?"} › ${c.name}`;
}

/** Group holding events by holdingId. */
export function eventsByHolding(state: PortfolioState): Map<string, HoldingEvent[]> {
  const map = new Map<string, HoldingEvent[]>();
  for (const e of state.holdingEvents) {
    const list = map.get(e.holdingId) ?? [];
    list.push(e);
    map.set(e.holdingId, list);
  }
  return map;
}

export const CURRENCY_CHOICES = ["USD", "INR", "CLP", "EUR", "GBP", "AED", "THB", "SGD"];

/** Categorical colour palette for charts/legends. */
export const PALETTE = [
  "#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#475569",
];
