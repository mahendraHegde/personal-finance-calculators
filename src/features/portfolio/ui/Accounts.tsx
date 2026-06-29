// Manage the building blocks: family members, accounts, and categories.
// Each row is click-to-edit (the save methods upsert by id); the inline "remove"
// stays available and stops the click from also opening the editor.

import { useState } from "react";
import { newId } from "../../../lib/util/id";
import { usePortfolio } from "../state/context";
import type { Account, AccountType, Category, CategoryKind, Person } from "../model/types";
import { SHARED } from "../model/types";
import { Badge, Button, Card, EmptyState, Field, Modal, Select, SectionTitle, TextInput } from "./components";
import { CURRENCY_CHOICES, ownerLabel, personOptions, referenceSummary } from "./helpers";

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
      {form?.kind === "account" && <AccountForm initial={form.rec} onClose={() => setForm(null)} />}
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
          <Select value={personId} onChange={setPersonId} options={personOptions(state, true, personId)} />
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
