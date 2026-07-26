// Import historical income/expense transactions from an arbitrary CSV (bank statement,
// credit-card export, a hand-kept spreadsheet). This is the PURE core: it turns mapped
// CSV rows into a reviewable PLAN — it never touches the store (the store applies the
// plan atomically; see applyTransactionImport).
//
// Sibling of import/holdings.ts, sharing all parsing primitives via import/common.ts.
//
// Design goals (data loss / corruption are the enemy):
//  - IDEMPOTENT re-import: every imported transaction gets a DETERMINISTIC id derived
//    from its account + content, so re-importing the same file (or an overlapping date
//    range) adds nothing new instead of double-counting.
//  - NOTHING SILENTLY DROPPED: a row that can't be imported lands in `skippedRows` with
//    a reason and its raw cells, shown in the review step.
//  - MAPPING, not assumptions: every file names its columns, banks, owners and
//    categories differently, so the caller supplies explicit column + value mappings.
//    Unmapped banks/categories can be CREATED as part of the import (and are removed
//    again by undo).
//  - CURRENCY IS THE ACCOUNT'S: a transaction posts in its account's currency (the
//    app-wide invariant — balances debit the amount directly). A file currency that
//    disagrees with the resolved account skips the row rather than mis-posting it.

import type { CsvTable } from "../../../../lib/util/csv";
import type { CurrencyCode } from "../../../../lib/money/currency";
import { newId } from "../../../../lib/util/id";
import type { Account, AccountType, Category, Owner, Person, Transaction } from "../../model/types";
import { SHARED } from "../../model/types";
import {
  IGNORE_VALUE,
  NEW_ENTITY,
  norm,
  parseImportDate,
  parseImportNumber,
  SKIP_ROWS,
  type SkippedImportRow,
} from "./common";

export { IGNORE_VALUE, NEW_ENTITY, SKIP_ROWS };

/** The transaction kinds an import can produce. Transfers are deliberately excluded:
 *  they need a second (destination) account and a paired amount, which a single
 *  statement row can't express unambiguously — map those values to "ignore" and enter
 *  the few transfers by hand. */
export type ImportedTxnKind = "expense" | "income";

// --- Column & value mapping ------------------------------------------------

export interface TxnColumnMap {
  /** Required: the date column. */
  date: string;
  /** Required: the amount column (the DEBIT column in `debitCredit` mode). */
  amount: string;
  /** `debitCredit` mode: the money-IN column. */
  credit?: string;
  /** `typeColumn` mode: the column whose values are mapped by `typeMap`. */
  type?: string;
  /** Optional descriptive columns. */
  note?: string;
  category?: string;
  subcategory?: string;
  /** Optional per-row entity columns; when absent the import's defaults apply. */
  person?: string;
  account?: string;
  /** Optional currency column — only used to VALIDATE against the account (and to set a
   *  newly-created account's currency), never to override it. */
  currency?: string;
}

/** How to read each row's direction (expense vs income) and magnitude:
 *  - `single`: one unsigned amount column; every row is `singleKind` (a plain expense
 *    sheet). A sign, if present, is respected as an inversion.
 *  - `sign`: one signed amount column; the sign decides (see `expenseIsNegative`).
 *  - `debitCredit`: two columns — `amount` is money out, `credit` money in.
 *  - `typeColumn`: magnitude in `amount`, direction from the mapped `type` column. */
export type TxnAmountMode = "single" | "sign" | "debitCredit" | "typeColumn";

/** Raw value of the type column → the kind it means (or "ignore" to skip those rows,
 *  e.g. a statement's TRANSFER / REVERSAL rows). */
export type TxnTypeMap = Record<string, ImportedTxnKind | "ignore">;

