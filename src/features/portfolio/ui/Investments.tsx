// Investments: holdings with XIRR/value/quality, legacy onboarding (opening +
// valuation), and per-holding event management.

import { useMemo, useState } from "react";
import { formatDate, formatMoney, formatPercent, todayIso } from "../../../lib/util/format";
import { newId } from "../../../lib/util/id";
import {
  currentHoldingValue,
  dataQuality,
  holdingPnl,
  holdingXirr,
  withFdAccrual,
} from "../domain/holdings";
import { usePortfolio, useSyncStatus } from "../state/context";
import { useNavigate } from "./navigation";
import { createPriceProviders, fetchPrices } from "../services/price-service";
import type {
  AssetClass,
  FdCompounding,
  FdTerms,
  Holding,
  HoldingEvent,
  HoldingEventType,
  IncomeMode,
  PriceSource,
} from "../model/types";
import { SHARED } from "../model/types";
import { Badge, Button, Card, EmptyState, Field, Modal, NumberInput, Select, TextInput } from "./components";
import {
  holdingAccountOptions,
  CURRENCY_CHOICES,
  eventsByHolding,
  INTEREST_FREQUENCY_OPTIONS,
  ownerLabel,
  personOptions,
  QUALITY_TONE,
} from "./helpers";

const ASSET_CLASSES: AssetClass[] = ["equity", "debt", "cash", "crypto", "gold", "realestate", "other"];

// Live-price sources. CoinGecko + mfapi.in are keyless/browser-direct; Google
// Finance needs Drive connected (it drives the user's own Sheet) but covers
// stocks, ETFs AND mutual funds.
const PRICE_SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "None — I'll enter values manually" },
  { value: "coingecko", label: "CoinGecko — crypto" },
  { value: "mfapi", label: "mfapi.in — Indian mutual-fund NAV" },
  { value: "googlefinance", label: "Google Finance — stocks, ETFs & funds" },
];
const TICKER_HINT: Record<string, string> = {
  coingecko: 'CoinGecko id (lowercase), e.g. "bitcoin", "ethereum"',
  mfapi: 'AMFI scheme code, e.g. "118550" — find it on mfapi.in',
  googlefinance:
    'GOOGLEFINANCE symbol, e.g. "VOO", "NSE:INFY", "MUTF_IN:…" — needs Google Drive connected',
};
/** Sensible default source for an asset class (the user can override). */
function defaultSource(assetClass: AssetClass): string {
  if (assetClass === "crypto") return "coingecko";
  if (assetClass === "debt") return "mfapi"; // Indian MFs are usually debt/equity funds
  if (assetClass === "equity") return "googlefinance";
  return "";
}

/** Shared ticker + source inputs. Live value = units held × fetched price, so
 *  it only helps holdings whose buys are recorded with units. */
function LivePriceFields({
  priceSource,
  setPriceSource,
  ticker,
  setTicker,
}: {
  priceSource: string;
  setPriceSource: (v: string) => void;
  ticker: string;
  setTicker: (v: string) => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="mb-2 text-xs font-medium text-slate-500">
        Live price (optional) — auto-updates value from units × latest price
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Source">
          <Select value={priceSource} onChange={setPriceSource} options={PRICE_SOURCE_OPTIONS} />
        </Field>
        <div className="col-span-2">
          <Field label="Ticker / code">
            <TextInput value={ticker} onChange={setTicker} placeholder={priceSource ? "e.g. NSE:INFY, VOO, MUTF_IN:…" : "—"} />
          </Field>
        </div>
      </div>
      {priceSource && (
        <p className="mt-1 text-xs text-slate-400">
          {TICKER_HINT[priceSource]}
          {priceSource === "googlefinance" && (
            <>
              {" ("}
              <button
                type="button"
                onClick={() => navigate("settings")}
                className="text-blue-600 underline"
              >
                Settings
              </button>
              {")"}
            </>
          )}
        </p>
      )}
    </div>
  );
}
// `opening` is created by the legacy-onboarding flow, not added manually here.
const EVENT_TYPES: HoldingEventType[] = ["buy", "sell", "dividend", "valuation", "adjustment"];
const EVENT_TYPE_LABELS: Record<HoldingEventType, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend received",
  valuation: "Update current value",
  adjustment: "Adjustment",
  opening: "Opening (cost basis)",
};

