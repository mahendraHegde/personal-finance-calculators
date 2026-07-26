// Tests for the expense/income CSV importer: parsing every amount convention, the
// mapping of banks / owners / categories (incl. creating missing ones), deterministic
// ids (idempotent re-import), and the atomic apply + undo through the store.

import { parseCsvTable } from "../src/lib/util/csv";
import { bestNameMatch, nameSimilarity } from "../src/features/portfolio/domain/import/common";
import {
  distinctSubPairs,
  distinctValues,
  IGNORE_VALUE,
  importTxnIdPrefix,
  isImportedTransaction,
  NEW_ENTITY,
  newNamed,
  planTransactionImport,
  SKIP_ROWS,
  subMapKey,
  toCanonicalTxnRows,
  type TxnAmountMode,
  type TxnColumnMap,
  type TxnImportContext,
} from "../src/features/portfolio/domain/import/transactions";
import { createMemoryStorage } from "../src/lib/storage/memory-adapter";
import { SCHEMA } from "../src/features/portfolio/model/schema";
import { createPortfolioStore } from "../src/features/portfolio/state/store";
import type { Account, Category, Person, Transaction } from "../src/features/portfolio/model/types";
import { done, eq, ok, section } from "./_harness";

const table = (csv: string) => parseCsvTable(csv);
const MAP: TxnColumnMap = { date: "Date", amount: "Amount" };
const parse = (csv: string, map: Partial<TxnColumnMap> = {}, mode: TxnAmountMode = "single", extra = {}) =>
  toCanonicalTxnRows(table(csv), { ...MAP, ...map }, { mode, dayFirst: true, ...extra });

const bank = (id: string, name: string, currency = "INR", personId = "p1"): Account => ({
  id, name, type: "bank", currency, personId,
});
const person = (id: string, name: string): Person => ({ id, name });
const ctx = (over: Partial<TxnImportContext> = {}): TxnImportContext => ({
  defaultAccountId: "A1",
  defaultPersonId: "p1",
  defaultCurrency: "INR",
  newAccountType: "bank",
  accounts: [bank("A1", "HDFC")],
  people: [person("p1", "Ravi")],
  categories: [],
  transactions: [],
  ...over,
});

// ---------------------------------------------------------------------------
section("[import-txn] `single` mode: every row one kind; a negative flips it");
{
  const r = parse("Date,Amount\n2026-01-05,250\n2026-01-06,-100\n", {}, "single", { singleKind: "expense" });
  eq(r.rows.length, 2, "both rows parsed");
  eq(r.rows[0]!.kind, "expense", "positive → the chosen kind");
  eq(r.rows[0]!.amount, 250, "magnitude kept");
  eq(r.rows[1]!.kind, "income", "negative flips to the other kind (a refund line)");
  eq(r.rows[1]!.amount, 100, "magnitude is always positive");
}

section("[import-txn] `sign` mode: the sign decides, either way round");
{
  const neg = parse("Date,Amount\n2026-01-05,-250\n2026-01-06,900\n", {}, "sign", { expenseIsNegative: true });
  eq(neg.rows[0]!.kind, "expense", "negative = expense (bank statement default)");
  eq(neg.rows[1]!.kind, "income", "positive = income");
  const pos = parse("Date,Amount\n2026-01-05,-250\n2026-01-06,900\n", {}, "sign", { expenseIsNegative: false });
  eq(pos.rows[0]!.kind, "income", "inverted: negative = income");
  eq(pos.rows[1]!.kind, "expense", "inverted: positive = expense (card export)");
}

section("[import-txn] `debitCredit` mode: two columns, whichever is filled");
{
  const csv = "Date,Withdrawal,Deposit\n2026-01-05,250,\n2026-01-06,,900\n2026-01-07,0.00,400\n2026-01-08,,\n2026-01-09,10,20\n";
  const r = parse(csv, { amount: "Withdrawal", credit: "Deposit" }, "debitCredit");
  eq(r.rows.length, 3, "3 usable rows");
  eq(r.rows[0]!.kind, "expense", "debit → expense");
  eq(r.rows[1]!.kind, "income", "credit → income");
  eq(r.rows[2]!.kind, "income", "a 0.00 in the unused column is ignored");
  eq(r.rows[2]!.amount, 400, "the filled column's amount is used");
  eq(r.skipped.length, 2, "the empty row and the ambiguous both-filled row are skipped");
  ok(r.skipped.some((s) => /both debit/i.test(s.reason)), "both-filled row skipped with an explicit reason");
}

section("[import-txn] `typeColumn` mode: mapped values, incl. ignore");
{
  const csv = "Date,Amount,Type\n2026-01-05,250,DR\n2026-01-06,900,CR\n2026-01-07,50,TRANSFER\n2026-01-08,50,WAT\n";
  const r = parse(csv, { amount: "Amount", type: "Type" }, "typeColumn", {
    typeMap: { DR: "expense", CR: "income", TRANSFER: "ignore" },
  });
  eq(r.rows.length, 2, "only the mapped in/out rows import");
  eq(r.rows[0]!.kind, "expense", "DR → expense");
  eq(r.rows[1]!.kind, "income", "CR → income");
  ok(r.skipped.some((s) => /set to ignore/.test(s.reason)), "an 'ignore' type is skipped with a reason");
  ok(r.skipped.some((s) => /Unmapped type "WAT"/.test(s.reason)), "an unmapped type is skipped, never guessed");
}

