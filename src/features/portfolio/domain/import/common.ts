// Primitives shared by EVERY CSV importer (holdings, transactions, …): tolerant
// number/date parsing, day-first sniffing, and header guessing. Pure and unit-tested.
//
// The parsing rule throughout: REJECT (return null) anything ambiguous rather than
// guess — a mis-read amount or date corrupts the ledger, and a rejected row is
// surfaced to the user with a reason instead of being silently dropped.

import { isoFromParts } from "../../../../lib/util/date";

/** Sentinel for "create a new entity for this value" in a mapping dropdown. */
export const NEW_ENTITY = "__new__";
/** Sentinel for "don't attach anything for this value" — for a CATEGORY it means "import
 *  the rows uncategorised"; for a type column it means "skip these rows". */
export const IGNORE_VALUE = "__ignore__";
/** Sentinel for "skip every row carrying this value" — the row is not imported at all
 *  (e.g. transfer narrations you don't want as expenses). Always reported as skipped. */
export const SKIP_ROWS = "__skip__";

export const norm = (s: string): string => s.trim().toLowerCase();

/** First header containing any of `keywords` (case-insensitive), or "" — used to
 *  pre-fill a column-mapping dropdown from the file's own header names. */
export function guessColumn(headers: string[], keywords: string[]): string {
  return headers.find((h) => keywords.some((k) => h.toLowerCase().includes(k))) ?? "";
}

/** Parse a money/quantity cell. Accepts plain, EN (1,234.56) and Indian lakh
 *  (1,23,456.78) grouping; strips currency symbols/spaces; reads (1,234) as -1234.
 *  REJECTS (null) anything ambiguous — EU decimals ("1.234,56"), scientific ("1e3"),
 *  or any letters — because a mis-parsed amount corrupts the ledger. */
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
 *  bank/broker export (MM/DD) import correctly without the user flipping a toggle. */
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

// --- Fuzzy name matching --------------------------------------------------
// Files name the same bank/category a dozen ways ("HDFC-BANK", "hdfc savings a/c",
// "Hdfc Bank Ltd."). Matching is a SUGGESTION: it pre-fills the mapping step, which the
// user always sees and can override — so a wrong guess costs a click, never data.

/** Comparison key: lowercased, punctuation collapsed to single spaces, trimmed.
 *  "HDFC-Bank (Savings)" → "hdfc bank savings". */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Words too generic to make two different names "similar" on their own.
 *  NOT included: "bank" / "card" / "credit" / "savings" — those DISCRIMINATE ("Axis Bank"
 *  is a different account from "Axis Card", and treating them as noise scored that pair
 *  0.9, pre-filling an asset statement onto a liability). */
const NOISE = new Set(["a", "c", "ac", "the", "ltd", "limited", "pvt", "inc", "my", "and", "of"]);

/** Words naming a distinct PRODUCT CLASS. Present on only one side (or differing), the two
 *  names are different accounts however much text they share — "HDFC Bank" vs "HDFC Bank
 *  Credit Card" must never be suggested for each other, or a bank statement gets pre-filled
 *  onto a liability. */
const PRODUCT_CLASS = new Set([
  "card", "credit", "debit", "loan", "wallet", "prepaid", "emi", "overdraft", "fd", "deposit",
]);
/** Sub-types of the SAME product. Harmless one-sided ("HDFC Bank" ≈ "HDFC Bank Savings" —
 *  a savings account IS the bank account), but two DIFFERENT ones mean different accounts
 *  ("HDFC Savings" vs "HDFC Current"). */
const SUBTYPE = new Set(["savings", "current", "salary", "joint"]);

const tokenSet = (tokens: string[], vocab: Set<string>): string =>
  [...new Set(tokens.filter((w) => vocab.has(w)))].sort().join(" ");

function bigrams(key: string): string[] {
  const t = key.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice similarity over character bigrams, 0..1 — cheap, dependency-free and
 *  forgiving of the abbreviations and punctuation real exports contain.
 *
 *  Whole-token containment ("hdfc" ⊂ "hdfc savings") gets a boost, because bigrams alone
 *  under-score a name that is simply longer. The boost is DICE-WEIGHTED (0.9 + dice/100)
 *  rather than a flat 0.9, so when several candidates contain the token the closest name
 *  wins instead of whichever happened to come first in the list. */
export function nameSimilarity(a: string, b: string): number {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (ka === "" || kb === "") return 0;
  if (ka === kb) return 1;

  const A = bigrams(ka);
  const B = bigrams(kb);
  if (A.length === 0 || B.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of B) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of A) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hits++;
      pool.set(g, n - 1);
    }
  }
  const dice = (2 * hits) / (A.length + B.length);

  const ta = ka.split(" ").filter((w) => !NOISE.has(w));
  const tb = kb.split(" ").filter((w) => !NOISE.has(w));
  if (ta.length > 0 && tb.length > 0) {
    const setA = new Set(ta);
    const setB = new Set(tb);
    // A different PRODUCT CLASS ⇒ different accounts of the same brand ("Axis Bank" vs
    // "Axis Bank Card", "ICICI" vs "ICICI FD"). Character overlap is huge for those, so
    // dropping the containment bonus isn't enough — cap below any usable threshold, since
    // suggesting one for the other files a statement into the wrong account (an asset onto
    // a liability). Two DIFFERENT sub-types are likewise different accounts, but a sub-type
    // on one side only is fine ("HDFC Bank" ≈ "HDFC Bank Savings").
    if (tokenSet(ta, PRODUCT_CLASS) !== tokenSet(tb, PRODUCT_CLASS)) return Math.min(dice, 0.5);
    const subA = tokenSet(ta, SUBTYPE);
    const subB = tokenSet(tb, SUBTYPE);
    if (subA !== "" && subB !== "" && subA !== subB) return Math.min(dice, 0.5);

    const shared = ta.filter((w) => setB.has(w));
    // Every meaningful word of one side appears in the other ("hdfc" vs "hdfc bank"),
    // as opposed to merely overlapping ("axis bank" vs "axis card").
    if (shared.length === setA.size || shared.length === setB.size) return Math.min(1, 0.9 + dice / 100);
  }
  return dice;
}

/** The candidate whose name best matches `raw`, or undefined when nothing clears
 *  `minScore`.
 *
 *  Fully ORDER-INDEPENDENT: the best score wins, and an exact score tie is broken by the
 *  shorter name then alphabetically — never by the candidate list's order (which is the
 *  user's account-creation order, so the same data would otherwise pre-fill differently on
 *  another device). */
export function bestNameMatch<T>(
  raw: string,
  candidates: T[],
  nameOf: (c: T) => string,
  minScore = 0.62,
): T | undefined {
  let best: T | undefined;
  let bestScore = 0;
  for (const c of candidates) {
    const score = nameSimilarity(raw, nameOf(c));
    if (score > bestScore) {
      bestScore = score;
      best = c;
      continue;
    }
    if (best !== undefined && score === bestScore && score > 0) {
      const a = nameKey(nameOf(c));
      const b = nameKey(nameOf(best));
      if (a.length < b.length || (a.length === b.length && a < b)) best = c;
    }
  }
  return bestScore >= minScore ? best : undefined;
}

/** A row an importer could not use, with the reason and the identifying raw cells —
 *  surfaced in the review UI so nothing is ever silently dropped. Never persisted. */
export interface SkippedImportRow {
  /** 1-based index of the DATA row (header excluded), for "row 42" messages. */
  row: number;
  reason: string;
  /** A few raw cells, labelled, for recognising the row in the file. */
  cells: Record<string, string>;
}
