// Import past income/expense transactions from any CSV (bank statement, card export, a
// spreadsheet you kept by hand). Four steps: pick the file → say which column is which →
// say which bank/owner/category each value means → review exactly what will be written.
//
// This component is only the WIZARD: all parsing, matching and dedup logic is the pure
// engine in domain/import/transactions, and the write is one atomic store commit
// (undoable from Settings → Import history).

import { useMemo, useState, type ReactNode } from "react";
import { parseCsvTable, type CsvTable } from "../../../lib/util/csv";
import {
  bestNameMatch,
  detectDayFirst,
  aliasKey,
  guessColumn,
  IGNORE_VALUE,
  isCreate,
  namedFrom,
  NEW_ENTITY,
  norm,
  parseImportNumber,
  SKIP_ROWS,
  type SkippedImportRow,
} from "../domain/import/common";
import {
  distinctSubPairs,
  distinctValues,
  planTransactionImport,
  subMapKey,
  toCanonicalTxnRows,
  type ImportedTxnKind,
  type TxnAmountMode,
  type TxnColumnMap,
  type TxnTypeMap,
  type ValueMap,
} from "../domain/import/transactions";
import type { AccountType, Category, Owner } from "../model/types";
import { SHARED } from "../model/types";
import { usePortfolio } from "../state/context";
import { Badge, Button, Field, Modal, Select, Stepper } from "./components";
import { ColumnMapGrid, SkippedRowsPanel, ValueMapRows, type ColumnSpec } from "./ImportShared";
import { accountLabel, CURRENCY_CHOICES, ownerLabel, personOptions } from "./helpers";
import { formatMoney, todayIso } from "../../../lib/util/format";

type Step = "upload" | "map" | "values" | "review";
type ColKey = keyof TxnColumnMap;

const COLUMN_SPECS: Array<ColumnSpec<ColKey>> = [
  { key: "date", label: "Date *", hint: "When the transaction happened." },
  { key: "amount", label: "Amount *", hint: "The money column (the money-OUT column when your file has two)." },
  { key: "credit", label: "Credit / money in", hint: "Only for files with separate debit and credit columns." },
  { key: "type", label: "Type / Dr-Cr", hint: "A column saying whether the row is money in or out (mapped below)." },
  { key: "note", label: "Description / note", hint: "The narration or memo — kept as the transaction's note." },
  { key: "category", label: "Category", hint: "Mapped to your categories in the next step (or created)." },
  { key: "subcategory", label: "Subcategory", hint: "Created under the matched category when present." },
  { key: "account", label: "Bank / account", hint: "Which account each row belongs to. Unmapped banks can be created." },
  { key: "person", label: "Owner", hint: "Who the row belongs to. Defaults to the owner chosen on step 1." },
  { key: "currency", label: "Currency", hint: "Only checked against the account's currency — never overrides it." },
];

const AMOUNT_MODES: Array<{ value: TxnAmountMode; label: string }> = [
  { value: "single", label: "One column, all the same kind" },
  { value: "sign", label: "One column, +/− sign decides" },
  { value: "debitCredit", label: "Separate debit & credit columns" },
  { value: "typeColumn", label: "A type column says which" },
];

const NEW_ACCOUNT_TYPES: AccountType[] = ["bank", "cash", "creditcard"];

/** Heuristic first guess for a type-column value, so common statements need no clicks. */
function guessKind(v: string): ImportedTxnKind | "ignore" {
  const s = v.trim().toLowerCase();
  if (/^(dr|debit|withdrawal|withdraw|paid|payment|expense|purchase|spend|out)\b/.test(s)) return "expense";
  if (/^(cr|credit|deposit|received|receipt|income|salary|refund|in)\b/.test(s)) return "income";
  if (/transfer|reversal|contra/.test(s)) return "ignore";
  return "expense";
}