section("[import-txn] nothing is silently dropped: every unusable row has a reason");
{
  const csv = "Date,Amount,Description\n,250,no date\nnot-a-date,250,bad date\n2026-01-05,,no amount\n2026-01-05,abc,junk amount\n2026-01-05,0,zero\n,,\n";
  const r = parse(csv, { note: "Description" });
  eq(r.rows.length, 0, "no row is importable");
  eq(r.skipped.length, 5, "5 reported (the fully-blank row isn't an error)");
  const reasons = r.skipped.map((s) => s.reason).join(" | ");
  ok(/No date/.test(reasons) && /Unrecognised date/.test(reasons), "missing + unparseable dates reported");
  ok(/No amount/.test(reasons) && /Couldn't read the amount/.test(reasons), "missing + junk amounts reported");
  ok(/zero/i.test(reasons), "zero amount reported");
  ok(r.skipped.every((s) => s.row > 0), "each skip carries its 1-based row number");
}

section("[import-txn] a mistyped far-future year is reported, not imported silently");
{
  // Real case: a hand-kept sheet had "2205" where "2025" was meant. Importing it would put a
  // transaction 180 years out and quietly skew every all-time chart.
  const csv = "Date,Amount\n17-6-2205,500\n17-6-2025,600\n";
  const r = parse(csv, {}, "single", { singleKind: "expense", maxDate: "2027-01-01" });
  eq(r.rows.length, 1, "only the plausible row is imported");
  eq(r.rows[0]!.date, "2025-06-17", "…the real one");
  ok(r.skipped.some((s) => /far in the future/.test(s.reason)), "the typo is reported with a clear reason");
  // Without a bound, nothing is rejected (the guard is opt-in for callers).
  eq(parse(csv, {}, "single", { singleKind: "expense" }).rows.length, 2, "no maxDate → both rows parse");
  // A near-future date (a planned expense next month) is still fine.
  eq(parse("Date,Amount\n1-3-2026,10\n", {}, "single", { maxDate: "2027-01-01" }).rows.length, 1, "near-future dates are kept");
}

section("[import-txn] distinctValues drives the mapping dropdowns (first-seen order)");
{
  const t = table("Date,Amount,Bank\n2026-01-01,1,ICICI\n2026-01-02,2,HDFC\n2026-01-03,3,ICICI\n2026-01-04,4,\n");
  eq(distinctValues(t, "Bank").join(","), "ICICI,HDFC", "distinct, blanks dropped, first-seen order");
  eq(distinctValues(t, undefined).length, 0, "no column → no values");
}

// ---------------------------------------------------------------------------
section("[import-txn] plan: banks map to existing accounts, or are CREATED once each");
{
  const csv = "Date,Amount,Bank\n2026-01-05,250,HDFC\n2026-01-06,100,Amex Card\n2026-01-07,75,Amex Card\n";
  const { rows, skipped } = parse(csv, { account: "Bank" });
  const plan = planTransactionImport(rows, ctx({ accountMap: { HDFC: "A1", "Amex Card": NEW_ENTITY }, parseSkipped: skipped }));
  eq(plan.transactions.length, 3, "all 3 rows planned");
  eq(plan.newAccounts.length, 1, "the unknown bank is created ONCE for its two rows");
  eq(plan.newAccounts[0]!.name, "Amex Card", "created with the file's name");
  eq(plan.newAccounts[0]!.type, "bank", "created with the chosen type");
  const created = plan.newAccounts[0]!.id;
  eq(plan.transactions.filter((t) => t.accountId === created).length, 2, "both its rows point at the one new account");
  eq(plan.transactions.filter((t) => t.accountId === "A1").length, 1, "the mapped row goes to the existing account");
}

section("[import-txn] plan: an unmapped bank matches an EXISTING account by name (re-import safe)");
{
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,250,  hdfc \n", { account: "Bank" });
  const plan = planTransactionImport(rows, ctx()); // no accountMap at all
  eq(plan.newAccounts.length, 0, "no duplicate account created");
  eq(plan.transactions[0]!.accountId, "A1", "case/space-insensitive name match wins");
}

section("[import-txn] plan: a bank mapped to skip drops its rows (with a reason)");
{
  const csv = "Date,Amount,Bank\n2026-01-05,250,HDFC\n2026-01-06,100,Petty\n";
  const { rows } = parse(csv, { account: "Bank" });
  const plan = planTransactionImport(rows, ctx({ accountMap: { HDFC: "A1", Petty: SKIP_ROWS } }));
  eq(plan.transactions.length, 1, "only the kept bank's row imports");
  ok(plan.skippedRows.some((s) => /set to skip/.test(s.reason)), "the skipped bank's row is reported, not silently dropped");
  // IGNORE on an ACCOUNT means the same thing (a row must land somewhere or not at all).
  const legacy = planTransactionImport(rows, ctx({ accountMap: { HDFC: "A1", Petty: IGNORE_VALUE } }));
  eq(legacy.transactions.length, 1, "IGNORE on an account also skips its rows");
}

section("[import-txn] plan: rows with no bank column land in the default account");
{
  const { rows } = parse("Date,Amount\n2026-01-05,250\n");
  const plan = planTransactionImport(rows, ctx());
  eq(plan.transactions[0]!.accountId, "A1", "default account used");
  eq(plan.transactions[0]!.currency, "INR", "currency comes from the ACCOUNT");
}

section("[import-txn] plan: currency is the ACCOUNT's; a disagreeing row is skipped, never mis-posted");
{
  const csv = "Date,Amount,Ccy\n2026-01-05,250,INR\n2026-01-06,100,USD\n2026-01-07,50,zz\n";
  const { rows } = parse(csv, { currency: "Ccy" });
  const plan = planTransactionImport(rows, ctx()); // default account is INR
  eq(plan.transactions.length, 2, "the INR row and the junk-currency row import");
  ok(plan.transactions.every((t) => t.currency === "INR"), "every imported row posts in the account's currency");
  ok(plan.skippedRows.some((s) => /is in USD but/.test(s.reason)), "the USD row is skipped with an explanatory reason");
}

section("[import-txn] plan: a created account takes the file's currency");
{
  const { rows } = parse("Date,Amount,Bank,Ccy\n2026-01-05,250,Schwab,USD\n", { account: "Bank", currency: "Ccy" });
  const plan = planTransactionImport(rows, ctx({ accountMap: { Schwab: NEW_ENTITY } }));
  eq(plan.newAccounts[0]!.currency, "USD", "new account created in the row's currency");
  eq(plan.transactions[0]!.currency, "USD", "and the transaction posts in it");
}

section("[import-txn] plan: owners map to people, or are created");
{
  const csv = "Date,Amount,Who\n2026-01-05,250,Ravi\n2026-01-06,100,Meera\n2026-01-07,50,Meera\n";
  const { rows } = parse(csv, { person: "Who" });
  const plan = planTransactionImport(rows, ctx({ personMap: { Ravi: "p1", Meera: NEW_ENTITY } }));
  eq(plan.newPeople.length, 1, "the unknown owner is created once");
  eq(plan.transactions[0]!.personId, "p1", "known owner mapped");
  eq(plan.transactions[1]!.personId, plan.newPeople[0]!.id, "created owner used for their rows");
  eq(plan.transactions[2]!.personId, plan.newPeople[0]!.id, "…and shared across their rows");
}

section("[import-txn] plan: categories + subcategories are matched or created (2 levels)");
{
  const csv = "Date,Amount,Cat,Sub\n2026-01-05,250,Food,Dining\n2026-01-06,100,Food,Dining\n2026-01-07,50,Food,\n";
  const { rows } = parse(csv, { category: "Cat", subcategory: "Sub" });
  const existing: Category[] = [{ id: "food", name: "Food" }];
  const plan = planTransactionImport(rows, ctx({ categories: existing }));
  eq(plan.newCategories.length, 1, "only the missing subcategory is created");
  const sub = plan.newCategories[0]!;
  eq(sub.name, "Dining", "subcategory named from the file");
  eq(sub.parentId, "food", "…nested under the matched parent");
  eq(plan.transactions[0]!.categoryId, sub.id, "the LEAF (subcategory) is stored on the transaction");
  eq(plan.transactions[1]!.categoryId, sub.id, "reused, not duplicated");
  eq(plan.transactions[2]!.categoryId, "food", "a row with no subcategory keeps the parent");
}

section("[import-txn] plan: a category mapped to ignore leaves rows UNCATEGORISED (not dropped)");
{
  const { rows } = parse("Date,Amount,Cat\n2026-01-05,250,Misc\n", { category: "Cat" });
  const plan = planTransactionImport(rows, ctx({ categoryMap: { Misc: IGNORE_VALUE } }));
  eq(plan.transactions.length, 1, "the row still imports");
  eq(plan.transactions[0]!.categoryId, undefined, "…just with no category");
  eq(plan.newCategories.length, 0, "and nothing is created");
}

section("[import-txn] plan: deterministic ids — re-import adds nothing, identical rows both survive");
{
  const csv = "Date,Amount,Description\n2026-01-05,250,Coffee\n2026-01-05,250,Coffee\n2026-01-06,90,Bus\n";
  const { rows } = parse(csv, { note: "Description" });
  const first = planTransactionImport(rows, ctx());
  eq(first.transactions.length, 3, "two identical coffees AND the bus all import");
  eq(new Set(first.transactions.map((t) => t.id)).size, 3, "…with distinct ids (per-content counter)");
  ok(first.transactions.every((t) => isImportedTransaction(t)), "ids are marked import-owned");
  ok(first.transactions.every((t) => t.id.startsWith(importTxnIdPrefix("A1"))), "…and scoped to the target account");
  // Re-plan against a DB that already holds them → all duplicates, nothing new.
  const second = planTransactionImport(rows, ctx({ transactions: first.transactions }));
  eq(second.transactions.length, 0, "re-importing the same file imports nothing");
  eq(second.duplicates, 3, "…all three are reported as already-imported");
}

section("[import-txn] plan: the id changes with content, so an edited row is NOT a duplicate");
{
  const base = parse("Date,Amount,Description\n2026-01-05,250,Coffee\n", { note: "Description" }).rows;
  const changed = parse("Date,Amount,Description\n2026-01-05,255,Coffee\n", { note: "Description" }).rows;
  const a = planTransactionImport(base, ctx()).transactions[0]!;
  const b = planTransactionImport(changed, ctx()).transactions[0]!;
  ok(a.id !== b.id, "a different amount yields a different id");
  eq(planTransactionImport(changed, ctx({ transactions: [a] })).duplicates, 0, "so it isn't swallowed as a duplicate");
}

section("[import-txn] plan totals describe the whole file (parse skips included)");
{
  const csv = "Date,Amount\n2026-01-05,250\n2026-01-06,-40\nbad,1\n";
  const { rows, skipped } = parse(csv, {}, "sign");
  const plan = planTransactionImport(rows, ctx({ parseSkipped: skipped }));
  eq(plan.totals.imported, 2, "2 imported");
  eq(plan.totals.expense + plan.totals.income, 2, "kinds add up");
  eq(plan.totals.skipped, 1, "the unparseable row is counted in the plan's totals");
}

// ---------------------------------------------------------------------------
section("[store] applyTransactionImport writes atomically and is idempotent");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC"));
  const csv = "Date,Amount,Bank,Cat\n2026-01-05,250,HDFC,Food\n2026-01-06,100,Amex,Travel\n";
  const { rows, skipped } = parse(csv, { account: "Bank", category: "Cat" });
  const build = () =>
    planTransactionImport(rows, {
      ...ctx({
        accounts: store.getState().accounts,
        people: store.getState().people,
        categories: store.getState().categories,
        transactions: store.getState().transactions,
        accountMap: { HDFC: "A1", Amex: NEW_ENTITY },
        parseSkipped: skipped,
      }),
    });
  const res = await store.applyTransactionImport(build(), { label: "jan.csv" });
  eq(res.transactions, 2, "2 transactions written");
  eq(res.accounts, 1, "1 account created for the unknown bank");
  eq(res.categories, 2, "2 categories created");
  ok(res.batch !== null && res.batch.kind === "transactions", "an undo batch is recorded, tagged as a transaction import");
  eq(store.getState().transactions.length, 2, "state has them");
  const persisted = (await store.exportDocument()).data;
  eq((persisted.transactions ?? []).length, 2, "…and so does storage");
  // Re-apply the SAME file: deterministic ids mean nothing is added.
  const again = await store.applyTransactionImport(build(), { label: "jan.csv" });
  eq(again.transactions, 0, "re-import writes no transactions");
  eq(again.accounts, 0, "…and creates no duplicate account");
  eq(store.getState().transactions.length, 2, "still 2 transactions");
}

