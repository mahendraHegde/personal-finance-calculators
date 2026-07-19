// Import historical investments from a broker / mutual-fund CSV export. This is the
// PURE core: it turns mapped CSV rows into a detailed, reviewable PLAN — never
// touches the store. The store applies the plan atomically (see applyImportPlan).
//
// Design goals (data-loss / corruption are the enemy):
//  - IDEMPOTENT re-import: every imported event gets a DETERMINISTIC id, so
//    re-importing the same file (or an overlapping range) adds nothing new.
//  - NO double-count on merge: an imported security is matched to an existing
//    holding (by ticker, then name, scoped to the target account); if that holding
//    holds only a manual ESTIMATE (opening, no real buys) and the import brings real
//    buys, the estimate is REPLACED by the real history (upgraded), not stacked.
//  - Full transparency: the plan carries each holding's before/after units, cost,
//    and value so the UI can show an exact diff and the user confirms before write.

import { isoFromParts } from "../../../lib/util/date";
import type { CsvTable } from "../../../lib/util/csv";
import type { CurrencyCode } from "../../../lib/money/currency";
import type { AssetClass, Holding, HoldingEvent, Owner, PriceSource } from "../model/types";
import { newId } from "../../../lib/util/id";
import { currentHoldingValue, holdingPnl, netUnits, withFdAccrual } from "./holdings";

// --- Canonical row --------------------------------------------------------

/** A source-agnostic transaction row, produced from the CSV + the user's column /
 *  action mapping. `action` is already normalised to an event type. */
export interface CanonicalRow {
  /** ISO yyyy-mm-dd. */
  date: string;
  action: "buy" | "sell" | "dividend";
  /** Security identifier from the file (ticker / scheme code / name); used to group
   *  rows and match to an existing holding. */
  symbol: string;
  name?: string;
  units?: number;
  price?: number;
  amount?: number;
  fee?: number;
  currency?: CurrencyCode;
  /** The broker's own transaction/order reference, if the file has one — the most
   *  reliable dedup key. */
  ref?: string;
  /** Raw security-type / asset-class text from the file (e.g. "Equity", "Fixed
   *  Income", "ETF") — used to GUESS a new holding's asset class. Never stored. */
  assetType?: string;
}

// --- Column / action mapping (CSV -> canonical) ---------------------------

export interface ColumnMap {
  date: string; // header names
  action: string;
  symbol: string;
  name?: string;
  units?: string;
  price?: string;
  amount?: string;
  fee?: string;
  currency?: string;
  ref?: string;
  assetType?: string;
}
/** Maps a raw action cell value (lower-cased) to a canonical action, or "ignore". */
export type ActionMap = Record<string, "buy" | "sell" | "dividend" | "ignore">;

/** Guess an asset class from a broker's raw "security type" text (e.g. Schwab's
 *  "Equity", "ETFs & Closed End Funds", "Fixed Income"). Returns null when the text
 *  is absent or ambiguous (e.g. a bare "Mutual Fund") so the caller falls back to the
 *  import default rather than guess wrong. Order matters: check debt before equity so
 *  "bond fund" → debt, not equity. */
