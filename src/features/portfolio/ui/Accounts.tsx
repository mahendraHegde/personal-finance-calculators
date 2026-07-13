// Manage the building blocks: family members, accounts, and categories.
// Each row is click-to-edit (the save methods upsert by id); the inline "remove"
// stays available and stops the click from also opening the editor.

import { useState } from "react";
import { newId } from "../../../lib/util/id";
import { todayIso } from "../../../lib/util/format";
import { usePortfolio } from "../state/context";
import type { Account, AccountType, Category, CategoryKind, InterestFrequency, Person } from "../model/types";
import { SHARED } from "../model/types";
import { Badge, Button, Card, EmptyState, Field, Modal, NumberInput, Select, SectionTitle, TextInput } from "./components";
import {
  composeAccountExtras,
  CURRENCY_CHOICES,
  holdingAccountOptions,
  INTEREST_FREQUENCY_OPTIONS,
  ownerLabel,
  personOptions,
  referenceSummary,
} from "./helpers";

type EntityKind = "person" | "account" | "category";
type Entity = Person | Account | Category;

const ACCOUNT_TYPES: AccountType[] = [
  "bank",
  "cash",
  "creditcard",
  "brokerage",
  "crypto",
  "fd",
  "realestate",
  "liability",
];
const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  bank: "bank",
  cash: "cash",
  creditcard: "credit card",
  brokerage: "brokerage",
  crypto: "crypto",
  fd: "fixed deposit",
  realestate: "real estate",
  liability: "liability",
};

type FormState =
  | { kind: "person"; rec?: Person }
  | { kind: "account"; rec?: Account }
  | { kind: "category"; rec?: Category }
  | null;

