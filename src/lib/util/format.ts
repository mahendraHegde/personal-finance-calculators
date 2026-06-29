// Presentation helpers. Pure and locale-aware via Intl.

import type { CurrencyCode } from "../money/currency";

/** The number-formatting locale for a currency, so digit grouping AND compact
 *  notation match local convention. INR → `en-IN` gives the Indian system —
 *  2-2-3 grouping (₹9,90,755) and Lakh/Crore compact (₹9.9L, ₹1.2Cr) — instead
 *  of thousands/millions. Everything formats money through here, so this one
 *  seam localises the whole app; extend the map for other currencies as needed.
 *  `undefined` = the runtime's default locale (Western K/M grouping). */
function localeFor(currency: CurrencyCode): string | undefined {
  return currency === "INR" ? "en-IN" : undefined;
}

export function formatMoney(amount: number, currency: CurrencyCode): string {
  if (!Number.isFinite(amount)) return "—";
  const locale = localeFor(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
    }).format(amount);
  } catch {
    // Unknown currency code → fall back to a plain number + code.
    return `${amount.toLocaleString(locale, { maximumFractionDigits: 2 })} ${currency}`;
  }
}

/** Compact form for big dashboard numbers (e.g. $1.2M; ₹9.9L / ₹1.2Cr for INR). */
export function formatCompactMoney(amount: number, currency: CurrencyCode): string {
  if (!Number.isFinite(amount)) return "—";
  const locale = localeFor(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString(locale, { notation: "compact" })} ${currency}`;
  }
}

export function formatPercent(decimal: number | null, digits = 1): string {
  if (decimal === null || !Number.isFinite(decimal)) return "—";
  return `${(decimal * 100).toFixed(digits)}%`;
}

/** Parse our stored dates. A date-only `YYYY-MM-DD` is built in LOCAL time —
 *  `new Date("2026-06-01")` is UTC midnight, which renders as the previous day
 *  in time zones west of UTC (e.g. America/Santiago). Full ISO timestamps pass
 *  through unchanged. */
export function parseStoredDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = parseStoredDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Today's date as an ISO YYYY-MM-DD string (local). */
export function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}