section("[store] undo of a transaction import removes exactly what it added");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC"));
  const { rows } = parse("Date,Amount,Bank,Cat\n2026-01-05,250,HDFC,Food\n2026-01-06,100,Amex,Travel\n", {
    account: "Bank",
    category: "Cat",
  });
  const s = store.getState();
  const plan = planTransactionImport(rows, ctx({ accounts: s.accounts, people: s.people, accountMap: { HDFC: "A1", Amex: NEW_ENTITY } }));
  const res = await store.applyTransactionImport(plan, { label: "jan.csv" });
  const rev = await store.undoImportBatch(res.batch!.id);
  eq(rev?.transactions, 2, "both imported transactions reverted");
  eq(rev?.accounts, 1, "the account it created is removed");
  eq(rev?.categories, 2, "the categories it created are removed");
  eq(store.getState().transactions.length, 0, "no transactions left");
  eq(store.getState().accounts.length, 1, "the user's own account is untouched");
  eq(store.getState().categories.length, 0, "no leftover categories");
  eq(await store.undoImportBatch(res.batch!.id), null, "a second undo reports nothing left to revert");
}

section("[store] undo KEEPS an import-created account/category you have since used");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC"));
  const { rows } = parse("Date,Amount,Bank,Cat\n2026-01-05,250,Amex,Food\n", { account: "Bank", category: "Cat" });
  const s = store.getState();
  const plan = planTransactionImport(rows, ctx({ accounts: s.accounts, people: s.people, accountMap: { Amex: NEW_ENTITY } }));
  const res = await store.applyTransactionImport(plan, { label: "jan.csv" });
  const createdAccount = res.batch!.createdAccountIds![0]!;
  const createdCategory = res.batch!.createdCategoryIds![0]!;
  // The user then records their OWN transaction in the imported account + category.
  const mine: Transaction = {
    id: "mine", date: "2026-02-01", type: "expense", accountId: createdAccount, personId: "p1",
    amount: 999, currency: "INR", categoryId: createdCategory, updatedAt: "",
  };
  await store.saveTransaction(mine);
  const rev = await store.undoImportBatch(res.batch!.id);
  eq(rev?.transactions, 1, "only the IMPORTED transaction is removed");
  eq(rev?.accounts, 0, "the account is KEPT — the user's own transaction still needs it");
  eq(rev?.categories, 0, "the category is KEPT for the same reason");
  eq(store.getState().transactions.length, 1, "the user's transaction survives");
  ok(store.getState().accounts.some((a) => a.id === createdAccount), "account still there");
  ok(store.getState().categories.some((c) => c.id === createdCategory), "category still there");
}

section("[store] applyTransactionImport converges on an account created concurrently");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC"));
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,250,Amex\n", { account: "Bank" });
  const s = store.getState();
  const plan = planTransactionImport(rows, ctx({ accounts: s.accounts, people: s.people, accountMap: { Amex: NEW_ENTITY } }));
  // Another tab creates the same-named account BEFORE this plan is applied.
  await store.saveAccount(bank("A2", "Amex", "INR"));
  const res = await store.applyTransactionImport(plan, { label: "jan.csv" });
  eq(res.accounts, 0, "no duplicate account created");
  eq(res.transactions, 1, "the row still imports");
  eq(store.getState().transactions[0]!.accountId, "A2", "…into the account that already existed");
  ok(store.getState().transactions[0]!.id.startsWith(importTxnIdPrefix("A2")), "its id is re-keyed to that account so re-import dedups");
}

