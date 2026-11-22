// Expenses/income ledger: filters, client-paginated list, and an add/edit form.

import { useMemo, useState } from "react";
import type { BadgeTone } from "./components";
import { formatDate, formatMoney, todayIso } from "../../../lib/util/format";
import { tryConvert } from "../../../lib/money/currency";
import { newId } from "../../../lib/util/id";
import {
  filterTransactions,
  flowSummary,
  LEDGER_CUSTOM as CUSTOM,
  ledgerFilter,
  secondaryFilterCount,
  sortByDateDesc,
  type TxnFilter,
} from "../domain/transactions";
import { isAutopayTransaction } from "../domain/autopay";
import { usePortfolio } from "../state/context";
import type { Category, Transaction, TxnType } from "../model/types";
import { SHARED } from "../model/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FiltersButton,
  FiltersPanel,
  Modal,
  NumberInput,
  Select,
  TextInput,
} from "./components";
import { ImportTransactions } from "./ImportTransactions";
import {
  accountLabel,
  accountLabelById,
  accountOptions,
  categoryOptions,
  categoryPath,
  displayFx,
  ownerLabel,
  personOptions,
  subcategoryOptions,
} from "./helpers";

const PAGE = 25;
const TYPE_TONE: Record<TxnType, BadgeTone> = { income: "green", expense: "red", transfer: "blue" };
const MONTH_OPTIONS: { value: string; label: string }[] = [
  ["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"],
  ["05", "May"], ["06", "June"], ["07", "July"], ["08", "August"],
  ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"],
].map(([value, label]) => ({ value, label }));

