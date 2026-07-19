// Tests for the holdings CSV import: parser, canonical mapping, the merge/dedup
// engine (the corruption-critical core), and the store's atomic apply.

import { parseCsv, parseCsvTable } from "../src/lib/util/csv";
import {
  defaultPriceSource,
  detectDayFirst,
  guessAssetClass,
  parseImportDate,
  parseImportNumber,
  planImport,
  toCanonicalRows,
  type CanonicalRow,
  type ImportContext,
} from "../src/features/portfolio/domain/import-holdings";
import { createMemoryStorage } from "../src/lib/storage/memory-adapter";
import { SCHEMA } from "../src/features/portfolio/model/schema";
import { createPortfolioStore } from "../src/features/portfolio/state/store";
import type { Account, Holding, HoldingEvent } from "../src/features/portfolio/model/types";
import { done, eq, near, ok, section } from "./_harness";

// ---------------------------------------------------------------------------
section("[csv] RFC4180: quotes, embedded commas/newlines, CRLF, BOM");
{
  const rows = parseCsv('a,b,c\r\n1,"x,y","line1\nline2"\r\n"he said ""hi""",2,3\n');
  eq(rows.length, 3, "3 rows (trailing newline doesn't add one)");
  eq(rows[1][1], "x,y", "embedded comma preserved inside quotes");
  eq(rows[1][2], "line1\nline2", "embedded newline preserved inside quotes");
  eq(rows[2][0], 'he said "hi"', "escaped double-quote unescaped");
  const withBom = parseCsv("﻿a,b\n1,2\n");
  eq(withBom[0][0], "a", "leading BOM stripped");
}

section("[csv] parseCsvTable: headers, ragged rows, blank-line skip");
{
  const t = parseCsvTable("Date, Amount ,Note\n2024-01-01,100,hi\n2024-02-01,200\n\n");
  eq(t.headers.join("|"), "Date|Amount|Note", "headers trimmed");
  eq(t.rows.length, 2, "blank line skipped");
  eq(t.rows[0]["Amount"], "100", "cell trimmed + keyed by header");
  eq(t.rows[1]["Note"], "", "missing trailing cell → empty string, not undefined");
}

section("[import] number parsing: currency symbols, commas, parens-negative");
{
  eq(parseImportNumber("₹1,23,456.50"), 123456.5, "INR grouping + symbol stripped");
  eq(parseImportNumber("$1,000"), 1000, "USD symbol + comma");
  eq(parseImportNumber("(500)"), -500, "parenthesised → negative");
  eq(parseImportNumber(""), null, "blank → null");
  eq(parseImportNumber("  "), null, "whitespace → null");
  eq(parseImportNumber("N/A"), null, "junk → null");
}

section("[import] date parsing: ISO, dd/mm vs mm/dd, dd-Mon-yyyy, 2-digit year");
{
  eq(parseImportDate("2024-03-05"), "2024-03-05", "ISO");
  eq(parseImportDate("05/03/2024", true), "2024-03-05", "day-first numeric");
  eq(parseImportDate("03/05/2024", false), "2024-03-05", "month-first numeric");
  eq(parseImportDate("05-Mar-2024"), "2024-03-05", "dd-Mon-yyyy");
  eq(parseImportDate("5 Mar 24"), "2024-03-05", "2-digit year → 20xx");
  eq(parseImportDate("31/02/2024", true), null, "impossible date rejected (not shifted)");
  eq(parseImportDate("garbage"), null, "junk → null");
}

section("[import] toCanonicalRows: mapping + skips unusable rows");
{
  const table = parseCsvTable(
    "Trade Date,Type,Symbol,Qty,Price,Amount,Ref\n" +
      "05/01/2024,Buy,AAPL,10,100,,ORD1\n" +
      "06/01/2024,DIV,AAPL,,,50,ORD2\n" +
      "07/01/2024,Weird,AAPL,1,1,,ORD3\n" + // unmapped action → skip
      ",Buy,AAPL,1,1,,ORD4\n", // no date → skip
  );
  const cols = { date: "Trade Date", action: "Type", symbol: "Symbol", units: "Qty", price: "Price", amount: "Amount", ref: "Ref" };
  const actions = { buy: "buy" as const, div: "dividend" as const };
  const { rows, skipped } = toCanonicalRows(table, cols, actions, { dayFirst: true });
  eq(rows.length, 2, "buy + dividend mapped");
  eq(skipped, 2, "unmapped action + missing date skipped (not silently lost)");
  eq(rows[0].action, "buy", "buy mapped");
  eq(rows[1].action, "dividend", "div → dividend");
  eq(rows[0].ref, "ORD1", "broker ref carried");
}

// --- merge engine ---------------------------------------------------------

const ctxBase = (over: Partial<ImportContext> = {}): ImportContext => ({
  targetAccountId: "",
  targetPersonId: "shared",
  defaultAssetClass: "equity",
  defaultCurrency: "USD",
  holdings: [],
  events: [],
  asOf: "2025-01-01",
  ...over,
});
const buy = (symbol: string, date: string, units: number, price: number, ref?: string): CanonicalRow => ({
  date, action: "buy", symbol, units, price, ref,
});

section("[import] new holding: buys create a holding with correct after totals");
{
  const rows = [buy("AAPL", "2024-01-01", 10, 100), buy("AAPL", "2024-06-01", 5, 120)];
  const plan = planImport(rows, ctxBase());
  eq(plan.holdings.length, 1, "one holding planned");
  const p = plan.holdings[0];
  eq(p.existingHoldingId, null, "new holding");
  eq(p.draft?.assetClass, "equity", "uses default asset class");
  eq(p.draft?.ticker, "AAPL", "ticker from symbol");
  eq(p.newEvents.length, 2, "two buy events");
  eq(p.duplicates, 0, "no duplicates");
  eq(p.before.units, null, "before: nothing held");
  near(p.after.units ?? NaN, 15, 1e-9, "after: 15 units");
  near(p.after.invested, 1600, 1e-9, "after invested = 10·100 + 5·120");
  eq(plan.totals.newHoldings, 1, "totals");
}

section("[import] idempotent re-import: same rows against applied events → 0 new, all duplicates");
{
  const rows = [buy("AAPL", "2024-01-01", 10, 100), buy("AAPL", "2024-06-01", 5, 120)];
  const first = planImport(rows, ctxBase());
  const draft = first.holdings[0].draft as Holding;
  const applied = first.holdings[0].newEvents;
  const plan2 = planImport(rows, ctxBase({ holdings: [draft], events: applied }));
  const p = plan2.holdings[0];
  eq(p.existingHoldingId, draft.id, "re-matches the now-existing holding (by ticker)");
  eq(p.newEvents.length, 0, "nothing new on re-import");
  eq(p.duplicates, 2, "both rows recognised as duplicates (deterministic ids)");
}