export function Accounts() {
  const { state, store } = usePortfolio();
  const [form, setForm] = useState<FormState>(null);
  const [error, setError] = useState<string | null>(null);
  const [del, setDel] = useState<{ kind: EntityKind; rec: Entity } | null>(null);

  const remove = (fn: Promise<void>): void => {
    setError(null);
    void fn.catch((e: unknown) => setError(String(e)));
  };

  const setArchived = (kind: EntityKind, rec: Entity, archived: boolean): Promise<void> => {
    if (kind === "person") return store.savePerson({ ...(rec as Person), archived });
    if (kind === "account") return store.saveAccount({ ...(rec as Account), archived });
    return store.saveCategory({ ...(rec as Category), archived });
  };

  // Row that opens the editor on click; the action buttons stop propagation.
  const rowProps = (onEdit: () => void) => ({
    onClick: onEdit,
    className: "flex cursor-pointer items-center justify-between gap-2 py-2 hover:bg-slate-50",
  });

  // Per-row actions: archive/unarchive (reversible, no confirm) + delete (opens a
  // dialog that hard-deletes only when nothing references it, else offers Archive).
  const actions = (kind: EntityKind, rec: Entity) => (
    <span className="flex shrink-0 items-center gap-3" onClick={(e) => e.stopPropagation()}>
      {rec.archived && <Badge>archived</Badge>}
      <button
        onClick={() => remove(setArchived(kind, rec, !rec.archived))}
        className="text-xs text-slate-500 hover:underline"
      >
        {rec.archived ? "unarchive" : "archive"}
      </button>
      <button onClick={() => setDel({ kind, rec })} className="text-xs text-red-500 hover:underline">
        delete
      </button>
    </span>
  );
  const nameCls = (archived?: boolean): string => (archived ? "text-slate-400" : "text-slate-700");

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{error}</div>}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>Family members</SectionTitle>
          <Button variant="ghost" onClick={() => setForm({ kind: "person" })}>
            + Person
          </Button>
        </div>
        {state.people.length === 0 ? (
          <EmptyState>Add the people whose finances you track.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {state.people.map((p) => (
              <li key={p.id} {...rowProps(() => setForm({ kind: "person", rec: p }))}>
                <span className={nameCls(p.archived)}>{p.name}</span>
                {actions("person", p)}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>Accounts</SectionTitle>
          <Button variant="ghost" onClick={() => setForm({ kind: "account" })}>
            + Account
          </Button>
        </div>
        {state.accounts.length === 0 ? (
          <EmptyState>Add bank, cash, brokerage, or liability accounts.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {state.accounts.map((a) => (
              <li key={a.id} {...rowProps(() => setForm({ kind: "account", rec: a }))}>
                <span className={nameCls(a.archived)}>
                  {a.name}{" "}
                  <span className="text-xs text-slate-400">
                    {a.type} · {a.currency} · {ownerLabel(state, a.personId)}
                  </span>
                </span>
                {actions("account", a)}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>Categories</SectionTitle>
          <Button variant="ghost" onClick={() => setForm({ kind: "category" })}>
            + Category
          </Button>
        </div>
        {state.categories.length === 0 ? (
          <EmptyState>Add expense/income categories.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {state.categories.map((c) => (
              <li key={c.id} {...rowProps(() => setForm({ kind: "category", rec: c }))}>
                <span className={nameCls(c.archived)}>
                  {c.parentId ? <span className="text-slate-400">↳ </span> : null}
                  {c.name} <span className="text-xs text-slate-400">{c.kind}</span>
                </span>
                {actions("category", c)}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {form?.kind === "person" && <PersonForm initial={form.rec} onClose={() => setForm(null)} />}
      {form?.kind === "account" && (
        <AccountForm key={form.rec?.id ?? "new"} initial={form.rec} onClose={() => setForm(null)} />
      )}
      {form?.kind === "category" && <CategoryForm initial={form.rec} onClose={() => setForm(null)} />}
      {del && <DeleteDialog kind={del.kind} rec={del.rec} onClose={() => setDel(null)} />}
    </div>
  );
}

// Delete confirm that protects history: hard-delete only when nothing references
// the entity; otherwise explain what uses it and offer Archive (hide from menus,
// keep history) instead.
function DeleteDialog({
  kind,
  rec,
  onClose,
}: {
  kind: EntityKind;
  rec: Entity;
  onClose: () => void;
}) {
  const { state, store } = usePortfolio();
  const [err, setErr] = useState<string | null>(null);
  const { total, summary } = referenceSummary(state, kind, rec.id);
  const label = kind === "person" ? "family member" : kind;
  const run = (p: Promise<void>): void => {
    setErr(null);
    p.then(onClose).catch((e: unknown) => setErr(String(e)));
  };
  const archive = (): Promise<void> => {
    if (kind === "person") return store.savePerson({ ...(rec as Person), archived: true });
    if (kind === "account") return store.saveAccount({ ...(rec as Account), archived: true });
    return store.saveCategory({ ...(rec as Category), archived: true });
  };
  const hardDelete = (): Promise<void> => {
    if (kind === "person") return store.deletePerson(rec.id);
    if (kind === "account") return store.deleteAccount(rec.id);
    return store.deleteCategory(rec.id);
  };

  return (
    <Modal title={`Delete ${label}?`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {err && <p className="text-red-600">{err}</p>}
        {total === 0 ? (
          <>
            <p className="text-slate-600">
              Permanently delete <b>{rec.name}</b>? Nothing uses it, so this is safe — but it can't be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => run(hardDelete())}>
                Delete
              </Button>
            </div>
          </>
        ) : !rec.archived ? (
          <>
            <p className="text-slate-600">
              <b>{rec.name}</b> is used by {summary}. Deleting it would orphan that history, so it's
              protected.
            </p>
            <p className="text-slate-500">
              Archive it instead — it's hidden from the menus when you add or edit entries, but your
              history and totals stay intact. You can unarchive it anytime.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => run(archive())}>Archive</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-slate-600">
              <b>{rec.name}</b> is used by {summary} and is already archived (hidden from menus). To
              delete it, reassign or remove those entries first.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PersonForm({ initial, onClose }: { initial?: Person; onClose: () => void }) {
  const { store } = usePortfolio();
  const [name, setName] = useState(initial?.name ?? "");
  return (
    <Modal title={initial ? "Edit person" : "Add person"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="e.g. Priya" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              void store.savePerson({ ...initial, id: initial?.id ?? newId(), name: name.trim() });
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AccountForm({ initial, onClose }: { initial?: Account; onClose: () => void }) {
  const { state, store } = usePortfolio();
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<AccountType>(initial?.type ?? "bank");
  const [currency, setCurrency] = useState(initial?.currency ?? state.settings.displayCurrency);
  const [personId, setPersonId] = useState(initial?.personId ?? state.people[0]?.id ?? SHARED);
  const [openingBalance, setOpeningBalance] = useState(
    initial?.openingBalance !== undefined ? String(initial.openingBalance) : "",
  );
  const [openingDate, setOpeningDate] = useState(initial?.openingBalanceDate ?? "");
  const [earnsInterest, setEarnsInterest] = useState(!!initial?.interest);
  const [interestRate, setInterestRate] = useState(
    initial?.interest ? String(initial.interest.ratePct) : "",
  );
  const [interestFreq, setInterestFreq] = useState<InterestFrequency>(
    initial?.interest?.frequency ?? "quarterly",
  );
  const [autopayOn, setAutopayOn] = useState(!!initial?.autopay);
  const [payFrom, setPayFrom] = useState(initial?.autopay?.fromAccountId ?? "");
  const [statementDay, setStatementDay] = useState(initial?.autopay ? String(initial.autopay.statementDay) : "");
  const [dueDay, setDueDay] = useState(initial?.autopay ? String(initial.autopay.dueDay) : "");
  const [dueNextMonth, setDueNextMonth] = useState(initial?.autopay?.dueNextMonth ?? false);
  // Transactions/holdings post amounts in the account's currency (we don't store a
  // bank-converted amount). Changing the currency of an account that already has
  // history would silently REINTERPRET every past amount in the new currency and
  // corrupt balances & net worth — so lock it once there's history (same guard
  // shape as deleteAccount). Make a new account for another currency instead.
  const hasHistory = initial
    ? state.transactions.some((t) => t.accountId === initial.id || t.transferToAccountId === initial.id) ||
      state.holdings.some((h) => h.accountId === initial.id)
    : false;
  // Interest auto-accrual is for a SAVINGS (bank) account — a fluctuating balance
  // earning daily interest. A fixed deposit is modelled as a HOLDING instead
  // (Holding.fd: locked principal, maturity, counts in the portfolio return), so
  // there's ONE FD path and no double-count. Other account types don't earn
  // account-level interest — EXCEPT we keep the section visible for an account that
  // already HAS interest (e.g. a legacy FD-type account from before this rule), so
  // editing it (say, a rename) doesn't silently strip its config; the user can see
  // it and turn it off to migrate.
  const showInterest = type === "bank" || Boolean(initial?.interest);
  // Statement auto-pay is a credit-card-only, opt-in convenience. The payer must be
  // a same-currency asset account (reuse the holding-account picker: it already
  // excludes credit cards / liabilities).
  const showAutopay = type === "creditcard";
  const payerOptions = holdingAccountOptions(state, payFrom).filter(
    (o) => state.accounts.find((a) => a.id === o.value)?.currency === currency,
  );
  // The payer must be a CURRENT, same-currency option — not just any non-empty id.
  // Otherwise changing the card's currency (or a since-deleted payer) could leave a
  // stranded `fromAccountId` that saves "enabled" but silently never pays.
  const payerValid = payerOptions.some((o) => o.value === payFrom);
  const autopayReady =
    payerValid && Number(statementDay) >= 1 && Number(statementDay) <= 31 && Number(dueDay) >= 1 && Number(dueDay) <= 31;
  const interestReady = Number(interestRate) > 0;
  return (
    <Modal title={initial ? "Edit account" : "Add account"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="e.g. HDFC Savings" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select
              value={type}
              onChange={(v) => setType(v as AccountType)}
              options={ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))}
            />
          </Field>
          <Field label="Currency">
            <Select
              value={currency}
              onChange={setCurrency}
              disabled={hasHistory}
              options={CURRENCY_CHOICES.map((c) => ({ value: c, label: c }))}
            />
            {hasHistory && (
              <p className="mt-1 text-xs text-slate-400">
                Locked — this account has transactions or holdings in {initial?.currency}. Changing it
                would mis-state their amounts. Create a new account for another currency.
              </p>
            )}
          </Field>
        </div>
        <Field label="Owner">
          <Select value={personId} onChange={setPersonId} options={personOptions(state, true, personId)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opening balance (optional)">
            <NumberInput value={openingBalance} onChange={setOpeningBalance} placeholder="e.g. 50000" />
          </Field>
          <Field label="As of (optional)">
            <TextInput value={openingDate} onChange={setOpeningDate} type="date" />
          </Field>
        </div>
        <p className="-mt-1 text-xs text-slate-400">
          Money already in the account before your first tracked entry. It counts toward the balance and
          net worth, but isn't recorded as income.
        </p>

        {showInterest && (
          <div className="rounded-lg bg-slate-50 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={earnsInterest}
                onChange={(e) => setEarnsInterest(e.target.checked)}
              />
              Earns interest — auto-accrue it on the balance
            </label>
            {earnsInterest && (
              <>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Field label="Interest rate (% p.a.)">
                    <NumberInput value={interestRate} onChange={setInterestRate} placeholder="e.g. 3.5" />
                  </Field>
                  <Field label="Credited">
                    <Select
                      value={interestFreq}
                      onChange={(v) => setInterestFreq(v as InterestFrequency)}
                      options={INTEREST_FREQUENCY_OPTIONS}
                    />
                  </Field>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  Interest is computed on your daily balance up to today and added to this account — it's
                  an estimate (banks round / deduct TDS). For exact figures, leave this off and record
                  interest credits as income instead.
                </p>
                {!interestReady && (
                  <p className="mt-1 text-xs text-amber-700">
                    Enter a rate above 0% — otherwise this saves with no interest.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {showAutopay && (
          <div className="rounded-lg bg-slate-50 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={autopayOn} onChange={(e) => setAutopayOn(e.target.checked)} />
              Auto-pay the statement from another account
            </label>
            {autopayOn && (
              <>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Field label="Pay from">
                    <Select
                      value={payFrom}
                      onChange={setPayFrom}
                      options={[{ value: "", label: "— select account —" }, ...payerOptions]}
                    />
                  </Field>
                  <Field label="Statement day">
                    <NumberInput value={statementDay} onChange={setStatementDay} placeholder="e.g. 10" />
                  </Field>
                  <Field label="Due day">
                    <NumberInput value={dueDay} onChange={setDueDay} placeholder="e.g. 5" />
                  </Field>
                  {/* A plain caption + standalone checkbox label — NOT wrapped in
                      Field, which renders its own <label> (nested labels are invalid). */}
                  <div>
                    <span className="mb-1 block text-xs font-medium text-slate-500">Due month</span>
                    <label className="flex items-center gap-2 py-1.5 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={dueNextMonth}
                        onChange={(e) => setDueNextMonth(e.target.checked)}
                      />
                      Next month
                    </label>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  On each due date, a transfer pays the statement balance (as of the statement day) from
                  the chosen account — so your cash keeps earning interest until then. Tick "Next month"
                  when the due date falls the month after the statement closes (e.g. statement 10th, pay
                  15th next month). These payments are managed automatically — change these settings or
                  turn this off to edit them.
                </p>
                {payerOptions.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-700">
                    Add a {currency} bank or cash account to pay from — auto-pay needs a same-currency payer.
                  </p>
                ) : (
                  !autopayReady && (
                    <p className="mt-1 text-xs text-amber-700">
                      Pick a payer and enter statement/due days (1–31) — otherwise this saves with auto-pay off.
                    </p>
                  )
                )}
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              // All the fiddly form→record mapping (number parsing, drop-stray-date,
              // `since` preservation) lives in this pure, unit-tested helper.
              const extras = composeAccountExtras({
                openingBalance,
                openingDate,
                interestEnabled: showInterest && earnsInterest,
                interestRate,
                interestFreq,
                autopayEnabled: showAutopay && autopayOn && autopayReady,
                fromAccountId: payFrom,
                statementDay,
                dueDay,
                dueNextMonth,
                existingSince: initial?.autopay?.since,
                today: todayIso(),
              });
              void store.saveAccount({
                ...initial,
                id: initial?.id ?? newId(),
                name: name.trim(),
                type,
                currency,
                personId,
                ...extras,
              });
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CategoryForm({ initial, onClose }: { initial?: Category; onClose: () => void }) {
  const { state, store } = usePortfolio();
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(initial?.kind ?? "expense");
  const [parentId, setParentId] = useState(initial?.parentId ?? ""); // "" = top-level

  // A category that already HAS subcategories must stay top-level (we only allow
  // two levels), so editing it can't move it under a parent.
  const hasChildren = initial ? state.categories.some((c) => c.parentId === initial.id) : false;
  // Eligible parents: top-level categories of the chosen kind, never itself.
  // Hide archived parents, but keep the currently-selected one visible.
  const parents = state.categories.filter(
    (c) => !c.parentId && c.kind === kind && c.id !== initial?.id && (!c.archived || c.id === parentId),
  );
  const parent = state.categories.find((c) => c.id === parentId);
  // A subcategory inherits its parent's kind.
  const effectiveKind = parent ? parent.kind : kind;

  const [err, setErr] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setErr(null);
    try {
      const id = initial?.id ?? newId();
      await store.saveCategory({
        id,
        name: name.trim(),
        kind: effectiveKind,
        parentId: parentId || undefined,
        archived: initial?.archived, // preserve archived state across an edit
      });
      // Keep subcategories' kind in sync if a parent's kind changed (they inherit it).
      if (initial) {
        const children = state.categories.filter((c) => c.parentId === id && c.kind !== effectiveKind);
        for (const child of children) await store.saveCategory({ ...child, kind: effectiveKind });
      }
      onClose();
    } catch (e) {
      setErr(String(e)); // keep the modal open so the edit isn't lost
    }
  };

  return (
    <Modal title={initial ? "Edit category" : "Add category"} onClose={onClose}>
      <div className="space-y-3">
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="e.g. Groceries" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(v) => {
                setKind(v as CategoryKind);
                setParentId(""); // parents are kind-specific
              }}
              options={[
                { value: "expense", label: "Expense" },
                { value: "income", label: "Income" },
              ]}
            />
          </Field>
          {hasChildren ? (
            <Field label="Parent">
              <p className="py-2 text-xs text-slate-400">Has subcategories — stays top-level.</p>
            </Field>
          ) : (
            <Field label="Parent (optional)">
              <Select
                value={parentId}
                onChange={setParentId}
                options={[
                  { value: "", label: "— top-level —" },
                  ...parents.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </Field>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