export function Expenses() {
  const { state, store } = usePortfolio();
  const [filter, setFilter] = useState<TxnFilter>({});
  // Default to the current year; "" = all years; CUSTOM = the From/To range below.
  const [year, setYear] = useState<string>(todayIso().slice(0, 4));
  // Month-of-year "01".."12"; "" = all months (the default). Ignored for a custom range.
  const [month, setMonth] = useState<string>("");
  // Inclusive ISO bounds for a custom range; "" = open on that side.
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [fCat, setFCat] = useState<string>(""); // top-level category filter ("" = all)
  const [fSubCat, setFSubCat] = useState<string>(""); // subcategory filter ("" = all)
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // Years present in the data, plus the current year, newest first.
  const years = useMemo(() => {
    const set = new Set<string>([todayIso().slice(0, 4)]);
    for (const t of state.transactions) set.add(t.date.slice(0, 4));
    return [...set].sort((a, b) => (a < b ? 1 : -1));
  }, [state.transactions]);

  // Currencies present across transactions (for the currency filter).
  const currencies = useMemo(
    () => [...new Set(state.transactions.map((t) => t.currency))].sort(),
    [state.transactions],
  );

  // Category / subcategory filter. Selecting a PARENT matches it AND its subcategories;
  // selecting a subcategory narrows to exactly that. Archived categories are included
  // (labelled) so transactions tagged with a now-archived/merged-away category stay
  // filterable. Alphabetical by name.
  const catFilterOptions = useMemo(
    () => [
      { value: "", label: "All categories" },
      ...state.categories
        .filter((c) => !c.parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ value: c.id, label: c.archived ? `${c.name} (archived)` : c.name })),
    ],
    [state.categories],
  );
  // Collapse a stale selection (its category was deleted/merged) down to "all".
  const catVal = fCat && state.categories.some((c) => c.id === fCat && !c.parentId) ? fCat : "";
  // Subcategories are directly filterable — the dropdown is always available whenever any
  // subcategory exists (not gated behind picking a parent). With a parent selected it lists
  // that parent's children by plain name; with NO parent it lists EVERY subcategory,
  // labelled "Parent › Sub" so you can pick one without first drilling into its parent.
  const subFilterOptions = useMemo(() => {
    const label = (c: Category): string => {
      const base = c.archived ? `${c.name} (archived)` : c.name;
      if (catVal) return base;
      const parent = state.categories.find((p) => p.id === c.parentId);
      return parent ? `${parent.name} › ${base}` : base;
    };
    const subs = state.categories
      .filter((c) => c.parentId !== undefined && (catVal ? c.parentId === catVal : true))
      .map((c) => ({ value: c.id, label: label(c) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return subs.length > 0 ? [{ value: "", label: "All subcategories" }, ...subs] : [];
  }, [state.categories, catVal]);
  const subVal = fSubCat && subFilterOptions.some((o) => o.value === fSubCat) ? fSubCat : "";

  // The filter actually applied (rows and totals): drops picks that no longer resolve or whose
  // control is hidden, and turns the period into date bounds. See ledgerFilter.
  const effFilter = useMemo<TxnFilter>(
    () =>
      ledgerFilter(
        { filter, year, month, rangeFrom, rangeTo, categoryId: catVal, subcategoryId: subVal },
        { currencies, people: state.people, categories: state.categories, hasAccounts: state.accounts.length > 0 },
      ),
    [filter, year, month, rangeFrom, rangeTo, catVal, subVal, currencies, state.people, state.categories, state.accounts],
  );
  const rows = useMemo(
    () => sortByDateDesc(filterTransactions(state.transactions, effFilter, state.accounts)),
    [state.transactions, effFilter, state.accounts],
  );
  // A From after To matches nothing; say so instead of showing an unexplained empty list.
  const rangeInverted = year === CUSTOM && !!rangeFrom && !!rangeTo && rangeFrom > rangeTo;
  // Secondary filters live behind the Filters button; count the EFFECTIVE (normalized) ones,
  // so a value that no longer resolves can't leave a phantom count with nothing to clear.
  const secondaryCount = secondaryFilterCount(effFilter);
  const clearSecondary = (): void => {
    setFCat("");
    setFSubCat("");
    updateFilter({ personId: undefined, accountHolderId: undefined, currency: undefined });
  };
  const visible = rows.slice(0, limit);

  // Income/expense totals for the current view (year + any other filters), in the
  // display currency. Counts `excludeFromBalance` transactions (reporting-only — real
  // spending/income for analysis even if they don't move a balance) but NOT
  // `excludeFromReports` ones (internal asset moves like an FD settlement: a real
  // balance change that isn't earnings/spending). flowSummary enforces the latter.
  const totals = useMemo(() => {
    const { fx, base } = displayFx(state);
    // Currencies in the filtered rows with NO rate to the display base silently
    // count as 0 in flowSummary — surface them (like the Dashboard does) so the
    // totals are never quietly wrong.
    const unconvertible = [...new Set(rows.map((r) => r.currency))].filter(
      (c) => tryConvert({ amount: 1, currency: c }, base, fx) === null,
    );
    return { ...flowSummary(rows, base, fx), base, unconvertible };
  }, [rows, state]);

  // Any filter change resets pagination to the first page (uniform with the year
  // selector), so you don't keep an inflated "load more" count after narrowing.
  const updateFilter = (patch: Partial<TxnFilter>): void => {
    setFilter((f) => ({ ...f, ...patch }));
    setLimit(PAGE);
  };

  const openNew = (): void => {
    setEditing(null);
    setShowForm(true);
  };
  const openEdit = (t: Transaction): void => {
    setEditing(t);
    setShowForm(true);
  };

  const monthName = month ? (MONTH_OPTIONS.find((m) => m.value === month)?.label ?? "") : "";
  const periodLabel =
    year === CUSTOM
      ? rangeFrom && rangeTo
        ? `${formatDate(rangeFrom)} to ${formatDate(rangeTo)}`
        : rangeFrom
          ? `From ${formatDate(rangeFrom)}`
          : rangeTo
            ? `Up to ${formatDate(rangeTo)}`
            : "All time"
      : year && month
        ? `${monthName} ${year}`
        : year
          ? year
          : month
            ? `${monthName} (all years)`
            : "All time";

  return (
    <div className="space-y-4">
      {/* Everyday controls only; the rest sit behind Filters. Two per row on a phone. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        {/* Full width on a phone in custom mode: the date pair below can't sit beside it. */}
        <div className={`sm:w-36 ${year === CUSTOM ? "col-span-2 sm:col-auto" : ""}`}>
          <Select
            value={year}
            onChange={(v) => {
              setYear(v);
              setLimit(PAGE);
            }}
            options={[
              { value: "", label: "All years" },
              ...years.map((y) => ({ value: y, label: y })),
              { value: CUSTOM, label: "Custom range…" },
            ]}
          />
        </div>
        {year === CUSTOM ? (
          <div className="col-span-2 grid grid-cols-2 gap-2 sm:col-auto sm:flex sm:items-center">
            <div className="sm:w-36">
              <TextInput
                type="date"
                value={rangeFrom}
                onChange={(v) => {
                  setRangeFrom(v);
                  setLimit(PAGE);
                }}
                placeholder="From date"
                ariaLabel="From date"
              />
            </div>
            <div className="sm:w-36">
              <TextInput
                type="date"
                value={rangeTo}
                onChange={(v) => {
                  setRangeTo(v);
                  setLimit(PAGE);
                }}
                placeholder="To date"
                ariaLabel="To date"
              />
            </div>
          </div>
        ) : (
          <div className="sm:w-32">
            <Select
              value={month}
              onChange={(v) => {
                setMonth(v);
                setLimit(PAGE);
              }}
              options={[{ value: "", label: "All months" }, ...MONTH_OPTIONS]}
            />
          </div>
        )}
        <div className="sm:w-32">
          <Select
            value={filter.type ?? ""}
            onChange={(v) => updateFilter({ type: (v || undefined) as TxnType | undefined })}
            options={[
              { value: "", label: "All types" },
              { value: "expense", label: "Expense" },
              { value: "income", label: "Income" },
              { value: "transfer", label: "Transfer" },
            ]}
          />
        </div>
        <div className="sm:min-w-[8rem] sm:flex-1">
          <TextInput
            value={filter.text ?? ""}
            onChange={(v) => updateFilter({ text: v || undefined })}
            placeholder="Search notes…"
          />
        </div>
        <div className="col-span-2 flex gap-2 sm:contents">
          <FiltersButton open={showFilters} onToggle={() => setShowFilters((o) => !o)} count={secondaryCount} />
          <Button variant="ghost" className="flex-1 whitespace-nowrap sm:flex-none" onClick={() => setShowImport(true)}>
            Import CSV
          </Button>
          <Button className="flex-1 whitespace-nowrap sm:flex-none" onClick={openNew}>
            + Add
          </Button>
        </div>
      </div>

      {showFilters && (
        <FiltersPanel onClear={secondaryCount > 0 ? clearSecondary : undefined}>
          <Field label="Category">
            <Select
              value={catVal}
              onChange={(v) => {
                setFCat(v);
                setFSubCat(""); // subcategories belong to a parent
                setLimit(PAGE);
              }}
              options={catFilterOptions}
            />
          </Field>
          {subFilterOptions.length > 1 && (
            <Field label="Subcategory">
              <Select
                value={subVal}
                onChange={(v) => {
                  setFSubCat(v);
                  setLimit(PAGE);
                }}
                options={subFilterOptions}
              />
            </Field>
          )}
          {/* Two different people: whose transaction it is, and whose name the account is in. */}
          <Field label="Owner">
            <Select
              value={effFilter.personId ?? ""}
              onChange={(v) => updateFilter({ personId: v || undefined })}
              options={[{ value: "", label: "All owners" }, ...personOptions(state, true, undefined, true)]}
            />
          </Field>
          {state.accounts.length > 0 && (
            <Field label="Account holder">
              <Select
                value={effFilter.accountHolderId ?? ""}
                onChange={(v) => updateFilter({ accountHolderId: v || undefined })}
                options={[{ value: "", label: "All holders" }, ...personOptions(state, true, undefined, true)]}
              />
            </Field>
          )}
          {currencies.length > 1 && (
            <Field label="Currency">
              <Select
                value={effFilter.currency ?? ""}
                onChange={(v) => updateFilter({ currency: v || undefined })}
                options={[{ value: "", label: "All currencies" }, ...currencies.map((c) => ({ value: c, label: c }))]}
              />
            </Field>
          )}
        </FiltersPanel>
      )}

      {rangeInverted && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          The From date is after the To date, so nothing can match. Swap them to see transactions.
        </p>
      )}

      <Card className="flex flex-wrap items-center justify-between gap-2 py-3">
        <span className="text-sm font-medium text-slate-600">
          {periodLabel}
          {filter.type || filter.text || secondaryCount > 0 ? " (filtered)" : ""}
        </span>
        <div className="flex gap-4 text-sm">
          <span className="text-green-600">Income {formatMoney(totals.income, totals.base)}</span>
          <span className="text-red-600">Expenses {formatMoney(totals.expense, totals.base)}</span>
          <span className="font-semibold text-slate-800">Net {formatMoney(totals.net, totals.base)}</span>
        </div>
      </Card>

      {totals.unconvertible.length > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          No exchange rate for {totals.unconvertible.join(", ")} → those transactions count as 0 in
          the totals above. Set a rate in Settings for an accurate total.
        </p>
      )}

      {visible.length === 0 ? (
        <EmptyState>No transactions match. Add one to get started.</EmptyState>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {visible.map((t) => {
              const account = state.accounts.find((a) => a.id === t.accountId);
              const catPath = categoryPath(state, t.categoryId);
              // Managed auto-pay transfers are derived from the card's settings —
              // editing/deleting one here would just be reverted/recreated by the
              // reconciler, so they're read-only and badged. Change them via the
              // card's auto-pay settings.
              const managed = isAutopayTransaction(t);
              return (
                <li
                  key={t.id}
                  onClick={managed ? undefined : () => openEdit(t)}
                  title={managed ? "Managed by the card's auto-pay — change it in the account's settings" : undefined}
                  className={`flex items-center justify-between gap-3 px-4 py-3 ${
                    managed ? "" : "cursor-pointer hover:bg-slate-50"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={TYPE_TONE[t.type]}>{t.type}</Badge>
                      {managed && <Badge>auto-pay</Badge>}
                      {t.excludeFromReports && <Badge>not in reports</Badge>}
                      <span className="truncate text-sm font-medium text-slate-700">
                        {t.note || catPath || account?.name || "—"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {formatDate(t.date)} · {accountLabelById(state, t.accountId, { vsOwner: t.personId })} · {ownerLabel(state, t.personId)}
                      {catPath && t.note ? ` · ${catPath}` : ""}
                    </div>
                  </div>
                  <div
                    className={`shrink-0 text-sm font-semibold ${
                      t.type === "income" ? "text-green-600" : "text-slate-800"
                    }`}
                  >
                    {t.type === "expense" ? "−" : t.type === "income" ? "+" : ""}
                    {formatMoney(t.amount, t.currency)}
                    {t.type === "transfer" && t.transferToAmount !== undefined
                      ? (() => {
                          const d = state.accounts.find((a) => a.id === t.transferToAccountId);
                          return d ? (
                            <span className="font-normal text-slate-400"> → {formatMoney(t.transferToAmount, d.currency)}</span>
                          ) : null;
                        })()
                      : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {rows.length > limit && (
        <div className="text-center">
          <Button variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
            Load more ({rows.length - limit} more)
          </Button>
        </div>
      )}

      {showImport && <ImportTransactions onClose={() => setShowImport(false)} />}

      {showForm && (
        <TransactionForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSave={(t) => {
            void store.saveTransaction(t);
            setShowForm(false);
          }}
          onDelete={
            editing
              ? () => {
                  void store.deleteTransaction(editing.id);
                  setShowForm(false);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function TransactionForm({
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  initial: Transaction | null;
  onClose: () => void;
  onSave: (t: Transaction) => void;
  onDelete?: () => void;
}) {
  const { state } = usePortfolio();
  const firstAccount = state.accounts[0];
  const [type, setType] = useState<TxnType>(initial?.type ?? "expense");
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [accountId, setAccountId] = useState(initial?.accountId ?? firstAccount?.id ?? "");
  const [personId, setPersonId] = useState(initial?.personId ?? firstAccount?.personId ?? SHARED);
  const [amount, setAmount] = useState<string>(initial?.amount !== undefined ? String(initial.amount) : "");
  // A transaction posts to ONE account, in THAT account's currency (the balance
  // math debits the amount directly, and we don't store a bank-converted posted
  // amount) — so the currency is DERIVED from the account, never set independently
  // (a divergent currency would corrupt account balances & net worth). To record
  // an amount in another currency, pick/make an account in that currency.
  const account = state.accounts.find((a) => a.id === accountId);
  const currency = account?.currency ?? firstAccount?.currency ?? state.settings.displayCurrency;
  // Category is stored as a single leaf id; the form edits it as parent + sub.
  const initialCat = state.categories.find((c) => c.id === initial?.categoryId);
  const [parentCat, setParentCat] = useState(
    initialCat ? (initialCat.parentId ?? initialCat.id) : "",
  );
  const [subCat, setSubCat] = useState(initialCat?.parentId ? initialCat.id : "");
  const [transferTo, setTransferTo] = useState(initial?.transferToAccountId ?? "");
  // Cross-currency transfer: the destination amount, "" = follow the FX-suggested value.
  // Both the Rate and Target-amount fields write through to it; reset when either account
  // changes so the suggestion re-derives in the new destination currency.
  const [destOverride, setDestOverride] = useState<string | null>(
    initial?.transferToAmount !== undefined ? String(initial.transferToAmount) : null,
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [excludeFromBalance, setExcludeFromBalance] = useState(initial?.excludeFromBalance ?? false);

  // Stored category = the most specific chosen (sub if set, else parent).
  const leafCategoryId = subCat || parentCat || undefined;

  const selectAccount = (id: string): void => {
    setAccountId(id);
    const acc = state.accounts.find((a) => a.id === id);
    if (acc) setPersonId(acc.personId);
    setDestOverride(null); // the source currency may have changed → re-suggest the target
  };

  // Any other account can receive a transfer; a different-currency destination makes it a
  // CROSS-CURRENCY transfer (the target amount / rate is entered below). Sorted by name.
  const transferTargets = state.accounts
    .filter((a) => a.id !== accountId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ value: a.id, label: accountLabel(state, a, { currency: true }) }));

  const amountNum = Number(amount);

  // --- Cross-currency transfer: destination amount + conversion rate, prefilled from FX ---
  const dest = state.accounts.find((a) => a.id === transferTo);
  const isCrossCurrency = type === "transfer" && !!dest && dest.currency !== currency;
  const round = (n: number, dp: number): string => String(Math.round(n * 10 ** dp) / 10 ** dp);
  // Live rate: 1 source-unit = ? dest-units (null when no rate is available).
  const fxRate = isCrossCurrency && dest ? tryConvert({ amount: 1, currency }, dest.currency, state.fx) : null;
  // While the user hasn't overridden it, the target is source × the live rate.
  const suggestedDest =
    isCrossCurrency && fxRate !== null && Number.isFinite(amountNum) && amountNum > 0 ? amountNum * fxRate : null;
  const shownDest = destOverride ?? (suggestedDest !== null ? round(suggestedDest, 2) : "");
  const destNum = Number(shownDest);
  const shownRate =
    Number.isFinite(amountNum) && amountNum > 0 && Number.isFinite(destNum) && destNum > 0
      ? round(destNum / amountNum, 6)
      : fxRate !== null
        ? round(fxRate, 6)
        : "";
  const canSave =
    accountId !== "" &&
    date !== "" && // a transaction must be dated (the date field holds a partial silently)
    amount.trim() !== "" &&
    Number.isFinite(amountNum) && // rejects "", Infinity, NaN ("1e999", "1.2.3")
    amountNum > 0 &&
    (type !== "transfer" || (transferTo !== "" && transferTo !== accountId)) &&
    // A cross-currency transfer must have a positive destination amount.
    (!isCrossCurrency || (Number.isFinite(destNum) && destNum > 0));
  const save = (): void => {
    if (!canSave) return;
    onSave({
      id: initial?.id ?? newId(),
      date,
      type,
      accountId,
      // Transfers aren't owned by a person (they net across accounts), so we
      // don't carry a hidden personId that would leak into per-person filters.
      personId: type === "transfer" ? SHARED : personId,
      amount: amountNum,
      currency,
      categoryId: type === "transfer" ? undefined : leafCategoryId,
      transferToAccountId: type === "transfer" ? transferTo || undefined : undefined,
      // Cross-currency: store the exact destination amount so the credit bypasses FX.
      transferToAmount: isCrossCurrency ? destNum : undefined,
      note: note || undefined,
      // Reporting-only (historical) transactions don't move account balances.
      // Not applicable to transfers.
      excludeFromBalance: type !== "transfer" && excludeFromBalance ? true : undefined,
      // The MIRROR flag (in balance, out of income/expense reports) is set
      // programmatically by FD settlement and has NO form field — preserve it on
      // edit so a plain re-save can't silently drop it and turn the settled corpus
      // back into "income" (which there's then no UI path to undo).
      excludeFromReports: initial?.excludeFromReports || undefined,
      updatedAt: new Date().toISOString(),
    });
  };

  if (state.accounts.length === 0) {
    return (
      <Modal title="No accounts yet" onClose={onClose}>
        <p className="text-sm text-slate-600">Add an account in the Accounts tab first.</p>
      </Modal>
    );
  }

  return (
    <Modal title={initial ? "Edit transaction" : "Add transaction"} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Type">
          <Select
            value={type}
            onChange={(v) => setType(v as TxnType)}
            // Categories are shared across income & expense now, so switching type keeps
            // the chosen category (transfers ignore it — save() drops categoryId for them).
            options={[
              { value: "expense", label: "Expense" },
              { value: "income", label: "Income" },
              { value: "transfer", label: "Transfer" },
            ]}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput value={date} onChange={setDate} type="date" />
          </Field>
          <Field label={`Amount (${currency})`}>
            <NumberInput value={amount} onChange={setAmount} placeholder="0.00" />
          </Field>
        </div>
        <Field label="Account">
          <Select value={accountId} onChange={selectAccount} options={accountOptions(state, accountId)} />
        </Field>
        {type === "transfer" ? (
          <>
            <Field label="To account">
              <Select
                value={transferTo}
                onChange={(v) => {
                  setTransferTo(v);
                  setDestOverride(null); // re-suggest the target in the new destination currency
                }}
                options={[{ value: "", label: "Select destination…" }, ...transferTargets]}
              />
            </Field>
            {isCrossCurrency && dest && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Rate (1 ${currency} = ? ${dest.currency})`} hint="Prefilled from live FX; edit either field.">
                  <NumberInput
                    value={shownRate}
                    onChange={(v) => {
                      const r = Number(v);
                      setDestOverride(
                        v.trim() !== "" && Number.isFinite(r) && Number.isFinite(amountNum) && amountNum > 0
                          ? round(amountNum * r, 2)
                          : "",
                      );
                    }}
                    placeholder="rate"
                  />
                </Field>
                <Field label={`Target amount (${dest.currency})`}>
                  <NumberInput value={shownDest} onChange={setDestOverride} placeholder="amount received" />
                </Field>
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="Person">
              <Select value={personId} onChange={setPersonId} options={personOptions(state, true, personId)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <Select
                  value={parentCat}
                  onChange={(v) => {
                    setParentCat(v);
                    setSubCat(""); // subcategories belong to a parent
                  }}
                  options={categoryOptions(state, parentCat)}
                />
              </Field>
              <Field label="Subcategory">
                <Select
                  value={subCat}
                  onChange={setSubCat}
                  options={subcategoryOptions(state, parentCat, subCat)}
                />
              </Field>
            </div>
          </>
        )}
        <Field label="Note">
          <TextInput value={note} onChange={setNote} placeholder="Optional" />
        </Field>
        {type !== "transfer" && (
          <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={excludeFromBalance}
              onChange={(e) => setExcludeFromBalance(e.target.checked)}
            />
            <span>
              For reporting only — don't change account balance
              <span className="block text-xs text-slate-400">
                Use for past/imported transactions already reflected in your current balance, so
                they don't double-count against net worth. They still appear in income/expense
                totals.
              </span>
            </span>
          </label>
        )}
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
            <Button onClick={save} disabled={!canSave}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