section("[import] estimate-replace: a manual opening the import COVERS is superseded, NOT double-counted");
{
  const h: Holding = { id: "H1", name: "AAPL", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" };
  // Estimate dated AFTER the imported buys — the import re-delivers that money, so replace.
  const opening: HoldingEvent = { id: "o1", holdingId: "H1", date: "2024-06-01", type: "opening", amount: 1000 };
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ holdings: [h], events: [opening] }));
  const p = plan.holdings[0];
  eq(p.existingHoldingId, "H1", "matched the existing holding");
  eq(p.replacedOpeningIds.join(","), "o1", "the opening estimate is replaced");
  eq(p.newEvents.length, 1, "the imported buy is added");
  near(p.before.invested, 1000, 1e-9, "before: the 1000 estimate");
  near(p.after.invested, 1000, 1e-9, "after: 1000 from the real buy — NOT 2000 (no double-count)");
  near(p.after.units ?? NaN, 10, 1e-9, "after units from the imported buy");
}

section("[import] M2: an opening that PREDATES the import is KEPT, not deleted (no lost cost)");
{
  const h: Holding = { id: "H1", name: "AAPL", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" };
  // Old estimate for a big pre-history position; the import only brings a later, small buy.
  const opening: HoldingEvent = { id: "o1", holdingId: "H1", date: "2015-01-01", type: "opening", amount: 1_000_000 };
  const p = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ holdings: [h], events: [opening] })).holdings[0];
  eq(p.replacedOpeningIds.length, 0, "the 2015 estimate is NOT deleted (the 2024-only import doesn't cover it)");
  near(p.after.invested, 1_001_000, 1e-9, "invested = 1,000,000 estimate + 1,000 imported buy (nothing lost)");
  ok(p.warnings.some((w) => /predates the imported/i.test(w)), "warns that the estimate predates the import");
}

section("[import] estimate is NOT replaced when the import brings no buys (only dividends)");
{
  const h: Holding = { id: "H1", name: "AAPL", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "payout", ticker: "AAPL" };
  const opening: HoldingEvent = { id: "o1", holdingId: "H1", date: "2023-01-01", type: "opening", amount: 1000 };
  const div: CanonicalRow = { date: "2024-01-01", action: "dividend", symbol: "AAPL", amount: 50 };
  const p = planImport([div], ctxBase({ holdings: [h], events: [opening] })).holdings[0];
  eq(p.replacedOpeningIds.length, 0, "opening kept (no buys to replace the cost basis)");
  near(p.after.invested, 1000, 1e-9, "invested unchanged");
}

section("[import] matching: by name; account scoping; ambiguity; overrides");
{
  const inAcct: Holding = { id: "H1", name: "Nifty Index Fund", personId: "shared", accountId: "A", assetClass: "equity", currency: "INR", incomeMode: "accumulating" };
  const other: Holding = { id: "H2", name: "Nifty Index Fund", personId: "shared", accountId: "B", assetClass: "equity", currency: "INR", incomeMode: "accumulating" };
  const row = { date: "2024-01-01", action: "buy" as const, symbol: "Nifty Index Fund", units: 1, price: 100 };
  // by name, scoped to account A:
  const p = planImport([row], ctxBase({ targetAccountId: "A", defaultCurrency: "INR", holdings: [inAcct, other] })).holdings[0];
  eq(p.existingHoldingId, "H1", "matched by name within the target account only (not H2 in account B)");
  // two matches in the SAME account → ambiguous:
  const dup: Holding = { ...inAcct, id: "H1b" };
  const amb = planImport([row], ctxBase({ targetAccountId: "A", holdings: [inAcct, dup] }));
  eq(amb.ambiguous.length, 1, "two same-name holdings in the account → ambiguous");
  eq(amb.holdings.length, 0, "ambiguous symbol excluded from the applied plan until resolved");
  // override to force NEW even though a match exists:
  const forced = planImport([row], ctxBase({ targetAccountId: "A", holdings: [inAcct], matchOverrides: { "NIFTY INDEX FUND": "__new__" } })).holdings[0];
  eq(forced.existingHoldingId, null, "override __new__ forces a new holding");
}

section("[import] a sell exceeding units held is flagged");
{
  const rows: CanonicalRow[] = [{ date: "2024-01-01", action: "sell", symbol: "AAPL", units: 10, price: 100 }];
  const p = planImport(rows, ctxBase()).holdings[0];
  ok(p.warnings.some((w) => /exceed/i.test(w)), "warns that sells exceed units on record");
}

// --- store apply ----------------------------------------------------------

const bankUSD = (id: string): Account => ({ id, name: id, type: "brokerage", currency: "USD", personId: "shared" });

section("[store] applyImport creates holdings+events; re-plan is idempotent");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const rows = [buy("AAPL", "2024-01-01", 10, 100), buy("AAPL", "2024-06-01", 5, 120)];
  const ctx = ctxBase({ targetAccountId: "BRK" });
  const plan = planImport(rows, ctx);
  const written = await store.applyImport(plan);
  eq(written.holdings, 1, "one holding created");
  eq(written.events, 2, "two events written");
  eq(store.getState().holdings.length, 1, "holding persisted");
  eq(store.getState().holdingEvents.filter((e) => e.id.startsWith("import:")).length, 2, "events persisted");
  // Re-plan against live state → nothing new (idempotent).
  const s = store.getState();
  const plan2 = planImport(rows, ctxBase({ targetAccountId: "BRK", holdings: s.holdings, events: s.holdingEvents }));
  eq(plan2.totals.newEvents, 0, "re-import adds nothing");
  eq(plan2.totals.duplicates, 2, "recognised as duplicates");
}

section("[store] applyImport replaces an opening estimate atomically (no double-count in the ledger)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.saveHolding({ id: "H1", name: "AAPL", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" });
  await store.saveHoldingEvent({ id: "o1", holdingId: "H1", date: "2024-06-01", type: "opening", amount: 1000 });
  const s0 = store.getState();
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents }));
  await store.applyImport(plan);
  const ev = store.getState().holdingEvents.filter((e) => e.holdingId === "H1");
  ok(!ev.some((e) => e.id === "o1"), "the opening estimate was deleted");
  eq(ev.filter((e) => e.type === "buy").length, 1, "the imported buy was added");
}

section("[store] applyImport skips a merge target deleted during preview (no orphan events)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.saveHolding({ id: "H1", name: "AAPL", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" });
  const s0 = store.getState();
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents }));
  eq(plan.holdings[0].existingHoldingId, "H1", "plan targets the existing holding");
  await store.deleteHolding("H1"); // vanishes while the preview is open
  const written = await store.applyImport(plan);
  eq(written.events, 0, "nothing written — no orphan events for the deleted holding");
  eq(store.getState().holdingEvents.filter((e) => e.id.startsWith("import:")).length, 0, "no import events persisted");
}