export function Investments() {
  const { state, store, sync } = usePortfolio();
  const [showHoldingForm, setShowHoldingForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<string | null>(null); // quick "add transaction" target

  const byHolding = useMemo(() => eventsByHolding(state), [state]);
  // Precompute value/XIRR/quality once per state change (XIRR is iterative) so
  // the card grid doesn't recompute it for every holding on every render —
  // matching the Dashboard's memoized approach.
  const metrics = useMemo(
    () => {
      const today = todayIso(); // FDs accrue their computed value up to today
      return new Map(
        state.holdings.map((h) => {
          const events = withFdAccrual(h, byHolding.get(h.id) ?? [], today);
          return [
            h.id,
            { value: currentHoldingValue(events), xirr: holdingXirr(events), quality: dataQuality(events) },
          ] as const;
        }),
      );
    },
    [state.holdings, byHolding],
  );
  const detail = state.holdings.find((h) => h.id === detailId) ?? null;
  const addForHolding = state.holdings.find((h) => h.id === addFor) ?? null;

  // Include the Google Finance provider only when Drive is configured (it needs
  // the OAuth/Sheets client). Rebuild when the client id changes OR when sync
  // state transitions (e.g. after connecting Drive makes the auth available).
  const status = useSyncStatus();
  const clientId = state.settings.drive?.clientId;
  const providers = useMemo(
    () => createPriceProviders({ googleFinance: sync.priceOracle() ?? undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync, clientId, status.phase],
  );
  const hasLivePriced = state.holdings.some((h) => h.ticker && h.priceSource);
  const [refreshing, setRefreshing] = useState(false);
  const [priceResult, setPriceResult] = useState<
    { updated: number; skipped: { name: string; reason: string }[] } | { error: string } | null
  >(null);

  // Refresh live prices. With no args, refreshes every live-priced holding (the
  // manual button). Pass `ids` to refresh just those holdings — used to re-value
  // a single holding right after its quantity/transactions change, so the user
  // never has to hit the global button. `silent` skips the banner + spinner for
  // those targeted auto-refreshes (the holding's value updating in place IS the
  // feedback).
  const refreshPrices = async (ids?: string[], opts?: { silent?: boolean }): Promise<void> => {
    const silent = opts?.silent ?? false;
    if (!silent) {
      setRefreshing(true);
      setPriceResult(null);
    }
    try {
      // Read LIVE store state (not the render-closure `state`) so a refresh
      // fired right after saving sees the new holding/event immediately.
      const s = store.getState();
      const targets = ids ? s.holdings.filter((h) => ids.includes(h.id)) : s.holdings;
      if (targets.length === 0) return;
      const res = await fetchPrices(targets, eventsByHolding(s), providers, s.fx, todayIso());
      // Report the count the store actually PERSISTED — it may drop valuations
      // for holdings deleted mid-fetch or positions no longer held, so the fetched
      // count can over-report.
      const updated = res.valuations.length > 0 ? await store.addValuations(res.valuations) : 0;
      if (!silent) {
        setPriceResult({
          updated,
          skipped: res.skipped.map((sk) => ({ name: sk.holding.name, reason: sk.reason })),
        });
      }
    } catch (e) {
      if (!silent) setPriceResult({ error: String(e) });
    } finally {
      if (!silent) setRefreshing(false);
    }
  };

  // Re-value one holding after its events change (add/edit/delete a transaction).
  // Waits for the write to persist, then refetches just that holding's price.
  const revalueHolding = (id: string) => (p: Promise<unknown>): void => {
    void p.then(() => refreshPrices([id], { silent: true }));
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        {hasLivePriced && (
          <Button variant="ghost" onClick={() => void refreshPrices()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "↻ Refresh prices"}
          </Button>
        )}
        <Button onClick={() => setShowHoldingForm(true)}>+ Add holding</Button>
      </div>

      {priceResult && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
          {"error" in priceResult ? (
            <span className="text-red-600">Price refresh failed: {priceResult.error}</span>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-700">
                  Updated <b>{priceResult.updated}</b>
                  {priceResult.skipped.length > 0 && <> · skipped {priceResult.skipped.length}</>}
                </span>
                <button onClick={() => setPriceResult(null)} className="text-xs text-slate-400 hover:underline">
                  dismiss
                </button>
              </div>
              {priceResult.skipped.length > 0 && (
                <ul className="text-xs text-slate-500">
                  {priceResult.skipped.map((s, i) => (
                    <li key={i}>
                      <span className="text-slate-600">{s.name}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {state.holdings.length === 0 ? (
        <EmptyState>No holdings yet. Add your existing investments with their cost basis.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {state.holdings.map((h) => {
            const m = metrics.get(h.id);
            const value = m?.value ?? null;
            const xirr = m?.xirr ?? null;
            const quality = m?.quality ?? "value-only";
            return (
              <Card key={h.id} className="hover:border-blue-300">
                <div className="cursor-pointer" onClick={() => setDetailId(h.id)}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium text-slate-800">{h.name}</div>
                      <div className="text-xs text-slate-400">
                        {ownerLabel(state, h.personId)} · <span className="capitalize">{h.assetClass}</span>
                        {h.accountId && (
                          <> · {state.accounts.find((a) => a.id === h.accountId)?.name ?? "—"}</>
                        )}
                      </div>
                    </div>
                    <Badge tone={QUALITY_TONE[quality]}>{quality}</Badge>
                  </div>
                  <div className="mt-3 flex items-end justify-between">
                    <div className="text-lg font-semibold text-slate-800">
                      {value === null ? "—" : formatMoney(value, h.currency)}
                    </div>
                    <div className="text-sm text-slate-500">XIRR {formatPercent(xirr)}</div>
                  </div>
                </div>
                <div className="mt-3 flex justify-between border-t border-slate-100 pt-2">
                  <button
                    onClick={() => setDetailId(h.id)}
                    className="text-xs text-slate-500 hover:underline"
                  >
                    View &amp; history
                  </button>
                  <button
                    onClick={() => setAddFor(h.id)}
                    className="text-xs font-medium text-blue-600 hover:underline"
                  >
                    + Add transaction
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {showHoldingForm && (
        <HoldingForm
          onClose={() => setShowHoldingForm(false)}
          onSaved={(hadLiveSource) => {
            setShowHoldingForm(false);
            // Auto-fetch the price immediately so a live-priced holding shows a
            // value without a separate click — matching the "it should just
            // fetch" expectation.
            if (hadLiveSource) void refreshPrices();
          }}
        />
      )}
      {detail && (
        <HoldingDetail
          holding={detail}
          events={byHolding.get(detail.id) ?? []}
          onClose={() => setDetailId(null)}
          onLivePriceSaved={() => void refreshPrices([detail.id], { silent: true })}
          onDelete={() => {
            void store.deleteHolding(detail.id);
            setDetailId(null);
          }}
        />
      )}
      {addForHolding && (
        <EventForm
          holdingId={addForHolding.id}
          currency={addForHolding.currency}
          incomeMode={addForHolding.incomeMode}
          onClose={() => setAddFor(null)}
          onSave={(ev) => {
            revalueHolding(addForHolding.id)(store.saveHoldingEvent(ev));
            setAddFor(null);
          }}
        />
      )}
    </div>
  );
}

function HoldingForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Holding | null;
  onClose: () => void;
  onSaved: (hadLiveSource: boolean) => void;
}) {
  const { state, store } = usePortfolio();
  const [name, setName] = useState(initial?.name ?? "");
  const [personId, setPersonId] = useState(initial?.personId ?? state.people[0]?.id ?? SHARED);
  const [accountId, setAccountId] = useState(initial?.accountId ?? ""); // broker/account this lot sits in
  const [assetClass, setAssetClass] = useState<AssetClass>(initial?.assetClass ?? "equity");
  const [currency, setCurrency] = useState(initial?.currency ?? state.settings.displayCurrency);

  // Picking the broker account defaults the currency + owner to it (a holding
  // usually trades in its account's currency); both stay overridable.
  const pickAccount = (id: string): void => {
    setAccountId(id);
    const acc = state.accounts.find((a) => a.id === id);
    if (acc) {
      setCurrency(acc.currency);
      setPersonId(acc.personId);
    }
  };
  const [incomeMode, setIncomeMode] = useState<IncomeMode>(initial?.incomeMode ?? "accumulating");
  const [priceSource, setPriceSource] = useState<string>(
    initial?.priceSource ?? defaultSource(initial?.assetClass ?? "equity"),
  );
  const [ticker, setTicker] = useState(initial?.ticker ?? "");
  // Onboarding (NEW holdings only). Raw strings; parsed at save. Editing an
  // existing holding manages its lots via the transaction history instead.
  const [quantity, setQuantity] = useState("");
  const [invested, setInvested] = useState("");
  const [startDate, setStartDate] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  // Fixed-deposit auto-accrual (opt-in). Offered for a debt holding or an FD-type
  // account; the value is then computed from the deposit principal by compound
  // interest, and a manual valuation re-bases (overrides) it.
  const [fdEnabled, setFdEnabled] = useState(Boolean(initial?.fd));
  const [fdRate, setFdRate] = useState(initial?.fd ? String(initial.fd.ratePct) : "");
  const [fdCompounding, setFdCompounding] = useState<FdCompounding>(initial?.fd?.compounding ?? "quarterly");
  const [fdMaturity, setFdMaturity] = useState(initial?.fd?.maturityDate ?? "");

  // Default the price source to match the asset class until the user touches it.
  const pickAssetClass = (v: AssetClass): void => {
    setPriceSource((cur) => (cur === defaultSource(assetClass) ? defaultSource(v) : cur));
    setAssetClass(v);
  };

  const livePriced = Boolean(priceSource && ticker.trim());
  const num = (s: string): number | null => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? n : null;
  };

  // Asset accounts a holding can sit in (bank / FD / real estate / brokerage /
  // crypto / cash) — but ALWAYS include the holding's CURRENT account even if it
  // falls outside that filter (e.g. one set earlier on a now-archived or debt
  // account), so the Select's value always matches an option and editing other
  // fields can never silently blank/drop the existing account link.
  const accountChoices = holdingAccountOptions(state);
  if (initial?.accountId && !accountChoices.some((o) => o.value === initial.accountId)) {
    const a = state.accounts.find((x) => x.id === initial.accountId);
    if (a) accountChoices.push({ value: a.id, label: `${a.name} (${a.currency})` });
  }
  // Offer the fixed-deposit auto-accrual when this looks like an FD: a debt-class
  // holding, or one sitting in an FD-type account.
  const showFd = assetClass === "debt" || state.accounts.find((a) => a.id === accountId)?.type === "fd";

  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    // FD terms only when the section is shown, enabled, and the rate is valid;
    // otherwise undefined (also clears it if the user turned FD off).
    const rate = num(fdRate);
    const fd: FdTerms | undefined =
      showFd && fdEnabled && rate !== null && rate > 0
        ? { ratePct: rate, compounding: fdCompounding, maturityDate: fdMaturity || undefined }
        : undefined;
    const holding: Holding = {
      ...initial, // preserve fields not edited here (e.g. archived)
      id: initial?.id ?? newId(),
      name: name.trim(),
      personId,
      accountId: accountId || undefined,
      assetClass,
      currency,
      incomeMode,
      ticker: ticker.trim() || undefined,
      priceSource: priceSource ? (priceSource as PriceSource) : undefined,
      fd,
    };
    await store.saveHolding(holding);

    // Editing an existing holding only updates its properties; its lots/events
    // are managed in the detail view, so skip the onboarding-event creation.
    if (initial) {
      onSaved(livePriced);
      return;
    }

    const qty = num(quantity);
    const cost = num(invested);
    const date = startDate || todayIso();
    if (qty !== null && qty > 0 && cost !== null && cost > 0) {
      // Quantity AND cost → a real BUY (units × price): live-priceable AND a true
      // cost basis for XIRR/gain.
      await store.saveHoldingEvent({
        id: newId(),
        holdingId: holding.id,
        date,
        type: "buy",
        units: qty,
        price: cost / qty,
      });
    } else if (qty !== null && qty > 0) {
      // Quantity but NO cost → an UNKNOWN-BASIS opening (units, no amount). Still
      // live-priceable (netUnits counts opening units), but NOT a zero-cost buy —
      // so it shows as "cost-estimate", not "complete", and a later sale doesn't
      // report the whole proceeds as a (fake) gain.
      await store.saveHoldingEvent({
        id: newId(),
        holdingId: holding.id,
        date,
        type: "opening",
        units: qty,
      });
    } else if (cost !== null && cost > 0) {
      // Cost but no quantity → amount-only cost basis. Can't be live-priced (no
      // units); value comes from the manual "current value" valuation below.
      await store.saveHoldingEvent({
        id: newId(),
        holdingId: holding.id,
        date,
        type: "opening",
        amount: cost,
      });
    }
    // A manual current value only makes sense when there's no live source to
    // fetch it; otherwise the refresh provides it (units × live price).
    const valueNum = num(currentValue);
    if (!livePriced && valueNum !== null && valueNum >= 0) {
      await store.saveHoldingEvent({
        id: newId(),
        holdingId: holding.id,
        date: todayIso(),
        type: "valuation",
        amount: valueNum,
      });
    }
    onSaved(livePriced);
  };

  return (
    <Modal title={initial ? "Edit holding" : "Add holding"} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="e.g. Nifty 50 Index Fund" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Owner">
            <Select value={personId} onChange={setPersonId} options={personOptions(state, true, personId)} />
          </Field>
          <Field label="Account / broker">
            <Select
              value={accountId}
              onChange={pickAccount}
              options={[{ value: "", label: "— none —" }, ...accountChoices]}
            />
          </Field>
          <Field label="Currency">
            <Select
              value={currency}
              onChange={setCurrency}
              options={CURRENCY_CHOICES.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Asset class">
            <Select
              value={assetClass}
              onChange={(v) => pickAssetClass(v as AssetClass)}
              options={ASSET_CLASSES.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Dividends">
            <Select
              value={incomeMode}
              onChange={(v) => setIncomeMode(v as IncomeMode)}
              options={[
                { value: "accumulating", label: "Reinvested (growth)" },
                { value: "payout", label: "Paid out (income)" },
              ]}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-400">
          {incomeMode === "accumulating"
            ? "Growth funds reinvest dividends into the price, so you don't log them separately."
            : "Income funds pay cash dividends — you'll log each payout, and it counts toward returns."}
        </p>

        <LivePriceFields
          priceSource={priceSource}
          setPriceSource={setPriceSource}
          ticker={ticker}
          setTicker={setTicker}
        />

        {/* Onboarding (NEW holdings only) — for an existing one, lots are edited
            in its transaction history. */}
        {!initial && (
          <div className="rounded-lg bg-slate-50 p-3">
            <div className="mb-2 text-xs font-medium text-slate-500">
              Already hold this? Enter your quantity and what you paid (optional).
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Quantity (units held)">
                <NumberInput value={quantity} onChange={setQuantity} placeholder="e.g. 0.085" />
              </Field>
              <Field label="Total cost (what you paid)">
                <NumberInput value={invested} onChange={setInvested} placeholder="cost basis" />
              </Field>
              <Field label="Since">
                <TextInput value={startDate} onChange={setStartDate} type="date" />
              </Field>
              {!livePriced && (
                <Field label="Current value">
                  <NumberInput value={currentValue} onChange={setCurrentValue} placeholder="value now" />
                </Field>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {livePriced
                ? "Current value is fetched automatically (quantity × latest price) — enter your quantity so it can be valued."
                : "Enter quantity to track units (needed for live prices), or just a cost + current value."}
            </p>
          </div>
        )}

        {showFd && (
          <div className="rounded-lg bg-slate-50 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={fdEnabled}
                onChange={(e) => setFdEnabled(e.target.checked)}
              />
              Fixed deposit — auto-calculate its value from interest
            </label>
            {fdEnabled && (
              <>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Field label="Interest rate (% p.a.)">
                    <NumberInput value={fdRate} onChange={setFdRate} placeholder="e.g. 7.1" />
                  </Field>
                  <Field label="Compounding">
                    <Select
                      value={fdCompounding}
                      onChange={(v) => setFdCompounding(v as FdCompounding)}
                      // Same crediting frequencies as savings interest, plus an FD-only "simple".
                      options={[...INTEREST_FREQUENCY_OPTIONS, { value: "simple", label: "Simple (no compounding)" }]}
                    />
                  </Field>
                  <Field label="Maturity date (optional)">
                    <TextInput value={fdMaturity} onChange={setFdMaturity} type="date" />
                  </Field>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {initial
                    ? "Value accrues from your deposit (or latest manual valuation) to today."
                    : "Enter your deposit as “Total cost” and its date as “Since” above; the value then accrues to today."}{" "}
                  It's an estimate (banks round / deduct TDS) — enter a current value any time to reconcile.
                  Assumes interest is reinvested (cumulative FD); a payout FD (Dividends = “Paid out”) isn't
                  auto-valued — log each payout instead.
                </p>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function HoldingDetail({
  holding,
  events,
  onClose,
  onLivePriceSaved,
  onDelete,
}: {
  holding: Holding;
  events: HoldingEvent[];
  onClose: () => void;
  onLivePriceSaved: () => void;
  onDelete: () => void;
}) {
  const { state, store } = usePortfolio();
  const [adding, setAdding] = useState(false);
  const [editEvent, setEditEvent] = useState<HoldingEvent | null>(null);
  const [showQuantity, setShowQuantity] = useState(false);
  const [editing, setEditing] = useState(false); // edit holding PROPERTIES via the form
  // Accrue an FD to today for value/return; the event LIST still shows raw events
  // (the synthetic FD valuation is a read-time estimate, not a real ledger entry).
  const accrued = withFdAccrual(holding, events, todayIso());
  const pnl = holdingPnl(accrued);
  const xirr = holdingXirr(accrued);
  const sorted = [...events].sort((a, b) => (a.date < b.date ? 1 : -1));
  const existingOpening = events.find((e) => e.type === "opening");

  return (
    <Modal title={holding.name} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-slate-50 p-2">
            <div className="text-xs text-slate-400">Value</div>
            <div className="font-semibold text-slate-800">
              {pnl.value === null ? "—" : formatMoney(pnl.value, holding.currency)}
            </div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2">
            <div className="text-xs text-slate-400">Invested</div>
            <div className="font-semibold text-slate-800">{formatMoney(pnl.invested, holding.currency)}</div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2">
            <div className="text-xs text-slate-400">XIRR</div>
            <div className="font-semibold text-slate-800">{formatPercent(xirr)}</div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-600">Transaction history</span>
            <Button variant="ghost" onClick={() => setAdding(true)}>
              + Add transaction
            </Button>
          </div>
          {sorted.length === 0 ? (
            <EmptyState>No events yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {sorted.map((e) => (
                <li
                  key={e.id}
                  // Click to edit. Openings represent the position/quantity, so
                  // they're edited through the quantity form (pre-filled) instead.
                  onClick={() => (e.type === "opening" ? setShowQuantity(true) : setEditEvent(e))}
                  className="flex cursor-pointer items-center justify-between py-2 hover:bg-slate-50"
                >
                  <span>
                    <Badge>{EVENT_TYPE_LABELS[e.type]}</Badge>{" "}
                    <span className="ml-2 text-slate-400">{formatDate(e.date)}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-slate-700">
                      {e.units !== undefined && e.price !== undefined
                        ? `${e.units} × ${e.price}`
                        : formatMoney(e.amount ?? 0, holding.currency)}
                    </span>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation(); // don't open the editor
                        void store.deleteHoldingEvent(e.id).then(onLivePriceSaved);
                      }}
                      className="text-xs text-red-500 hover:underline"
                    >
                      remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Holding properties (name, owner, broker, currency, dividends, ticker /
            price source) are all edited in the prefilled form. */}
        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          <span className="capitalize text-slate-600">{holding.assetClass}</span>
          {holding.accountId && (
            <> · {state.accounts.find((a) => a.id === holding.accountId)?.name ?? "—"}</>
          )}
          {holding.ticker && <> · {holding.ticker}</>}
          <span className="ml-1">· {holding.currency}</span>
        </div>

        <div className="flex justify-between pt-2">
          <Button variant="danger" onClick={onDelete}>
            Delete holding
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Edit details
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>

      {editing && (
        <HoldingForm
          initial={holding}
          onClose={() => setEditing(false)}
          onSaved={(live) => {
            setEditing(false);
            if (live) onLivePriceSaved(); // re-fetch if a live source is configured
          }}
        />
      )}

      {adding && (
        <EventForm
          holdingId={holding.id}
          currency={holding.currency}
          incomeMode={holding.incomeMode}
          onClose={() => setAdding(false)}
          onSave={(ev) => {
            void store.saveHoldingEvent(ev).then(onLivePriceSaved);
            setAdding(false);
          }}
        />
      )}
      {editEvent && (
        <EventForm
          holdingId={holding.id}
          currency={holding.currency}
          incomeMode={holding.incomeMode}
          initial={editEvent}
          onClose={() => setEditEvent(null)}
          onSave={(ev) => {
            void store.saveHoldingEvent(ev).then(onLivePriceSaved);
            setEditEvent(null);
          }}
          onDelete={() => {
            void store.deleteHoldingEvent(editEvent.id).then(onLivePriceSaved);
            setEditEvent(null);
          }}
        />
      )}
      {showQuantity && (
        <QuantityForm
          holding={holding}
          existingOpening={existingOpening}
          onClose={() => setShowQuantity(false)}
          onSaved={() => {
            setShowQuantity(false);
            onLivePriceSaved(); // re-fetch so the new quantity is valued
          }}
        />
      )}
    </Modal>
  );
}

function EventForm({
  holdingId,
  currency,
  incomeMode,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  holdingId: string;
  currency: string;
  incomeMode: IncomeMode;
  initial?: HoldingEvent | null;
  onClose: () => void;
  onSave: (e: HoldingEvent) => void;
  onDelete?: () => void;
}) {
  const str = (n: number | undefined): string => (n !== undefined ? String(n) : "");
  // Accumulating funds reinvest dividends into NAV, so a manual dividend would
  // double-count — only offer it for payout holdings. Always include the event's
  // own type so editing an existing one never lands on an option that's missing.
  const availableTypes = EVENT_TYPES.filter(
    (t) => t !== "dividend" || incomeMode === "payout" || t === initial?.type,
  );
  const [type, setType] = useState<HoldingEventType>(initial?.type ?? "buy");
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [units, setUnits] = useState(str(initial?.units));
  const [price, setPrice] = useState(str(initial?.price));
  const [amount, setAmount] = useState(str(initial?.amount));
  const [fee, setFee] = useState(str(initial?.fee));

  const usesUnits = type === "buy" || type === "sell";
  const fin = (v: string) => v.trim() !== "" && Number.isFinite(Number(v));
  // Validate per type so no sign-flipped/Infinity/zero-information event saves:
  //  buy/sell → units>0, price≥0; dividend → amount>0; valuation → amount≥0;
  //  adjustment → finite, non-zero (it's a signed reconciliation plug).
  let canSave: boolean;
  if (usesUnits) canSave = fin(units) && Number(units) > 0 && fin(price) && Number(price) >= 0;
  else if (type === "adjustment") canSave = fin(amount) && Number(amount) !== 0;
  else if (type === "dividend") canSave = fin(amount) && Number(amount) > 0;
  else canSave = fin(amount) && Number(amount) >= 0; // valuation / opening
  const okFee = fee.trim() === "" || (Number.isFinite(Number(fee)) && Number(fee) >= 0);

  const save = (): void => {
    if (!canSave || !okFee) return;
    onSave({
      // Editing keeps the same id (upsert) and its original createdAt (so the
      // same-day ordering of valuations doesn't shift on a correction).
      id: initial?.id ?? newId(),
      holdingId,
      date,
      type,
      units: usesUnits ? Number(units) : undefined,
      price: usesUnits ? Number(price) : undefined,
      amount: !usesUnits ? Number(amount) : undefined,
      fee: fee.trim() !== "" ? Number(fee) : undefined,
      createdAt: initial?.createdAt,
    });
  };

  return (
    <Modal title={initial ? "Edit transaction" : "Add transaction"} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select
              value={type}
              onChange={(v) => setType(v as HoldingEventType)}
              options={availableTypes.map((t) => ({ value: t, label: EVENT_TYPE_LABELS[t] }))}
            />
          </Field>
          <Field label="Date">
            <TextInput value={date} onChange={setDate} type="date" />
          </Field>
        </div>
        {usesUnits ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Units">
                <NumberInput value={units} onChange={setUnits} />
              </Field>
              <Field label={`Price per unit (${currency})`}>
                <NumberInput value={price} onChange={setPrice} />
              </Field>
            </div>
            {/* Spell out that price is per-unit (not the total paid) by showing
                the running total — removes the most common data-entry mistake. */}
            {fin(units) && fin(price) ? (
              <p className="-mt-1 text-xs text-slate-500">
                {units} × {formatMoney(Number(price), currency)} ={" "}
                <span className="font-medium">
                  {formatMoney(Number(units) * Number(price), currency)}
                </span>
                {fee.trim() !== "" && okFee ? ` + ${formatMoney(Number(fee), currency)} fee` : ""}{" "}
                total {type === "buy" ? "paid" : "received"}
              </p>
            ) : (
              <p className="-mt-1 text-xs text-slate-400">
                Enter the price for a single unit, not the total amount paid.
              </p>
            )}
          </>
        ) : (
          <Field label={`Amount (${currency})`}>
            <NumberInput value={amount} onChange={setAmount} />
          </Field>
        )}
        <Field label="Fee (optional)">
          <NumberInput value={fee} onChange={setFee} />
        </Field>
        <div className="flex items-center justify-between pt-2">
          {onDelete ? (
            <Button variant="danger" onClick={onDelete}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!canSave || !okFee}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Reconcile a holding to a known quantity (writes a single units-bearing
 *  opening). Used to fix a holding that was onboarded as an amount, so live
 *  pricing can value it. Pre-fills from the existing opening when there is one. */
function QuantityForm({
  holding,
  existingOpening,
  onClose,
  onSaved,
}: {
  holding: Holding;
  existingOpening: HoldingEvent | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { store } = usePortfolio();
  const [quantity, setQuantity] = useState(
    existingOpening?.units !== undefined ? String(existingOpening.units) : "",
  );
  const [cost, setCost] = useState(
    existingOpening?.amount !== undefined ? String(existingOpening.amount) : "",
  );
  const [date, setDate] = useState(existingOpening?.date ?? todayIso());

  const qty = Number(quantity);
  const costNum = Number(cost);
  const canSave = quantity.trim() !== "" && Number.isFinite(qty) && qty > 0;
  const save = async (): Promise<void> => {
    if (!canSave) return;
    await store.setOpeningPosition(holding.id, {
      units: qty,
      cost: cost.trim() !== "" && Number.isFinite(costNum) && costNum > 0 ? costNum : undefined,
      date,
    });
    onSaved();
  };

  return (
    <Modal title="Set quantity held" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Sets your starting position in units (replacing any earlier cost-basis entry). Buys and
          sells you record still add to or subtract from this.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity (units held)">
            <NumberInput value={quantity} onChange={setQuantity} placeholder="e.g. 0.085" />
          </Field>
          <Field label="Total cost (optional)">
            <NumberInput value={cost} onChange={setCost} placeholder="what you paid" />
          </Field>
        </div>
        <Field label="Since">
          <TextInput value={date} onChange={setDate} type="date" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