section("[store] a transaction import skips rows whose account vanished mid-preview");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC"));
  await store.saveAccount(bank("A9", "Doomed"));
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,250,HDFC\n2026-01-06,100,Doomed\n", { account: "Bank" });
  const s = store.getState();
  const plan = planTransactionImport(rows, ctx({ accounts: s.accounts, people: s.people, accountMap: { HDFC: "A1", Doomed: "A9" } }));
  await store.deleteAccount("A9"); // deleted while the preview was open
  const res = await store.applyTransactionImport(plan, { label: "jan.csv" });
  eq(res.transactions, 1, "only the row with a live account is written");
  ok(
    store.getState().transactions.every((t) => t.accountId === "A1"),
    "nothing is orphaned onto a dead account",
  );
}

// ---------------------------------------------------------------------------
section("[import-txn] reporting-only marks every row excludeFromBalance (reports yes, balances no)");
{
  const { rows } = parse("Date,Amount\n2026-01-05,250\n2026-01-06,100\n");
  const on = planTransactionImport(rows, ctx({ reportingOnly: true }));
  ok(on.transactions.every((t) => t.excludeFromBalance === true), "reporting-only → flagged, so balances/net worth are untouched");
  const off = planTransactionImport(rows, ctx({ reportingOnly: false }));
  ok(off.transactions.every((t) => t.excludeFromBalance === undefined), "opted out → normal transactions that move balances");
}

section("[import-txn] fileCurrency stands in for a missing currency column");
{
  const { rows } = parse("Date,Amount\n2026-01-05,250\n"); // no currency column at all
  const usdAcc = [bank("A1", "Schwab", "USD")];
  // File says INR, account is USD → the row must be skipped, never re-tagged as USD.
  const bad = planTransactionImport(rows, ctx({ accounts: usdAcc, fileCurrency: "INR" }));
  eq(bad.transactions.length, 0, "a file currency that disagrees with the account skips the row");
  ok(bad.skippedRows.some((s) => /is in INR but/.test(s.reason)), "…with an explanatory reason");
  const good = planTransactionImport(rows, ctx({ accounts: usdAcc, fileCurrency: "USD" }));
  eq(good.transactions.length, 1, "a matching file currency imports normally");
  // It also gives a CREATED account its currency.
  const { rows: r2 } = parse("Date,Amount,Bank\n2026-01-05,250,Wise\n", { account: "Bank" });
  const created = planTransactionImport(r2, ctx({ fileCurrency: "EUR", accountMap: { Wise: NEW_ENTITY } }));
  eq(created.newAccounts[0]!.currency, "EUR", "a created account takes the file currency");
  // A per-row currency cell still wins over the file default.
  const { rows: r3 } = parse("Date,Amount,Ccy\n2026-01-05,250,INR\n", { currency: "Ccy" });
  eq(planTransactionImport(r3, ctx({ fileCurrency: "USD" })).transactions.length, 1, "row currency (INR) beats the file default and matches the INR account");
}

section("[fuzzy] nameSimilarity/bestNameMatch: suggests near-names, refuses discriminating ones");
{
  const sim = (a: string, b: string): number => Math.round(nameSimilarity(a, b) * 100) / 100;
  ok(sim("HDFC Bank", "hdfc  bank") === 1, "case/spacing-insensitive exact → 1");
  ok(sim("HDFC-BANK Ltd.", "HDFC Bank") >= 0.62, "'HDFC-BANK Ltd.' is a match for 'HDFC Bank'");
  ok(sim("food and dining", "Food & Dining") >= 0.62, "'food and dining' matches 'Food & Dining'");
  // The dangerous pairs: same brand, DIFFERENT instrument. These must NOT be suggested.
  for (const [a, b] of [
    ["Axis Bank", "Axis Card"],
    ["SBI Bank", "SBI Card"],
    ["ICICI Bank", "ICICI Credit Card"],
  ] as Array<[string, string]>) {
    ok(sim(a, b) < 0.62, `"${a}" is NOT confused with "${b}" (${sim(a, b)})`);
  }
  // An INSTRUMENT word on one side only ⇒ a different product of the same brand. These are
  // the pairs that made a bank statement pre-fill onto a credit card / loan.
  for (const [a, b] of [
    ["HDFC Bank", "HDFC Bank Credit Card"],
    ["Axis Bank", "Axis Bank Card"],
    ["HDFC Bank", "HDFC Bank Loan"],
    ["SBI", "SBI Card"],
    ["Paytm", "Paytm Wallet"],
    ["ICICI", "ICICI FD"],
  ] as Array<[string, string]>) {
    ok(sim(a, b) < 0.62, `"${a}" is NOT matched to "${b}" (${sim(a, b)})`);
  }
  // …while the SAME product class on both sides still matches through extra words.
  ok(sim("HDFC Bank", "HDFC") >= 0.62, "'HDFC Bank' still matches 'HDFC'");
  ok(sim("HDFC Credit Card", "HDFC Bank Credit Card") >= 0.62, "same product class on both sides still matches");
  // A sub-type on ONE side only is the same account; two DIFFERENT sub-types are not.
  ok(sim("HDFC Bank Savings", "HDFC Bank") >= 0.62, "'HDFC Bank Savings' matches 'HDFC Bank' (a savings a/c IS the bank a/c)");
  ok(sim("HDFC Savings", "HDFC Current") < 0.62, "…but savings vs current are different accounts");
  // Deterministic + closest-wins, regardless of list order.
  const cands = [{ name: "HDFC Credit Card" }, { name: "HDFC Bank" }];
  eq(bestNameMatch("HDFC Bank Savings", cands, (c) => c.name)?.name, "HDFC Bank", "closest containing name wins, not the first");
  eq(
    bestNameMatch("HDFC Bank Savings", [...cands].reverse(), (c) => c.name)?.name,
    "HDFC Bank",
    "…and the same result with the list reversed (order-independent)",
  );
  // An exact-score tie must NOT depend on list order (creation order differs per device).
  const tie = [{ name: "Axis Bank" }, { name: "Axis Wallet" }];
  eq(
    bestNameMatch("Axis", tie, (c) => c.name)?.name,
    bestNameMatch("Axis", [...tie].reverse(), (c) => c.name)?.name,
    "a tie resolves identically whichever order the candidates come in",
  );
  eq(bestNameMatch("Totally Unrelated", cands, (c) => c.name), undefined, "nothing below the threshold matches");
}

section("[import-txn] the ENGINE never fuzzy-matches: an inexact bank is skipped, not guessed");
{
  // Fuzzy matching is a UI prefill (visible + overridable). Down here it would be invisible,
  // so "HDFC-BANK Ltd." must NOT be silently filed into the existing "HDFC Bank".
  const accounts = [bank("A1", "HDFC Bank"), bank("A2", "Axis Card")];
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,250,HDFC-BANK Ltd.\n", { account: "Bank" });
  const plan = planTransactionImport(rows, ctx({ accounts })); // no mapping at all
  eq(plan.transactions.length, 0, "the row is skipped rather than guessed into an account");
  ok(plan.skippedRows.some((s) => /No account matches/.test(s.reason)), "…and reported");
  // An EXACT name still reuses the account (that's how re-import stays idempotent).
  const { rows: exact } = parse("Date,Amount,Bank\n2026-01-05,250,  hdfc bank \n", { account: "Bank" });
  eq(planTransactionImport(exact, ctx({ accounts })).transactions[0]!.accountId, "A1", "exact (case/space-insensitive) name reuses it");
  // An explicit "create" choice is honoured even when a similar account exists.
  const { rows: create } = parse("Date,Amount,Bank\n2026-01-05,250,Axis Bank\n", { account: "Bank" });
  const p2 = planTransactionImport(create, ctx({ accounts, accountMap: { "Axis Bank": NEW_ENTITY } }));
  eq(p2.newAccounts.length, 1, "'Create this account' really creates one");
  eq(p2.newAccounts[0]!.name, "Axis Bank", "…named from the file");
  eq(p2.transactions[0]!.accountId, p2.newAccounts[0]!.id, "…and the rows go to it, NOT to the similar 'Axis Card'");
}