// --- regression tests for the review-round fixes --------------------------

section("[import] number parsing REJECTS ambiguous formats (no silent mangling)");
{
  eq(parseImportNumber("1e3"), null, "scientific rejected (not 13)");
  eq(parseImportNumber("1.234,56"), null, "EU decimal rejected (not mis-parsed to 1.23456)");
  eq(parseImportNumber("1,23,456.50"), 123456.5, "INR lakh grouping still parses");
  eq(parseImportNumber("1,234.56"), 1234.56, "US grouping still parses");
  eq(parseImportNumber("-1,000.50"), -1000.5, "negative + grouping");
}

section("[import] rows sharing a broker ref get DISTINCT ids (no collision / silent overwrite)");
{
  const rows: CanonicalRow[] = [
    { date: "2024-01-01", action: "buy", symbol: "AAPL", units: 10, price: 100, ref: "ORD1" },
    { date: "2024-02-01", action: "buy", symbol: "AAPL", units: 7, price: 110, ref: "ORD1" }, // partial fill, same order id
  ];
  const p = planImport(rows, ctxBase()).holdings[0];
  eq(p.newEvents.length, 2, "both events kept");
  eq(new Set(p.newEvents.map((e) => e.id)).size, 2, "two DISTINCT ids despite the shared ref");
  near(p.after.units ?? NaN, 17, 1e-9, "both fills counted (17 units), not overwritten to 7");
  // re-import is still idempotent:
  const draft = p.draft as Holding;
  const p2 = planImport(rows, ctxBase({ holdings: [draft], events: p.newEvents })).holdings[0];
  eq(p2.newEvents.length, 0, "re-import adds nothing");
  eq(p2.duplicates, 2, "both recognised as duplicates");
}

section("[import] a units-bearing opening (real pre-history baseline) is NOT deleted");
{
  const h: Holding = { id: "H1", name: "AAPL", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" };
  const opening: HoldingEvent = { id: "o1", holdingId: "H1", date: "2015-01-01", type: "opening", units: 100, price: 50 };
  const p = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ holdings: [h], events: [opening] })).holdings[0];
  eq(p.replacedOpeningIds.length, 0, "the 100-unit baseline is preserved, not replaced");
  near(p.after.units ?? NaN, 110, 1e-9, "baseline (100) + imported buy (10) = 110");
  ok(p.warnings.some((w) => /starting quantity|baseline/i.test(w)), "warns to check for overlap");
}

section("[import] non-positive units/amount rows are skipped, not injected");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Price\n01/01/2024,Buy,AAPL,0,100\n02/01/2024,Buy,AAPL,-5,100\n03/01/2024,Buy,AAPL,10,100\n");
  const { rows, skipped } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price" }, { buy: "buy" }, { dayFirst: true });
  eq(rows.length, 1, "only the positive-qty buy is kept");
  eq(skipped, 2, "zero-qty and negative-qty rows skipped (counted, not injected as bad events)");
}

section("[csv] duplicate headers are disambiguated (no column silently lost)");
{
  const t = parseCsvTable("Amount,Note,Amount\n100,hi,200\n");
  eq(t.headers.join("|"), "Amount|Note|Amount (2)", "second Amount renamed");
  eq(t.rows[0]["Amount"], "100", "first Amount preserved");
  eq(t.rows[0]["Amount (2)"], "200", "second Amount preserved (not overwriting the first)");
}

section("[csv] a stray quote mid-field is literal — never swallows delimiters");
{
  const rows = parseCsv('ab"cd,ef\n');
  eq(rows.length, 1, "one row");
  eq(rows[0].length, 2, "the comma still split the row (delimiter not swallowed)");
  eq(rows[0][0], 'ab"cd', "the stray quote is a literal character");
}

section("[import] comma-only EU decimals are rejected, not mangled ×100");
{
  // A 2-digit FINAL group after a comma is an EU decimal — must reject, never ×100.
  eq(parseImportNumber("12,50"), null, "12,50 (EU €12.50) rejected, not read as 1250");
  eq(parseImportNumber("999,99"), null, "999,99 rejected, not read as 99999");
  eq(parseImportNumber("1,23"), null, "1,23 rejected, not read as 123");
  eq(parseImportNumber("0,5"), null, "0,5 rejected, not read as 05");
  // Genuine grouping (final group is 3 digits) still parses.
  eq(parseImportNumber("1,234"), 1234, "1,234 (US thousands) parses");
  eq(parseImportNumber("1,234,567"), 1234567, "1,234,567 (US) parses");
  eq(parseImportNumber("1,23,456"), 123456, "1,23,456 (Indian lakh) parses");
}

section("[import] a NEW holding takes the file's currency, not the import default (F2)");
{
  const rows: CanonicalRow[] = [
    { date: "2024-01-01", action: "buy", symbol: "NIFTYBEES", units: 10, price: 200, currency: "INR" },
    { date: "2024-02-01", action: "buy", symbol: "NIFTYBEES", units: 5, price: 210, currency: "INR" },
  ];
  const p = planImport(rows, ctxBase({ defaultCurrency: "USD" })).holdings[0];
  eq(p.currency, "INR", "planned holding currency = the file's uniform currency");
  eq((p.draft as Holding).currency, "INR", "the created draft stores INR, not the USD default");
}

section("[import] mixed row currencies for one symbol fall back to default + warn (F2)");
{
  const rows: CanonicalRow[] = [
    { date: "2024-01-01", action: "buy", symbol: "X", units: 1, price: 1, currency: "INR" },
    { date: "2024-02-01", action: "buy", symbol: "X", units: 1, price: 1, currency: "USD" },
  ];
  const p = planImport(rows, ctxBase({ defaultCurrency: "EUR" })).holdings[0];
  eq(p.currency, "EUR", "mixed currencies → the default, not a wrong guess");
  ok(p.warnings.some((w) => /mixed currenc/i.test(w)), "warns about the mixed currencies");
  eq(p.warnings.filter((w) => /mixed currenc/i.test(w)).length, 1, "the mixed-currency warning is not duplicated per row");
}

section("[import] an EXISTING holding keeps its own currency (import default ignored)");
{
  const h: Holding = { id: "H1", name: "AAPL", personId: "shared", accountId: "A", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" };
  const p = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "A", defaultCurrency: "INR", holdings: [h] })).holdings[0];
  eq(p.currency, "USD", "merge target's own currency, not the INR import default");
}