export interface TxnParseOptions {
  mode: TxnAmountMode;
  /** `single` mode: the kind every row gets. */
  singleKind?: ImportedTxnKind;
  /** `sign` mode: is a NEGATIVE amount an expense? (Bank statements: usually yes.
   *  Some card exports list charges as positive — then set this false.) */
  expenseIsNegative?: boolean;
  /** `typeColumn` mode: the value → kind mapping. */
  typeMap?: TxnTypeMap;
  /** Numeric dd/mm vs mm/dd disambiguation (see detectDayFirst). */
  dayFirst: boolean;
  /** Latest plausible date (ISO). A row dated after this is REPORTED as a skip rather than
   *  imported, because it's almost always a typo in the source ("2205" for "2025") — and a
   *  transaction 180 years out silently skews every all-time chart. Omit to accept any date. */
  maxDate?: string;
}

// --- Canonical row ---------------------------------------------------------

/** A source-agnostic transaction row: direction + positive magnitude + the RAW text of
 *  every entity column, still unresolved (mapping to ids happens in the plan). */
export interface TxnCanonicalRow {
  /** 1-based index of the source DATA row, for "row 42" messages. */
  row: number;
  /** ISO yyyy-mm-dd. */
  date: string;
  kind: ImportedTxnKind;
  /** Always positive — direction lives in `kind`. */
  amount: number;
  note?: string;
  categoryRaw?: string;
  subcategoryRaw?: string;
  personRaw?: string;
  accountRaw?: string;
  currencyRaw?: string;
}

const cell = (rec: Record<string, string>, col: string | undefined): string =>
  col ? (rec[col] ?? "").trim() : "";

/** Distinct non-empty values of a column, in first-seen order — drives the value-mapping
 *  dropdowns (which bank/owner/category is which) without scanning the file twice. */
export function distinctValues(table: CsvTable, column: string | undefined): string[] {
  if (!column) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rec of table.rows) {
    const v = cell(rec, column);
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Distinct (category, subcategory) pairs in the file, first-seen order — the unit the
 *  subcategory mapping works in, since one sub name can sit under several parents. */
export function distinctSubPairs(
  table: CsvTable,
  categoryColumn: string | undefined,
  subColumn: string | undefined,
): Array<{ category: string; subcategory: string; key: string }> {
  if (!subColumn) return [];
  const seen = new Set<string>();
  const out: Array<{ category: string; subcategory: string; key: string }> = [];
  for (const rec of table.rows) {
    const subcategory = cell(rec, subColumn);
    if (subcategory === "") continue;
    const category = cell(rec, categoryColumn);
    const key = subMapKey(category || undefined, subcategory);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ category, subcategory, key });
  }
  return out;
}

/** Turn a parsed CSV into canonical rows using the column mapping + amount rules.
 *  Every unusable row is reported in `skipped` WITH a reason — never dropped. */
