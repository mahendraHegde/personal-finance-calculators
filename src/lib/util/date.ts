// Small UTC date helpers. ISO dates are YYYY-MM-DD; parsing/constructing via
// Date.UTC keeps day arithmetic timezone-independent. Kept framework-free and
// dependency-free so both the money math (interest) and the domain (autopay
// billing cycles) can share one implementation instead of re-deriving it.

/** Number of days in a given month (1-12), UTC. Day 0 of the next month is the
 *  last day of this one, so this also yields 28/29 for February. */
export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** ISO date for (year, month 1-12, day), with the day CLAMPED to the month's
 *  length — e.g. day 31 in February becomes the 28th/29th, never rolling into the
 *  next month. Use this for a fixed day-of-month that must stay in its month. */
export function isoFromParts(year: number, month1to12: number, day: number): string {
  const dim = daysInMonth(year, month1to12);
  const d = Math.min(Math.max(1, day), dim);
  return new Date(Date.UTC(year, month1to12 - 1, d)).toISOString().slice(0, 10);
}

/** ISO date `months` after `iso` (UTC). Reads only the YYYY-MM-DD head, so a value
 *  carrying a time component doesn't parse to NaN and throw. A clamped day-of-month
 *  rolls into the next month (JS Date semantics) — fine where only the resulting
 *  instant matters (e.g. a compounding boundary), not the day-of-month. */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}