section("[import] re-import with rows REORDERED is still idempotent (F3 ref-counter)");
{
  // The worst case for the old ref-only key: two fills sharing BOTH the same ref AND
  // the same date, differing only in units. With a ref-only base key they collided and
  // were told apart only by a positional counter (#0/#1 in sorted order) — so a
  // different input order flipped which id each got, and a re-import re-injected both.
  // The base key now folds in row CONTENT, so each fill has a stable, order-independent id.
  const a: CanonicalRow = { date: "2024-01-01", action: "buy", symbol: "AAPL", units: 10, price: 100, ref: "ORD1" };
  const b: CanonicalRow = { date: "2024-01-01", action: "buy", symbol: "AAPL", units: 7, price: 110, ref: "ORD1" };
  const first = planImport([a, b], ctxBase()).holdings[0];
  eq(first.newEvents.length, 2, "both same-ref same-date fills kept as distinct events");
  eq(new Set(first.newEvents.map((e) => e.id)).size, 2, "two distinct ids");
  const draft = first.draft as Holding;
  // Same file, rows in the OPPOSITE order:
  const p2 = planImport([b, a], ctxBase({ holdings: [draft], events: first.newEvents })).holdings[0];
  eq(p2.newEvents.length, 0, "reordered re-import adds nothing");
  eq(p2.duplicates, 2, "both rows recognised as duplicates regardless of order");
}

// --- H1: units are never silently dropped when the price is blank ----------

section("[import] H1: a row with units but a BLANK price keeps the units (not dropped)");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Price,Amount\n01/01/2024,Buy,AAPL,10,,1000\n02/01/2024,Buy,AAPL,5,100,\n");
  const { rows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", amount: "Amount" }, { buy: "buy" }, { dayFirst: true });
  eq(rows.length, 2, "both buys kept");
  eq(rows[0].units, 10, "blank-price row still carries its 10 units");
  eq(rows[0].price, undefined, "no price attached (blank)");
  eq(rows[0].amount, 1000, "the amount is carried as the cost basis");
  const p = planImport(rows, ctxBase()).holdings[0];
  near(p.after.units ?? NaN, 15, 1e-9, "units = 10 + 5 = 15 (the 10 were NOT lost)");
  near(p.after.invested, 1500, 1e-9, "invested = 1000 (amount) + 500 (5×100)");
  ok(p.warnings.some((w) => /quantity but no price/i.test(w)), "warns about the price-less rows");
}

// --- H2: event ids keyed on the HOLDING, not the account -------------------

section("[import] H2: re-import after MOVING the holding's account still dedups");
{
  const p1 = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "A" })).holdings[0];
  const draft = p1.draft as Holding;
  eq(draft.accountId, "A", "created in account A");
  // User moves the holding to account B, then re-imports the SAME file into B.
  const moved: Holding = { ...draft, accountId: "B" };
  const p2 = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "B", holdings: [moved], events: p1.newEvents })).holdings[0];
  eq(p2.newEvents.length, 0, "no new events after the account move (ids keyed on the holding, not the account)");
  eq(p2.duplicates, 1, "the buy is recognised as a duplicate");
}

// --- M4: currency-token sanity check ---------------------------------------