section("[import-txn] with no subcategory column, a category value can map onto an existing SUB");
{
  const cats: Category[] = [
    { id: "travel", name: "Travel" },
    { id: "flights", name: "Flight Charges", parentId: "travel" },
  ];
  const { rows } = parse("Date,Amount,Cat\n2026-01-05,250,Flight Charges\n", { category: "Cat" });
  const plan = planTransactionImport(rows, ctx({ categories: cats, categoryMap: { "Flight Charges": "flights" } }));
  eq(plan.newCategories.length, 0, "nothing created — it mapped onto the existing subcategory");
  eq(plan.transactions[0]!.categoryId, "flights", "the subcategory is stored as the leaf");
  // And if the file ALSO has a sub column, mapping the category onto a sub can't nest a 3rd level.
  const { rows: both } = parse("Date,Amount,Cat,Sub\n2026-01-05,250,Flight Charges,Economy\n", { category: "Cat", subcategory: "Sub" });
  const p2 = planTransactionImport(both, ctx({ categories: cats, categoryMap: { "Flight Charges": "flights" } }));
  eq(p2.newCategories.length, 0, "no third level is created");
  eq(p2.transactions[0]!.categoryId, "flights", "the mapped subcategory stays the leaf");
}

section("[import-txn] subcategories map per (category, subcategory) pair");
{
  const cats: Category[] = [
    { id: "food", name: "Food" },
    { id: "travel", name: "Travel" },
    { id: "food-misc", name: "Misc", parentId: "food" },
    { id: "travel-misc", name: "Misc", parentId: "travel" },
  ];
  const csv = "Date,Amount,Cat,Sub\n2026-01-05,250,Food,Misc\n2026-01-06,100,Travel,Misc\n";
  const t = table(csv);
  const pairs = distinctSubPairs(t, "Cat", "Sub");
  eq(pairs.length, 2, "the same sub name under two parents is TWO mapping entries");
  const { rows } = parse(csv, { category: "Cat", subcategory: "Sub" });
  const plan = planTransactionImport(rows, ctx({ categories: cats }));
  eq(plan.newCategories.length, 0, "both resolve to existing subs — nothing created");
  eq(plan.transactions[0]!.categoryId, "food-misc", "Food › Misc → the sub under Food");
  eq(plan.transactions[1]!.categoryId, "travel-misc", "Travel › Misc → the sub under Travel");
  // An explicit pair mapping wins.
  const forced = planTransactionImport(rows, ctx({
    categories: cats,
    subcategoryMap: { [subMapKey("Food", "Misc")]: "travel-misc" },
  }));
  eq(forced.transactions[0]!.categoryId, "travel-misc", "an explicit pair mapping overrides the parent-scoped match");
}

section("[import-txn] subcategory reuse is exact-within-parent; it can be mapped, skipped or ignored");
{
  const cats: Category[] = [
    { id: "food", name: "Food" },
    { id: "dining", name: "Dining Out", parentId: "food" },
  ];
  // Exact (case/space-insensitive) name inside the parent → reuse, no duplicate.
  const { rows: same } = parse("Date,Amount,Cat,Sub\n2026-01-05,250,Food, dining out \n", { category: "Cat", subcategory: "Sub" });
  const reuse = planTransactionImport(same, ctx({ categories: cats }));
  eq(reuse.newCategories.length, 0, "an exact sub name under the same parent is reused");
  eq(reuse.transactions[0]!.categoryId, "dining", "…and stored as the leaf");
  // An INEXACT name is created (the engine never guesses); the wizard's fuzzy prefill is what
  // suggests "dining-out" → "Dining Out", visibly, before this point.
  const { rows } = parse("Date,Amount,Cat,Sub\n2026-01-05,250,Food,dining-out\n", { category: "Cat", subcategory: "Sub" });
  const plan = planTransactionImport(rows, ctx({ categories: cats }));
  eq(plan.newCategories.length, 1, "an inexact sub name is created under the parent, not silently merged");
  eq(plan.newCategories[0]!.parentId, "food", "…nested correctly");
  // …and an explicit mapping resolves it onto the existing sub.
  const mapped = planTransactionImport(rows, ctx({ categories: cats, subcategoryMap: { [subMapKey("Food", "dining-out")]: "dining" } }));
  eq(mapped.newCategories.length, 0, "an explicit pair mapping reuses the existing sub");
  eq(mapped.transactions[0]!.categoryId, "dining", "…stored as the leaf");
  const ignored = planTransactionImport(rows, ctx({ categories: cats, subcategoryMap: { [subMapKey("Food", "dining-out")]: IGNORE_VALUE } }));
  eq(ignored.transactions[0]!.categoryId, "food", "IGNORE keeps the parent category only");
  const skipped = planTransactionImport(rows, ctx({ categories: cats, subcategoryMap: { [subMapKey("Food", "dining-out")]: SKIP_ROWS } }));
  eq(skipped.transactions.length, 0, "SKIP drops the rows");
  ok(skipped.skippedRows.some((s) => /Subcategory .* set to skip/.test(s.reason)), "…with a reason");
}

section("[import-txn] a category set to skip drops rows; IGNORE only clears the category");
{
  const { rows } = parse("Date,Amount,Cat\n2026-01-05,250,SELF TRANSFER\n2026-01-06,100,Food\n", { category: "Cat" });
  const plan = planTransactionImport(rows, ctx({ categoryMap: { "SELF TRANSFER": SKIP_ROWS, Food: NEW_ENTITY } }));
  eq(plan.transactions.length, 1, "the transfer-ish rows are dropped entirely");
  ok(plan.skippedRows.some((s) => /Category .* set to skip/.test(s.reason)), "reported, not silently dropped");
}

section("[import-txn] an unmatched bank is SKIPPED, never silently filed in the default account");
{
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,250,Totally Unknown Bank\n", { account: "Bank" });
  const plan = planTransactionImport(rows, ctx()); // no mapping, no name/fuzzy match
  eq(plan.transactions.length, 0, "the row is not misfiled into the default account");
  ok(plan.skippedRows.some((s) => /No account matches/.test(s.reason)), "it's reported so the money is never invisible");
}

section("[import-txn] debit/credit signs: a negative debit is a refund, not a charge");
{
  const csv = "Date,Withdrawal,Deposit\n2026-01-05,-250,\n2026-01-06,,-90\n";
  const r = parse(csv, { amount: "Withdrawal", credit: "Deposit" }, "debitCredit");
  eq(r.rows[0]!.kind, "income", "a NEGATIVE withdrawal is money coming back IN");
  eq(r.rows[0]!.amount, 250, "…with a positive magnitude");
  eq(r.rows[1]!.kind, "expense", "a NEGATIVE deposit is money going OUT");
  eq(r.rows[1]!.amount, 90, "…with a positive magnitude");
}