export function guessAssetClass(raw: string | undefined): AssetClass | null {
  const s = (raw ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (/crypto|digital asset|coin|token/.test(s)) return "crypto";
  if (/gold|silver|bullion|commodit|sgb|sovereign gold/.test(s)) return "gold"; // before debt: an SGB is gold, not "bond"→debt
  if (/reit|real estate|realty|property/.test(s)) return "realestate";
  if (/bond|fixed income|debt|treasury|gilt|debenture|g-sec|govt sec|money market|liquid fund|overnight fund/.test(s)) return "debt";
  if (/equity|stock|share|etf|index|equit/.test(s)) return "equity"; // before cash: "Equity Savings" is equity, not cash
  if (/\bcash\b|cash fund|cash management/.test(s)) return "cash";
  return null; // bare "mutual fund", "other", unknown → let the default decide
}

/** The default live-price source for a new imported holding. Google Finance covers
 *  stocks, ETFs AND mutual funds, so it's the default for everything EXCEPT crypto
 *  (CoinGecko). The user can change the source per holding afterward. */
export function defaultPriceSource(assetClass: AssetClass): PriceSource | undefined {
  return assetClass === "crypto" ? "coingecko" : "googlefinance";
}

/** Parse a numeric cell for EN/INR-formatted numbers (dot = decimal, comma =
 *  thousands, incl. Indian lakh grouping). Strips currency symbols/spaces and reads
 *  (1,234) as -1234. Crucially it REJECTS (returns null) rather than silently
 *  mangles anything ambiguous — EU decimals ("1.234,56"), scientific ("1e3"), or
 *  other letters — because a mis-parsed amount corrupts the ledger. */
export function parseImportNumber(raw: string): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s === "") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₹$€£\s]/g, ""); // currency symbols + whitespace only
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  if (/[a-zA-Z]/.test(s)) return null; // "1e3", "USD100", "N/A" → reject, don't strip-and-guess
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // Whichever separator is LAST is the decimal. Last-comma = EU decimal → reject.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) return null;
    s = s.replace(/,/g, ""); // EN: comma is thousands
  } else if (hasComma) {
    // Only commas: accept ONLY genuine EN/INR grouping, where the FINAL group is
    // always exactly 3 digits — all-3-digit (US: 1,234,567) or Indian lakh
    // (2-digit groups then a 3-digit tail: 1,23,456). A 2-digit final group ("12,50",
    // "1,234,56") is an EU decimal → reject rather than mangle it ×100.
    if (!/^\d{1,3}((,\d{3})+|(,\d{2})+,\d{3})$/.test(s)) return null;
    s = s.replace(/,/g, "");
  }
  if (!/^\d*\.?\d+$/.test(s)) return null; // must now be plain digits(.digits)
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse a date cell to ISO yyyy-mm-dd, or null. Handles ISO (yyyy-mm-dd),
 *  dd-Mon-yyyy / dd Mon yyyy (unambiguous), and numeric d/m/y or m/d/y separated by
 *  / - or . — the numeric case uses `dayFirst` to resolve the d-vs-m ambiguity. */
export function parseImportDate(raw: string, dayFirst = true): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (s === "") return null;
  // ISO first.
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (iso) return validIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  // dd-Mon-yyyy / dd Mon yyyy.
  const mon = /^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})/.exec(s);
  if (mon) {
    const m = MONTHS[mon[2].slice(0, 3).toLowerCase()];
    if (m) return validIso(fullYear(Number(mon[3])), m, Number(mon[1]));
    return null;
  }
  // Numeric d/m/y (or m/d/y).
  const num = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const y = fullYear(Number(num[3]));
    const [dd, mm] = dayFirst ? [a, b] : [b, a];
    return validIso(y, mm, dd);
  }
  return null;
}
function fullYear(y: number): number {
  return y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y;
}
function validIso(y: number, m: number, d: number): string | null {
  if (![y, m, d].every(Number.isInteger)) return null;
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = isoFromParts(y, m, d);
  // isoFromParts clamps an out-of-range day; reject rather than silently shift.
  return iso.endsWith(`-${String(d).padStart(2, "0")}`) ? iso : null;
}

/** Sniff whether a column of numeric dates is day-first (DD/MM) or month-first
 *  (MM/DD) by finding a component that can ONLY be a day (>12). Returns true
 *  (day-first), false (month-first), or null when every value is ambiguous (both
 *  parts ≤12) or the signals conflict — the caller then keeps the user's choice.
 *  ISO and dd-Mon-yyyy values are unambiguous and ignored here. This lets a US
 *  broker export (Schwab, MM/DD) import correctly without the user flipping a toggle. */