section("[import] M4: a junk currency token is rejected (holding won't vanish from totals)");
{
  const junk = parseCsvTable("Date,Type,Sym,Qty,Price,Ccy\n01/01/2024,Buy,AAPL,10,100,Rupees\n");
  const { rows } = toCanonicalRows(junk, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", currency: "Ccy" }, { buy: "buy" }, { dayFirst: true });
  eq(rows[0].currency, undefined, '"Rupees" is not a 3-letter code → rejected (falls back to the default)');
  const ok3 = parseCsvTable("Date,Type,Sym,Qty,Price,Ccy\n01/01/2024,Buy,AAPL,10,100,inr\n");
  const { rows: r2 } = toCanonicalRows(ok3, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", currency: "Ccy" }, { buy: "buy" }, { dayFirst: true });
  eq(r2[0].currency, "INR", "a valid 3-letter code is upper-cased and kept");
}

// --- asset class: guess + override + merges keep their class ----------------

section("[import] guessAssetClass: recognises common broker security-type text");
{
  eq(guessAssetClass("Fixed Income"), "debt", "fixed income → debt");
  eq(guessAssetClass("Government Bond"), "debt", "bond → debt");
  eq(guessAssetClass("Equity"), "equity", "equity");
  eq(guessAssetClass("ETFs & Closed End Funds"), "equity", "ETF → equity");
  eq(guessAssetClass("Crypto"), "crypto", "crypto");
  eq(guessAssetClass("Gold ETF"), "gold", "gold checked before equity → gold, not equity");
  eq(guessAssetClass("Mutual Fund"), null, "bare 'Mutual Fund' is ambiguous → null (use default)");
  eq(guessAssetClass(""), null, "blank → null");
  eq(guessAssetClass(undefined), null, "missing → null");
}

section("[import] asset class: file guess overrides default; explicit override wins; merges keep their own");
{
  const rows: CanonicalRow[] = [{ date: "2024-01-01", action: "buy", symbol: "HDFCBOND", units: 1, price: 100, assetType: "Fixed Income" }];
  const guessed = planImport(rows, ctxBase({ defaultAssetClass: "equity" })).holdings[0];
  eq(guessed.assetClass, "debt", "guessed 'debt' from the security-type column, overriding the equity default");
  eq((guessed.draft as Holding).assetClass, "debt", "the created draft stores debt");
  const overridden = planImport(rows, ctxBase({ defaultAssetClass: "equity", assetClassOverrides: { HDFCBOND: "gold" } })).holdings[0];
  eq(overridden.assetClass, "gold", "explicit per-symbol override beats the file guess");
  const existing: Holding = { id: "H1", name: "HDFCBOND", personId: "shared", accountId: "A", assetClass: "crypto", currency: "USD", incomeMode: "accumulating", ticker: "HDFCBOND" };
  const merged = planImport(rows, ctxBase({ targetAccountId: "A", holdings: [existing], assetClassOverrides: { HDFCBOND: "gold" } })).holdings[0];
  eq(merged.assetClass, "crypto", "a merge target keeps its OWN class — an import never reclassifies it");
  eq(merged.draft, null, "no draft for a merge");
}

// --- live-price setup: source + exchange prefix ----------------------------

section("[import] defaultPriceSource: googlefinance for all but crypto");
{
  eq(defaultPriceSource("equity"), "googlefinance", "equity → google finance");
  eq(defaultPriceSource("debt"), "googlefinance", "debt (incl. MFs) → google finance");
  eq(defaultPriceSource("gold"), "googlefinance", "gold → google finance");
  eq(defaultPriceSource("crypto"), "coingecko", "crypto → coingecko");
}

section("[import] new holdings get a ticker + price source; exchange prefix applied for Google Finance");
{
  const inr = planImport([buy("INFY", "2024-01-01", 10, 100)], ctxBase({ defaultAssetClass: "equity", googleFinanceExchange: "NSE" })).holdings[0];
  const d = inr.draft as Holding;
  eq(d.priceSource, "googlefinance", "google finance source set");
  eq(d.ticker, "NSE:INFY", "exchange prefix prepended so it prices out of the box");
  const us = planImport([buy("VOO", "2024-01-01", 10, 100)], ctxBase({ defaultAssetClass: "equity" })).holdings[0];
  eq((us.draft as Holding).ticker, "VOO", "no exchange set → US ticker left as-is");
  const already = planImport([buy("NSE:INFY", "2024-01-01", 10, 100)], ctxBase({ defaultAssetClass: "equity", googleFinanceExchange: "NSE" })).holdings[0];
  eq((already.draft as Holding).ticker, "NSE:INFY", "a symbol that already has an exchange is not double-prefixed");
  const btc = planImport([{ date: "2024-01-01", action: "buy", symbol: "bitcoin", units: 1, price: 100, assetType: "Crypto" }], ctxBase({ googleFinanceExchange: "NSE" })).holdings[0];
  const b = btc.draft as Holding;
  eq(b.priceSource, "coingecko", "crypto → coingecko");
  eq(b.ticker, "bitcoin", "the google-finance exchange prefix is NOT applied to a coingecko ticker");
}

// --- ignored transactions with reasons -------------------------------------

section("[import] skipped rows are collected WITH reasons + identifying cells");
{
  const table = parseCsvTable(
    "Date,Type,Sym,Amount\n" +
      "01/01/2024,Buy,AAPL,100\n" + // good
      ",Buy,AAPL,100\n" + // no date
      "01/01/2024,Weird,AAPL,100\n" + // unmapped action
      "01/01/2024,Buy,,100\n" + // no symbol
      "01/01/2024,Buy,AAPL,0\n", // zero amount
  );
  const { rows, skipped, skippedRows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", amount: "Amount" }, { buy: "buy" }, { dayFirst: true });
  eq(rows.length, 1, "only the one good row is imported");
  eq(skipped, 4, "four rows skipped (count preserved for existing callers)");
  eq(skippedRows.length, 4, "…and detailed");
  ok(skippedRows.some((s) => /date/i.test(s.reason)), "missing-date reason present");
  ok(skippedRows.some((s) => /not mapped/i.test(s.reason)), "unmapped-action reason present");
  ok(skippedRows.some((s) => /security|symbol/i.test(s.reason)), "no-symbol reason present");
  ok(skippedRows.some((s) => /quantity or amount/i.test(s.reason)), "no-amount reason present");
  const unmapped = skippedRows.find((s) => /not mapped/i.test(s.reason));
  eq(unmapped?.cells.action, "Weird", "the raw action cell is captured for display");
}

// --- store: concurrent previews, deleted owner, deleted account -------------

section("[store] applyImport: two previews of the same NEW holding create ONE, not two (M1)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  const opts = { targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents };
  const planA = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase(opts));
  const planB = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase(opts)); // built from the SAME pre-apply state
  await store.applyImport(planA);
  await store.applyImport(planB);
  const hs = store.getState().holdings.filter((h) => h.ticker === "AAPL");
  eq(hs.length, 1, "only ONE AAPL holding despite two independent previews");
  const buys = store.getState().holdingEvents.filter((e) => e.type === "buy");
  eq(buys.length, 1, "the buy was not double-counted");
}

section("[store] applyImport: an owner deleted during preview falls back to shared (M3)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.savePerson({ id: "alice", name: "Alice" });
  const s0 = store.getState();
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", targetPersonId: "alice", holdings: s0.holdings, events: s0.holdingEvents }));
  await store.deletePerson("alice"); // allowed — she owns nothing yet
  await store.applyImport(plan);
  const h = store.getState().holdings.find((x) => x.ticker === "AAPL");
  eq(h?.personId, "shared", "dangling owner replaced with 'shared', not persisted as a broken ref");
}

section("[store] applyImport: an account deleted during preview → holding kept, unassigned (F6)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents }));
  await store.deleteAccount("BRK");
  await store.applyImport(plan);
  const h = store.getState().holdings.find((x) => x.ticker === "AAPL");
  ok(h !== undefined, "the holding is still created");
  eq(h?.accountId, undefined, "its accountId is unassigned, not a dangling id");
}

// --- follow-up review fixes (N1–N8 + date auto-detect) ---------------------

section("[import] detectDayFirst: infers date format from the data (fixes Schwab US dates)");
{
  eq(detectDayFirst(["06/30/2026", "07/07/2026"]), false, "a >12 in position 2 → month-first (US/Schwab)");
  eq(detectDayFirst(["30/06/2026", "07/07/2026"]), true, "a >12 in position 1 → day-first");
  eq(detectDayFirst(["07/07/2026", "05/06/2026"]), null, "all ambiguous → null (keep the user's choice)");
  eq(detectDayFirst(["2024-03-05", "29-MAY-2023"]), null, "ISO / dd-Mon are unambiguous → ignored → null");
  eq(detectDayFirst(["13/01/2024", "01/13/2024"]), null, "contradictory signals → null");
}

section("[import] N3: price 0 with an amount keeps the cost basis (not zeroed)");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Price,Amount\n01/01/2024,Buy,AAPL,10,0,1000\n");
  const { rows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", amount: "Amount" }, { buy: "buy" }, { dayFirst: true });
  eq(rows[0].price, undefined, "price 0 is NOT attached");
  eq(rows[0].units, 10, "units kept");
  eq(rows[0].amount, 1000, "amount carried as cost basis");
  const p = planImport(rows, ctxBase()).holdings[0];
  near(p.after.invested, 1000, 1e-9, "invested = 1000 (from amount), not 0 (10 × price-0)");
  ok(p.warnings.some((w) => /quantity but no price/i.test(w)), "warns");
}

section("[import] N6: a units-only 'dividend' (no amount/price) is skipped, not a 0-amount event");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Amount\n01/01/2024,Div,AAPL,5,\n02/01/2024,Div,AAPL,,50\n");
  const { rows, skippedRows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", amount: "Amount" }, { div: "dividend" }, { dayFirst: true });
  eq(rows.length, 1, "only the dividend WITH an amount survives");
  eq(rows[0].amount, 50, "the real dividend amount");
  ok(skippedRows.some((s) => /dividend/i.test(s.reason)), "the units-only dividend is skipped with a reason");
}

section("[import] N5: an exchange-prefixed stored ticker matches a raw file symbol");
{
  const h: Holding = { id: "H1", name: "Infosys", personId: "shared", accountId: "A", assetClass: "equity", currency: "INR", incomeMode: "accumulating", ticker: "NSE:INFY" };
  const p = planImport([buy("INFY", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "A", defaultCurrency: "INR", holdings: [h] })).holdings[0];
  eq(p.existingHoldingId, "H1", "raw 'INFY' matches stored 'NSE:INFY' (exchange prefix ignored) — no bogus new holding");
}

section("[import] N7: existing buys + leftover opening estimate + import buys → double-count warning");
{
  const h: Holding = { id: "H1", name: "AAPL", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" };
  const events: HoldingEvent[] = [
    { id: "o1", holdingId: "H1", date: "2020-01-01", type: "opening", amount: 5000 },
    { id: "b1", holdingId: "H1", date: "2021-01-01", type: "buy", units: 10, price: 100 },
  ];
  const p = planImport([buy("AAPL", "2024-01-01", 5, 200)], ctxBase({ holdings: [h], events })).holdings[0];
  eq(p.replacedOpeningIds.length, 0, "not auto-replaced (existing already has real buys)");
  ok(p.warnings.some((w) => /double-count/i.test(w)), "warns the leftover estimate may double-count");
}

section("[import] N8: guessAssetClass order — SGB→gold, gilt→debt, equity-savings→equity");
{
  eq(guessAssetClass("Sovereign Gold Bond"), "gold", "SGB → gold, not debt via 'bond'");
  eq(guessAssetClass("Gilt Fund"), "debt", "gilt → debt");
  eq(guessAssetClass("Equity Savings Fund"), "equity", "equity savings → equity, not cash via 'savings'");
  eq(guessAssetClass("Liquid Fund"), "debt", "liquid fund → debt");
}

section("[store] N2: two symbols merged into ONE holding keep BOTH identical-content events");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.saveHolding({ id: "H1", name: "Combo", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "COMBO" });
  const s0 = store.getState();
  const rows: CanonicalRow[] = [
    { date: "2024-01-01", action: "buy", symbol: "AAA", units: 10, price: 100 },
    { date: "2024-01-01", action: "buy", symbol: "BBB", units: 10, price: 100 }, // identical content, different symbol
  ];
  const plan = planImport(rows, ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents, matchOverrides: { AAA: "H1", BBB: "H1" } }));
  const ids = plan.holdings.flatMap((p) => p.newEvents.map((e) => e.id));
  eq(ids.length, 2, "two events planned");
  eq(new Set(ids).size, 2, "with DISTINCT ids (no cross-symbol collision)");
  await store.applyImport(plan);
  const ev = store.getState().holdingEvents.filter((e) => e.holdingId === "H1");
  eq(ev.length, 2, "both events persisted into H1 (neither silently dropped)");
}