section("[import-txn] ids ignore mapping choices, so re-mapping cannot double-import");
{
  const csv = "Date,Amount,Cat\n2026-01-05,250,Food\n";
  const { rows } = parse(csv, { category: "Cat" });
  const first = planTransactionImport(rows, ctx({ categoryMap: { Food: NEW_ENTITY } }));
  eq(first.transactions.length, 1, "first import writes the row");
  // Re-import the SAME file, but map the category somewhere else entirely.
  const other: Category[] = [{ id: "groceries", name: "Groceries" }];
  const second = planTransactionImport(rows, ctx({ categories: other, categoryMap: { Food: "groceries" }, transactions: first.transactions }));
  eq(second.transactions.length, 0, "remapping the category does NOT re-import the row");
  eq(second.duplicates, 1, "…it's still recognised as already imported");
  // Same for a row whose category is later left uncategorised.
  const third = planTransactionImport(rows, ctx({ categoryMap: { Food: IGNORE_VALUE }, transactions: first.transactions }));
  eq(third.duplicates, 1, "and for leaving it uncategorised");
}

section("[store] undoing import #1 KEEPS the categories that import #2's transactions use");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC"));
  const runImport = async (csv: string, label: string) => {
    const { rows } = parse(csv, { category: "Cat", subcategory: "Sub" });
    const s = store.getState();
    const plan = planTransactionImport(
      rows,
      ctx({ accounts: s.accounts, people: s.people, categories: s.categories, transactions: s.transactions }),
    );
    return store.applyTransactionImport(plan, { label });
  };
  // File 1 creates 5 categories (3 parents + 2 subs).
  const f1 = await runImport(
    "Date,Amount,Cat,Sub\n2026-01-01,10,Food,Dining\n2026-01-02,20,Travel,Flights\n2026-01-03,30,Health,\n",
    "file1.csv",
  );
  eq(f1.categories, 5, "file 1 created 5 categories (Food/Travel/Health + Dining/Flights)");
  // File 2 REUSES 3 of them (Food › Dining, Travel) and adds 2 more.
  const f2 = await runImport(
    "Date,Amount,Cat,Sub\n2026-02-01,11,Food,Dining\n2026-02-02,21,Travel,\n2026-02-03,31,Utilities,Power\n",
    "file2.csv",
  );
  eq(f2.categories, 2, "file 2 created only the 2 genuinely new ones");
  eq(store.getState().categories.length, 7, "7 categories in total");
  // Undo file 1 — the categories file 2's transactions rely on must SURVIVE.
  const rev = await store.undoImportBatch(f1.batch!.id);
  eq(rev?.transactions, 3, "file 1's 3 transactions reverted");
  const left = store.getState().categories.map((c) => c.name).sort().join(",");
  eq(store.getState().transactions.length, 3, "file 2's transactions are untouched");
  ok(left.includes("Food") && left.includes("Dining") && left.includes("Travel"), "categories file 2 uses are KEPT");
  ok(!left.includes("Health"), "a category only file 1 used is removed");
  ok(!left.includes("Flights"), "…including its unused subcategory");
  ok(left.includes("Utilities") && left.includes("Power"), "file 2's own categories are untouched");
  // No category may be left with a dangling parent (the bug this scenario exposes: file 2
  // referenced the SUBcategory Dining, so Food had to be kept even though no transaction
  // is tagged with Food itself).
  const ids = new Set(store.getState().categories.map((c) => c.id));
  ok(
    store.getState().categories.every((c) => !c.parentId || ids.has(c.parentId)),
    "every surviving subcategory still has its parent (no orphans)",
  );
  // File 2 then undoes independently. Categories batch 1 created but batch 1's undo had to
  // keep are now unreferenced — they simply remain as empty categories (batch 1's undo
  // record is already gone, so nothing owns their removal). Leftover clutter the user can
  // delete is the right trade against deleting something another import still needs.
  const rev2 = await store.undoImportBatch(f2.batch!.id);
  eq(rev2?.transactions, 3, "file 2 undoes independently");
  eq(store.getState().transactions.length, 0, "no transactions remain");
  const after = store.getState().categories.map((c) => c.name).sort().join(",");
  eq(after, "Dining,Food,Travel", "file 1's kept-for-file-2 categories linger as empty ones (documented)");
  const ids2 = new Set(store.getState().categories.map((c) => c.id));
  ok(store.getState().categories.every((c) => !c.parentId || ids2.has(c.parentId)), "still no orphans");
}

section("[store] convergence identity is name + currency + OWNER, never the name alone");
{
  // Same display names are legal here — each person can have an "IBKR". Converging on the name
  // alone let a row planned for one owner's new account be posted into ANOTHER owner's existing
  // one whenever a concurrent tab created that name first; the ids are then re-keyed to it, so a
  // later re-import dedups against the wrong account and never repairs the misrouting.
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC", "INR"));
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,50000,Schwab\n", { account: "Bank" });
  const s0 = store.getState();
  const plan = planTransactionImport(rows, ctx({ accounts: s0.accounts, people: s0.people, accountMap: { Schwab: NEW_ENTITY } }));
  eq(plan.newAccounts[0]!.currency, "INR", "planned as INR");
  // A concurrent tab creates a USD "Schwab" — same name, different currency, so NOT the same
  // account. Converging would have re-tagged ₹50,000 as $50,000; refusing to converge keeps the
  // row, in an account with the right currency.
  await store.saveAccount(bank("A2", "Schwab", "USD"));
  const res = await store.applyTransactionImport(plan, { label: "x.csv" });
  eq(res.transactions, 1, "the row is imported, not dropped");
  eq(res.dropped.length, 0, "…with nothing to explain away");
  const written = store.getState().transactions[0]!;
  const landed = store.getState().accounts.find((a) => a.id === written.accountId)!;
  eq(landed.currency, "INR", "it landed in an INR account");
  ok(landed.id !== "A2", "…which is NOT the other tab's USD account");
  eq(written.amount, 50000, "and the amount was never re-tagged");
}