export function detectDayFirst(samples: string[]): boolean | null {
  let dayFirst = false; // saw a first component > 12 → must be day-first
  let monthFirst = false; // saw a second component > 12 → must be month-first
  for (const raw of samples) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec((raw ?? "").trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return true;
  if (monthFirst && !dayFirst) return false;
  return null; // all ambiguous, or contradictory (bad data) → leave the choice to the user
}

/** A row that couldn't become an event, with the reason and a few identifying raw
 *  cells — surfaced in the review UI so nothing is silently dropped. Never persisted. */
export interface SkippedRow {
  reason: string;
  cells: { date: string; action: string; symbol: string; units: string; amount: string };
}

/** Turn a parsed CSV table into canonical rows using the column + action mapping.
 *  Rows that can't become an event (unparseable/missing date, unmapped/ignored
 *  action, no usable quantity/amount) are collected in `skippedRows` WITH a reason,
 *  never silently dropped; `skipped` is their count (kept for existing callers). */
export function toCanonicalRows(
  table: CsvTable,
  cols: ColumnMap,
  actions: ActionMap,
  opts: { dayFirst?: boolean } = {},
): { rows: CanonicalRow[]; skipped: number; skippedRows: SkippedRow[] } {
  const rows: CanonicalRow[] = [];
  const skippedRows: SkippedRow[] = [];
  const cell = (r: Record<string, string>, key?: string): string => (key ? (r[key] ?? "") : "");
  for (const r of table.rows) {
    const rawDate = cell(r, cols.date);
    const rawAction = cell(r, cols.action);
    const rawUnits = cols.units ? cell(r, cols.units) : "";
    const rawAmount = cols.amount ? cell(r, cols.amount) : "";
    const symbol = cell(r, cols.symbol).trim();
    const skip = (reason: string): void => {
      skippedRows.push({ reason, cells: { date: rawDate.trim(), action: rawAction.trim(), symbol, units: rawUnits.trim(), amount: rawAmount.trim() } });
    };

    const date = parseImportDate(rawDate, opts.dayFirst ?? true);
    const action = actions[rawAction.trim().toLowerCase()];
    if (!date) {
      skip("couldn't read the date");
      continue;
    }
    if (!action || action === "ignore") {
      skip(rawAction.trim() ? `action "${rawAction.trim()}" is not mapped (ignored)` : "no transaction type");
      continue;
    }
    if (symbol === "") {
      skip("no security / symbol");
      continue;
    }
    // Direction comes from the mapped ACTION, not the number's sign, so money magnitudes
    // are taken absolute: a BUY's amount is often signed negative (cash out; Schwab) and a
    // SELL's units+amount are often signed negative (units leaving a folio; a CAS
    // statement marks redemptions & switch-outs that way) — |value| is the true
    // cost/proceeds/quantity. TWO sign exceptions: a BUY's UNITS keep their sign (a
    // negative "buy" quantity is a data error → fails >0 → skipped, not flipped into a
    // fake position); and a DIVIDEND's AMOUNT keeps its sign (a negative dividend is a
    // reversal we don't represent → fails >0 → skipped, not doubled into income). Price is
    // always a magnitude; fee keeps its sign so a rebate (negative) is dropped, not charged.
    const rawUnitsN = cols.units ? parseImportNumber(rawUnits) : null;
    const rawPriceN = cols.price ? parseImportNumber(cell(r, cols.price)) : null;
    const rawAmountN = cols.amount ? parseImportNumber(rawAmount) : null;
    const units = rawUnitsN === null ? null : action === "sell" ? Math.abs(rawUnitsN) : rawUnitsN;
    const price = rawPriceN === null ? null : Math.abs(rawPriceN);
    const amount = rawAmountN === null ? null : action === "dividend" ? rawAmountN : Math.abs(rawAmountN);
    const fee = cols.fee ? parseImportNumber(cell(r, cols.fee)) : null;
    // A dividend with an explicit NON-POSITIVE amount is a reversal/adjustment we don't
    // represent — skip it OUTRIGHT (before the units×price fallback below could rescue it
    // and book it as positive income, which would be a sign error). N6/F2 invariant.
    if (action === "dividend" && rawAmountN !== null && rawAmountN <= 0) {
      skip("dividend with a non-positive amount (reversal/adjustment) — not imported");
      continue;
    }
    // A row is usable with a POSITIVE quantity OR a positive amount; direction comes
    // from `action`, so a zero/negative number is a reversal/blank we skip (+count),
    // never inject as a nonsensical negative event. CRUCIALLY: units are kept whenever
    // they're positive, EVEN IF the price cell is blank/unparseable/zero — a common
    // broker export shape (bonus/corporate-action/transfer rows) — so units are never
    // silently lost. A price is attached only when POSITIVE (a 0 price is meaningless
    // and would zero the cost basis — mirror prices.ts); otherwise the amount (if any)
    // is carried as the cost basis (grossAmount falls back to it), units still track.
    const hasUnits = units !== null && units > 0;
    const hasPrice = price !== null && price > 0;
    const hasAmount = amount !== null && amount > 0;
    // A dividend is an income AMOUNT, not a unit change — it needs a value (an explicit
    // amount, or units×price). A units-only "dividend" is noise → skip it (with reason)
    // rather than store a 0-amount event that drops both the shares and the cash.
    const usable = action === "dividend" ? hasAmount || (hasUnits && hasPrice) : hasUnits || hasAmount;
    if (!usable) {
      skip(action === "dividend" ? "dividend with no amount (or price)" : "no positive quantity or amount");
      continue;
    }
    // M4: adopt the file's currency only when it's a plausible ISO code; a junk token
    // ("Rupees") would otherwise be stored and silently drop the holding from all FX
    // totals. An unrecognised token → undefined → the import default is used instead.
    const rawCcy = cols.currency ? cell(r, cols.currency).trim().toUpperCase() : "";
    const currency = /^[A-Z]{3}$/.test(rawCcy) ? (rawCcy as CurrencyCode) : undefined;
    rows.push({
      date,
      action,
      symbol,
      name: cols.name ? cell(r, cols.name).trim() || undefined : undefined,
      units: hasUnits ? units : undefined,
      price: hasUnits && hasPrice ? price : undefined,
      amount: hasAmount ? amount : undefined,
      fee: fee !== null && fee >= 0 ? fee : undefined,
      currency,
      ref: cols.ref ? cell(r, cols.ref).trim() || undefined : undefined,
      assetType: cols.assetType ? cell(r, cols.assetType).trim() || undefined : undefined,
    });
  }
  return { rows, skipped: skippedRows.length, skippedRows };
}

// --- Merge plan -----------------------------------------------------------

export interface ImportSummary {
  units: number | null;
  invested: number;
  value: number | null;
}
export interface PlannedHolding {
  symbol: string;
  name: string;
  /** The holding's own currency (existing holding's, or the new draft's) — the
   *  before/after amounts are in THIS currency, so the diff must format with it. */
  currency: CurrencyCode;
  /** The resolved asset class: an existing holding's own class, or the class a NEW
   *  holding will be created with (override → file guess → import default). */
  assetClass: AssetClass;
  /** id of the existing holding this merges into, or null when a new one is created. */
  existingHoldingId: string | null;
  /** The holding to create (only when existingHoldingId is null). */
  draft: Holding | null;
  newEvents: HoldingEvent[];
  /** Rows skipped because that exact event already exists (idempotent re-import). */
  duplicates: number;
  /** Existing opening-estimate event ids replaced by the imported real history. */
  replacedOpeningIds: string[];
  before: ImportSummary;
  after: ImportSummary;
  warnings: string[];
}
export interface AmbiguousMatch {
  symbol: string;
  name: string;
  candidateIds: string[];
  candidateNames: string[];
}
export interface ImportPlan {
  holdings: PlannedHolding[];
  /** Symbols that matched more than one existing holding — the user must pick. */
  ambiguous: AmbiguousMatch[];
  ignoredRows: number;
  /** Ids of the holdings that existed when this plan was BUILT. The store's apply-time
   *  re-match (which converges a draft onto a holding a concurrent preview created)
   *  must only fire for holdings NOT in this set — otherwise it would silently merge
   *  into a holding the user explicitly declined to merge with (a "__new__" pick), or a
   *  pre-existing unrelated same-ticker holding. */
  knownHoldingIds: string[];
  totals: {
    newHoldings: number;
    existingHoldings: number;
    newEvents: number;
    duplicates: number;
    replacedOpenings: number;
  };
}

export interface ImportContext {
  targetAccountId: string; // "" = no account
  targetPersonId: Owner;
  defaultAssetClass: AssetClass;
  defaultCurrency: CurrencyCode;
  holdings: Holding[];
  events: HoldingEvent[];
  /** symbol (UPPER) -> existing holdingId, or "__new__" to force a new holding. */
  matchOverrides?: Record<string, string>;
  /** symbol (UPPER) -> asset class for a NEW holding, overriding the file guess /
   *  default. Ignored for merges (an existing holding keeps its own class). */
  assetClassOverrides?: Record<string, AssetClass>;
  /** Optional Google Finance exchange prefix (e.g. "NSE", "BSE") prepended to a new
   *  googlefinance-priced holding's ticker when the symbol has no exchange yet — so an
   *  Indian broker's "INFY" becomes "NSE:INFY" and prices out of the box. */
  googleFinanceExchange?: string;
  asOf: string;
}

const NEW = "__new__";
const norm = (s: string): string => s.trim().toLowerCase();
/** A ticker's core with any EXCHANGE prefix ("NSE:", "MUTF_IN:") stripped, normalised.
 *  Lets a stored "NSE:INFY" match a file's raw "INFY" (and vice-versa) when matching.
 *  Only a real exchange-code-shaped prefix (letters/underscore, no spaces) is stripped,
 *  so a colon inside a fund NAME ("Franklin Feeder: US Opportunities") is left intact and
 *  can't collapse two different schemes together. */
const tickerCore = (t: string): string => {
  const m = /^([A-Za-z_]{1,10}):(.+)$/.exec(t.trim());
  return norm(m ? m[2] : t);
};

/** The base dedup key for a row: the broker ref when present (most reliable), else
 *  the row's content. A per-key counter (added by the caller) then disambiguates
 *  genuine collisions WITHIN one file — critically including rows that SHARE a ref
 *  (partial fills, or a non-unique column like a folio number mapped as ref), which
 *  otherwise produce identical ids and silently overwrite each other on apply. */
function rowBaseKey(row: CanonicalRow): string {
  // Always include the row's content, even when a ref is present: the per-key
  // counter then only ever disambiguates BYTE-IDENTICAL rows (which are
  // interchangeable), so a later export that reorders same-ref/same-date fills or
  // adds one can't positionally mismap an id (silent double-count / drop).
  const content = `${row.date}|${row.action}|${row.units ?? ""}|${row.price ?? ""}|${row.amount ?? ""}`;
  return row.ref ? `r:${row.ref}|${content}` : `h:${content}`;
}
/** Deterministic id, scoped to the HOLDING (not the account) + base key + a per-key
 *  counter. Keying on the holding id — rather than account+symbol — means moving a
 *  holding to another account (or unassigning it) can't change its imported events'
 *  ids, so re-importing the same file still dedups instead of double-counting. The
 *  `import:` prefix marks the event as import-owned and can't collide with a UUID. */
export function importEventIdPrefix(holdingId: string): string {
  return `import:${holdingId}:`;
}
function eventId(holdingId: string, baseKey: string, counter: number): string {
  return `${importEventIdPrefix(holdingId)}${baseKey}#${counter}`;
}
export function isImportedEvent(e: Pick<HoldingEvent, "id">): boolean {
  return e.id.startsWith("import:");
}

function rowToEvent(row: CanonicalRow, holdingId: string, id: string): HoldingEvent {
  const e: HoldingEvent = { id, holdingId, date: row.date, type: row.action };
  if (row.action === "dividend") {
    e.amount = row.amount ?? (row.units !== undefined && row.price !== undefined ? row.units * row.price : 0);
  } else {
    // Buy / sell. Keep units whenever present (H1) so a blank-price row still tracks
    // quantity. For the cost basis: prefer the per-unit price, BUT when units×price
    // grossly disagrees with the actual cash amount (>3×) the price is in a different
    // unit than the amount — classically bonds quoted per 100 face (qty 10000 × 98.83 =
    // 988k vs a real 9.9k amount) — so trust the amount instead (avoids a 100× blowup).
    if (row.units !== undefined) e.units = row.units;
    const up = row.units !== undefined && row.price !== undefined ? Math.abs(row.units * row.price) : null;
    const amt = row.amount !== undefined ? Math.abs(row.amount) : null;
    const grossMismatch = up !== null && amt !== null && amt > 0 && (up / amt > 3 || amt / up > 3);
    if (grossMismatch) {
      e.amount = row.amount; // the cash amount is the reliable cost basis
    } else if (row.units !== undefined && row.price !== undefined) {
      e.price = row.price;
    } else if (row.amount !== undefined) {
      e.amount = row.amount;
    }
  }
  if (row.fee !== undefined) e.fee = row.fee;
  e.note = "Imported";
  return e;
}

function summarise(holding: Holding, events: HoldingEvent[], asOf: string): ImportSummary {
  const withFd = withFdAccrual(holding, events, asOf);
  return {
    units: netUnits(events),
    invested: holdingPnl(withFd).invested,
    value: currentHoldingValue(withFd),
  };
}

/**
 * Build a detailed, reviewable plan from canonical rows. Pure — computes what WOULD
 * change (new holdings, events to add, estimates to replace, duplicates skipped,
 * before/after totals) without mutating anything.
 */
export function planImport(rows: CanonicalRow[], ctx: ImportContext): ImportPlan {
  const existingEventIds = new Set(ctx.events.map((e) => e.id));
  const eventsByHolding = new Map<string, HoldingEvent[]>();
  for (const e of ctx.events) {
    const arr = eventsByHolding.get(e.holdingId);
    if (arr) arr.push(e);
    else eventsByHolding.set(e.holdingId, [e]);
  }
  // Existing holdings eligible to match INTO: same target account only (the same
  // security in a different account is a different position).
  const inAccount = ctx.holdings.filter((h) => (h.accountId ?? "") === ctx.targetAccountId && !h.archived);

  // Group rows by symbol, preserving first-seen name and a stable order (by date,
  // then first-seen index) so dedup counters are reproducible across re-imports.
  const groups = new Map<string, { symbol: string; name: string; rows: Array<{ row: CanonicalRow; i: number }> }>();
  rows.forEach((row, i) => {
    const key = row.symbol.toUpperCase();
    let g = groups.get(key);
    if (!g) {
      g = { symbol: row.symbol, name: row.name || row.symbol, rows: [] };
      groups.set(key, g);
    } else if (g.name === g.symbol && row.name) {
      g.name = row.name; // fill a better display name if a later row has one
    }
    g.rows.push({ row, i });
  });

  const planned: PlannedHolding[] = [];
  const ambiguous: AmbiguousMatch[] = [];
  // Duplicate counter keyed per TARGET HOLDING (not per symbol group): two different
  // symbols merged into one holding (via overrides) with byte-identical content would
  // otherwise both get #0 and collide into one event on apply (N2). A per-holding
  // counter gives the second row #1. Re-import stays idempotent (identical rows are
  // interchangeable, so the {#0,#1} id set is stable).
  const holdingCounters = new Map<string, Map<string, number>>();

  for (const [symbolUpper, g] of groups) {
    // --- resolve the target holding ---
    const override = ctx.matchOverrides?.[symbolUpper];
    let existing: Holding | null = null;
    if (override && override !== NEW) {
      existing = ctx.holdings.find((h) => h.id === override) ?? null;
    } else if (!override) {
      // Match on the ticker CORE (exchange prefix stripped) so a holding stored as
      // "NSE:INFY" from a prior prefixed import still matches a raw "INFY" in the file —
      // otherwise the re-import previews as a bogus NEW holding (N5).
      const byTicker = inAccount.filter((h) => h.ticker && tickerCore(h.ticker) === tickerCore(g.symbol));
      const byName = inAccount.filter((h) => norm(h.name) === norm(g.name) || norm(h.name) === norm(g.symbol));
      const candidates = byTicker.length > 0 ? byTicker : byName;
      if (candidates.length > 1) {
        ambiguous.push({
          symbol: g.symbol,
          name: g.name,
          candidateIds: candidates.map((h) => h.id),
          candidateNames: candidates.map((h) => h.name),
        });
        continue; // unresolved → excluded from the applied plan until the user picks
      }
      existing = candidates[0] ?? null;
    } // override === NEW → existing stays null

    // A NEW holding takes the file's currency when the rows agree on one — otherwise
    // an INR fund imported under a USD default would store INR amounts labelled USD
    // and inflate net worth. Mixed currencies fall back to the default (+ a warning).
    const rowCurrencies = new Set(g.rows.map((r) => r.row.currency).filter(Boolean));
    const groupWarnings: string[] = [];
    const draftCurrency: CurrencyCode = rowCurrencies.size === 1 ? [...rowCurrencies][0]! : ctx.defaultCurrency;
    if (rowCurrencies.size > 1) groupWarnings.push(`File has mixed currencies for this symbol — using ${ctx.defaultCurrency}.`);

    // Asset class for a NEW holding: explicit override → file "security type" guess →
    // import default. An EXISTING holding keeps its own class (never reclassified by
    // an import). The guess uses the first row whose asset-type text is recognisable.
    const guessedClass = g.rows.map((r) => guessAssetClass(r.row.assetType)).find((c) => c !== null) ?? null;
    const draftAssetClass: AssetClass = ctx.assetClassOverrides?.[symbolUpper] ?? guessedClass ?? ctx.defaultAssetClass;

    // Live-price setup for a NEW holding: source defaults from the class, ticker is the
    // file symbol — prefixed with the exchange for Google Finance when one is given and
    // the symbol lacks its own (so "INFY" → "NSE:INFY", but "NSE:INFY"/"VOO" stay put).
    const draftSource = draftAssetClass && g.symbol ? defaultPriceSource(draftAssetClass) : undefined;
    const exch = ctx.googleFinanceExchange?.trim();
    const draftTicker = !g.symbol
      ? undefined
      : draftSource === "googlefinance" && exch && !g.symbol.includes(":")
        ? `${exch}:${g.symbol}`
        : g.symbol;

    const holdingId = existing ? existing.id : newId();
    const draft: Holding | null = existing
      ? null
      : {
          id: holdingId,
          name: g.name,
          personId: ctx.targetPersonId,
          accountId: ctx.targetAccountId || undefined,
          assetClass: draftAssetClass,
          currency: draftCurrency,
          incomeMode: "accumulating",
          ticker: draftTicker,
          ...(draftSource && draftTicker ? { priceSource: draftSource } : {}),
        };
    const holding = existing ?? (draft as Holding);
    const existingEvents = existing ? (eventsByHolding.get(existing.id) ?? []) : [];

    // --- build candidate events, dedup against existing ids ---
    const ordered = [...g.rows].sort((x, y) => (x.row.date < y.row.date ? -1 : x.row.date > y.row.date ? 1 : x.i - y.i));
    // Counter keyed on the FULL base key (ref or content) so ANY id collision — even
    // across symbol groups mapped to the SAME holding — gets a distinct #n (N2).
    let dupCounter = holdingCounters.get(holdingId);
    if (!dupCounter) {
      dupCounter = new Map<string, number>();
      holdingCounters.set(holdingId, dupCounter);
    }
    const newEvents: HoldingEvent[] = [];
    let duplicates = 0;
    const warnings: string[] = [...groupWarnings];
    for (const { row } of ordered) {
      const baseKey = rowBaseKey(row);
      const idx = dupCounter.get(baseKey) ?? 0;
      dupCounter.set(baseKey, idx + 1);
      const id = eventId(holdingId, baseKey, idx);
      if (existingEventIds.has(id)) {
        duplicates++;
        continue;
      }
      newEvents.push(rowToEvent(row, holdingId, id));
      if (row.currency && existing && row.currency !== existing.currency) {
        warnings.push(`Row currency ${row.currency} differs from the holding's ${existing.currency}.`);
      }
      // A buy/sell that carries units but no price still tracks quantity; its cost
      // basis comes from the amount (or is unknown). Flag it so a surprising cost is
      // explainable rather than looking like a bug.
      if (row.action !== "dividend" && row.units !== undefined && row.price === undefined) {
        warnings.push("Some transactions have a quantity but no price — cost basis uses the amount where available.");
      }
      // units×price grossly disagreeing with the amount (bonds quoted per 100 face) — we
      // use the amount, but tell the user so the cost basis isn't a surprise.
      if (row.action !== "dividend" && row.units !== undefined && row.price !== undefined && row.amount !== undefined) {
        const up = Math.abs(row.units * row.price);
        const amt = Math.abs(row.amount);
        if (amt > 0 && (up / amt > 3 || amt / up > 3)) {
          warnings.push("A transaction's quantity × price disagrees with its amount (common for bonds quoted per 100 face value) — the cash amount is used as the cost basis.");
        }
      }
    }

    // --- estimate-replace: a manual AMOUNT-ONLY opening estimate (no real buys) is
    // superseded by imported real buys, so history isn't stacked on top. An opening
    // that carries UNITS is a real pre-history baseline (brokers cap export windows),
    // so it is NOT deleted — instead we warn, since imported buys sit on top of it. ---
    const amountOnlyOpenings = existingEvents.filter((e) => e.type === "opening" && e.units === undefined);
    const unitsOpenings = existingEvents.filter((e) => e.type === "opening" && e.units !== undefined);
    const importAddsBuys = newEvents.some((e) => e.type === "buy");
    const existingHasBuys = existingEvents.some((e) => e.type === "buy");
    // M2: only replace an estimate when the import's EARLIEST buy is at or before the
    // opening's date — i.e. the imported history actually re-delivers the money that
    // estimate stood in for. If the import starts LATER, the opening represents earlier
    // history the import doesn't cover, so keep it (and warn) rather than delete cost.
    const earliestBuyDate = newEvents.reduce<string | null>(
      (min, e) => (e.type === "buy" && (min === null || e.date < min) ? e.date : min),
      null,
    );
    const canReplace = Boolean(existing) && importAddsBuys && !existingHasBuys && earliestBuyDate !== null;
    const replacedOpenings = canReplace ? amountOnlyOpenings.filter((o) => earliestBuyDate! <= o.date) : [];
    const keptEstimateOpenings = canReplace ? amountOnlyOpenings.filter((o) => !replacedOpenings.includes(o)) : [];
    if (existing && importAddsBuys && unitsOpenings.length > 0) {
      warnings.push("This holding has a starting quantity (opening) — imported buys are added on top; check they don't re-count that baseline.");
    }
    if (keptEstimateOpenings.length > 0) {
      warnings.push("An opening estimate predates the imported transactions — kept it (the import may not cover that earlier history). Remove it if the import already includes it.");
    }
    // N7: existing REAL buys + a leftover amount-only opening estimate + more imported
    // buys → the estimate is never auto-replaced (that only happens with no prior buys),
    // so its cost may now double-count. Warn rather than silently stack.
    if (existing && importAddsBuys && existingHasBuys && amountOnlyOpenings.length > 0) {
      warnings.push("This holding already has transactions plus an opening estimate — the imported buys add on top, which may double-count the estimate. Remove the opening if it's now covered.");
    }

    const afterEvents = existingEvents.filter((e) => !replacedOpenings.includes(e)).concat(newEvents);
    const before = existing ? summarise(existing, existingEvents, ctx.asOf) : { units: null, invested: 0, value: null };
    const after = summarise(holding, afterEvents, ctx.asOf);

    // A sell that drives net units negative usually means missing prior buys.
    if (after.units !== null && after.units < -1e-9) {
      warnings.push("Imported sells exceed the units on record — some earlier buys may be missing.");
    }

    planned.push({
      symbol: g.symbol,
      name: g.name,
      currency: holding.currency,
      assetClass: holding.assetClass,
      existingHoldingId: existing ? existing.id : null,
      draft,
      newEvents,
      duplicates,
      replacedOpeningIds: replacedOpenings.map((e) => e.id),
      before,
      after,
      warnings: [...new Set(warnings)], // dedupe (a per-row currency warning could repeat thousands of times)
    });
  }

  const totals = {
    newHoldings: planned.filter((p) => p.existingHoldingId === null).length,
    existingHoldings: planned.filter((p) => p.existingHoldingId !== null).length,
    newEvents: planned.reduce((n, p) => n + p.newEvents.length, 0),
    duplicates: planned.reduce((n, p) => n + p.duplicates, 0),
    replacedOpenings: planned.reduce((n, p) => n + p.replacedOpeningIds.length, 0),
  };
  return { holdings: planned, ambiguous, ignoredRows: 0, knownHoldingIds: ctx.holdings.map((h) => h.id), totals };
}