section("[store] N1: apply respects an explicit '__new__' pick even when a same-ticker holding exists");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.saveHolding({ id: "H1", name: "AAPL a", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" });
  await store.saveHolding({ id: "H2", name: "AAPL b", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" });
  await store.saveHoldingEvent({ id: "m1", holdingId: "H1", date: "2024-01-01", type: "buy", units: 10, price: 100 });
  const s0 = store.getState();
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents, matchOverrides: { AAPL: "__new__" } }));
  eq(plan.holdings[0].existingHoldingId, null, "planned as a NEW holding (user forced it)");
  await store.applyImport(plan);
  const aapl = store.getState().holdings.filter((h) => h.ticker === "AAPL");
  eq(aapl.length, 3, "a THIRD holding was created — the __new__ pick respected, not merged into H1/H2");
  eq(store.getState().holdingEvents.filter((e) => e.holdingId === "H1").length, 1, "H1 keeps only its original event (no double-count)");
}

section("[store] N4: deleted account + a loose same-ticker holding → new unassigned holding, bystander untouched");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.saveHolding({ id: "RSU", name: "AAPL RSUs", personId: "shared", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" });
  await store.saveHoldingEvent({ id: "r1", holdingId: "RSU", date: "2023-01-01", type: "buy", units: 50, price: 100 });
  const s0 = store.getState();
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 200)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents }));
  await store.deleteAccount("BRK");
  await store.applyImport(plan);
  eq(store.getState().holdingEvents.filter((e) => e.holdingId === "RSU").length, 1, "the loose RSU holding is untouched (import did NOT hijack it)");
  const imported = store.getState().holdings.find((h) => h.ticker === "AAPL" && h.id !== "RSU");
  ok(imported !== undefined, "a separate holding was created for the import");
  eq(imported?.accountId, undefined, "…unassigned (its account was deleted mid-preview)");
}

section("[import] CAS convention: negative units on a SELL are a magnitude (redemption reduces units)");
{
  const table = parseCsvTable("Scheme,Txn,Date,NAV,Units,Amount\nFund X,Purchase,01-JAN-2024,10,100,1000\nFund X,Redemption,01-FEB-2024,12,-40,-480\n");
  const { rows } = toCanonicalRows(table, { date: "Date", action: "Txn", symbol: "Scheme", units: "Units", price: "NAV", amount: "Amount" }, { purchase: "buy", redemption: "sell" }, { dayFirst: true });
  eq(rows.length, 2, "both the purchase and the negative-signed redemption are kept");
  eq(rows[1].action, "sell", "redemption → sell");
  eq(rows[1].units, 40, "the negative units become a positive magnitude");
  eq(rows[1].amount, 480, "the negative amount becomes a positive magnitude");
  const p = planImport(rows, ctxBase({ defaultCurrency: "INR" })).holdings[0];
  near(p.after.units ?? NaN, 60, 1e-9, "100 bought − 40 redeemed = 60 (the sell actually reduces units)");
}

section("[import] a BUY with negative units is STILL skipped (data error, not a signed sell)");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Price\n01/01/2024,Buy,AAPL,-5,100\n02/01/2024,Buy,AAPL,10,100\n");
  const { rows, skipped } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price" }, { buy: "buy" }, { dayFirst: true });
  eq(rows.length, 1, "only the positive buy kept");
  eq(skipped, 1, "the negative-qty buy is skipped — a buy magnitude is not inferred from a negative");
}

section("[import] F1: bonds quoted per-100 face use the cash AMOUNT as cost (not units×price)");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Price,Amount\n01/01/2024,Buy,TBILL,10000,98.8265,-9882.65\n");
  const { rows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", amount: "Amount" }, { buy: "buy" }, { dayFirst: true });
  const p = planImport(rows, ctxBase()).holdings[0];
  near(p.after.invested, 9882.65, 1e-6, "cost = the $9,882.65 cash amount, NOT 10000 × 98.83 = 988,265");
  near(p.after.units ?? NaN, 10000, 1e-9, "still tracks 10,000 units");
  ok(p.warnings.some((w) => /per 100|disagrees/i.test(w)), "warns about the quantity×price vs amount discrepancy");
}

