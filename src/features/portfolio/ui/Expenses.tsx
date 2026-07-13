// Expenses/income ledger: filters, client-paginated list, and an add/edit form.

import { useMemo, useState } from "react";
import { formatDate, formatMoney, todayIso } from "../../../lib/util/format";
import { tryConvert } from "../../../lib/money/currency";
import { newId } from "../../../lib/util/id";
import { filterTransactions, flowSummary, sortByDateDesc, type TxnFilter } from "../domain/transactions";
import { isAutopayTransaction } from "../domain/autopay";
import { usePortfolio } from "../state/context";
import type { Transaction, TxnType } from "../model/types";
import { SHARED } from "../model/types";
import { Badge, Button, Card, EmptyState, Field, Modal, NumberInput, Select, TextInput } from "./components";
import {
  accountOptions,
  categoryOptions,
  categoryPath,
  displayFx,
  ownerLabel,
  personOptions,
  subcategoryOptions,
} from "./helpers";

const PAGE = 25;
const TYPE_TONE: Record<TxnType, string> = { income: "green", expense: "red", transfer: "blue" };

export function Expenses() {
  const { state, store } = usePortfolio();
  const [filter, setFilter] = useState<TxnFilter>({});
  // Default to the current year; "" = all years.
  const [year, setYear] = useState<string>(todayIso().slice(0, 4));
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [showForm, setShowForm] = useState(false);

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

  // Merge the year selection into the filter as inclusive date bounds.
  const effFilter = useMemo<TxnFilter>(() => {
    // Drop a filter value that no longer resolves, so the ledger + totals can't
    // stay SILENTLY scoped to something the dropdown no longer shows (which would
    // make the headline numbers look wrong with no visible cause):
    //  - currency: its Select hides once only one currency remains.
    //  - personId: a person who was hard-deleted is gone from state.people.
    //    (An ARCHIVED person still resolves — they stay selectable in this filter.)
    let f: TxnFilter = filter;
    if (f.currency && !currencies.includes(f.currency)) f = { ...f, currency: undefined };
    if (f.personId && f.personId !== SHARED && !state.people.some((p) => p.id === f.personId)) {
      f = { ...f, personId: undefined };
    }
    return year ? { ...f, from: `${year}-01-01`, to: `${year}-12-31` } : f;
  }, [filter, year, currencies, state.people]);
  const rows = useMemo(
    () => sortByDateDesc(filterTransactions(state.transactions, effFilter)),
    [state.transactions, effFilter],
  );
  const visible = rows.slice(0, limit);

  // Income/expense totals for the current view (year + any other filters), in the
  // display currency. Counts ALL matching transactions incl. reporting-only ones
  // (they're real spending/income for analysis even if excluded from balances).
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-28">
          <Select
            value={year}
            onChange={(v) => {
              setYear(v);
              setLimit(PAGE);
            }}
            options={[{ value: "", label: "All years" }, ...years.map((y) => ({ value: y, label: y }))]}
          />
        </div>
        <div className="w-32">
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
        <div className="w-40">
          <Select
            value={filter.personId ?? ""}
            onChange={(v) => updateFilter({ personId: v || undefined })}
            options={[{ value: "", label: "All people" }, ...personOptions(state, true, undefined, true)]}
          />
        </div>
        {currencies.length > 1 && (
          <div className="w-28">
            <Select
              value={filter.currency ?? ""}
              onChange={(v) => updateFilter({ currency: v || undefined })}
              options={[{ value: "", label: "All ccy" }, ...currencies.map((c) => ({ value: c, label: c }))]}
            />
          </div>
        )}
        <div className="min-w-[8rem] flex-1">
          <TextInput
            value={filter.text ?? ""}
            onChange={(v) => updateFilter({ text: v || undefined })}
            placeholder="Search notes…"
          />
        </div>
        <Button onClick={openNew}>+ Add</Button>
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-2 py-3">
        <span className="text-sm font-medium text-slate-600">
          {year || "All years"}
          {filter.type || filter.personId || filter.text ? " (filtered)" : ""}
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
                      <span className="truncate text-sm font-medium text-slate-700">
                        {t.note || catPath || account?.name || "—"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {formatDate(t.date)} · {account?.name ?? "—"} · {ownerLabel(state, t.personId)}
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
  const [note, setNote] = useState(initial?.note ?? "");
  const [excludeFromBalance, setExcludeFromBalance] = useState(initial?.excludeFromBalance ?? false);

  // Stored category = the most specific chosen (sub if set, else parent).
  const leafCategoryId = subCat || parentCat || undefined;

  const selectAccount = (id: string): void => {
    setAccountId(id);
    const acc = state.accounts.find((a) => a.id === id);
    if (acc) {
      setPersonId(acc.personId);
      // A transfer's two legs share one amount, so both accounts must use the
      // same currency. Clear a now-mismatched destination.
      const dest = state.accounts.find((a) => a.id === transferTo);
      if (dest && dest.currency !== acc.currency) setTransferTo("");
    }
  };

  // Same-currency destinations only (cross-currency would post the source
  // amount to a different-currency account and corrupt balances).
  const transferTargets = state.accounts
    .filter((a) => a.id !== accountId && a.currency === currency)
    .map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }));

  const amountNum = Number(amount);
  const canSave =
    accountId !== "" &&
    date !== "" && // a transaction must be dated (the date field holds a partial silently)
    amount.trim() !== "" &&
    Number.isFinite(amountNum) && // rejects "", Infinity, NaN ("1e999", "1.2.3")
    amountNum > 0 &&
    (type !== "transfer" || (transferTo !== "" && transferTo !== accountId));
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
      note: note || undefined,
      // Reporting-only (historical) transactions don't move account balances.
      // Not applicable to transfers.
      excludeFromBalance: type !== "transfer" && excludeFromBalance ? true : undefined,
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
            onChange={(v) => {
              setType(v as TxnType);
              // categories are kind-specific → clear when switching expense/income
              setParentCat("");
              setSubCat("");
            }}
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
          <Field label="To account">
            <Select
              value={transferTo}
              onChange={setTransferTo}
              options={[{ value: "", label: "Select destination…" }, ...transferTargets]}
            />
          </Field>
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
                  options={categoryOptions(state, type, parentCat)}
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
