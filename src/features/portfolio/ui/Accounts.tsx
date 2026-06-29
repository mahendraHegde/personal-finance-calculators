// Manage the building blocks: family members, accounts, and categories.
// Each row is click-to-edit (the save methods upsert by id); the inline "remove"
// stays available and stops the click from also opening the editor.

import { useState } from "react";
import { newId } from "../../../lib/util/id";
import { usePortfolio } from "../state/context";
import type { Account, AccountType, Category, CategoryKind, Person } from "../model/types";
import { SHARED } from "../model/types";
import { Button, Card, EmptyState, Field, Modal, Select, SectionTitle, TextInput } from "./components";
import { CURRENCY_CHOICES, ownerLabel, personOptions } from "./helpers";

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

  const remove = (fn: Promise<void>): void => {
    setError(null);
    void fn.catch((e: unknown) => setError(String(e)));
  };

  // Row that opens the editor on click; the "remove" button stops propagation.
  const rowProps = (onEdit: () => void) => ({
    onClick: onEdit,
    className: "flex cursor-pointer items-center justify-between gap-2 py-2 hover:bg-slate-50",
  });

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
                <span className="text-slate-700">{p.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(store.deletePerson(p.id));
                  }}
                  className="text-xs text-red-500 hover:underline"
                >
                  remove
                </button>
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
                <span className="text-slate-700">
                  {a.name}{" "}
                  <span className="text-xs text-slate-400">
                    {a.type} · {a.currency} · {ownerLabel(state, a.personId)}
                  </span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(store.deleteAccount(a.id));
                  }}
                  className="text-xs text-red-500 hover:underline"
                >
                  remove
                </button>
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
                <span className="text-slate-700">
                  {c.parentId ? <span className="text-slate-400">↳ </span> : null}
                  {c.name} <span className="text-xs text-slate-400">{c.kind}</span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(store.deleteCategory(c.id));
                  }}
                  className="text-xs text-red-500 hover:underline"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {form?.kind === "person" && <PersonForm initial={form.rec} onClose={() => setForm(null)} />}
      {form?.kind === "account" && <AccountForm initial={form.rec} onClose={() => setForm(null)} />}
      {form?.kind === "category" && <CategoryForm initial={form.rec} onClose={() => setForm(null)} />}
    </div>
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
  // Transactions/holdings post amounts in the account's currency (we don't store a
  // bank-converted amount). Changing the currency of an account that already has
  // history would silently REINTERPRET every past amount in the new currency and
  // corrupt balances & net worth — so lock it once there's history (same guard
  // shape as deleteAccount). Make a new account for another currency instead.
  const hasHistory = initial
    ? state.transactions.some((t) => t.accountId === initial.id || t.transferToAccountId === initial.id) ||
      state.holdings.some((h) => h.accountId === initial.id)
    : false;
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
          <Select value={personId} onChange={setPersonId} options={personOptions(state)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              void store.saveAccount({
                ...initial,
                id: initial?.id ?? newId(),
                name: name.trim(),
                type,
                currency,
                personId,
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
  const parents = state.categories.filter(
    (c) => !c.parentId && c.kind === kind && c.id !== initial?.id,
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