section("[import] F1: a normal buy (units×price ≈ amount) keeps units×price — no false trigger");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Price,Amount\n01/01/2024,Buy,MSFT,5,354.09,-1770.45\n");
  const { rows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", amount: "Amount" }, { buy: "buy" }, { dayFirst: true });
  const p = planImport(rows, ctxBase()).holdings[0];
  near(p.after.invested, 1770.45, 1e-6, "5 × 354.09 = 1770.45");
  ok(!p.warnings.some((w) => /per 100|disagrees/i.test(w)), "no discrepancy warning for an ordinary stock buy");
}

section("[import] F2: a negative dividend (reversal) is skipped, not flipped into positive income");
{
  const table = parseCsvTable("Date,Type,Sym,Amount\n01/01/2024,Div,AAPL,-6.90\n02/01/2024,Div,AAPL,50\n");
  const { rows, skippedRows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", amount: "Amount" }, { div: "dividend" }, { dayFirst: true });
  eq(rows.length, 1, "only the positive dividend is kept");
  eq(rows[0].amount, 50, "the +50 dividend");
  ok(skippedRows.some((s) => /dividend/i.test(s.reason)), "the −6.90 reversal is skipped with a reason (not booked as +6.90)");
}

section("[import] F5: a negative fee (rebate) is dropped, not added as a charge");
{
  const table = parseCsvTable("Date,Type,Sym,Qty,Price,Fee\n01/01/2024,Buy,AAPL,10,100,-5\n");
  const { rows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", fee: "Fee" }, { buy: "buy" }, { dayFirst: true });
  eq(rows[0].fee, undefined, "negative fee dropped");
  const p = planImport(rows, ctxBase()).holdings[0];
  near(p.after.invested, 1000, 1e-9, "invested = 10 × 100 = 1000 (a rebate isn't added as a charge)");
}

section("[import] F6: exchange-prefix matching doesn't over-collapse colon-in-name schemes");
{
  const a: Holding = { id: "HA", name: "Franklin US Opp", personId: "shared", accountId: "A", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "Franklin Feeder: US Opportunities" };
  const row: CanonicalRow = { date: "2024-01-01", action: "buy", symbol: "Motilal Feeder: US Opportunities", units: 1, price: 100 };
  const p = planImport([row], ctxBase({ targetAccountId: "A", holdings: [a] })).holdings[0];
  eq(p.existingHoldingId, null, "a DIFFERENT colon-name scheme is not collapsed into HA");
  const b: Holding = { id: "HB", name: "Infosys", personId: "shared", accountId: "A", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "NSE:INFY" };
  const p2 = planImport([buy("INFY", "2024-01-01", 1, 100)], ctxBase({ targetAccountId: "A", holdings: [b] })).holdings[0];
  eq(p2.existingHoldingId, "HB", "but a real exchange prefix (NSE:INFY) still matches raw INFY");
}

section("[import] F-B: a negative dividend WITH units+price is still skipped (no sign flip via units×price)");
{
  // amount −50 (reversal) but units×price would compute +50 — must NOT be booked as income.
  const table = parseCsvTable("Date,Type,Sym,Qty,Price,Amount\n01/01/2024,Div,AAPL,5,10,-50\n02/01/2024,Div,AAPL,,,50\n");
  const { rows, skippedRows } = toCanonicalRows(table, { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", amount: "Amount" }, { div: "dividend" }, { dayFirst: true });
  eq(rows.length, 1, "only the genuine +50 dividend is kept");
  eq(rows[0].amount, 50, "the positive dividend");
  ok(skippedRows.some((s) => /reversal|non-positive/i.test(s.reason)), "the −50 (with a units×price that would flip +50) is skipped with a reason");
}

section("[store] DEDUP: importing the SAME multi-holding file twice adds no duplicate holdings or transactions");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  // A representative file: 3 securities, buys + a sell + a dividend, some signed & blank cells.
  const csv =
    "Date,Type,Sym,Qty,Price,Amount\n" +
    "01/01/2024,Buy,AAPL,10,150,-1500\n" +
    "02/01/2024,Buy,AAPL,5,160,-800\n" +
    "03/01/2024,Sell,AAPL,4,170,680\n" +
    "01/01/2024,Buy,VOO,2,400,-800\n" +
    "15/02/2024,Dividend,VOO,,,12.50\n" +
    "01/03/2024,Buy,GOLDBEES,100,60,-6000\n";
  const table = parseCsvTable(csv);
  const cols = { date: "Date", action: "Type", symbol: "Sym", units: "Qty", price: "Price", amount: "Amount" };
  const actions = { buy: "buy" as const, sell: "sell" as const, dividend: "dividend" as const };
  const canonical = toCanonicalRows(table, cols, actions, { dayFirst: true });
  const ctx = (): ImportContext => ({
    targetAccountId: "BRK", targetPersonId: "shared", defaultAssetClass: "equity", defaultCurrency: "USD",
    holdings: store.getState().holdings, events: store.getState().holdingEvents, asOf: "2025-01-01",
  });

  const w1 = await store.applyImport(planImport(canonical.rows, ctx()));
  const h1 = store.getState().holdings.length;
  const e1 = store.getState().holdingEvents.length;
  eq(h1, 3, "first import creates 3 holdings (AAPL, VOO, GOLDBEES)");
  eq(w1.events, e1, "first import wrote all its events");

  // Re-import the EXACT same file.
  const plan2 = planImport(canonical.rows, ctx());
  const w2 = await store.applyImport(plan2);
  eq(w2.holdings, 0, "2nd import creates NO new holdings");
  eq(w2.events, 0, "2nd import writes NO new transactions");
  eq(store.getState().holdings.length, h1, "holding count unchanged after re-import");
  eq(store.getState().holdingEvents.length, e1, "event count unchanged after re-import");
  eq(plan2.holdings.reduce((n, p) => n + p.duplicates, 0), canonical.rows.length, "every row recognised as a duplicate");
}

// --- undo an import ---------------------------------------------------------

section("[store] undo: a new-holding import records a batch and undoImportBatch fully reverts it");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  const plan = planImport(
    [buy("AAPL", "2024-01-01", 10, 100), buy("VOO", "2024-01-02", 2, 400)],
    ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents }),
  );
  const res = await store.applyImport(plan, { label: "test.csv" });
  ok(res.batch !== null, "an undo batch is recorded");
  eq(store.getState().holdings.length, 2, "2 holdings created");
  eq(store.getState().holdingEvents.length, 2, "2 transactions added");
  const rev = await store.undoImportBatch(res.batch!.id);
  ok(rev !== null, "undo ran");
  eq(store.getState().holdings.length, 0, "the created holdings are removed");
  eq(store.getState().holdingEvents.length, 0, "the added transactions are removed");
  eq((await store.listImportBatches()).length, 0, "the batch record is consumed");
}