export function ImportTransactions({ onClose }: { onClose: () => void }) {
  const { state, store } = usePortfolio();
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [fileName, setFileName] = useState("");
  const [done, setDone] = useState<{
    transactions: number;
    accounts: number;
    categories: number;
    people: number;
    dropped: string[];
    batchId: string | null;
  } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  // Step-1 defaults (used for rows whose file doesn't say).
  const [defaultAccountId, setDefaultAccountId] = useState(state.accounts[0]?.id ?? "");
  // SHARED unless the file names an owner — a back-filled statement isn't implicitly
  // "mine", and attributing years of history to one person skews every per-person figure.
  const [defaultPersonId, setDefaultPersonId] = useState<Owner>(SHARED);
  const [newAccountType, setNewAccountType] = useState<AccountType>("bank");
  /** Reporting-only (`excludeFromBalance`): counts in income/expense reports but does NOT
   *  move balances or net worth. ON by default — importing past years into balances that
   *  already reflect them would double-count and wreck net worth. */
  const [reportingOnly, setReportingOnly] = useState(true);
  /** Currency of the whole file, for files with no currency column. "" = each account's own. */
  const [fileCurrency, setFileCurrency] = useState<string>("");

  // Step-2 column mapping + how to read the amount.
  const [col, setCol] = useState<Record<ColKey, string>>({
    date: "", amount: "", credit: "", type: "", note: "", category: "", subcategory: "", account: "", person: "", currency: "",
  });
  const [mode, setMode] = useState<TxnAmountMode>("single");
  const [singleKind, setSingleKind] = useState<ImportedTxnKind>("expense");
  const [expenseIsNegative, setExpenseIsNegative] = useState(true);
  const [typeMap, setTypeMap] = useState<TxnTypeMap>({});
  const [dayFirst, setDayFirst] = useState(true);
  const [dayFirstTouched, setDayFirstTouched] = useState(false);

  // Step-3 value mappings (raw file value → id / sentinel).
  const [accountMap, setAccountMap] = useState<ValueMap>({});
  const [personMap, setPersonMap] = useState<ValueMap>({});
  const [categoryMap, setCategoryMap] = useState<ValueMap>({});
  const [subcategoryMap, setSubcategoryMap] = useState<ValueMap>({});

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    try {
      const t = parseCsvTable(await file.text());
      if (t.headers.length === 0 || t.rows.length === 0) {
        setError("That file has no data rows.");
        return;
      }
      setTable(t);
      setFileName(file.name);
      // Guess the columns from the header names — the user confirms on the next step.
      const h = t.headers;
      const dateCol = guessColumn(h, ["date", "txn date", "value date"]);
      const debit = guessColumn(h, ["debit", "withdrawal", "paid out", "money out"]);
      const credit = guessColumn(h, ["credit", "deposit", "paid in", "money in"]);
      const amountCol = guessColumn(h, ["amount", "value", "total"]);
      const typeCol = guessColumn(h, ["type", "dr / cr", "dr/cr", "drcr", "direction"]);
      setCol({
        date: dateCol,
        amount: debit || amountCol,
        credit: debit && credit ? credit : "",
        type: typeCol,
        note: guessColumn(h, [
          "description", "narration", "note", "details", "particulars", "memo", "remark",
          "summary", "comment", "purpose", "reason", "towards", "vendor", "payee", "merchant",
        ]),
        // "MainCategory" wins over "SubCategory" because guessColumn takes the FIRST header
        // containing the keyword and main columns conventionally come first; the sub guess
        // then explicitly looks for the sub-prefixed one.
        category: guessColumn(h, ["maincategory", "main category", "category", "head", "group"]),
        subcategory: guessColumn(h, ["subcategory", "sub category", "sub-category", "sub head", "subhead"]),
        account: guessColumn(h, ["account", "bank", "card", "source", "wallet"]),
        // NOT a bare "who": a real sheet had a "To Whom" column (the PAYEE), which that
        // matched — turning shop names into family members. Owner columns say owner/person/
        // member/paid-by, never "to whom".
        person: guessColumn(h, ["owner", "person", "member", "paid by", "spent by", "user"]),
        currency: guessColumn(h, ["currency", "ccy"]),
      });
      // Pick the amount mode that matches the file's shape. With no debit/credit pair and no
      // type column, the sign only decides direction if the file ACTUALLY uses signs — a
      // hand-kept expense sheet is all-positive, and guessing "sign" there would import
      // every expense as income. So: negatives present → `sign`, else `single` (expense).
      const amountUsed = debit || amountCol;
      const hasNegative =
        !!amountUsed &&
        t.rows.some((r) => {
          const n = parseImportNumber(r[amountUsed] ?? "");
          return n !== null && n < 0;
        });
      setMode(debit && credit ? "debitCredit" : typeCol ? "typeColumn" : hasNegative ? "sign" : "single");
      setSingleKind("expense");
      if (dateCol && !dayFirstTouched) {
        const d = detectDayFirst(t.rows.map((r) => r[dateCol] ?? ""));
        if (d !== null) setDayFirst(d);
      }
      setStep("map");
    } catch {
      setError("Couldn't read that file. Is it a CSV?");
    }
  };

  // Distinct values of the type column, seeded with guesses.
  const typeValues = useMemo(() => (table ? distinctValues(table, col.type) : []), [table, col.type]);
  const effectiveTypeMap = useMemo(() => {
    const m: TxnTypeMap = { ...typeMap };
    for (const v of typeValues) if (!(v in m)) m[v] = guessKind(v);
    return m;
  }, [typeMap, typeValues]);

  const columnMap: TxnColumnMap | null = useMemo(() => {
    if (!col.date || !col.amount) return null;
    if (mode === "debitCredit" && !col.credit) return null;
    if (mode === "typeColumn" && !col.type) return null;
    return {
      date: col.date,
      amount: col.amount,
      credit: col.credit || undefined,
      type: col.type || undefined,
      note: col.note || undefined,
      category: col.category || undefined,
      subcategory: col.subcategory || undefined,
      account: col.account || undefined,
      person: col.person || undefined,
      currency: col.currency || undefined,
    };
  }, [col, mode]);

  // Parse only from the value/review steps — a 10k-row file shouldn't re-parse on every
  // dropdown change while mapping columns.
  const parsed = useMemo(() => {
    if (!table || !columnMap || step === "upload" || step === "map") return null;
    return toCanonicalTxnRows(table, columnMap, {
      mode,
      singleKind,
      expenseIsNegative,
      typeMap: effectiveTypeMap,
      dayFirst,
      // A year mistyped as 2205 instead of 2025 would otherwise import silently and skew
      // every all-time chart. Anything more than a year out is reported in the skipped
      // list, so the typo is visible and fixable instead of buried.
      maxDate: `${Number(todayIso().slice(0, 4)) + 1}${todayIso().slice(4)}`,
    });
  }, [table, columnMap, step, mode, singleKind, expenseIsNegative, effectiveTypeMap, dayFirst]);

  // Distinct account / owner / category values + (category, subcategory) pairs, for mapping.
  const valueSets = useMemo(() => {
    if (!table) return { accounts: [], people: [], categories: [], subPairs: [] };
    return {
      accounts: distinctValues(table, col.account),
      people: distinctValues(table, col.person),
      categories: distinctValues(table, col.category),
      subPairs: distinctSubPairs(table, col.category, col.subcategory),
    };
  }, [table, col.account, col.person, col.category, col.subcategory]);
  const counts = useMemo(() => {
    const tally = (column: string): Record<string, number> => {
      const out: Record<string, number> = {};
      if (!table || !column) return out;
      for (const r of table.rows) {
        const v = (r[column] ?? "").trim();
        if (v) out[v] = (out[v] ?? 0) + 1;
      }
      return out;
    };
    return { accounts: tally(col.account), people: tally(col.person), categories: tally(col.category), types: tally(col.type) };
  }, [table, col.account, col.person, col.category, col.type]);

  // Pre-fill each value with the best existing match — EXACT name first, then fuzzy
  // ("HDFC-BANK Ltd" → "HDFC Bank") — else "create it". Only a suggestion: every row is
  // shown here and can be changed, so a wrong guess costs a click, never data.
  /** Resolve a remembered alias to exactly one record, or nothing.
   *
   *  Never "the first one with that name": duplicate display names are legal here (two "IBKR"
   *  accounts under different owners, a "Misc" subcategory under two parents), and silently
   *  picking one changes which record a repeat import targets — for accounts that changes the
   *  `imptxn:<accountId>` prefix, so the same statement imports again instead of deduping. */
  const resolveAlias = <T extends { id: string; name: string }>(
    alias: { id?: string; name: string; parent?: string } | undefined,
    list: T[],
    parentNameOf?: (rec: T) => string | undefined,
  ): T | undefined => {
    if (!alias) return undefined;
    if (alias.id) {
      const byId = list.find((e) => e.id === alias.id);
      if (byId) return byId; // exact identity — survives renames
    }
    const matches = list.filter(
      (e) =>
        norm(e.name) === norm(alias.name) &&
        (!alias.parent || norm(parentNameOf?.(e) ?? "") === norm(alias.parent)),
    );
    return matches.length === 1 ? matches[0] : undefined; // ambiguous → fall back to matching
  };

  const prefill = <T extends { id: string; name: string }>(
    values: string[],
    list: T[],
    current: ValueMap,
    kind?: "account" | "person" | "category",
  ): ValueMap => {
    const next = { ...current };
    const aliases = state.settings.importAliases ?? {};
    for (const v of values) {
      if (v in next) continue;
      // What you filed this spelling under LAST time beats re-guessing from the file's own text.
      const aliased = kind ? resolveAlias(aliases[aliasKey(kind, v)], list) : undefined;
      const exact = list.find((e) => norm(e.name) === norm(v));
      const match = aliased ?? exact ?? bestNameMatch(v, list, (e) => e.name);
      next[v] = match ? match.id : NEW_ENTITY;
    }
    return next;
  };
  /** Subcategories match within their mapped PARENT first (that's where they'll be
   *  created), then against any subcategory — so "Food › Dinning" finds "Food › Dining". */
  const prefillSubs = (current: ValueMap, parentMap: ValueMap): ValueMap => {
    const next = { ...current };
    const subs = state.categories.filter((c) => c.parentId);
    const aliases = state.settings.importAliases ?? {};
    for (const p of valueSets.subPairs) {
      if (p.key in next) continue;
      const parentNameOf = (c: Category): string | undefined =>
        state.categories.find((x) => x.id === c.parentId)?.name;
      const aliased = resolveAlias(aliases[aliasKey("sub", p.key)], subs, parentNameOf);
      if (aliased) {
        next[p.key] = aliased.id;
        continue;
      }
      const parentId = p.category ? parentMap[p.category] : undefined;
      const parentIsExisting = !!parentId && parentId !== NEW_ENTITY && parentId !== IGNORE_VALUE && parentId !== SKIP_ROWS;
      const exact = (list: Category[]): Category | undefined =>
        list.find((c) => c.name.trim().toLowerCase() === p.subcategory.trim().toLowerCase());
      let match: Category | undefined;
      if (parentIsExisting) {
        // Search ONLY inside the mapped parent: that's where this sub belongs, and a global
        // search would happily suggest a same-named child of an unrelated parent
        // ("Weird Stuff › Misc" → "Food › Misc"), silently merging two different things.
        const inParent = subs.filter((c) => c.parentId === parentId);
        match = exact(inParent) ?? bestNameMatch(p.subcategory, inParent, (c) => c.name);
      } else if (!p.category) {
        // No parent context at all (file has no category column) → any subcategory is fair game.
        match = exact(subs) ?? bestNameMatch(p.subcategory, subs, (c) => c.name);
      }
      // Parent is being created / ignored / skipped → create the sub under it too.
      next[p.key] = match ? match.id : NEW_ENTITY;
    }
    return next;
  };
  const goToValues = (): void => {
    const nextAccounts = prefill(valueSets.accounts, state.accounts, accountMap, "account");
    // With no subcategory column, a category value can legitimately BE one of your
    // subcategories, so match against both levels (top-level first — a value that names a
    // parent should map to the parent, not to one of its children).
    const categoryCandidates = col.subcategory
      ? state.categories.filter((c) => !c.parentId)
      : [...state.categories.filter((c) => !c.parentId), ...state.categories.filter((c) => c.parentId)];
    const nextCategories = prefill(valueSets.categories, categoryCandidates, categoryMap, "category");
    setAccountMap(nextAccounts);
    setPersonMap((m) => prefill(valueSets.people, state.people, m, "person"));
    setCategoryMap(nextCategories);
    setSubcategoryMap((m) => prefillSubs(m, nextCategories));
    const anythingToMap =
      valueSets.accounts.length + valueSets.people.length + valueSets.categories.length + valueSets.subPairs.length > 0;
    setStep(anythingToMap ? "values" : "review");
  };

  const plan = useMemo(() => {
    if (step !== "review" || !parsed) return null;
    return planTransactionImport(parsed.rows, {
      defaultAccountId,
      defaultPersonId,
      // Currency for accounts this import CREATES when neither the row nor the file states
      // one. The DEFAULT ACCOUNT's currency — not the app's display currency — because the
      // file is almost certainly denominated like the account the user picked for it.
      // (Using the display currency wrote ₹ amounts into a USD account: an 83× error.)
      defaultCurrency:
        state.accounts.find((a) => a.id === defaultAccountId)?.currency ?? state.settings.displayCurrency,
      newAccountType,
      accounts: state.accounts,
      people: state.people,
      categories: state.categories,
      transactions: state.transactions,
      accountMap,
      personMap,
      categoryMap,
      subcategoryMap,
      fileCurrency: fileCurrency || undefined,
      reportingOnly,
      parseSkipped: parsed.skipped,
    });
    // Depend on the SLICES the plan reads, not the whole state object: any unrelated emit (the
    // hourly FX cache, an autopay reconcile, an autosave) replaced `state` and re-planned the
    // entire file synchronously, which on a large CSV blocks the UI for no reason.
  }, [
    step, parsed, defaultAccountId, defaultPersonId, newAccountType, accountMap, personMap, categoryMap,
    subcategoryMap, fileCurrency, reportingOnly,
    state.accounts, state.people, state.categories, state.transactions, state.settings.displayCurrency,
  ]);

  const accountOpts = useMemo(
    () => [
      ...[...state.accounts]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a) => ({ value: a.id, label: accountLabel(state, a, { currency: true }) })),
      { value: NEW_ENTITY, label: "➕ Create this account" },
      { value: SKIP_ROWS, label: "🚫 Skip these rows" },
    ],
    [state],
  );
  const personOpts = useMemo(
    // `includeArchived` — the prefill matches against ALL people, so an archived one must be
    // selectable here or the dropdown would silently show "Shared" while assigning them.
    () => [
      ...personOptions(state, true, undefined, true),
      { value: NEW_ENTITY, label: "➕ Create this person" },
      { value: SKIP_ROWS, label: "🚫 Skip these rows" },
    ],
    [state],
  );
  // When the file has NO subcategory column, its single category value may well name one of
  // YOUR subcategories ("Flight Charges" is a sub of Travel), so offer subcategories too —
  // labelled "Parent › Sub" — and let it be stored as the leaf. When the file DOES have a
  // subcategory column the parent must stay top-level, or the sub would need a third level.
  /** Where each subcategory pair will END UP, and whether the category choice matters for it.
   *
   *  The subcategory DRIVES the outcome: mapped to an existing sub, it carries its own parent and
   *  the category pick plays no part. That used to be invisible — you could map the category to
   *  Housing, the sub to Petrol (a child of Utilities), and the row would file under Utilities
   *  with nothing on screen saying your Housing pick had been dropped. */
  const subDestinations = useMemo(() => {
    const byId = new Map(state.categories.map((c) => [c.id, c]));
    const nameOf = (id: string | undefined): string | undefined => (id ? byId.get(id)?.name : undefined);
    /** What the CATEGORY choice resolves to, mirroring the engine exactly. Reading only existing
     *  ids here made the hint contradict the importer in the cases it exists to explain: a
     *  category mapped to Create/Leave-uncategorised/Skip left the name undefined, so the row
     *  claimed "top level" while the engine was creating under the new parent, dropping the
     *  subcategory, or skipping the row entirely. */
    const catTarget = (raw: string | undefined): { kind: "existing" | "create" | "ignore" | "skip" | "none"; name?: string; isSub?: boolean } => {
      if (!raw) return { kind: "none" };
      const choice = categoryMap[raw];
      if (choice === SKIP_ROWS) return { kind: "skip" };
      if (choice === IGNORE_VALUE) return { kind: "ignore" };
      if (isCreate(choice)) return { kind: "create", name: namedFrom(choice) ?? raw };
      const existing = choice ? byId.get(choice) : undefined;
      if (existing) return { kind: "existing", name: existing.name, isSub: !!existing.parentId };
      return { kind: "none" };
    };
    const hints: Record<string, ReactNode> = {};
    const catDriven = new Set<string>();
    const catUsed = new Set<string>();
    for (const p of valueSets.subPairs) {
      const choice = subcategoryMap[p.key];
      const cat = catTarget(p.category || undefined);
      const existing = choice && !isCreate(choice) && choice !== IGNORE_VALUE && choice !== SKIP_ROWS
        ? byId.get(choice)
        : undefined;
      if (cat.kind === "skip") {
        // The category's own choice wins over everything: those rows never reach the engine.
        hints[p.key] = <>these rows aren't imported — the category above is set to skip</>;
        if (p.category) catUsed.add(p.category);
        continue;
      }
      if (existing) {
        const parent = nameOf(existing.parentId);
        const path = parent ? `${parent} › ${existing.name}` : existing.name;
        const overridden = cat.kind === "existing" && !!parent && parent !== cat.name;
        hints[p.key] = overridden ? (
          <>
            files under <b>{path}</b> — this subcategory brings its own category, so the “{cat.name}”
            choice below isn't used for these rows
          </>
        ) : (
          <>
            files under <b>{path}</b>
          </>
        );
        if (p.category) catDriven.add(p.category);
      } else if (choice === SKIP_ROWS) {
        hints[p.key] = <>these rows aren't imported</>;
      } else if (choice === IGNORE_VALUE) {
        hints[p.key] =
          cat.kind === "existing" || cat.kind === "create" ? (
            <>
              files under <b>{cat.name}</b> only
            </>
          ) : (
            <>left uncategorised</>
          );
        if (p.category) catUsed.add(p.category);
      } else {
        // Creating (or falling back to creating) the subcategory: the parent comes from the
        // category choice, so every one of its outcomes has to be spelled out.
        const named = namedFrom(choice) ?? p.subcategory;
        if (cat.kind === "existing" && cat.isSub) {
          hints[p.key] = (
            <>
              files under <b>{cat.name}</b> — that category choice is itself a subcategory, so it stays
              the leaf and “{p.subcategory}” isn't recorded
            </>
          );
        } else if (cat.kind === "existing" || cat.kind === "create") {
          hints[p.key] = (
            <>
              creates <b>{cat.name} › {named}</b>
              {cat.kind === "create" ? " (both new)" : ""}
            </>
          );
        } else if (cat.kind === "ignore") {
          hints[p.key] = (
            <>
              left uncategorised — the category above is set to “leave uncategorised”, so “{named}” isn't
              created either
            </>
          );
        } else {
          hints[p.key] = (
            <>
              creates <b>{named}</b> as a top-level category (nothing is mapped for these rows'
              category)
            </>
          );
        }
        if (p.category) catUsed.add(p.category);
      }
    }
    // A category's pick is unused only when EVERY row under it is decided by its own subcategory —
    // including rows whose subcategory cell is BLANK, which have nothing but the category to go on.
    const withBlankSub = new Set<string>();
    if (table && col.category && col.subcategory) {
      for (const r of table.rows) {
        const c = (r[col.category] ?? "").trim();
        if (c && !(r[col.subcategory] ?? "").trim()) withBlankSub.add(c);
      }
    }
    const unused = new Set(
      [...catDriven].filter((c) => !catUsed.has(c) && !withBlankSub.has(c)),
    );
    return { hints, unused };
  }, [state.categories, valueSets.subPairs, subcategoryMap, categoryMap, table, col.category, col.subcategory]);

  const categoryHints = useMemo(() => {
    const out: Record<string, ReactNode> = {};
    for (const v of valueSets.categories) {
      if (subDestinations.unused.has(v)) {
        out[v] = <>not used — every row with this category has a subcategory that carries its own</>;
      }
    }
    return out;
  }, [valueSets.categories, subDestinations.unused]);

  const categoryOpts = useMemo(() => {
    const hasSubColumn = !!col.subcategory;
    const parentName = (id: string | undefined): string => state.categories.find((c) => c.id === id)?.name ?? "?";
    const tops = [...state.categories]
      .filter((c) => !c.parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name }));
    const subs = hasSubColumn
      ? []
      : [...state.categories]
          .filter((c) => c.parentId)
          .map((c) => ({ value: c.id, label: `${parentName(c.parentId)} › ${c.name}`, sort: `${parentName(c.parentId)} ${c.name}` }))
          .sort((a, b) => a.sort.localeCompare(b.sort))
          .map(({ value, label }) => ({ value, label }));
    return [
      ...tops,
      ...subs,
      { value: NEW_ENTITY, label: "➕ Create this category" },
      { value: IGNORE_VALUE, label: "Leave uncategorised" },
      { value: SKIP_ROWS, label: "🚫 Skip these rows" },
    ];
  }, [state, col.subcategory]);
  /** Existing subcategories, labelled "Parent › Sub" so the same sub name under different
   *  parents is distinguishable, plus create/keep-parent/skip. */
  const subcategoryOpts = useMemo(() => {
    const parentName = (id: string | undefined): string => state.categories.find((c) => c.id === id)?.name ?? "?";
    return [
      ...state.categories
        .filter((c) => c.parentId)
        .map((c) => ({ value: c.id, label: `${parentName(c.parentId)} › ${c.name}`, sort: `${parentName(c.parentId)} ${c.name}` }))
        .sort((a, b) => a.sort.localeCompare(b.sort))
        .map(({ value, label }) => ({ value, label })),
      { value: NEW_ENTITY, label: "➕ Create under its category" },
      { value: IGNORE_VALUE, label: "Use the category only" },
      { value: SKIP_ROWS, label: "🚫 Skip these rows" },
    ];
  }, [state]);
  const subLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of valueSets.subPairs) out[p.key] = p.category ? `${p.category} › ${p.subcategory}` : p.subcategory;
    return out;
  }, [valueSets.subPairs]);
  const subCounts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!table || !col.subcategory) return out;
    for (const r of table.rows) {
      const sub = (r[col.subcategory] ?? "").trim();
      if (!sub) continue;
      const k = subMapKey((col.category ? (r[col.category] ?? "").trim() : "") || undefined, sub);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }, [table, col.subcategory, col.category]);

  const runImport = async (): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await store.applyTransactionImport(plan, { label: fileName });
      // Remember how each of the file's own spellings was filed. Names, not ids, so an alias
      // survives a later merge/rename and just falls back to a suggestion if it stops resolving.
      const aliases: Record<string, { id?: string; name: string; parent?: string }> = {};
      const catById = new Map(state.categories.map((c) => [c.id, c]));
      const remember = (
        kind: "account" | "person" | "category" | "sub",
        raw: string,
        choice: string | undefined,
        fallbackName: string,
        byId: Map<string, string>,
        parent?: string,
      ): void => {
        if (!raw || !choice) return;
        // An existing pick keeps its ID (exact identity); a create can only be remembered by the
        // name it was given, resolved uniquely next time or not at all.
        if (isCreate(choice)) {
          const name = namedFrom(choice) ?? fallbackName;
          if (name && norm(name) !== norm(raw)) aliases[aliasKey(kind, raw)] = { name, parent };
          return;
        }
        const name = byId.get(choice);
        if (name) aliases[aliasKey(kind, raw)] = { id: choice, name, parent };
      };
      const accountNames = new Map(state.accounts.map((a) => [a.id, a.name]));
      const personNames = new Map(state.people.map((p) => [p.id, p.name]));
      const categoryNames = new Map(state.categories.map((c) => [c.id, c.name]));
      for (const raw of valueSets.accounts) remember("account", raw, accountMap[raw], raw, accountNames);
      for (const raw of valueSets.people) remember("person", raw, personMap[raw], raw, personNames);
      for (const raw of valueSets.categories) remember("category", raw, categoryMap[raw], raw, categoryNames);
      for (const p of valueSets.subPairs) {
        const choice = subcategoryMap[p.key];
        // The parent a subcategory alias belongs to: its own parent when an existing sub was
        // chosen, otherwise the category this pair maps to (that's where a create would land).
        const chosen = choice && !isCreate(choice) ? catById.get(choice) : undefined;
        const parentName = chosen
          ? catById.get(chosen.parentId ?? "")?.name
          : catById.get(p.category ? (categoryMap[p.category] ?? "") : "")?.name;
        remember("sub", p.key, choice, p.subcategory, categoryNames, parentName);
      }
      if (Object.keys(aliases).length > 0) await store.saveSettings({ importAliases: aliases });
      setDone({
        transactions: res.transactions,
        accounts: res.accounts,
        categories: res.categories,
        people: res.people,
        dropped: res.dropped,
        batchId: res.batch?.id ?? null,
      });
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    if (!done?.batchId) return;
    setBusy(true);
    try {
      await store.undoImportBatch(done.batchId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const skipped: SkippedImportRow[] = plan?.skippedRows ?? parsed?.skipped ?? [];

  // A created account needs a currency, and NOTHING in the file states one: no currency
  // column, no file currency. Any value we pick would be a silent guess that RE-TAGS every
  // amount (₹94,000 stored as US$94,000 — no conversion happens). So refuse to proceed and
  // make the user state it. This is the one place the import can corrupt money invisibly.
  const currencyUnstated = !col.currency && !fileCurrency;
  const needsFileCurrency = !!plan && plan.newAccounts.length > 0 && currencyUnstated;

  if (state.accounts.length === 0) {
    return (
      <Modal title="No accounts yet" onClose={onClose}>
        <p className="text-sm text-slate-600">
          Add at least one account (Accounts tab) first — imported transactions have to post somewhere.
        </p>
      </Modal>
    );
  }

  return (
    <Modal title="Import transactions from CSV" onClose={onClose} wide>
      <div className="space-y-4">
        {!done && (
          <Stepper
            steps={["Choose file", "Match columns", "Match banks & people", "Review & import"]}
            current={step === "upload" ? 0 : step === "map" ? 1 : step === "values" ? 2 : 3}
          />
        )}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {/* ---------- done ---------- */}
        {done ? (
          <div className="space-y-3">
            {done.transactions === 0 ? (
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                {/* "already imported" is only true when nothing was DROPPED — otherwise this sat
                    directly above the list of rows that couldn't be written, telling the user
                    two different stories about the same import. */}
                {done.dropped.length > 0
                  ? "Nothing was added — none of the rows could be written. See why below."
                  : "Nothing new to import — every row was already imported previously, so nothing was added or changed."}
              </p>
            ) : (
              <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">
                Imported <b>{done.transactions}</b> transaction{done.transactions === 1 ? "" : "s"}
                {done.accounts > 0 ? `, created ${done.accounts} account${done.accounts === 1 ? "" : "s"}` : ""}
                {done.categories > 0 ? `, ${done.categories} categor${done.categories === 1 ? "y" : "ies"}` : ""}
                {done.people > 0 ? `, ${done.people} person/people` : ""}.
                {reportingOnly ? " They count in reports but don't change your balances." : ""}
              </p>
            )}
            {done.dropped.length > 0 && (
              <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                <p className="font-medium">
                  {done.dropped.length} row{done.dropped.length === 1 ? "" : "s"} in the preview couldn't be written —
                  something changed while the import was open:
                </p>
                <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4 text-xs">
                  {done.dropped.slice(0, 20).map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                  {done.dropped.length > 20 && <li>+{done.dropped.length - 20} more…</li>}
                </ul>
              </div>
            )}
            {done.batchId && (
              <p className="text-xs text-slate-500">
                Wrong? Undo it now, or later from Settings → Import history (kept for 30 days).
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
              {done.batchId ? (
                <Button variant="danger" disabled={busy} onClick={() => void undo()}>
                  Undo this import
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <>
            {/* ---------- 1. upload ---------- */}
            {step === "upload" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  Any CSV works — a bank or card statement, or your own spreadsheet. Everything stays on this
                  device. Rows are matched so re-importing the same file won't duplicate anything.
                </p>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => void pick(e.target.files?.[0])}
                  className="block w-full rounded-lg border border-slate-300 p-2 text-sm"
                />
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Default account" hint="Used for rows whose bank isn't in the file.">
                    <Select
                      value={defaultAccountId}
                      onChange={(v) => {
                        setDefaultAccountId(v);
                        const acc = state.accounts.find((a) => a.id === v);
                        if (acc) setDefaultPersonId(acc.personId);
                      }}
                      options={[...state.accounts]
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((a) => ({ value: a.id, label: accountLabel(state, a, { currency: true }) }))}
                    />
                  </Field>
                  <Field label="Default owner" hint="Used for rows with no owner column.">
                    <Select value={defaultPersonId} onChange={(v) => setDefaultPersonId(v)} options={personOptions(state, true, defaultPersonId)} />
                  </Field>
                  <Field label="New accounts are" hint="Type given to banks this import creates.">
                    <Select
                      value={newAccountType}
                      onChange={(v) => setNewAccountType(v as AccountType)}
                      options={NEW_ACCOUNT_TYPES.map((t) => ({ value: t, label: t }))}
                    />
                  </Field>
                  <Field
                    label="Currency of this file"
                    hint="For files with no currency column: it's checked against each row's account (a mismatch is skipped, never converted) and sets the currency of any account this import creates."
                  >
                    <Select
                      value={fileCurrency}
                      onChange={setFileCurrency}
                      options={[
                        { value: "", label: "Each account's own currency" },
                        ...CURRENCY_CHOICES.map((c) => ({ value: c, label: c })),
                      ]}
                    />
                  </Field>
                </div>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-slate-50 p-3">
                  <input
                    type="checkbox"
                    checked={reportingOnly}
                    onChange={(e) => setReportingOnly(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span className="text-sm text-slate-700">
                    Reporting only — don't change account balances
                    <span className="mt-0.5 block text-xs text-slate-500">
                      Recommended for past years: the rows count in your income/expense reports and charts, but leave
                      balances and net worth alone (your current balances already reflect this history). Untick if you're
                      importing from the very beginning and want balances built from these rows.
                    </span>
                  </span>
                </label>
                {/* A forward control matters: coming BACK here from the review (to fix the
                    file currency or the reporting-only choice) must not force re-picking the
                    file, which would discard the column mapping. */}
                {table && (
                  <div className="flex justify-end">
                    <Button onClick={() => setStep("map")}>Next</Button>
                  </div>
                )}
              </div>
            )}

            {/* ---------- 2. columns ---------- */}
            {step === "map" && table && (
              <div className="space-y-3">
                <div className="rounded-lg bg-blue-50 p-3 text-sm text-slate-600">
                  <p className="font-medium text-slate-700">Tell us which column in your file is which.</p>
                  <p className="mt-1 text-xs text-slate-500">
                    We've guessed from the header names — check the required ones (<b>*</b>). Leave anything your
                    file doesn't have as “none”.
                  </p>
                </div>
                <ColumnMapGrid
                  specs={COLUMN_SPECS}
                  headers={table.headers}
                  value={col}
                  onChange={(key, v) => {
                    setCol((c) => ({ ...c, [key]: v }));
                    if (key === "type") setTypeMap({});
                    // Changing which column feeds a mapping invalidates that mapping's keys.
                    // Critically: mapping a category onto one of YOUR SUBcategories is only
                    // offered while the file has NO subcategory column — once one is mapped,
                    // that choice is no longer a valid option, so the dropdown would show a
                    // different category than the one still applied (and the file's own
                    // subcategory value would be silently dropped by the two-level guard).
                    if (key === "category") {
                      setCategoryMap({});
                      setSubcategoryMap({});
                    }
                    if (key === "subcategory") {
                      setSubcategoryMap({});
                      const subIds = new Set(state.categories.filter((c) => c.parentId).map((c) => c.id));
                      setCategoryMap((m) => Object.fromEntries(Object.entries(m).filter(([, id]) => !subIds.has(id))));
                    }
                    if (key === "account") setAccountMap({});
                    if (key === "person") setPersonMap({});
                    if (key === "date" && v && !dayFirstTouched) {
                      const d = detectDayFirst(table.rows.map((r) => r[v] ?? ""));
                      if (d !== null) setDayFirst(d);
                    }
                  }}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="How is money in vs out marked?" hint="Pick what matches your file.">
                    <Select value={mode} onChange={(v) => setMode(v as TxnAmountMode)} options={AMOUNT_MODES} />
                  </Field>
                  {mode === "single" && (
                    <Field label="Every row is" hint="A negative value still flips to the other kind.">
                      <Select
                        value={singleKind}
                        onChange={(v) => setSingleKind(v as ImportedTxnKind)}
                        options={[
                          { value: "expense", label: "An expense" },
                          { value: "income", label: "Income" },
                        ]}
                      />
                    </Field>
                  )}
                  {mode === "sign" && (
                    <Field label="A negative amount means">
                      <Select
                        value={expenseIsNegative ? "expense" : "income"}
                        onChange={(v) => setExpenseIsNegative(v === "expense")}
                        options={[
                          { value: "expense", label: "Money out (expense)" },
                          { value: "income", label: "Money in (income)" },
                        ]}
                      />
                    </Field>
                  )}
                  <Field label="Numeric dates read as" hint="Auto-detected when the file makes it obvious.">
                    <Select
                      value={dayFirst ? "dmy" : "mdy"}
                      onChange={(v) => {
                        setDayFirst(v === "dmy");
                        setDayFirstTouched(true);
                      }}
                      options={[
                        { value: "dmy", label: "DD/MM/YYYY" },
                        { value: "mdy", label: "MM/DD/YYYY" },
                      ]}
                    />
                  </Field>
                </div>
                {mode === "typeColumn" && (
                  <div>
                    <p className="mb-1 text-sm font-medium text-slate-600">What does each type mean?</p>
                    <ValueMapRows
                      values={typeValues}
                      counts={counts.types}
                      options={[
                        { value: "expense", label: "Money out (expense)" },
                        { value: "income", label: "Money in (income)" },
                        { value: "ignore", label: "🚫 Skip these rows" },
                      ]}
                      value={effectiveTypeMap}
                      onChange={(raw, v) => setTypeMap((m) => ({ ...m, [raw]: v as ImportedTxnKind | "ignore" }))}
                      emptyLabel="That column has no values — pick a different column."
                    />
                  </div>
                )}
                {!columnMap && (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    To continue, map <b>Date</b> and <b>Amount</b>
                    {mode === "debitCredit" ? " and the Credit column" : ""}
                    {mode === "typeColumn" ? " and the Type column" : ""}.
                  </p>
                )}
                <div className="flex justify-between">
                  <Button variant="ghost" onClick={() => setStep("upload")}>
                    Back
                  </Button>
                  <Button disabled={!columnMap} onClick={goToValues}>
                    Next
                  </Button>
                </div>
              </div>
            )}

            {/* ---------- 3. value mapping ---------- */}
            {step === "values" && table && (
              <div className="space-y-4">
                <div className="rounded-lg bg-blue-50 p-3 text-sm text-slate-600">
                  <p className="font-medium text-slate-700">Match the names in your file to your records.</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Anything that doesn't exist yet can be created as part of this import — undo removes it again.
                  </p>
                </div>
                {valueSets.accounts.length > 0 && (
                  <div>
                    <p className="mb-1 text-sm font-medium text-slate-600">Banks / accounts</p>
                    <ValueMapRows values={valueSets.accounts} counts={counts.accounts} options={accountOpts} value={accountMap} allowRename onChange={(raw, v) => setAccountMap((m) => ({ ...m, [raw]: v }))} />
                  </div>
                )}
                {valueSets.people.length > 0 && (
                  <div>
                    <p className="mb-1 text-sm font-medium text-slate-600">Owners</p>
                    <ValueMapRows values={valueSets.people} counts={counts.people} options={personOpts} value={personMap} allowRename onChange={(raw, v) => setPersonMap((m) => ({ ...m, [raw]: v }))} />
                  </div>
                )}
                {valueSets.subPairs.length > 0 && (
                  <div>
                    <p className="mb-1 text-sm font-medium text-slate-600">
                      Subcategories <span className="font-normal text-xs text-slate-400">— these decide where a row files</span>
                    </p>
                    <ValueMapRows
                      values={valueSets.subPairs.map((p) => p.key)}
                      labels={subLabels}
                      counts={subCounts}
                      options={subcategoryOpts}
                      value={subcategoryMap}
                      hints={subDestinations.hints}
                      allowRename
                      onChange={(key, v) => setSubcategoryMap((m) => ({ ...m, [key]: v }))}
                    />
                  </div>
                )}
                {valueSets.categories.length > 0 && (
                  <div>
                    <p className="mb-1 text-sm font-medium text-slate-600">
                      Categories{" "}
                      <span className="font-normal text-xs text-slate-400">
                        {valueSets.subPairs.length > 0
                          ? "— the parent for subcategories being created, and the category for rows with no subcategory"
                          : ""}
                      </span>
                    </p>
                    <ValueMapRows
                      values={valueSets.categories}
                      counts={counts.categories}
                      options={categoryOpts}
                      value={categoryMap}
                      hints={categoryHints}
                      allowRename
                      onChange={(raw, v) => {
                        setCategoryMap((m) => ({ ...m, [raw]: v }));
                        // The parent changed → re-suggest its subcategories against the new parent.
                        setSubcategoryMap((m) => {
                          const next = { ...m };
                          for (const p of valueSets.subPairs) if (p.category === raw) delete next[p.key];
                          return prefillSubs(next, { ...categoryMap, [raw]: v });
                        });
                      }}
                    />
                  </div>
                )}
                <div className="flex justify-between">
                  <Button variant="ghost" onClick={() => setStep("map")}>
                    Back
                  </Button>
                  <Button onClick={() => setStep("review")}>Next</Button>
                </div>
              </div>
            )}

            {/* ---------- 4. review ---------- */}
            {step === "review" && plan && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ["To import", plan.totals.imported],
                    ["Expenses", plan.totals.expense],
                    ["Income", plan.totals.income],
                    ["Already imported", plan.totals.duplicates],
                  ].map(([label, n]) => (
                    <div key={String(label)} className="rounded-lg bg-slate-50 p-2 text-center">
                      <div className="text-xs text-slate-400">{label}</div>
                      <div className="font-semibold text-slate-800">{n}</div>
                    </div>
                  ))}
                </div>
                {(plan.newAccounts.length > 0 || plan.newCategories.length > 0 || plan.newPeople.length > 0) && (
                  <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                    <p className="font-medium">This import will also create:</p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {plan.newAccounts.length > 0 && (
                        <li>
                          {plan.newAccounts.length} account{plan.newAccounts.length === 1 ? "" : "s"}:{" "}
                          {/* Owner may be a person THIS import creates, so look it up in
                              state + the plan's new people — otherwise it reads "Unknown". */}
                          {plan.newAccounts
                            .map((a) => {
                              const created = plan.newPeople.find((p) => p.id === a.personId);
                              return `${a.name} (${a.currency}, ${created ? created.name : ownerLabel(state, a.personId)})`;
                            })
                            .join(", ")}
                        </li>
                      )}
                      {plan.newCategories.length > 0 && (
                        <li>
                          {plan.newCategories.length} categor{plan.newCategories.length === 1 ? "y" : "ies"}:{" "}
                          {plan.newCategories.map((c) => c.name).join(", ")}
                        </li>
                      )}
                      {plan.newPeople.length > 0 && <li>{plan.newPeople.length} person/people: {plan.newPeople.map((p) => p.name).join(", ")}</li>}
                    </ul>
                  </div>
                )}
                {needsFileCurrency && (
                  <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
                    <p className="font-medium">Which currency is this file in?</p>
                    <p className="mt-1 text-xs">
                      This import would create {plan.newAccounts.length} new account
                      {plan.newAccounts.length === 1 ? "" : "s"}, and the file doesn't say what currency its amounts
                      are in. Amounts are recorded as-is — never converted — so guessing would silently mis-state
                      them (₹94,000 stored as $94,000). Pick it below, then continue.
                    </p>
                    <div className="mt-2 max-w-[12rem]">
                      <Select
                        value={fileCurrency}
                        onChange={setFileCurrency}
                        options={[
                          { value: "", label: "Select currency…" },
                          ...CURRENCY_CHOICES.map((c) => ({ value: c, label: c })),
                        ]}
                      />
                    </div>
                  </div>
                )}
                {plan.totals.duplicates > 0 && (
                  <p className="text-xs text-slate-500">
                    {plan.totals.duplicates} row{plan.totals.duplicates === 1 ? "" : "s"} already imported previously — they'll be skipped, not duplicated.
                  </p>
                )}
                <SkippedRowsPanel rows={skipped} open={showSkipped} onToggle={() => setShowSkipped((s) => !s)} />
                {plan.transactions.length > 0 && (
                  <div className="rounded-lg border border-slate-200">
                    <p className="border-b border-slate-100 p-2 text-xs text-slate-500">
                      First {Math.min(10, plan.transactions.length)} of {plan.transactions.length}:
                    </p>
                    <ul className="divide-y divide-slate-100 text-xs">
                      {plan.transactions.slice(0, 10).map((t) => {
                        const acc = [...state.accounts, ...plan.newAccounts].find((a) => a.id === t.accountId);
                        const cat = [...state.categories, ...plan.newCategories].find((c) => c.id === t.categoryId);
                        return (
                          <li key={t.id} className="flex items-center justify-between gap-2 p-2">
                            {/* min-w-0 on the FLEX ITEM + a block-level truncate: `truncate` on an
                                inline span sets nowrap but can't clip, so a long UPI narration
                                overran the row and collided with the amount on a phone. */}
                            <span className="flex min-w-0 items-center gap-1">
                              <Badge tone={t.type === "income" ? "green" : "red"}>{t.type}</Badge>
                              <span className="shrink-0 text-slate-400">{t.date}</span>
                              <span className="block min-w-0 truncate text-slate-700">{t.note ?? cat?.name ?? ""}</span>
                            </span>
                            <span className="shrink-0 text-slate-700">
                              {formatMoney(t.amount, t.currency)}
                              <span className="ml-1 text-slate-400">{acc?.name ?? ""}</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                <div className="flex justify-between">
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setStep(
                        valueSets.accounts.length + valueSets.people.length + valueSets.categories.length + valueSets.subPairs.length > 0
                          ? "values"
                          : "map",
                      )
                    }
                  >
                    Back
                  </Button>
                  <Button
                    disabled={busy || plan.totals.imported === 0 || needsFileCurrency}
                    onClick={() => void runImport()}
                  >
                    {busy
                      ? "Importing…"
                      : needsFileCurrency
                        ? "Choose the file's currency first"
                        : `Import ${plan.totals.imported} transaction${plan.totals.imported === 1 ? "" : "s"}`}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
