// CoinGecko price provider (crypto). Free, no key, CORS-enabled (verified:
// `access-control-allow-origin: *`), so it works directly from a static browser
// app. We always quote in USD and let the caller convert into the holding's
// currency via the FxTable — keeps the provider uniform with the others.
//
// The ticker is a CoinGecko *id* (e.g. "bitcoin", "ethereum"), NOT a symbol —
// ids are unambiguous, symbols collide. Parsing is split out as a pure function
// so it's unit-testable without network.

import type { PriceProvider, PriceQuery, PriceQuote } from "./types";

export const COINGECKO_ENDPOINT = "https://api.coingecko.com/api/v3/simple/price";

type CoinGeckoResponse = Record<string, { usd?: number } | undefined>;

/** Pure: turn a CoinGecko `/simple/price?vs_currencies=usd` payload into quotes.
 *  Ids missing from the payload (unknown coin) are simply omitted. */
export function parseCoinGecko(json: unknown, ids: string[]): PriceQuote[] {
  const r = (json ?? {}) as CoinGeckoResponse;
  const quotes: PriceQuote[] = [];
  for (const id of ids) {
    const usd = r[id]?.usd;
    if (typeof usd === "number" && Number.isFinite(usd)) {
      quotes.push({ ticker: id, price: usd, currency: "USD" });
    }
  }
  return quotes;
}

export function coinGeckoProvider(fetchImpl: typeof fetch = fetch): PriceProvider {
  return {
    id: "coingecko",
    label: "CoinGecko",
    async quote(queries: PriceQuery[]): Promise<PriceQuote[]> {
      const ids = [...new Set(queries.map((q) => q.ticker.trim()).filter(Boolean))];
      if (ids.length === 0) return [];
      const url = `${COINGECKO_ENDPOINT}?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);
      return parseCoinGecko(await res.json(), ids);
    },
  };
}