section("[store] undo: a MERGE keeps the pre-existing holding + its events, and restores a replaced opening");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.saveHolding({ id: "H1", name: "AAPL", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" });
  await store.saveHoldingEvent({ id: "o1", holdingId: "H1", date: "2024-06-01", type: "opening", amount: 1000 }); // estimate the import replaces
  const s0 = store.getState();
  const plan = planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents }));
  const res = await store.applyImport(plan, { label: "merge.csv" });
  ok(!store.getState().holdingEvents.some((e) => e.id === "o1"), "opening estimate was replaced (deleted) on import");
  await store.undoImportBatch(res.batch!.id);
  ok(store.getState().holdings.some((h) => h.id === "H1"), "the pre-existing merge-target holding is KEPT (not deleted)");
  ok(store.getState().holdingEvents.some((e) => e.id === "o1"), "the replaced opening estimate is restored");
  eq(store.getState().holdingEvents.filter((e) => e.type === "buy").length, 0, "the imported buy is removed");
}

section("[store] undo: a created holding you added your OWN transaction to is KEPT (only imported rows go)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  const res = await store.applyImport(
    planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents })),
    { label: "x.csv" },
  );
  const created = store.getState().holdings.find((h) => h.ticker === "AAPL")!;
  await store.saveHoldingEvent({ id: "manual1", holdingId: created.id, date: "2025-01-01", type: "buy", units: 5, price: 120 });
  await store.undoImportBatch(res.batch!.id);
  ok(store.getState().holdings.some((h) => h.id === created.id), "the holding is KEPT (it has a manual transaction)");
  const ev = store.getState().holdingEvents.filter((e) => e.holdingId === created.id);
  eq(ev.length, 1, "only the manual transaction remains");
  eq(ev[0].id, "manual1", "the imported row was removed, the manual one kept");
}

section("[store] undo: the import-undo log is device-local (stripped from the backup/sync snapshot)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  await store.applyImport(
    planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents })),
    { label: "y.csv" },
  );
  eq((await store.listImportBatches()).length, 1, "batch recorded locally");
  const doc = await store.exportDocument();
  eq((doc.data.importBatches ?? []).length, 0, "the snapshot does NOT carry the import-undo log");
}

section("[store] undo: incremental import into a holding with PRIOR transactions removes ONLY the imported rows");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  await store.saveHolding({ id: "H1", name: "AAPL", personId: "shared", accountId: "BRK", assetClass: "equity", currency: "USD", incomeMode: "accumulating", ticker: "AAPL" });
  // Prior transactions the user already had (manual or an earlier import) — NOT this import.
  await store.saveHoldingEvent({ id: "prior1", holdingId: "H1", date: "2023-01-01", type: "buy", units: 10, price: 50 });
  await store.saveHoldingEvent({ id: "prior2", holdingId: "H1", date: "2023-06-01", type: "buy", units: 5, price: 60 });
  const s0 = store.getState();
  // Now incrementally import 2026 transactions INTO that same holding (a merge, not a create).
  const plan = planImport(
    [buy("AAPL", "2026-01-01", 3, 100), buy("AAPL", "2026-02-01", 2, 110)],
    ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents }),
  );
  const res = await store.applyImport(plan, { label: "2026.csv" });
  eq(res.batch!.createdHoldingIds.length, 0, "no holding created — the import merged into the existing one");
  eq(store.getState().holdingEvents.filter((e) => e.holdingId === "H1").length, 4, "2 prior + 2 imported");
  await store.undoImportBatch(res.batch!.id);
  ok(store.getState().holdings.some((h) => h.id === "H1"), "the pre-existing holding is KEPT");
  const ev = store.getState().holdingEvents.filter((e) => e.holdingId === "H1");
  eq(ev.length, 2, "only the 2 prior transactions remain");
  ok(ev.every((e) => e.id === "prior1" || e.id === "prior2"), "the imported 2026 rows were removed; the prior ones are untouched");
}

section("[store] undo: an AUTO price-refresh valuation does not keep an import-created holding");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  const res = await store.applyImport(
    planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents })),
    { label: "a.csv" },
  );
  const h = store.getState().holdings.find((x) => x.ticker === "AAPL")!;
  // A price refresh added an auto valuation (its "amount") — not user data.
  await store.saveHoldingEvent({ id: `auto-${h.id}-2025-01-01`, holdingId: h.id, date: "2025-01-01", type: "valuation", amount: 1500, price: 150, note: "auto: live price" });
  await store.undoImportBatch(res.batch!.id);
  ok(!store.getState().holdings.some((x) => x.id === h.id), "the created holding is removed despite the auto valuation");
  eq(store.getState().holdingEvents.filter((e) => e.holdingId === h.id).length, 0, "its auto valuation is cleaned up too (no orphan event)");
}

section("[store] undo: a MANUAL valuation you set keeps the import-created holding (your data)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  const res = await store.applyImport(
    planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents })),
    { label: "b.csv" },
  );
  const h = store.getState().holdings.find((x) => x.ticker === "AAPL")!;
  await store.saveHoldingEvent({ id: "manualval1", holdingId: h.id, date: "2025-01-01", type: "valuation", amount: 1500, price: 150 }); // no auto note = user-entered
  await store.undoImportBatch(res.batch!.id);
  ok(store.getState().holdings.some((x) => x.id === h.id), "holding KEPT — a manual valuation is user data");
  const ev = store.getState().holdingEvents.filter((e) => e.holdingId === h.id);
  eq(ev.length, 1, "only the manual valuation remains");
  eq(ev[0].id, "manualval1", "the imported buy was removed, the manual valuation kept");
}

section("[store] undo twice → the second call returns null (already undone), no double-delete");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  const s0 = store.getState();
  const res = await store.applyImport(
    planImport([buy("AAPL", "2024-01-01", 10, 100)], ctxBase({ targetAccountId: "BRK", holdings: s0.holdings, events: s0.holdingEvents })),
    { label: "z.csv" },
  );
  const first = await store.undoImportBatch(res.batch!.id);
  ok(first !== null && first.events === 1, "first undo reverts the import");
  const second = await store.undoImportBatch(res.batch!.id);
  eq(second, null, "second undo returns null — nothing left to revert");
  eq(store.getState().holdings.length, 0, "no resurrection or double-delete");
}

section("[store] undo log is count-bounded (keeps the most recent ~25 imports)");
{
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.saveAccount(bankUSD("BRK"));
  for (let i = 0; i < 27; i++) {
    const s = store.getState();
    await store.applyImport(
      planImport([buy(`SYM${i}`, "2024-01-01", 1, 100)], ctxBase({ targetAccountId: "BRK", holdings: s.holdings, events: s.holdingEvents })),
      { label: `f${i}.csv` },
    );
  }
  const list = await store.listImportBatches();
  ok(list.length <= 25, `the log is capped (${list.length} ≤ 25), not unbounded`);
  ok(list[0].label === "f26.csv", "the most recent import is retained");
}

done();
