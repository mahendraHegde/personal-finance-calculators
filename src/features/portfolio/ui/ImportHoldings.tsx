// Import historical investments from a broker / mutual-fund CSV. Everything runs
// in the browser — the file never leaves the device. Flow: upload + target →
// map columns/actions → REVIEW a detailed diff (per holding before→after) → apply.
// The merge/dedup logic is the pure engine in domain/import-holdings; this is only
// the mapping UI + the review screen.

import { useMemo, useState } from "react";
import { formatMoney, todayIso } from "../../../lib/util/format";
import { parseCsvTable, type CsvTable } from "../../../lib/util/csv";
import {
  detectDayFirst,
  planImport,
  toCanonicalRows,
  type ActionMap,
  type ColumnMap,
  type ImportPlan,
  type SkippedRow,
} from "../domain/import-holdings";
import { usePortfolio } from "../state/context";
import type { CurrencyCode } from "../../../lib/money/currency";
import type { AssetClass, Owner } from "../model/types";
import { Badge, Button, Field, Modal, Select, Stepper } from "./components";
import { accountOptions, CURRENCY_CHOICES, personOptions } from "./helpers";

const ASSET_CLASS_OPTS: Array<{ value: AssetClass; label: string }> = [
  { value: "equity", label: "Equity / ETF" },
  { value: "debt", label: "Debt / bonds" },
  { value: "crypto", label: "Crypto" },
  { value: "gold", label: "Gold" },
  { value: "realestate", label: "Real estate" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

const classLabel = (c: AssetClass): string => ASSET_CLASS_OPTS.find((o) => o.value === c)?.label ?? c;

type Act = "buy" | "sell" | "dividend" | "ignore";
const ACTION_OPTS: Array<{ value: Act; label: string }> = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "dividend", label: "Dividend" },
  { value: "ignore", label: "Ignore" },
];

const guessCol = (headers: string[], kws: string[]): string =>
  headers.find((h) => kws.some((k) => h.toLowerCase().includes(k))) ?? "";

function guessAction(v: string): "buy" | "sell" | "dividend" | "ignore" {
  const s = v.toLowerCase();
  // A cancel/reversal/rejection isn't a representable transaction (it would otherwise
  // re-apply as a SECOND sell/buy and double-count) — default it to Ignore; the user can
  // still remap it, and it lands visibly in the Ignore bucket.
  if (/cancel|revers|reject/.test(s)) return "ignore";
  // IDCW spelled out ("Income Distribution cum capital Withdrawal") contains "withdrawal"
  // — classify it as a dividend BEFORE the sell rule so it isn't read as a redemption.
  if (/idcw|income distribution/.test(s)) return "dividend";
  // Explicit SELL then BUY transaction keywords are tested BEFORE the generic dividend
  // pattern, so a purchase/switch of a fund whose NAME contains "Dividend" (e.g. a
  // "Dividend Yield Fund") isn't mis-read as a dividend. "invest" is deliberately NOT a
  // buy keyword — it would swallow Schwab's "Reinvest Dividend" (income); the share
  // purchase is the explicit "Reinvest Shares". Dividend is the last, catch-all rule.
  if (/sell|redeem|redempt|withdraw|switch.?out|switch over out|merged into|debit/.test(s)) return "sell";
  if (/buy|purchase|sip|switch.?in|switch over in|merged from|reinvest shares/.test(s)) return "buy";
  if (/div|payout|interest/.test(s)) return "dividend";
  return "ignore";
}

type Step = "upload" | "map" | "review";