export function toCanonicalTxnRows(
  table: CsvTable,
  map: TxnColumnMap,
  opts: TxnParseOptions,
): { rows: TxnCanonicalRow[]; skipped: SkippedImportRow[] } {
  const rows: TxnCanonicalRow[] = [];
  const skipped: SkippedImportRow[] = [];

  table.rows.forEach((rec, i) => {
    const row = i + 1;
    const rawDate = cell(rec, map.date);
    const rawAmount = cell(rec, map.amount);
    const rawCredit = cell(rec, map.credit);
    const rawType = cell(rec, map.type);
    const cells: Record<string, string> = { date: rawDate, amount: rawAmount };
    if (map.credit) cells.credit = rawCredit;
    if (map.type) cells.type = rawType;
    const note = cell(rec, map.note);
    if (note) cells.note = note;
    const skip = (reason: string): void => void skipped.push({ row, reason, cells });

    // A fully-blank row (e.g. a spacer) is not an error. Every MAPPED column must be
    // empty — a footer that only fills, say, the category column is still reported.
    const anyMapped = [map.date, map.amount, map.credit, map.type, map.note, map.category, map.subcategory, map.account, map.person, map.currency]
      .some((c) => cell(rec, c) !== "");
    if (!anyMapped) return;

    const date = parseImportDate(rawDate, opts.dayFirst);
    if (!date) {
      skip(rawDate === "" ? "No date" : `Unrecognised date "${rawDate}"`);
      return;
    }
    if (opts.maxDate && date > opts.maxDate) {
      skip(`Date "${rawDate}" is far in the future (${date}) — looks like a typo, so it wasn't imported`);
      return;
    }

    // Direction + magnitude, per mode.
    let kind: ImportedTxnKind;
    let magnitude: number;
    if (opts.mode === "debitCredit") {
      const debit = rawAmount === "" ? null : parseImportNumber(rawAmount);
      const credit = rawCredit === "" ? null : parseImportNumber(rawCredit);
      if (rawAmount !== "" && debit === null) {
        skip(`Couldn't read the amount "${rawAmount}"`);
        return;
      }
      if (rawCredit !== "" && credit === null) {
        skip(`Couldn't read the credit "${rawCredit}"`);
        return;
      }
      const d = debit ?? 0;
      const c = credit ?? 0;
      if (d === 0 && c === 0) {
        skip("No amount in either the debit or credit column");
        return;
      }
      // Both filled (some exports put 0.00 in the unused one) → a true both-nonzero row is
      // ambiguous, so skip it rather than guess which leg is real.
      if (d !== 0 && c !== 0) {
        skip(`Both debit (${rawAmount}) and credit (${rawCredit}) are filled — split it by hand`);
        return;
      }
      // The SIGN still matters: a negative debit is a reversal (money back IN), and a
      // negative credit is money OUT. Taking |value| would book a refund as a charge.
      const signed = d !== 0 ? d : -c; // >0 = money out, <0 = money in
      kind = signed > 0 ? "expense" : "income";
      magnitude = Math.abs(signed);
    } else {
      const n = parseImportNumber(rawAmount);
      if (n === null) {
        skip(rawAmount === "" ? "No amount" : `Couldn't read the amount "${rawAmount}"`);
        return;
      }
      if (n === 0) {
        skip("Amount is zero");
        return;
      }
      magnitude = Math.abs(n);
      if (opts.mode === "typeColumn") {
        const mapped = opts.typeMap?.[rawType];
        if (!mapped) {
          skip(rawType === "" ? "No transaction type" : `Unmapped type "${rawType}"`);
          return;
        }
        if (mapped === "ignore") {
          skip(`Type "${rawType}" is set to ignore`);
          return;
        }
        kind = mapped;
      } else if (opts.mode === "sign") {
        const negIsExpense = opts.expenseIsNegative !== false;
        const isNegative = n < 0;
        kind = isNegative === negIsExpense ? "expense" : "income";
      } else {
        // `single`: every row is one kind; a negative value still inverts it (a refund
        // line in an expense sheet), which is strictly more faithful than dropping it.
        const base = opts.singleKind ?? "expense";
        const other: ImportedTxnKind = base === "expense" ? "income" : "expense";
        kind = n < 0 ? other : base;
      }
    }

    rows.push({
      row,
      date,
      kind,
      amount: magnitude,
      note: note || undefined,
      categoryRaw: cell(rec, map.category) || undefined,
      subcategoryRaw: cell(rec, map.subcategory) || undefined,
      personRaw: cell(rec, map.person) || undefined,
      accountRaw: cell(rec, map.account) || undefined,
      currencyRaw: cell(rec, map.currency) || undefined,
    });
  });

  return { rows, skipped };
}

// --- Planning --------------------------------------------------------------

/** raw CSV value → target id, or a sentinel (NEW_ENTITY / IGNORE_VALUE). */
export type ValueMap = Record<string, string>;