section("[store] the currency guard still drops a row whose target account changed currency");
{
  // The property the previous test really protected: an INR amount must never be written into a
  // USD account. That guard lives at write time and still fires when the row's OWN target account
  // is altered mid-preview.
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC", "INR"));
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,50000,HDFC\n", { account: "Bank" });
  const s0 = store.getState();
  const plan = planTransactionImport(rows, ctx({ accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" } }));
  eq(plan.transactions[0]!.currency, "INR", "planned in INR");
  await store.saveAccount(bank("A1", "HDFC", "USD")); // the account is re-denominated meanwhile
  const res = await store.applyTransactionImport(plan, { label: "x.csv" });
  eq(res.transactions, 0, "the row is NOT written as 50,000 USD");
  eq(res.dropped.length, 1, "it's reported as dropped at write time");
  ok(/USD/.test(res.dropped[0]!), "…with the currency clash explained");
  eq(store.getState().transactions.length, 0, "nothing was written");
}

section("[import] same-named records resolve to the FIRST one, so re-import stays idempotent");
{
  // Names are not unique: two family accounts can both be "HDFC", and two devices can each create
  // a "Food" category. The planner's reuse must pick the same one every time — the imported id
  // embeds the account id, so picking differently changes every id, defeats duplicate detection,
  // and a re-import of the same file doubles the ledger.
  const accounts: Account[] = [
    { id: "acc-ravi", name: "HDFC", type: "bank", currency: "INR", personId: "p-ravi" },
    { id: "acc-priya", name: "hdfc ", type: "bank", currency: "INR", personId: "p-priya" },
  ];
  const people: Person[] = [
    { id: "p-ravi", name: "Ravi" },
    { id: "p-priya", name: "ravi" }, // normalises equal too
  ];
  const categories: Category[] = [
    { id: "cat-a", name: "Food" },
    { id: "cat-b", name: "food" },
  ];
  const rows = [
    { date: "2026-01-01", amountRaw: "100", accountRaw: "HDFC", categoryRaw: "Food", personRaw: "Ravi" },
    { date: "2026-01-02", amountRaw: "200", accountRaw: "HDFC", categoryRaw: "Food", personRaw: "Ravi" },
  ].map((r) => ({ ...r, subcategoryRaw: "", currencyRaw: "", noteRaw: "", typeRaw: "", rowIndex: 0 }));

  const plan = (rs: typeof rows) =>
    planTransactionImport(rs as never, {
      defaultAccountId: "acc-ravi",
      defaultPersonId: "p-ravi",
      defaultCurrency: "INR",
      newAccountType: "bank",
      accounts,
      people,
      categories,
      transactions: [],
      accountMap: {},
      personMap: {},
      categoryMap: {},
      subcategoryMap: {},
      reportingOnly: true,
      parseSkipped: [],
    } as never);

  const first = plan(rows);
  eq(
    [...new Set(first.transactions.map((t) => t.accountId))].join(","),
    "acc-ravi",
    "rows land in the FIRST same-named account, not the last",
  );
  eq(
    [...new Set(first.transactions.map((t) => t.categoryId))].join(","),
    "cat-a",
    "…and reuse the FIRST same-named category",
  );
  eq(first.newAccounts.length, 0, "no duplicate account is created");
  eq(first.newCategories.length, 0, "no duplicate category is created");
  // Re-planning the same file against the same data must detect every row as already imported.
  const second = planTransactionImport(rows as never, {
    defaultAccountId: "acc-ravi",
    defaultPersonId: "p-ravi",
    defaultCurrency: "INR",
    newAccountType: "bank",
    accounts,
    people,
    categories,
    transactions: first.transactions,
    accountMap: {},
    personMap: {},
    categoryMap: {},
    subcategoryMap: {},
    reportingOnly: true,
    parseSkipped: [],
  } as never);
  eq(second.transactions.length, 0, "a re-import adds nothing");
  eq(second.duplicates, first.transactions.length, "…every row is reported as a duplicate");
}

section("[import] two owners' otherwise-identical rows get distinct ids");
{
  // The id embeds the row's own text. Omitting the owner left two rows in one joint account —
  // same date, kind, amount, category and note — separated only by their position, so a partial or
  // reordered re-import could match one owner's row against the other's: one skipped as "already
  // imported", the other imported twice.
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.savePerson(person("p2", "Meera"));
  await store.saveAccount(bank("A1", "HDFC", "INR"));
  const s0 = store.getState();
  const both = parse("Date,Amount,Bank,Who\n2026-01-05,500,HDFC,Ravi\n2026-01-05,500,HDFC,Meera\n", {
    account: "Bank", person: "Who",
  });
  const plan = planTransactionImport(both.rows, ctx({
    accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" }, personMap: { Ravi: "p1", Meera: "p2" },
  }));
  eq(plan.transactions.length, 2, "both rows plan");
  eq(new Set(plan.transactions.map((t) => t.id)).size, 2, "…with distinct ids");
  eq(new Set(plan.transactions.map((t) => t.personId)).size, 2, "…and distinct owners");
  // Re-importing ONLY the second owner's row must dedup against HER row, not his.
  const onlyMeera = parse("Date,Amount,Bank,Who\n2026-01-05,500,HDFC,Meera\n", { account: "Bank", person: "Who" });
  const again = planTransactionImport(onlyMeera.rows, ctx({
    accounts: s0.accounts, people: s0.people, transactions: plan.transactions,
    accountMap: { HDFC: "A1" }, personMap: { Ravi: "p1", Meera: "p2" },
  }));
  eq(again.transactions.length, 0, "the re-imported row is recognised as already imported");
  eq(again.duplicates, 1, "…as a duplicate, not as a new row");
  // A file with NO owner column must keep the ids it had before this change (they must still
  // dedup against rows imported by an earlier build).
  const noOwner = parse("Date,Amount,Bank\n2026-01-05,500,HDFC\n", { account: "Bank" });
  const plain = planTransactionImport(noOwner.rows, ctx({ accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" } }));
  eq(plain.transactions[0]!.id.endsWith("|#1"), false, "sanity: the key isn't empty-padded");
  ok(!plain.transactions[0]!.id.includes("Ravi"), "no owner in the key when the file states none");
}

section("[import] an explicit 'leave uncategorised' is not undone by a subcategory");
{
  // IGNORE_VALUE on the category means "import these uncategorised". The subcategory fallback
  // treated that identically to "no category context" and promoted the sub to a top-level
  // category — inventing categories the user had just declined.
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC", "INR"));
  const s0 = store.getState();
  const { rows } = parse("Date,Amount,Bank,Cat,Sub\n2026-01-05,500,HDFC,Misc,Coffee\n", {
    account: "Bank", category: "Cat", subcategory: "Sub",
  });
  const plan = planTransactionImport(rows, ctx({
    accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" }, categoryMap: { Misc: IGNORE_VALUE },
  }));
  eq(plan.transactions.length, 1, "the row still imports");
  eq(plan.transactions[0]!.categoryId, undefined, "…uncategorised, as asked");
  eq(plan.newCategories.length, 0, "and no category was invented from the subcategory");
  // Without an explicit ignore, the sub is still kept as a top-level category rather than lost.
  const kept = planTransactionImport(rows, ctx({ accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" } }));
  ok(kept.newCategories.some((c) => c.name === "Coffee" || c.name === "Misc"), "no-mapping still keeps the category text");
}

section("[import] 'Create this account' is honoured when a same-named one belongs elsewhere");
{
  // Reusing on the NAME alone made the explicit choice a no-op: the row was either dropped by the
  // currency guard or filed into another owner's account. Reuse now needs name + currency + owner.
  const accounts: Account[] = [
    { id: "acc-ravi", name: "IBKR", type: "brokerage", currency: "USD", personId: "p-ravi" },
  ];
  const people: Person[] = [
    { id: "p-ravi", name: "Ravi" },
    { id: "p-meera", name: "Meera" },
  ];
  const rows = parse("Date,Amount,Bank,Who\n2026-01-05,500,IBKR,Meera\n", { account: "Bank", person: "Who" }).rows;
  const base = { accounts, people, accountMap: { IBKR: NEW_ENTITY }, personMap: { Meera: "p-meera" } };
  const plan = planTransactionImport(rows, ctx({ ...base, fileCurrency: "USD" }));
  eq(plan.newAccounts.length, 1, "Meera's IBKR is created, not folded into Ravi's");
  eq(plan.newAccounts[0]!.personId, "p-meera", "…owned by the person the row names");
  eq(plan.transactions[0]!.accountId, plan.newAccounts[0]!.id, "and the row lands there");

  // Same owner AND currency → that IS the same account, so it is reused (re-import idempotence).
  const sameOwner = parse("Date,Amount,Bank,Who\n2026-01-05,500,IBKR,Ravi\n", { account: "Bank", person: "Who" }).rows;
  const reuse = planTransactionImport(
    sameOwner,
    ctx({ accounts, people, accountMap: { IBKR: NEW_ENTITY }, personMap: { Ravi: "p-ravi" }, fileCurrency: "USD" }),
  );
  eq(reuse.newAccounts.length, 0, "no duplicate account when name, currency and owner all match");
  eq(reuse.transactions[0]!.accountId, "acc-ravi", "…the row joins the existing account");

  // And a repeated bank name inside ONE file still creates exactly one account.
  const twoRows = parse(
    "Date,Amount,Bank,Who\n2026-01-05,500,Amex,Meera\n2026-01-06,600,Amex,Meera\n",
    { account: "Bank", person: "Who" },
  ).rows;
  const once = planTransactionImport(
    twoRows,
    ctx({ accounts, people, accountMap: { Amex: NEW_ENTITY }, personMap: { Meera: "p-meera" }, fileCurrency: "USD" }),
  );
  eq(once.newAccounts.filter((a) => a.name === "Amex").length, 1, "created once for its two rows");
}

section("[store] the import write path validates against STORAGE, not this tab's memory");
{
  // Tabs share the database and get no cross-tab refresh. Validating from memory let a sibling
  // tab's delete or re-denomination slip past, writing a row onto a dead account or an INR amount
  // into a now-USD one — instead of dropping it as the method promises.
  const adapter = createMemoryStorage(SCHEMA);
  const tab1 = await createPortfolioStore(adapter);
  await tab1.savePerson(person("p1", "Ravi"));
  await tab1.saveAccount(bank("A1", "HDFC", "INR"));
  const s0 = tab1.getState();
  const { rows } = parse("Date,Amount,Bank\n2026-01-05,500,HDFC\n", { account: "Bank" });
  const plan = planTransactionImport(rows, ctx({ accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" } }));

  // A sibling tab re-denominates the target account while the review sits open. tab1's memory
  // still shows INR.
  const tab2 = await createPortfolioStore(adapter);
  await tab2.saveAccount({ ...bank("A1", "HDFC", "USD") });
  eq(tab1.getState().accounts.find((a) => a.id === "A1")!.currency, "INR", "tab1's memory is stale");

  const res = await tab1.applyTransactionImport(plan, { label: "x.csv" });
  eq(res.transactions, 0, "the row is NOT written into the re-denominated account");
  eq(res.dropped.length, 1, "…it is reported as dropped");
  ok(/USD/.test(res.dropped[0]!), "…with the clash explained");

  // And a sibling tab DELETING the account is caught the same way.
  const adapter2 = createMemoryStorage(SCHEMA);
  const t1 = await createPortfolioStore(adapter2);
  await t1.savePerson(person("p1", "Ravi"));
  await t1.saveAccount(bank("A1", "HDFC", "INR"));
  const st = t1.getState();
  const plan2 = planTransactionImport(
    parse("Date,Amount,Bank\n2026-01-05,500,HDFC\n", { account: "Bank" }).rows,
    ctx({ accounts: st.accounts, people: st.people, accountMap: { HDFC: "A1" } }),
  );
  const t2 = await createPortfolioStore(adapter2);
  await t2.deleteAccount("A1");
  const res2 = await t1.applyTransactionImport(plan2, { label: "y.csv" });
  eq(res2.transactions, 0, "no row is written onto the deleted account");
  ok(/deleted/.test(res2.dropped[0] ?? ""), "…and the reason says so");
  ok(
    !((await adapter2.exportAll()).transactions ?? []).length,
    "nothing was persisted, so no dangling accountId exists",
  );
}

section("[import] a mapping can CREATE a record under a name of your choosing");
{
  // The file's own spelling ("chali suldid", "CM-Groceries") is often not how you want things
  // named. `newNamed(x)` in place of NEW_ENTITY creates the record as x instead of as the raw text.
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC", "INR"));
  const s0 = store.getState();
  const { rows } = parse("Date,Amount,Bank,Cat,Sub\n2026-01-05,500,HDFC,Adike,Chali\n", {
    account: "Bank", category: "Cat", subcategory: "Sub",
  });
  const plan = planTransactionImport(rows, ctx({
    accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" },
    categoryMap: { Adike: newNamed("Agriculture") },
    subcategoryMap: { [subMapKey("Adike", "Chali")]: newNamed("Arecanut - Chali") },
  }));
  const parentNames = plan.newCategories.filter((c) => !c.parentId).map((c) => c.name);
  const subNames = plan.newCategories.filter((c) => c.parentId).map((c) => c.name);
  eq(parentNames.join(","), "Agriculture", "the category is created under the chosen name, not 'Adike'");
  eq(subNames.join(","), "Arecanut - Chali", "…and the subcategory under its chosen name, not 'Chali'");
  const leaf = plan.newCategories.find((c) => c.id === plan.transactions[0]!.categoryId)!;
  eq(leaf.name, "Arecanut - Chali", "the row files against the renamed subcategory");
  eq(leaf.parentId, plan.newCategories.find((c) => c.name === "Agriculture")!.id, "…under the renamed parent");
  // A blank/whitespace name falls back to the file's text rather than creating an unnamed record.
  const blank = planTransactionImport(rows, ctx({
    accounts: s0.accounts, people: s0.people, accountMap: { HDFC: "A1" },
    categoryMap: { Adike: newNamed("   ") },
  }));
  eq(blank.newCategories.filter((c) => !c.parentId)[0]!.name, "Adike", "an all-blank name falls back to the raw value");
}

section("[import] an explicitly mapped subcategory carries its OWN parent");
{
  // This is what the UI now states per row: the subcategory drives the outcome, so mapping the
  // category to Housing and the sub to a child of Utilities files under Utilities — the category
  // pick is not used for those rows (and can never produce an incoherent Housing › Petrol).
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson(person("p1", "Ravi"));
  await store.saveAccount(bank("A1", "HDFC", "INR"));
  await store.saveCategory({ id: "housing", name: "Housing" });
  await store.saveCategory({ id: "utilities", name: "Utilities" });
  await store.saveCategory({ id: "petrol", name: "Petrol", parentId: "utilities" });
  const s0 = store.getState();
  const { rows } = parse("Date,Amount,Bank,Cat,Sub\n2026-01-05,500,HDFC,HouseStuff,Fuel\n", {
    account: "Bank", category: "Cat", subcategory: "Sub",
  });
  const plan = planTransactionImport(rows, ctx({
    accounts: s0.accounts, people: s0.people, categories: s0.categories, accountMap: { HDFC: "A1" },
    categoryMap: { HouseStuff: "housing" },
    subcategoryMap: { [subMapKey("HouseStuff", "Fuel")]: "petrol" },
  }));
  eq(plan.transactions[0]!.categoryId, "petrol", "the row is filed against the mapped subcategory");
  eq(plan.newCategories.length, 0, "nothing is created — no 'Housing › Petrol' duplicate");
}

done();
