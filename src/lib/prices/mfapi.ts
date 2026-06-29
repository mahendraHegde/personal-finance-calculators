// Indian mutual-fund NAV provider, backed by mfapi.in. Free, no auth, CORS-clean
// (verified: `access-control-allow-origin: *`) — so it works directly from the
// browser, unlike the AMFI flat file (no CORS, dumps every scheme). The ticker
// is an AMFI scheme code (e.g. "118550"). NAV is always in INR; the caller
// FX-converts into the holding's currency.
//
// mfapi.in has no batch endpoint, so we fan out one request per scheme and
// tolerate individual failures (a bad code just omits that quote). Parsing is a
// pure function for unit testing.

import type { PriceProvider, PriceQuery, PriceQuote } from "./types";

export const MFAPI_ENDPOINT = "https://api.mfapi.in/mf";

interface MfApiLatestResponse {
  status?: string;
  data?: Array<{ date?: string; nav?: string }>;
}

/** mfapi dates are DD-MM-YYYY; normalise to ISO YYYY-MM-DD (undefined if odd). */
function toIsoDate(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

/** Pure: extract the latest NAV (in INR) for one scheme. Returns null when the
 *  payload has no usable NAV (unknown code / provider error / non-numeric). */
export function parseMfApiLatest(json: unknown, ticker: string): PriceQuote | null {
  const r = (json ?? {}) as MfApiLatestResponse;
  const row = r.data?.[0];
  const nav = row?.nav !== undefined ? Number(row.nav) : NaN;
  if (!Number.isFinite(nav) || nav <= 0) return null;
  return { ticker, price: nav, currency: "INR", asOf: toIsoDate(row?.date) };
}

export function mfApiProvider(fetchImpl: typeof fetch = fetch): PriceProvider {
  return {
    id: "mfapi",
    label: "mfapi.in (NAV)",
    async quote(queries: PriceQuery[]): Promise<PriceQuote[]> {
      const codes = [...new Set(queries.map((q) => q.ticker.trim()).filter(Boolean))];
      const results = await Promise.all(
        codes.map(async (code): Promise<PriceQuote | null> => {
          try {
            const res = await fetchImpl(`${MFAPI_ENDPOINT}/${encodeURIComponent(code)}/latest`);
            if (!res.ok) return null;
            return parseMfApiLatest(await res.json(), code);
          } catch {
            return null; // one bad scheme shouldn't sink the batch
          }
        }),
      );
      return results.filter((q): q is PriceQuote => q !== null);
    },
  };
}