export interface TxnImportContext {
  /** Fallback account when there's no account column (or a value maps to ""). */
  defaultAccountId: string;
  /** Fallback owner for rows with no person column. */
  defaultPersonId: Owner;
  /** Currency for accounts this import CREATES, when the file doesn't say. */
  defaultCurrency: CurrencyCode;
  /** Type for accounts this import CREATES. */
  newAccountType: AccountType;
  /** Live entities to match against / merge into. */
  accounts: Account[];
  people: Person[];
  categories: Category[];
  transactions: Transaction[];
  /** Value mappings from the review UI (keys are the RAW cell values). */
  accountMap?: ValueMap;
  personMap?: ValueMap;
  categoryMap?: ValueMap;
  /** Subcategory mapping, keyed by `subMapKey(categoryRaw, subcategoryRaw)` — the same
   *  sub name can appear under different parents ("Misc" under Food and under Travel), so
   *  the PAIR is the unit of mapping. */
  subcategoryMap?: ValueMap;
  /** Currency of the WHOLE file, when it has no currency column. Treated exactly like a
   *  per-row currency: validated against the row's account, and used for accounts this
   *  import creates. */
  fileCurrency?: CurrencyCode;
  /** Mark every imported transaction "reporting only" (`excludeFromBalance`): it counts in
   *  income/expense reports but does NOT move account balances or net worth. This is the
   *  right default for back-filling history that your CURRENT balances already reflect —
   *  otherwise importing years of rent would re-deduct it all from today's net worth. */
  reportingOnly?: boolean;
  /** Skips from the PARSE stage (toCanonicalTxnRows), carried through so the plan's
   *  `skippedRows` / `totals.skipped` describe the whole file, not just this stage. */
  parseSkipped?: SkippedImportRow[];
}

export interface TxnImportPlan {
  /** Entities the import will CREATE (undo removes them). */
  newAccounts: Account[];
  newPeople: Person[];
  newCategories: Category[];
  /** Transactions to insert, with deterministic ids. */
  transactions: Transaction[];
  /** Rows whose transaction id already exists (a previous import of the same file). */
  duplicates: number;
  /** Rows that could not be imported, each with a reason. */
  skippedRows: SkippedImportRow[];
  totals: {
    rows: number;
    imported: number;
    duplicates: number;
    skipped: number;
    expense: number;
    income: number;
    newAccounts: number;
    newCategories: number;
    newPeople: number;
  };
}

/** Prefix marking a transaction as owned by an import of `accountId`. Keyed on the
 *  ACCOUNT (not the file) so re-importing the same statement dedups even if the file is
 *  renamed, and so a row's id is stable as long as it lands in the same account. */
export function importTxnIdPrefix(accountId: string): string {
  return `imptxn:${accountId}:`;
}
export function isImportedTransaction(t: Pick<Transaction, "id">): boolean {
  return t.id.startsWith("imptxn:");
}
/** Mapping key for a (category, subcategory) pair from the file. JSON-encoded so the two
 *  parts can never run together ambiguously — ("Food Out","Dining") and ("Food","Out
 *  Dining") stay distinct keys — while remaining printable and greppable (a raw NUL made
 *  tools treat this source file as binary). */
export function subMapKey(categoryRaw: string | undefined, subcategoryRaw: string): string {
  return JSON.stringify([categoryRaw ?? "", subcategoryRaw]);
}

/** Content key for a row: everything in the FILE that tells two statement lines apart.
 *  Deliberately derived ONLY from the file's own text — never from resolved ids — so
 *  re-importing the same file dedups even if the user has since remapped a category or
 *  renamed one. Embedded verbatim (not hashed) so two distinct rows can NEVER collide
 *  into one id (a hash collision would silently drop a real transaction as a duplicate);
 *  the key is never decomposed (only compared), so a `|` inside a note or category is
 *  harmless; two rows only share a key if EVERY listed field matches, and the per-account
 *  counter then separates them. */