export function ImportHoldings({ onClose }: { onClose: () => void }) {
  const { state, store } = usePortfolio();
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [table, setTable] = useState<CsvTable | null>(null);
  const [fileName, setFileName] = useState("");
  // Set once the import is applied: the result + the undo-batch id (null = nothing new).
  const [done, setDone] = useState<{ holdings: number; events: number; batchId: string | null } | null>(null);
  const [accountId, setAccountId] = useState("");
  const [personId, setPersonId] = useState<Owner>(state.people[0]?.id ?? "shared");
  const [assetClass, setAssetClass] = useState<AssetClass>("equity");
  const [currency, setCurrency] = useState<CurrencyCode>(state.settings.displayCurrency);
  const [exchange, setExchange] = useState(""); // Google Finance exchange prefix (e.g. NSE), "" = US/as-is
  const [dayFirst, setDayFirst] = useState(true);
  const [dayFirstTouched, setDayFirstTouched] = useState(false); // user set it manually → auto-detect won't clobber

  // Column → header mappings ("" = unmapped).
  const [col, setCol] = useState<Record<keyof ColumnMap, string>>({
    date: "", action: "", symbol: "", name: "", units: "", price: "", amount: "", fee: "", currency: "", ref: "", assetType: "",
  });
  const [actions, setActions] = useState<ActionMap>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Per-symbol (UPPER) asset-class overrides for NEW holdings, edited in the review step.
  const [classOverrides, setClassOverrides] = useState<Record<string, AssetClass>>({});
  const [showIgnored, setShowIgnored] = useState(false);

  const readFile = async (file: File): Promise<void> => {
    setError(null);
    try {
      const t = parseCsvTable(await file.text());
      if (t.headers.length === 0) throw new Error("No columns found in the file.");
      setTable(t);
      setFileName(file.name);
      const h = t.headers;
      const dateCol = guessCol(h, ["date"]);
      setCol({
        date: dateCol,
        action: guessCol(h, ["type", "action", "transaction", "txn type"]),
        symbol: guessCol(h, ["symbol", "ticker", "scheme", "fund", "security", "isin", "name"]),
        name: guessCol(h, ["name", "description", "scheme"]),
        units: guessCol(h, ["unit", "qty", "quantity", "shares"]),
        price: guessCol(h, ["price", "nav", "rate"]),
        amount: guessCol(h, ["amount", "value", "net", "consideration"]),
        fee: guessCol(h, ["fee", "charge", "commission", "brokerage", "tax", "stt"]),
        currency: guessCol(h, ["currency", "ccy"]),
        ref: guessCol(h, ["order", "txn id", "transaction id", "ref", "folio", "confirmation"]),
        assetType: guessCol(h, ["security type", "sec type", "asset type", "asset class", "instrument type", "product type"]),
      });
      // Auto-detect day-first vs month-first from the actual dates (so a US month-first
      // export like Schwab imports correctly without the user touching the toggle). A new
      // file resets the "touched" flag, so this fresh detection always applies.
      setDayFirstTouched(false);
      // Reset to the default when detection is ambiguous, so a second file in the same
      // modal doesn't silently inherit the previous file's day-first setting (F-E).
      const detected = dateCol ? detectDayFirst(t.rows.map((r) => r[dateCol] ?? "")) : null;
      setDayFirst(detected ?? true);
      setActions({}); // a new file may have different action values / holdings
      setOverrides({});
      setClassOverrides({});
      setStep("map");
    } catch (e) {
      setError(String(e));
    }
  };

  // Distinct raw values in the chosen action column (+ how many rows each covers), for
  // the action-value mapping. Row counts let the grouped UI show impact per category.
  const { actionValues, actionRowCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    if (table && col.action) {
      for (const r of table.rows) {
        const v = (r[col.action] ?? "").trim();
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    return { actionValues: [...counts.keys()], actionRowCounts: counts };
  }, [table, col.action]);

  // Seed action mapping with guesses when the action column changes.
  const ensureActionDefaults = (): void => {
    setActions((prev) => {
      const next = { ...prev };
      for (const v of actionValues) {
        const k = v.toLowerCase();
        if (!(k in next)) next[k] = guessAction(v);
      }
      return next;
    });
  };

  const columnMap: ColumnMap | null = useMemo(() => {
    if (!col.date || !col.action || !col.symbol) return null;
    if (!col.amount && !(col.units && col.price)) return null; // need value: amount, or units×price
    const m: ColumnMap = { date: col.date, action: col.action, symbol: col.symbol };
    if (col.name) m.name = col.name;
    if (col.units) m.units = col.units;
    if (col.price) m.price = col.price;
    if (col.amount) m.amount = col.amount;
    if (col.fee) m.fee = col.fee;
    if (col.currency) m.currency = col.currency;
    if (col.ref) m.ref = col.ref;
    if (col.assetType) m.assetType = col.assetType;
    return m;
  }, [col]);

  // The map the ENGINE uses must equal what the UI shows: each Select displays
  // `actions[v] ?? guessAction(v)`, so an untouched value must be applied as its
  // guess too — otherwise the preview shows "Buy" but the row is silently skipped.
  const effectiveActions = useMemo(() => {
    const m: ActionMap = { ...actions };
    for (const v of actionValues) {
      const k = v.toLowerCase();
      if (!(k in m)) m[k] = guessAction(v);
    }
    return m;
  }, [actions, actionValues]);

  // Only parse/plan on the review step — a 10k+ row file would otherwise re-run the
  // whole pipeline on every column/action toggle in the mapping step.
  const canonical = useMemo(
    () =>
      step === "review" && table && columnMap
        ? toCanonicalRows(table, columnMap, effectiveActions, { dayFirst })
        : { rows: [], skipped: 0, skippedRows: [] as SkippedRow[] },
    [step, table, columnMap, effectiveActions, dayFirst],
  );

  const plan: ImportPlan | null = useMemo(() => {
    if (canonical.rows.length === 0) return null;
    const p = planImport(canonical.rows, {
      targetAccountId: accountId,
      targetPersonId: personId,
      defaultAssetClass: assetClass,
      defaultCurrency: currency,
      holdings: state.holdings,
      events: state.holdingEvents,
      matchOverrides: overrides,
      assetClassOverrides: classOverrides,
      googleFinanceExchange: exchange,
      asOf: todayIso(),
    });
    return { ...p, ignoredRows: canonical.skipped };
  }, [canonical, accountId, personId, assetClass, currency, overrides, classOverrides, exchange, state.holdings, state.holdingEvents]);

  const apply = async (): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await store.applyImport(plan, { label: fileName || "CSV import" });
      // Show a result screen with an Undo option rather than closing immediately.
      setDone({ holdings: res.holdings, events: res.events, batchId: res.batch?.id ?? null });
      setBusy(false);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    if (!done?.batchId) return;
    setBusy(true);
    setError(null);
    try {
      await store.undoImportBatch(done.batchId);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // Format each holding's amounts in ITS OWN currency (a merge target may differ from
  // the import default) — not the import-wide default.
  const money = (v: number | null, ccy: CurrencyCode): string => (v === null ? "—" : formatMoney(v, ccy));
  const units = (v: number | null): string => (v === null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 4 }));

  // Post-apply result screen — offers an immediate, precise Undo.
  if (done) {
    const nothingNew = done.holdings + done.events === 0;
    return (
      <Modal title="Import investments (CSV)" onClose={onClose} wide>
        <div className="space-y-4 py-2 text-center">
          <p className="text-4xl">{nothingNew ? "✓" : "🎉"}</p>
          {nothingNew ? (
            <p className="text-sm text-slate-600">
              Nothing new to import — every transaction in this file was already in your portfolio.
            </p>
          ) : (
            <>
              <p className="text-base font-medium text-slate-800">
                Imported {done.events} transaction{done.events === 1 ? "" : "s"}
                {done.holdings > 0 ? ` into ${done.holdings} new holding${done.holdings === 1 ? "" : "s"}` : ""}.
              </p>
              <p className="mx-auto max-w-md text-xs text-slate-500">
                Changed your mind? <b>Undo</b> removes exactly what this import added and restores anything it replaced —
                your other holdings and manually-added transactions are untouched. (You can also undo later from Settings → Import history.)
              </p>
            </>
          )}
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-center gap-2">
            {done.batchId && !nothingNew && (
              <Button variant="ghost" disabled={busy} onClick={() => void undo()}>
                {busy ? "Undoing…" : "Undo import"}
              </Button>
            )}
            <Button disabled={busy} onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Import investments (CSV)" onClose={onClose} wide>
      <div className="space-y-4">
        <Stepper steps={["Choose file", "Match columns", "Review & import"]} current={step === "upload" ? 0 : step === "map" ? 1 : 2} />
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {step === "upload" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-blue-50 p-3 text-sm text-slate-600">
              <p className="font-medium text-slate-700">Bring in your past investments from a broker or mutual-fund statement.</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs">
                <li>In your broker/fund app (Schwab, Zerodha, Groww, Dhan, Upstox, MF Central…), download your transaction history as a <b>CSV</b> file.</li>
                <li>Choose it below, then tell us which columns are which.</li>
                <li>Review a clear before/after summary, then import.</li>
              </ol>
              <p className="mt-1 text-xs text-slate-500">Your file stays on this device — it is never uploaded anywhere.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Import into account"
                hint="Which account these investments sit in. Choose “— none —” if you don't track accounts."
              >
                <Select
                  value={accountId}
                  onChange={(v) => {
                    setAccountId(v);
                    setOverrides({}); // holding-match overrides are account-scoped — don't carry them across
                    setClassOverrides({}); // matching changes → which holdings are "new" changes
                    // Default new-holding currency to the account's currency (e.g. a Schwab
                    // account → USD, a Zerodha account → INR). The user can still override it.
                    const acct = state.accounts.find((a) => a.id === v);
                    if (acct) setCurrency(acct.currency);
                  }}
                  options={[{ value: "", label: "— none —" }, ...accountOptions(state, accountId)]}
                />
              </Field>
              <Field label="Owner" hint="Who this belongs to — you, a family member, or shared.">
                <Select value={personId} onChange={(v) => setPersonId(v)} options={personOptions(state, true, personId)} />
              </Field>
              <Field
                label="Default type (new holdings)"
                hint="Used for new holdings we create. You can change it per holding on the review screen."
              >
                <Select value={assetClass} onChange={(v) => setAssetClass(v as AssetClass)} options={ASSET_CLASS_OPTS} />
              </Field>
              <Field
                label="Default currency (new holdings)"
                hint="Defaults to the chosen account's currency. Used only when your file doesn't state a currency (if it does, we use that)."
              >
                <Select value={currency} onChange={(v) => setCurrency(v as CurrencyCode)} options={CURRENCY_CHOICES.map((c) => ({ value: c, label: c }))} />
              </Field>
            </div>
            <Field
              label="Stock exchange for automatic prices (optional)"
              hint="Helps new holdings fetch live prices. For Indian stocks pick your exchange so “INFY” becomes “NSE:INFY”. Leave blank for US tickers like VOO or AAPL."
            >
              <Select
                value={exchange}
                onChange={setExchange}
                options={[
                  { value: "", label: "— none / US tickers (VOO, AAPL) —" },
                  { value: "NSE", label: "NSE (India) — INFY → NSE:INFY" },
                  { value: "BSE", label: "BSE (India)" },
                  { value: "NASDAQ", label: "NASDAQ" },
                  { value: "NYSE", label: "NYSE" },
                  { value: "LON", label: "LON (London)" },
                ]}
              />
            </Field>
            <p className="text-xs text-slate-400">
              Tip: numbers must use “.” for decimals (1,234.56). We auto-detect whether dates are day-first or
              month-first from your file, and you can correct it on the next screen if a date looks wrong.
            </p>
            <label className="mt-1 block text-sm font-medium text-slate-600">
              Choose your CSV file
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f);
                }}
                className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-white"
              />
            </label>
          </div>
        )}

        {step === "map" && table && (
          <div className="space-y-3">
            <div className="rounded-lg bg-blue-50 p-3 text-sm text-slate-600">
              <p className="font-medium text-slate-700">Tell us which column in your file is which.</p>
              <p className="mt-1 text-xs text-slate-500">
                We've guessed from the column names — check the three required ones (marked <b>*</b>) and fix any that look wrong.
                “Security” is the stock/fund identifier we group by; “Type” is what each row did (buy, sell, etc.).
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {(
                [
                  ["date", "Date *", "When the transaction happened."],
                  ["action", "Type / action *", "What the row is: buy, sell, dividend… (mapped below)."],
                  ["symbol", "Security / symbol *", "The stock ticker or fund name. Rows are grouped into holdings by this."],
                  ["name", "Name (optional)", "A friendlier display name, if your file has one."],
                  ["units", "Units / quantity", "Shares or fund units transacted."],
                  ["price", "Price / NAV", "Price per share/unit."],
                  ["amount", "Amount", "Total money for the row. Needed if there's no price."],
                  ["fee", "Fee (optional)", "Brokerage/commission/tax on the row."],
                  ["currency", "Currency (optional)", "3-letter code (USD, INR). Falls back to the default."],
                  ["ref", "Order / reference id (optional)", "Helps detect duplicates on re-import."],
                  ["assetType", "Security type (optional)", "e.g. Equity, Bond — used to guess each holding's type."],
                ] as Array<[keyof ColumnMap, string, string]>
              ).map(([key, label, hint]) => (
                <Field key={key} label={label} hint={hint}>
                  <Select
                    value={col[key]}
                    onChange={(v) => {
                      setCol((c) => ({ ...c, [key]: v }));
                      if (key === "action") setActions({});
                      if (key === "date" && v && !dayFirstTouched) {
                        const d = detectDayFirst(table.rows.map((r) => r[v] ?? ""));
                        if (d !== null) setDayFirst(d);
                      }
                    }}
                    options={[{ value: "", label: "— none —" }, ...table.headers.map((h) => ({ value: h, label: h }))]}
                  />
                </Field>
              ))}
            </div>
            {!columnMap && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                To continue, map <b>Date</b>, <b>Type</b>, <b>Security</b>, and either an <b>Amount</b> column or both <b>Units</b> and <b>Price</b>.
              </p>
            )}
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={dayFirst}
                onChange={(e) => {
                  setDayFirst(e.target.checked);
                  setDayFirstTouched(true);
                }}
              />
              Dates are day-first (DD/MM/YYYY)
              <span className="text-xs text-slate-400">— auto-detected; untick for US month-first files if a date looks wrong</span>
            </label>
            {col.action && (
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">
                    What does each “{col.action}” value mean? — {actionValues.length} distinct, grouped by our guess
                  </span>
                  <button className="text-xs text-blue-600 hover:underline" onClick={ensureActionDefaults}>
                    re-guess
                  </button>
                </div>
                <p className="mb-2 text-xs text-slate-400">
                  Set “Ignore” for anything that isn't an actual transaction (fees, address changes, nominee updates).
                  Only Buy / Sell / Dividend rows are imported.
                </p>
                <div className="max-h-[42vh] space-y-3 overflow-y-auto">
                  {ACTION_OPTS.map(({ value: cat, label }) => {
                    const vals = actionValues.filter((v) => (effectiveActions[v.toLowerCase()] ?? "ignore") === cat);
                    if (vals.length === 0) return null;
                    const rowTotal = vals.reduce((n, v) => n + (actionRowCounts.get(v) ?? 0), 0);
                    return (
                      <div key={cat}>
                        <div className="mb-1 text-xs font-semibold text-slate-600">
                          {label} — {vals.length} value{vals.length === 1 ? "" : "s"} · {rowTotal} row{rowTotal === 1 ? "" : "s"}
                        </div>
                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                          {vals.map((v) => (
                            <div key={v} className="flex items-center gap-2">
                              <div className="w-28 shrink-0">
                                <Select
                                  value={actions[v.toLowerCase()] ?? guessAction(v)}
                                  onChange={(val) => setActions((a) => ({ ...a, [v.toLowerCase()]: val as Act }))}
                                  options={ACTION_OPTS}
                                />
                              </div>
                              <span className="min-w-0 flex-1 truncate text-xs text-slate-500" title={v}>
                                {v} <span className="text-slate-400">({actionRowCounts.get(v) ?? 0})</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep("upload")}>← Back</Button>
              <Button disabled={!columnMap} onClick={() => setStep("review")}>Preview →</Button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-3">
            {!plan || plan.holdings.length + plan.ambiguous.length === 0 ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Nothing to import — no rows were recognised as a buy, sell or dividend. Go <b>Back</b> and check the “Type”
                mapping (make sure your buy/sell rows aren't all set to Ignore).
                {canonical.skipped > 0 ? ` (${canonical.skipped} rows were skipped — see the list below for why.)` : ""}
              </p>
            ) : (
              <>
                <div className="rounded-lg bg-blue-50 p-3 text-xs text-slate-600">
                  <p className="font-medium text-slate-700">Here's exactly what will change — nothing is saved until you press Import.</p>
                  <p className="mt-1 text-slate-500">
                    Each row shows a holding and its <b>before → after</b> units and cost. “New” holdings are created; “merge”
                    adds transactions to a holding you already have. Re-importing the same file later is safe — we skip anything already added.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="green">{plan.totals.newHoldings} new holdings</Badge>
                  <Badge>{plan.totals.existingHoldings} merged</Badge>
                  <Badge tone="green">{plan.totals.newEvents} new transactions</Badge>
                  {plan.totals.duplicates > 0 && <Badge tone="amber">{plan.totals.duplicates} duplicates skipped</Badge>}
                  {plan.totals.replacedOpenings > 0 && <Badge tone="amber">{plan.totals.replacedOpenings} estimates replaced</Badge>}
                  {plan.ignoredRows > 0 && <Badge tone="slate">{plan.ignoredRows} rows ignored</Badge>}
                </div>

                {plan.ambiguous.length > 0 && (
                  <div className="rounded-lg bg-amber-50 p-3">
                    <p className="mb-2 text-xs font-medium text-amber-800">
                      A few securities match more than one holding you already have. Pick which one to add to (or create a
                      new holding). Anything left as “skip” won't be imported.
                    </p>
                    {plan.ambiguous.map((a) => (
                      <Field key={a.symbol} label={a.name}>
                        <Select
                          value={overrides[a.symbol.toUpperCase()] ?? ""}
                          onChange={(v) => setOverrides((o) => ({ ...o, [a.symbol.toUpperCase()]: v }))}
                          options={[
                            { value: "", label: "— skip —" },
                            { value: "__new__", label: "Create new holding" },
                            ...a.candidateIds.map((id, i) => ({ value: id, label: `Merge into: ${a.candidateNames[i]}` })),
                          ]}
                        />
                      </Field>
                    ))}
                  </div>
                )}

                <div className="max-h-[46vh] overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[32rem] text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Holding</th>
                        <th className="px-3 py-2">Class</th>
                        <th className="px-3 py-2 text-right">Units</th>
                        <th className="px-3 py-2 text-right">Cost basis</th>
                        <th className="px-3 py-2 text-right">Value</th>
                        <th className="px-3 py-2 text-right">Adds</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {plan.holdings.map((p) => (
                        <tr key={p.symbol} className="align-top">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-700">{p.name}</span>
                              <Badge tone={p.existingHoldingId ? "slate" : "green"}>{p.existingHoldingId ? "merge" : "new"}</Badge>
                            </div>
                            {p.warnings.map((w, i) => (
                              <div key={i} className="mt-0.5 text-xs text-amber-700">⚠ {w}</div>
                            ))}
                          </td>
                          <td className="px-3 py-2">
                            {p.existingHoldingId ? (
                              // A merge keeps the existing holding's class — never reclassified by an import.
                              <span className="text-xs text-slate-400">{classLabel(p.assetClass)}</span>
                            ) : (
                              <Select
                                value={classOverrides[p.symbol.toUpperCase()] ?? p.assetClass}
                                onChange={(v) => setClassOverrides((o) => ({ ...o, [p.symbol.toUpperCase()]: v as AssetClass }))}
                                options={ASSET_CLASS_OPTS}
                              />
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                            {units(p.before.units)} <span className="text-slate-400">→</span> {units(p.after.units)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                            {money(p.before.invested, p.currency)} <span className="text-slate-400">→</span> {money(p.after.invested, p.currency)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600">{money(p.after.value, p.currency)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                            +{p.newEvents.length}
                            {p.duplicates > 0 ? <span className="text-amber-600"> ({p.duplicates} dup)</span> : ""}
                            {p.replacedOpeningIds.length > 0 ? <span className="text-amber-600"> (est. replaced)</span> : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-slate-400">
                  Cost basis and units are exact from your transactions; “Value” shows only where a
                  price/valuation is known (refresh prices or add a current value afterwards). Re-importing
                  the same file is safe — already-imported transactions are detected and skipped. New holdings
                  are set to live-price from their symbol — verify the ticker on each (mutual funds need a
                  <code className="mx-0.5">MUTF_IN:</code> code) before relying on auto prices.
                </p>
              </>
            )}

            {canonical.skippedRows.length > 0 && (
              <div className="rounded-lg border border-slate-200">
                <button
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-slate-500 hover:bg-slate-50"
                  onClick={() => setShowIgnored((s) => !s)}
                >
                  <span>{canonical.skippedRows.length} ignored transaction{canonical.skippedRows.length === 1 ? "" : "s"} — not imported</span>
                  <span className="text-slate-400">{showIgnored ? "hide ▲" : "show ▼"}</span>
                </button>
                {showIgnored && (
                  <div className="max-h-[30vh] overflow-auto border-t border-slate-100">
                    <table className="w-full min-w-[32rem] text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-left text-slate-400">
                        <tr>
                          <th className="px-3 py-1.5">Date</th>
                          <th className="px-3 py-1.5">Type</th>
                          <th className="px-3 py-1.5">Security</th>
                          <th className="px-3 py-1.5 text-right">Units</th>
                          <th className="px-3 py-1.5 text-right">Amount</th>
                          <th className="px-3 py-1.5">Why skipped</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {canonical.skippedRows.slice(0, 500).map((s, i) => (
                          <tr key={i} className="text-slate-600">
                            <td className="px-3 py-1.5 whitespace-nowrap">{s.cells.date || "—"}</td>
                            <td className="px-3 py-1.5">{s.cells.action || "—"}</td>
                            <td className="px-3 py-1.5">{s.cells.symbol || "—"}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{s.cells.units || "—"}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{s.cells.amount || "—"}</td>
                            <td className="px-3 py-1.5 text-amber-700">{s.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {canonical.skippedRows.length > 500 && (
                      <p className="px-3 py-1.5 text-slate-400">…and {canonical.skippedRows.length - 500} more (showing the first 500).</p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep("map")}>← Back</Button>
              <Button disabled={busy || !plan || plan.totals.newEvents + plan.totals.newHoldings === 0} onClick={() => void apply()}>
                {busy ? "Importing…" : `Import ${plan?.totals.newEvents ?? 0} transactions`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