function rowContentKey(r: TxnCanonicalRow): string {
  const clean = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const parts = [r.date, r.kind, r.amount, clean(r.categoryRaw), clean(r.subcategoryRaw), clean(r.note)];
  // The OWNER, appended only when the file states one. Two rows in a joint account that share
  // every other field were separated by the positional counter alone, so a partial or reordered
  // re-import could match one owner's row against the other's — skipping one as "already
  // imported" while importing the other again. Appending it only when present keeps the key (and
  // so every id) unchanged for files with no owner column, which must keep deduping against rows
  // imported before this change.
  const owner = clean(r.personRaw);
  if (owner) parts.push(owner);
  return parts.join("|");
}


/**
 * Resolve a raw value through its mapping to a concrete target:
 *  - an explicit id from the mapping (the user's choice in the review step)
 *  - NEW_ENTITY   → create one named after the raw value
 *  - IGNORE_VALUE → attach nothing (for a category: import uncategorised)
 *  - SKIP_ROWS    → don't import rows carrying this value at all
 *  - no mapping   → the caller falls back to an EXACT name match (never fuzzy: see matchByName)
 */
type Resolution =
  | { kind: "id"; id: string }
  | { kind: "new" }
  | { kind: "ignore" }
  | { kind: "skip" }
  | { kind: "fallback" };
function resolve(raw: string | undefined, map: ValueMap | undefined, key = raw): Resolution {
  if (!raw) return { kind: "fallback" };
  const choice = key === undefined ? undefined : map?.[key];
  if (choice === SKIP_ROWS) return { kind: "skip" };
  if (choice === IGNORE_VALUE) return { kind: "ignore" };
  if (choice === NEW_ENTITY) return { kind: "new" };
  if (choice) return { kind: "id", id: choice };
  return { kind: "fallback" };
}

/**
 * Build the import plan: resolve every row's account / owner / category (creating the
 * entities the user asked to create), give each transaction a deterministic id, and
 * report duplicates + skips. Pure — the caller applies it atomically.
 */
export function planTransactionImport(rows: TxnCanonicalRow[], ctx: TxnImportContext): TxnImportPlan {
  const newAccounts: Account[] = [];
  const newPeople: Person[] = [];
  const newCategories: Category[] = [];
  const transactions: Transaction[] = [];
  const skippedRows: SkippedImportRow[] = [...(ctx.parseSkipped ?? [])];
  let duplicates = 0;

  // Live sets, extended as the plan creates entities — so two rows naming the same new
  // bank share ONE created account instead of making a duplicate per row.
  const accounts = [...ctx.accounts];
  const people = [...ctx.people];
  const categories = [...ctx.categories];
  const existingTxnIds = new Set(ctx.transactions.map((t) => t.id));
  // Per-account counter over identical content keys: disambiguates genuinely identical
  // rows within one file (two ₹200 coffees on the same day) while keeping re-import
  // idempotent (the same file yields the same counters in the same order).
  const counters = new Map<string, Map<string, number>>();
  const usedIds = new Set<string>();

  const skip = (r: TxnCanonicalRow, reason: string): void => {
    skippedRows.push({
      row: r.row,
      reason,
      cells: { date: r.date, amount: String(r.amount), type: r.kind, note: r.note ?? "" },
    });
  };

  // Indexes over the working entity lists, kept up to date as rows create new ones. Without
  // them every row re-scanned (and re-ALLOCATED, via `categories.filter(...)`) each list — the
  // planner was O(rows × entities) on files with thousands of rows.
  // FIRST-wins, deliberately built with loops rather than `new Map(entries)`: the linear
  // `find()` these replaced returned the FIRST match in list order, while a Map constructor
  // keeps the LAST value for a repeated key. Names are not unique in this app — two family
  // accounts can both be "HDFC", two devices can each create "Food" — so last-wins silently
  // resolved rows to a DIFFERENT record. That changes the deterministic import id (it embeds the
  // account id), which breaks duplicate detection: re-importing the same file added every row
  // again and doubled the ledger.
  /** Exact-name index key, scoped by parent — the same (parent, name) grouping the engine's reuse
   *  rule has always used. */
  const catKey = (name: string, parentId: string | undefined): string => `${parentId ?? ""}\u0000${norm(name)}`;
  const firstWins = <T,>(items: readonly T[], key: (item: T) => string): Map<string, T> => {
    const map = new Map<string, T>();
    for (const item of items) {
      const k = key(item);
      if (!map.has(k)) map.set(k, item);
    }
    return map;
  };
  // Reuse is EXACT (normalised) name only, never fuzzy — deliberately. Fuzzy matching belongs in
  // the UI mapping step, where the user SEES and can change every suggestion; down here it once
  // filed an "Axis Bank" statement into an existing "Axis Card" and made an explicit "create this
  // account" choice a no-op.
  const accountsById = firstWins(accounts, (a) => a.id);
  const accountsByName = firstWins(accounts, (a) => norm(a.name));
  /** Identity for REUSE when the user asked to CREATE: an account is "the same" only if its name,
   *  currency AND owner match what we would create. Reusing on the name alone turned an explicit
   *  "Create this account" into a no-op, so in a portfolio that keeps same-named accounts apart by
   *  owner or currency the row was either dropped by the currency guard or filed into someone
   *  else's account. Matching on the full triple still keeps a RE-import idempotent: the account
   *  the first import created matches it exactly. */
  const acctTriple = (name: string, currency: string, personId: string): string =>
    `${norm(name)}\u0000${currency}\u0000${personId}`;
  const accountsByTriple = firstWins(accounts, (a) => acctTriple(a.name, a.currency, a.personId));
  const peopleById = firstWins(people, (p) => p.id);
  const peopleByName = firstWins(people, (p) => norm(p.name));
  const categoriesById = firstWins(categories, (c) => c.id);
  const categoriesByKey = firstWins(categories, (c) => catKey(c.name, c.parentId));
  const addAccount = (a: Account): void => {
    accounts.push(a);
    accountsById.set(a.id, a);
    if (!accountsByName.has(norm(a.name))) accountsByName.set(norm(a.name), a);
    const triple = acctTriple(a.name, a.currency, a.personId);
    if (!accountsByTriple.has(triple)) accountsByTriple.set(triple, a);
  };
  const addPerson = (p: Person): void => {
    people.push(p);
    peopleById.set(p.id, p);
    if (!peopleByName.has(norm(p.name))) peopleByName.set(norm(p.name), p);
  };
  const addCategory = (c: Category): void => {
    categories.push(c);
    categoriesById.set(c.id, c);
    if (!categoriesByKey.has(catKey(c.name, c.parentId))) categoriesByKey.set(catKey(c.name, c.parentId), c);
  };

  for (const r of rows) {
    // --- owner (resolved FIRST: a created account is owned by whoever its rows name) ---
    const perRes = resolve(r.personRaw, ctx.personMap);
    let personId: Owner;
    if (perRes.kind === "skip") {
      skip(r, `Owner "${r.personRaw}" is set to skip`);
      continue;
    } else if (perRes.kind === "ignore") {
      personId = SHARED; // "no particular owner" → shared, don't drop the row
    } else if (perRes.kind === "id") {
      personId = perRes.id === SHARED || peopleById.has(perRes.id) ? perRes.id : ctx.defaultPersonId;
    } else if (perRes.kind === "new" && r.personRaw) {
      const existing = peopleByName.get(norm(r.personRaw));
      if (existing) {
        personId = existing.id;
      } else {
        const person: Person = { id: newId(), name: r.personRaw.trim() };
        addPerson(person);
        newPeople.push(person);
        personId = person.id;
      }
    } else {
      // No mapping: exact name match, else the import's default owner (which
      // the wizard defaults to SHARED when the file has no owner column at all).
      personId = (r.personRaw ? peopleByName.get(norm(r.personRaw))?.id : undefined) ?? ctx.defaultPersonId;
    }

    // --- account (the row must land somewhere: no account, no transaction) ---
    const accRes = resolve(r.accountRaw, ctx.accountMap);
    if (accRes.kind === "skip" || accRes.kind === "ignore") {
      // Both mappings drop the row here (a transaction must land in an account), but they are
      // different user choices and the reason list has to name the one actually made — otherwise
      // "set to skip" appears for a bank the user asked to IGNORE and the list can't be acted on.
      skip(
        r,
        accRes.kind === "skip"
          ? `Account "${r.accountRaw}" is set to skip`
          : `Account "${r.accountRaw}" is set to ignore, but a transaction needs an account`,
      );
      continue;
    }
    // Currency the row itself claims: its own cell, else the whole file's currency.
    const rowCcy = validCurrency(r.currencyRaw) ?? ctx.fileCurrency;
    let account: Account | undefined;
    if (accRes.kind === "id") {
      account = accountsById.get(accRes.id);
      if (!account) {
        skip(r, "The mapped account no longer exists");
        continue;
      }
    } else if (accRes.kind === "new" && r.accountRaw) {
      // The user asked to CREATE this one. Reuse only an account that IS what we would create —
      // same name, currency and owner — which keeps a repeated bank name (and a whole re-import)
      // from yielding duplicates, while a same-named account belonging to someone else, or held in
      // another currency, no longer swallows the choice.
      const wantCurrency = rowCcy ?? ctx.defaultCurrency;
      account = accountsByTriple.get(acctTriple(r.accountRaw, wantCurrency, personId));
      if (!account) {
        account = {
          id: newId(),
          name: r.accountRaw.trim(),
          type: ctx.newAccountType,
          currency: wantCurrency,
          personId, // the owner THIS row names — not a blanket default
        };
        addAccount(account);
        newAccounts.push(account);
      }
    } else if (r.accountRaw) {
      // The file names a bank but nothing maps it: exact name match, else skip —
      // silently dumping it in the default account would misfile money invisibly.
      account = accountsByName.get(norm(r.accountRaw));
      if (!account) {
        skip(r, `No account matches "${r.accountRaw}" — map it on the previous step`);
        continue;
      }
    } else {
      account = accountsById.get(ctx.defaultAccountId);
      if (!account) {
        skip(r, "No account for this row");
        continue;
      }
    }

    // --- currency guard: a transaction posts in its ACCOUNT's currency ---
    if (rowCcy && rowCcy !== account.currency) {
      skip(r, `Row is in ${rowCcy} but "${account.name}" is ${account.currency} — import it into a ${rowCcy} account`);
      continue;
    }

    // --- category (+ subcategory) — optional: an unresolved one just stays uncategorised ---
    let categoryId: string | undefined;
    // Distinguishes "the user chose to leave these uncategorised" from "there was no category to
    // resolve". Both leave `categoryId` undefined, and the subcategory fallback below used to
    // treat them alike — so an explicit "ignore" still created a top-level category from the sub,
    // contradicting the choice and inventing categories the user didn't ask for.
    let categoryIgnored = false;
    const catRes = resolve(r.categoryRaw, ctx.categoryMap);
    if (catRes.kind === "skip") {
      skip(r, `Category "${r.categoryRaw}" is set to skip`);
      continue;
    } else if (catRes.kind === "ignore") {
      categoryId = undefined; // "don't categorise these", NOT "drop the row"
      categoryIgnored = true;
    } else if (catRes.kind === "id") {
      categoryId = categoriesById.has(catRes.id) ? catRes.id : undefined;
    } else if (catRes.kind === "new" && r.categoryRaw) {
      categoryId = ensureCategory(r.categoryRaw, undefined);
    } else if (r.categoryRaw) {
      // No explicit mapping: reuse a matching top-level category, else create it.
      const match = categoriesByKey.get(catKey(r.categoryRaw, undefined));
      categoryId = match ? match.id : ensureCategory(r.categoryRaw, undefined);
    }
    // A subcategory becomes the stored LEAF. It's mapped per (category, subcategory) pair
    // because the same sub name can live under several parents.
    if (r.subcategoryRaw) {
      const subRes = resolve(r.subcategoryRaw, ctx.subcategoryMap, subMapKey(r.categoryRaw, r.subcategoryRaw));
      if (subRes.kind === "skip") {
        skip(r, `Subcategory "${r.subcategoryRaw}" is set to skip`);
        continue;
      } else if (subRes.kind === "id") {
        // An explicit target wins outright (it carries its own parent).
        if (categoriesById.has(subRes.id)) categoryId = subRes.id;
      } else if (subRes.kind === "ignore") {
        // Keep the parent category only — the sub is deliberately not recorded.
      } else if (categoryId && categoriesById.get(categoryId)?.parentId) {
        // The resolved "category" is itself a SUBcategory (the file's category value was
        // mapped onto one). Only two levels exist, so keep that sub as the leaf rather than
        // trying to nest a third level under it.
      } else if (categoryId) {
        // Create/reuse under the resolved parent (exact name within that parent).
        const match = categoriesByKey.get(catKey(r.subcategoryRaw, categoryId));
        categoryId = match ? match.id : ensureCategory(r.subcategoryRaw, categoryId);
      } else if (!categoryIgnored) {
        // No category context at all (no column, or an unresolvable value) → keep the sub as a
        // top-level category rather than losing it. NOT done when the user explicitly mapped the
        // category to "leave uncategorised": there, uncategorised is the requested outcome.
        const match = categoriesByKey.get(catKey(r.subcategoryRaw, undefined));
        categoryId = match ? match.id : ensureCategory(r.subcategoryRaw, undefined);
      }
    }

    // --- deterministic id + duplicate detection ---
    const prefix = importTxnIdPrefix(account.id);
    const key = rowContentKey(r);
    let perAccount = counters.get(account.id);
    if (!perAccount) {
      perAccount = new Map<string, number>();
      counters.set(account.id, perAccount);
    }
    const n = perAccount.get(key) ?? 0;
    perAccount.set(key, n + 1);
    const id = `${prefix}${key}#${n}`;
    if (existingTxnIds.has(id) || usedIds.has(id)) {
      duplicates++;
      continue;
    }
    usedIds.add(id);

    transactions.push({
      id,
      date: r.date,
      type: r.kind,
      accountId: account.id,
      personId,
      amount: r.amount,
      currency: account.currency, // ALWAYS the account's — never the file's
      categoryId,
      note: r.note,
      // Reporting-only: counts in income/expense reports but doesn't move balances or net
      // worth — the right shape for history your current balances already include.
      excludeFromBalance: ctx.reportingOnly ? true : undefined,
      updatedAt: "", // stamped by the store on write
    });
  }

  return {
    newAccounts,
    newPeople,
    newCategories,
    transactions,
    duplicates,
    skippedRows,
    totals: {
      rows: rows.length,
      imported: transactions.length,
      duplicates,
      skipped: skippedRows.length,
      expense: transactions.filter((t) => t.type === "expense").length,
      income: transactions.filter((t) => t.type === "income").length,
      newAccounts: newAccounts.length,
      newCategories: newCategories.length,
      newPeople: newPeople.length,
    },
  };

  /** Create (or reuse) a category by name under an optional parent. Reuse is EXACT-name
   *  only here — the fuzzy step happens in the caller, which knows whether it's looking at
   *  top-level categories or one parent's children. */
  function ensureCategory(rawName: string, parentId: string | undefined): string {
    const name = rawName.trim();
    const existing = categoriesByKey.get(catKey(name, parentId));
    if (existing) return existing.id;
    const created: Category = { id: newId(), name, parentId };
    addCategory(created);
    newCategories.push(created);
    return created.id;
  }
}

/** ISO-4217-shaped code, uppercased — anything else is treated as "not stated" so a
 *  junk currency cell can't silently retag money. */
function validCurrency(raw: string | undefined): CurrencyCode | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : undefined;
}
